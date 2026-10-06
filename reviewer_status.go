package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"slash/modules/github"
)

// countsAsReviewer reports whether login already shows up in a PR's Reviewers
// sidebar on GitHub (or is its author, where the question is moot): a personal
// or team review request, or any submitted review. Only when this is false does
// an inline comment (which GitHub turns into a COMMENTED review) newly put
// login on the PR as a reviewer — the case the review tree asks about first,
// see "Placing an inline comment on a PR you don't review" in
// .claude/docs/comments-panel.md.
func countsAsReviewer(f github.ReviewerFacts, login string) bool {
	return strings.EqualFold(f.Author, login) || f.Requested || f.Reviewed
}

// ReviewerStatus answers, live from GitHub, whether the local user already
// counts as a reviewer on pr (countsAsReviewer). known=false when that cannot
// be established (offline, SLASH_GITHUB=off, unknown login, a failed call) —
// the caller then simply doesn't ask. Read-only: nothing is stored.
func (m *TaskManager) ReviewerStatus(ctx context.Context, repo string, pr int) (known, reviewer bool) {
	if m.gh == nil {
		return false, false
	}
	me, err := m.CurrentUser(ctx)
	if err != nil || me.Login == "" {
		return false, false
	}
	facts, err := m.ghFor(repo).ReviewerFacts(ctx, pr, me.Login)
	if err != nil {
		return false, false
	}
	return true, countsAsReviewer(facts, me.Login)
}

// handleReviewerStatus serves GET /api/reviewer-status?pr=N[&repo=…] →
// {"ok":true,"reviewer":bool}, or {"ok":false} when it cannot be established.
// Read-only (a live GitHub read, no state), so it sits outside the
// workflows-only write boundary. Always 200 on a valid request, mirroring
// handleMe.
func (s *server) handleReviewerStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pr, err := strconv.Atoi(r.URL.Query().Get("pr"))
	if err != nil || pr <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	known, reviewer := s.tasks.manager.ReviewerStatus(r.Context(), queryRepo(r), pr)
	if !known {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reviewer": reviewer})
}
