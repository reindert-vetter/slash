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
	// Status is only populated by Search (the issue-list endpoints); Issue()
	// does not ask for it, so it stays empty there. Type comes back from BOTH
	// (Issue() asks for `issuetype` because the plan page's hotfix gate keys
	// off "is this a bug?" — see .claude/docs/plan-page.md).
	// `omitempty` keeps every pre-existing payload/fixture byte-identical.
	Status string `json:"status,omitempty"`
	Type   string `json:"type,omitempty"`
	// Assignee/AssigneeAvatarURL name the person this issue is assigned to (the
	// display name Jira shows plus their 24x24 profile picture), both empty for
	// an unassigned issue — which the UI renders as a circle with a QUESTION
	// MARK rather than as a blank spot (see .claude/docs/pr-overview.md and
	// .claude/docs/plan-page.md). Populated by BOTH Issue() and Search(): the
	// assignee is shown everywhere an issue is shown, also when it is the
	// reviewer himself.
	Assignee          string `json:"assignee,omitempty"`
	AssigneeAvatarURL string `json:"assigneeAvatarUrl,omitempty"`
	// ParentKey/ParentTitle name the issue this one hangs under (a Sub-task's
	// own parent); Subtasks are the children hanging under this one. Both are
	// only populated by Issue() — Search() does not ask for those fields — and
	// both stay empty for an issue that has neither, which is what the plan
	// page's scope question keys off (see .claude/docs/plan-page.md).
	ParentKey   string     `json:"parentKey,omitempty"`
	ParentTitle string     `json:"parentTitle,omitempty"`
	Subtasks    []IssueRef `json:"subtasks,omitempty"`
	// Comments are the issue's own Jira comments, oldest first and bounded by
	// maxIssueComments. They come back from the very same `acli` call as the
	// description (one extra field name, no extra round trip) and are what the
	// plan page plans WITH: a comment that walks the description back is worth
	// more than the description itself (see .claude/docs/plan-page.md).
	Comments []Comment `json:"comments,omitempty"`
}

