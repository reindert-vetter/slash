// Package jira is the Jira-communication module: the one place that talks to
// Jira (via the local `acli` CLI). It is driven by workflow Activities — per
// the project rule, only workflows mutate state, and a module like this runs
// on their behalf. For now it only reads a single issue (title + description),
// used by the pr_status tracker to feed the PR-summary prompt.
package jira

import (
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

// Issue is the Jira fields the pr_status tracker (and the task-inbox
// aggregation, see the "jira" task source in taskinbox_analysis.go) care
// about. Status is the workitem's status name (e.g. "To Do"/"In Review"/
// "Done") — used by the task-inbox "jira_active" point rule to tell an
// actively-worked ticket apart from one still sitting in the backlog.
type Issue struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"` // flattened plain text (ADF extracted)
	URL         string `json:"url"`
	Status      string `json:"status"`
}

// Client is the module's behaviour, so callers (workflows, tests) can depend on
// an interface and swap in Fake.
type Client interface {
	// Issue fetches a single Jira issue by key (e.g. "INTEG-562").
	Issue(ctx context.Context, key string) (Issue, error)
	// AssignedToMe lists every Jira issue assigned to the logged-in user,
	// regardless of status (the task-inbox "jira" task source wants every
	// assigned ticket, not just open ones).
	AssignedToMe(ctx context.Context) ([]Issue, error)
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
	} `json:"fields"`
}

// acliSearchIssue is the shape of one element of `acli jira workitem search
// --json` — verified against a real `acli` invocation (see the doc comment
// on AssignedToMe). Only the fields we actually use are declared.
type acliSearchIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name string `json:"name"`
		} `json:"status"`
	} `json:"fields"`
}

// adfNode is a minimal Atlassian Document Format node: enough structure to walk
// the tree and collect every "text" leaf.
type adfNode struct {
	Type    string    `json:"type"`
	Text    string    `json:"text"`
	Content []adfNode `json:"content"`
}

// Issue fetches key's summary + description via `acli jira workitem view`. The
// key is validated against keyPattern before it ever reaches exec.CommandContext
// (never a shell string with user input).
func (m *Module) Issue(ctx context.Context, key string) (Issue, error) {
	if !keyPattern.MatchString(key) {
		return Issue{}, fmt.Errorf("jira: invalid issue key %q", key)
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "view", key,
		"--fields", "summary,description", "--json")
	out, err := cmd.Output()
	if err != nil {
		return Issue{}, fmt.Errorf("acli jira workitem view %s: %w", key, err)
	}
	var parsed acliIssue
	if err := json.Unmarshal(out, &parsed); err != nil {
		return Issue{}, fmt.Errorf("jira: parse %s: %w", key, err)
	}
	return Issue{
		Key:         key,
		Title:       parsed.Fields.Summary,
		Description: adfText(parsed.Fields.Description),
		URL:         baseURL + key,
	}, nil
}

// AssignedToMe lists every Jira issue assigned to the logged-in user (no
// status filter — the task-inbox "jira" task source wants every assigned
// ticket, active or not, and applies its own "jira_active" scoring on top),
// via `acli jira workitem search --jql "assignee = currentUser()" --json`.
//
// The exact acli subcommand/flags were verified interactively against a real,
// authenticated acli install (see the tembed-workflows.md task notes for this
// change): `acli jira workitem search --jql "<jql>" --fields "key,summary,
// status" --json --limit <n>` returns a JSON array of issues shaped like
// acliSearchIssue. No shell string is built from user input — the JQL here is
// a fixed constant, not built from any request parameter.
func (m *Module) AssignedToMe(ctx context.Context) ([]Issue, error) {
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "search",
		"--jql", "assignee = currentUser() order by updated desc",
		"--fields", "key,summary,status",
		"--json", "--limit", "100")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("acli jira workitem search: %w", err)
	}
	var parsed []acliSearchIssue
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("jira: parse search results: %w", err)
	}
	out2 := make([]Issue, 0, len(parsed))
	for _, p := range parsed {
		out2 = append(out2, Issue{
			Key:    p.Key,
			Title:  p.Fields.Summary,
			Status: p.Fields.Status.Name,
			URL:    baseURL + p.Key,
		})
	}
	return out2, nil
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
