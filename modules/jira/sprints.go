package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// sprints.go answers "which sprint is this issue in?" — the one thing the JQL
// search next door cannot tell us. `acli jira workitem search --fields` runs a
// strict whitelist that rejects BOTH `sprint` and the custom-field id behind
// it ("field 'sprint' is not allowed", verified live), while `acli jira
// workitem view` accepts the custom field and returns the full sprint objects.
// So the sprint of a row is read PER ISSUE, the same bounded/concurrent way
// jira_issues.go already reads a Sub-task's parent.
//
// It feeds the per-sprint blocks of the PR overview's Planning list
// ("Planning Team Core Sprint 71", then the future sprints below it) — see
// .claude/docs/pr-overview.md.

// sprintFieldID is Jira's own custom field holding an issue's sprints. It is a
// CONSTANT on purpose: the id is per Jira SITE, and this acli build offers no
// field-listing command to discover it (`acli jira field` only creates/updates
// custom fields). An issue that comes back without this field simply has no
// sprint as far as this module is concerned — the caller then shows the row in
// a plain, sprintless block rather than failing.
const sprintFieldID = "customfield_10020"

// Sprint is one Jira sprint an issue belongs to. State is Jira's own word
// ("active", "future", "closed"), which is what decides both whether a sprint
// is shown at all and where its block sits.
type Sprint struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	StartDate string `json:"startDate,omitempty"`
	BoardID   int    `json:"boardId,omitempty"`
}

// acliSprintView is the subset of `acli jira workitem view --fields
// key,<sprintFieldID>` this module reads.
type acliSprintView struct {
	Fields struct {
		Sprints []Sprint `json:"customfield_10020"`
	} `json:"fields"`
}

// IssueSprints reads the sprints one issue sits in, newest state and all: an
// issue that moved sprints carries every sprint it was ever in, so the caller
// picks (see pickSprint in jira_issues.go). The key is validated against
// keyPattern before it can reach exec.CommandContext, exactly like Issue().
func (m *Module) IssueSprints(ctx context.Context, key string) ([]Sprint, error) {
	if !keyPattern.MatchString(key) {
		return nil, fmt.Errorf("jira: invalid issue key %q", key)
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "view", key,
		"--fields", "key,"+sprintFieldID, "--json")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("acli jira workitem view %s: %w: %s", key, err, msg)
		}
		return nil, fmt.Errorf("acli jira workitem view %s: %w", key, err)
	}
	return parseSprintView(out)
}

// parseSprintView turns one view payload into its sprints. Empty output (or a
// payload without the field) is not an error: it means "no sprint".
func parseSprintView(out []byte) ([]Sprint, error) {
	if len(bytes.TrimSpace(out)) == 0 {
		return nil, nil
	}
	var parsed acliSprintView
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("jira: parse sprint view: %w", err)
	}
	list := make([]Sprint, 0, len(parsed.Fields.Sprints))
	for _, s := range parsed.Fields.Sprints {
		if strings.TrimSpace(s.Name) == "" {
			continue
		}
		list = append(list, s)
	}
	return list, nil
}