// Comment is one Jira comment, flattened the same way a description is.
// ID/AccountID/AvatarURL only matter to the plan page's comment panel (a
// stable key per row, the author's picture, and who to @-mention back — see
// .claude/docs/plan-page.md); every one of them is `omitempty`, so a payload
// stored before they existed stays byte-identical.
type Comment struct {
	ID        string `json:"id,omitempty"`
	Author    string `json:"author,omitempty"`
	AccountID string `json:"accountId,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Created   string `json:"created,omitempty"`
	Body      string `json:"body"`
}

// maxIssueComments bounds how many comments one issue contributes: a long
// ticket can carry dozens, and only the recent ones still describe the plan.
// The NEWEST ones are kept, in chronological order.
const maxIssueComments = 20

// IssueRef is the little an issue link carries: enough to name and open the
// other issue, never its description (Jira does not include one in a
// parent/subtasks field anyway — reading it costs a second Issue() call).
type IssueRef struct {
	Key    string `json:"key"`
	Title  string `json:"title"`
	Status string `json:"status,omitempty"`
	Type   string `json:"type,omitempty"`
	// Assignee/AssigneeAvatarURL stay EMPTY here as far as this module's own
	// parsing goes: Jira's parent/subtasks field carries only
	// summary/status/priority/issuetype per link, never an assignee (verified
	// against the live `acli jira workitem view --fields subtasks --json`).
	// They are filled by a caller that pays for the extra read — one
	// IssuesByKey search over the subtask keys, see planLoadIssue in
	// plan_workflow.go.
	Assignee          string `json:"assignee,omitempty"`
	AssigneeAvatarURL string `json:"assigneeAvatarUrl,omitempty"`
}

// Client is the module's behaviour, so callers (workflows, tests) can depend on
// an interface and swap in Fake.
type Client interface {
	// Issue fetches a single Jira issue by key (e.g. "INTEG-562").
	Issue(ctx context.Context, key string) (Issue, error)
	// Search runs a JQL query and returns the matching issues (see search.go).
	// The JQL is always a caller-side CONSTANT, never reviewer input.
	Search(ctx context.Context, jql string, limit int) ([]Issue, error)
	// IssuesByKey reads a known set of issues in one search, for the fields a
	// parent/subtasks link does not carry — the assignee (see search.go).
	IssuesByKey(ctx context.Context, keys []string) ([]Issue, error)
	// Notifications reads the reviewer's own bell feed (see notifications.go).
	Notifications(ctx context.Context, limit int) ([]Notification, error)
	// AddComment posts one comment (an ADF document, see BuildCommentADF) on
	// an issue and returns the new comment's id. The ONLY write method of this
	// module: called from the postJiraComment Activity, never from a handler
	// (.claude/rules/workflows-write-boundary.md).
	AddComment(ctx context.Context, key string, adf json.RawMessage) (string, error)
	// Users searches the people who can be @-mentioned in a comment (read-only,
	// see comments.go).
	Users(ctx context.Context, query string, limit int) ([]User, error)
	// VerifyCredentials confirms the configured email/token are accepted by
	// Jira via a stable, documented endpoint (see notifications.go) — kept
	// separate from Notifications so a broken undocumented feed endpoint is
	// never mistaken for a bad token.
	VerifyCredentials(ctx context.Context) error
	// Transition moves an issue to another workflow status by NAME ("In
	// Progress"). A WRITE, so it is called from a workflow Activity only
	// (.claude/rules/workflows-write-boundary.md) — today the plan tracker's
	// jiraStartProgress, once the reviewer answered which branch the plan goes
	// out from. See transition.go.
	Transition(ctx context.Context, key, status string) error
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
		// issuetype is the ticket's own kind ("Bug", "Story", "Sub-task").
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
		// assignee is null for an unassigned issue, hence the pointer: an
		// absent one must read as "nobody", not as an empty-named person.
		Assignee *acliUser `json:"assignee"`
		// comment is Jira's own paged envelope; asking for the field yields
		// {"comments":[...]} with each body in ADF, exactly like description.
		Comment struct {
			Comments []acliComment `json:"comments"`
		} `json:"comment"`
	} `json:"fields"`
}

// acliUser is one person as every Jira payload spells them — a comment author,
// an assignee. The 24x24 avatar is the size this app shows (see avatarHTML in
// src/avatar.mjs); the host it points at is on the avatar proxy's allowlist
// (avatar_proxy.go), so it really loads in the browser.
type acliUser struct {
	AccountID   string `json:"accountId"`
	DisplayName string `json:"displayName"`
	AvatarURLs  struct {
		Small string `json:"24x24"`
	} `json:"avatarUrls"`
}

// acliComment is one entry of the comment field.
type acliComment struct {
	ID      string          `json:"id"`
	Author  acliUser        `json:"author"`
	Created string          `json:"created"`
	Body    json.RawMessage `json:"body"`
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
	Type string `json:"type"`
	Text string `json:"text"`
	// Attrs carries the text of the nodes that have no text LEAF of their own —
	// a mention ("@Dennis Sloove") is the one that matters here: a comment
	// addressing someone by name loses its subject without it.
	Attrs struct {
		Text string `json:"text"`
	} `json:"attrs"`
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
		"--fields", "summary,description,parent,subtasks,issuetype,comment,assignee", "--json")
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
		Type:        strings.TrimSpace(parsed.Fields.IssueType.Name),
	}
	if a := parsed.Fields.Assignee; a != nil {
		issue.Assignee = strings.TrimSpace(a.DisplayName)
		issue.AssigneeAvatarURL = strings.TrimSpace(a.AvatarURLs.Small)
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
	all := parsed.Fields.Comment.Comments
	if len(all) > maxIssueComments {
		all = all[len(all)-maxIssueComments:]
	}
	for _, c := range all {
		body := strings.TrimSpace(adfText(c.Body))
		if body == "" {
			continue
		}
		issue.Comments = append(issue.Comments, Comment{
			ID:        strings.TrimSpace(c.ID),
			Author:    strings.TrimSpace(c.Author.DisplayName),
			AccountID: strings.TrimSpace(c.Author.AccountID),
			AvatarURL: strings.TrimSpace(c.Author.AvatarURLs.Small),
			Created:   strings.TrimSpace(c.Created),
			Body:      body,
		})
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
		if n.Type == "mention" {
			return n.Attrs.Text
		}
		if n.Type == "hardBreak" {
			return "\n"
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
