// plan_branches.go — GET /api/branches, the read-only branch list behind the
// plan page's hotfix question.
//
// The hotfix question's third choice is "another branch entirely", shown as a
// dropdown with a search field and the reviewer's OWN branches on top
// (reviewer request: "3e keuze moet een drop down zijn waarbij eigen branches
// bovenaan staan, met search input"). This endpoint is what fills it.
//
// Read-only, so it needs no workflow (.claude/rules/workflows-write-boundary.md):
// it runs one `git for-each-ref` in the primary repo's own local clone — the
// same clone gh.go already reads and fetches into — and writes nothing. The
// search itself happens in the browser: the whole list is small enough
// (bounded at maxBranchList) to filter client-side, which keeps the field
// instant and costs no round trip per keystroke.
//
// See .claude/docs/plan-page.md.
package main

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"
)

// maxBranchList bounds the answer: a big repo has thousands of stale remote
// branches, and a dropdown is not a place to render them all. Newest first, so
// the cut always falls on the ones nobody is working on.
const maxBranchList = 300

// branchListTimeout bounds the git read, so a slow/locked clone answers with
// an empty list instead of holding the request open (the same "bound every
// subprocess yourself" rule modules/jira states in full).
const branchListTimeout = 20 * time.Second

// branchView is one branch as the dropdown shows it.
type branchView struct {
	Name string `json:"name"`
	// Own is true when the branch's last commit is the reviewer's own — those
	// sort to the top of the list.
	Own bool `json:"own,omitempty"`
	// Updated is git's own relative date ("3 days ago"), a word rather than a
	// colour, per the colourblind rule.
	Updated string `json:"updated,omitempty"`
}

// handleBranches serves GET /api/branches — the primary repo's remote branches,
// the reviewer's own first, newest first within each group.
func (s *server) handleBranches(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), branchListTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "branches": listRepoBranches(ctx)})
}

// listRepoBranches reads the remote-tracking branches of the primary repo's
// local clone. A failure yields an empty list, never an error: the dropdown
// then simply has nothing to offer while the two named choices still work.
func listRepoBranches(ctx context.Context) []branchView {
	out := []branchView{}
	raw, err := runGitFor(ctx, "", "for-each-ref", "--sort=-committerdate",
		"--format=%(refname:short)%09%(authoremail)%09%(committerdate:relative)",
		"refs/remotes/origin")
	if err != nil {
		return out
	}
	return parseBranchRefs(string(raw), gitUserEmail(ctx))
}

// parseBranchRefs turns `git for-each-ref`'s own output into the dropdown's
// list — pure, so the ordering rule ("my branches first, newest first within
// each group") is testable without a repo.
func parseBranchRefs(raw, me string) []branchView {
	out := []branchView{}
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.Split(strings.TrimSpace(line), "\t")
		if len(parts) < 1 || parts[0] == "" {
			continue
		}
		name := strings.TrimPrefix(parts[0], "origin/")
		// origin/HEAD is a symbolic alias for the default branch, not a branch
		// of its own, and a name git would not accept back as a ref argument.
		if name == "" || name == "HEAD" || !planBranchRefPattern.MatchString(name) {
			continue
		}
		b := branchView{Name: name}
		if len(parts) > 1 {
			b.Own = me != "" && strings.EqualFold(strings.Trim(parts[1], "<>"), me)
		}
		if len(parts) > 2 {
			b.Updated = parts[2]
		}
		out = append(out, b)
	}
	// Own branches first, order within each group untouched (git already
	// sorted by commit date), so the list stays newest-first per group.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Own && !out[j].Own })
	if len(out) > maxBranchList {
		out = out[:maxBranchList]
	}
	return out
}

// gitUserEmail is who "own" means: the identity this clone commits under.
// Empty when git has none configured, which simply means no branch is marked
// as the reviewer's own.
func gitUserEmail(ctx context.Context) string {
	out, err := runGitFor(ctx, "", "config", "user.email")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
