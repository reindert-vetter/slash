package main

import (
	"net/http"

	"slash/modules/claude"
)

// handleClaudeUsage returns the latest 5-hour Claude session-budget reading
// (modules/claude/usage.go): what the CLI's rate_limit_event frame reported on
// the most recent Claude call slash made. Read-only, no input, and purely
// in-memory (lost on a restart) — the same operational carve-out as
// /api/chat/progress, see .claude/rules/workflows-write-boundary.md. No
// reading yet answers {ok:false} with a 200.
func (s *server) handleClaudeUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	u, ok := claude.LastSessionUsage()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"utilization": u.Utilization,
		"resetsAt":    u.ResetsAt.Unix(),
		"seenAt":      u.SeenAt.Unix(),
	})
}
