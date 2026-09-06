// Package jira is the Jira-communication module: the one place that talks to
// Jira (via the local `acli` CLI). It is driven by workflow Activities — per
// the project rule, only workflows mutate state, and a module like this runs
// on their behalf. For now it only reads a single issue (title + description),
// used by the pr_status tracker to feed the PR-summary prompt.
package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// cliTimeout bounds a single `acli` invocation, applied by this module itself
// (never relying solely on the caller): tembed's SignalWorkflow/advance runs a
// workflow — and thus its Activities — inline/blocking, so a hung acli (e.g. an
// interactive re-auth prompt with no TTY to answer it) would otherwise block
// that workflow run, and every later signal on the same run, forever. A real
// `acli jira workitem search` was measured at ~6s; 20s gives roughly 3x
// headroom for a slow network without allowing an unbounded hang. This is a
// production default, kept as a var (not a const) purely so tests can shrink
// it temporarily to exercise the timeout path against a fake, slow binary
// without waiting out the real value.
//
// context.WithTimeout on an already-bounded ctx only ever tightens the
// deadline — the shorter of the two always wins — so a caller's own shorter
// timeout is never overridden by this. Don't "optimize" this comment/call
// away; modules/github and modules/claude apply the same rule with their own
// values and refer back to this note instead of repeating it.
var cliTimeout = 20 * time.Second

// Issue is the Jira fields the pr_status tracker cares about.
type Issue struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"` // flattened plain text (ADF extracted)
	URL         string `json:"url"`
	// Status and Type are only populated by Search (the issue-list endpoints);
	// Issue() asks for summary+description only, so they stay empty there.
	// `omitempty` keeps every pre-existing payload/fixture byte-identical.
	Status string `json:"status,omitempty"`
	Type   string `json:"type,omitempty"`
	// ParentKey/ParentTitle name the issue this one hangs under (a Sub-task's
	// own parent); Subtasks are the children hanging under this one. Both are
	// only populated by Issue() — Search() does not ask for those fields — and
	// both stay empty for an issue that has neither, which is what the plan
	// page's scope question keys off (see .claude/docs/plan-page.md).
	ParentKey   string     `json:"parentKey,omitempty"`
	ParentTitle string     `json:"parentTitle,omitempty"`
	Subtasks    []IssueRef `json:"subtasks,omitempty"`
}

// IssueRef is the little an issue link carries: enough to name and open the
// other issue, never its description (Jira does not include one in a
// parent/subtasks field anyway — reading it costs a second Issue() call).
type IssueRef struct {
	Key    string `json:"key"`
	Title  string `json:"title"`
	Status string `json:"status,omitempty"`
	Type   string `json:"type,omitempty"`
}

// Client is the module's behaviour, so callers (workflows, tests) can depend on
// an interface and swap in Fake.
type Client interface {
	// Issue fetches a single Jira issue by key (e.g. "INTEG-562").
	Issue(ctx context.Context, key string) (Issue, error)
	// Search runs a JQL query and returns the matching issues (see search.go).
	// The JQL is always a caller-side CONSTANT, never reviewer input.
	Search(ctx context.Context, jql string, limit int) ([]Issue, error)
	// Notifications reads the reviewer's own bell feed (see notifications.go).
	Notifications(ctx context.Context, limit int) ([]Notification, error)
	// VerifyCredentials confirms the configured email/token are accepted by
	// Jira via a stable, documented endpoint (see notifications.go) — kept
	// separate from Notifications so a broken undocumented feed endpoint is
	// never mistaken for a bad token.
	VerifyCredentials(ctx context.Context) error
}

// Module is the production Client: it shells out to `acli jira workitem view`.
type Module struct{}

// New returns a production Module.
func New() *Module { return &Module{} }

