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
)

// Issue is the Jira fields the pr_status tracker cares about.
type Issue struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"` // flattened plain text (ADF extracted)
	URL         string `json:"url"`
}

// Client is the module's behaviour, so callers (workflows, tests) can depend on
// an interface and swap in Fake.
type Client interface {
	// Issue fetches a single Jira issue by key (e.g. "INTEG-562").
	Issue(ctx context.Context, key string) (Issue, error)
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
