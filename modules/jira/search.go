package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// search.go adds the second read this module can do: a JQL search returning a
// LIST of issues, next to jira.go's single-issue view. It feeds the two
// issue sections of the PR overview ("Planning" and "Todo", see
// .claude/docs/pr-overview.md) through the read-only GET /api/jira/issues.
//
// The JQL is always a constant owned by the caller (jira_issues.go), never
// anything a reviewer typed — it still reaches exec.CommandContext as one
// argv entry (never a shell string), and the limit is clamped below.

// searchLimitMax bounds one search, so a runaway JQL can never turn into a
// multi-page acli crawl inside an HTTP request.
const searchLimitMax = 100

// acliSearchIssue is the subset of `acli jira workitem search --json` this
// module reads: a bare JSON array of issue objects, each with the same
// `fields` envelope the single-issue view uses.
type acliSearchIssue struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  struct {
			Name string `json:"name"`
		} `json:"status"`
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
		// assignee is null for an unassigned issue (verified live), so it is a
		// pointer: absent must read as "nobody", never as an empty-named person.
		Assignee *acliUser `json:"assignee"`
	} `json:"fields"`
}

// Search runs jql via `acli jira workitem search` and returns the matching
// issues, most recent first (the ordering is the caller's own ORDER BY).
// Description is deliberately not requested: these rows only ever show a
// title, and asking for it would pull a full ADF document per issue.
//
// `parent` is deliberately absent from --fields too, but for a different
// reason: acli rejects it ("field 'parent' is not allowed" — its --fields
// whitelist is roughly issuetype/key/assignee/priority/status/summary/
// description/labels and nothing else). A Sub-task's parent is therefore read
// per issue via Issue(), see groupPlanning in jira_issues.go.
func (m *Module) Search(ctx context.Context, jql string, limit int) ([]Issue, error) {
	jql = strings.TrimSpace(jql)
	if jql == "" {
		return nil, fmt.Errorf("jira: empty jql")
	}
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "search",
		"--jql", jql, "--fields", "key,summary,status,issuetype,assignee",
		"--limit", strconv.Itoa(limit), "--json")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("acli jira workitem search: %w: %s", err, msg)
		}
		return nil, fmt.Errorf("acli jira workitem search: %w", err)
	}
	return parseSearch(out)
}

// parseSearch turns one `acli jira workitem search --json` payload into Issues.
// An empty result set prints an empty array (or nothing at all when the CLI has
// no match to render), which is not an error.
func parseSearch(out []byte) ([]Issue, error) {
	if len(bytes.TrimSpace(out)) == 0 {
		return nil, nil
	}
	var parsed []acliSearchIssue
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("jira: parse search result: %w", err)
	}
	issues := make([]Issue, 0, len(parsed))
	for _, p := range parsed {
		if p.Key == "" {
			continue
		}
		is := Issue{
			Key:    p.Key,
			Title:  p.Fields.Summary,
			Status: p.Fields.Status.Name,
			Type:   p.Fields.IssueType.Name,
			URL:    baseURL + p.Key,
		}
		if a := p.Fields.Assignee; a != nil {
			is.Assignee = strings.TrimSpace(a.DisplayName)
			is.AssigneeAvatarURL = strings.TrimSpace(a.AvatarURLs.Small)
		}
		issues = append(issues, is)
	}
	return issues, nil
}

// issuesByKeyMax bounds one IssuesByKey lookup. A `key in (…)` search is one
// acli call whatever its length, but the JQL still has to stay a sane size, and
// no caller has more subtasks than this to enrich.
const issuesByKeyMax = 50

// IssuesByKey reads a known SET of issues in one search — the cheap way to
// learn something Jira does not include in a parent/subtasks link, today the
// ASSIGNEE (see IssueRef). Only issues that really exist come back, in Jira's
// own order, so a caller matches them up by Key rather than by position.
//
// The JQL is built here rather than by the caller precisely because it is the
// one query in this module that is not a constant: every key is validated
// against keyPattern first (the same gate Issue() uses), so nothing but
// `PROJ-123` shapes can ever reach the argv entry — an invalid key is skipped,
// never passed on. Zero usable keys is not an error: it yields no issues and
// makes no call at all.
func (m *Module) IssuesByKey(ctx context.Context, keys []string) ([]Issue, error) {
	var safe []string
	seen := map[string]bool{}
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] || !keyPattern.MatchString(k) {
			continue
		}
		seen[k] = true
		safe = append(safe, k)
		if len(safe) == issuesByKeyMax {
			break
		}
	}
	if len(safe) == 0 {
		return nil, nil
	}
	return m.Search(ctx, "key in ("+strings.Join(safe, ",")+")", len(safe))
}