// keyPattern validates a Jira issue key before it is ever passed to exec.
var keyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]+-\d+$`)

// baseURL is the workspace's browse base; kept as a constant since this project
// only ever talks to the one Jira site.
const baseURL = "https://plugandpaybv.atlassian.net/browse/"

type acliIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary     string          `json:"summary"`
		Description json.RawMessage `json:"description"`
		// parent is absent entirely for an ordinary issue; subtasks is an
		// empty array for one without children. Both carry the same nested
		// `fields` envelope as the issue itself.
		Parent   *acliIssueLink  `json:"parent"`
		Subtasks []acliIssueLink `json:"subtasks"`
	} `json:"fields"`
}

// acliIssueLink is one entry of the parent/subtasks fields.
type acliIssueLink struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name string `json:"name"`
		} `json:"status"`
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
	} `json:"fields"`
}

// issueRef turns one such link into the trimmed form callers see.
func issueRef(l acliIssueLink) IssueRef {
	return IssueRef{
		Key:    strings.TrimSpace(l.Key),
		Title:  strings.TrimSpace(l.Fields.Summary),
		Status: strings.TrimSpace(l.Fields.Status.Name),
		Type:   strings.TrimSpace(l.Fields.IssueType.Name),
	}
}

// adfNode is a minimal Atlassian Document Format node: enough structure to walk
// the tree and collect every "text" leaf.
type adfNode struct {
	Type    string    `json:"type"`
	Text    string    `json:"text"`
	Content []adfNode `json:"content"`
}

// Issue fetches key's summary + description via `acli jira workitem view`,
// plus the parent/subtasks links around it (the plan page asks whether a plan
// is about the main task or one of its subtasks — see
// .claude/docs/plan-page.md). The
// key is validated against keyPattern before it ever reaches exec.CommandContext
// (never a shell string with user input).
func (m *Module) Issue(ctx context.Context, key string) (Issue, error) {
	if !keyPattern.MatchString(key) {
		return Issue{}, fmt.Errorf("jira: invalid issue key %q", key)
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "view", key,
		"--fields", "summary,description,parent,subtasks", "--json")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return Issue{}, fmt.Errorf("acli jira workitem view %s: %w: %s", key, err, msg)
		}
		return Issue{}, fmt.Errorf("acli jira workitem view %s: %w", key, err)
	}
	var parsed acliIssue
	if err := json.Unmarshal(out, &parsed); err != nil {
		return Issue{}, fmt.Errorf("jira: parse %s: %w", key, err)
	}
	return issueFromACLI(key, parsed), nil
}

// issueFromACLI maps one parsed `acli jira workitem view` payload onto an
// Issue — pure, so the parent/subtasks mapping is testable without a CLI.
func issueFromACLI(key string, parsed acliIssue) Issue {
	issue := Issue{
		Key:         key,
		Title:       parsed.Fields.Summary,
		Description: adfText(parsed.Fields.Description),
		URL:         baseURL + key,
	}
	if p := parsed.Fields.Parent; p != nil {
		ref := issueRef(*p)
		issue.ParentKey, issue.ParentTitle = ref.Key, ref.Title
	}
	for _, st := range parsed.Fields.Subtasks {
		if ref := issueRef(st); ref.Key != "" {
			issue.Subtasks = append(issue.Subtasks, ref)
		}
	}
	return issue
}

// adfText extracts the plain text of an ADF document (or node) by recursively
// walking its content tree and concatenating every "text" leaf. Paragraphs are
// joined with a newline so multi-paragraph descriptions stay readable.
func adfText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var doc adfNode
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	var paras []string
	var walk func(n adfNode) string
	walk = func(n adfNode) string {
		if n.Type == "text" {
			return n.Text
		}
		var b strings.Builder
		for _, c := range n.Content {
			b.WriteString(walk(c))
		}
		return b.String()
	}
	if doc.Type == "doc" {
		for _, child := range doc.Content {
			if t := walk(child); t != "" {
				paras = append(paras, t)
			}
		}
	} else if t := walk(doc); t != "" {
		paras = append(paras, t)
	}
	return strings.Join(paras, "\n")
}
