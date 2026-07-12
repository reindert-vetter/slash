package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// inbox_api.go wires the read-only inbox endpoints:
//   GET /api/inbox               — sectioned live PR list (light rows)
//   GET /api/inbox/status?prs=…  — heavy status backfill for those PRs
//   GET /api/prs/search?q=…      — all open PRs matching a query (full rows)
// All three are read-only. Under SLASH_GITHUB=off they serve the SLASH_INBOX
// fixture so tests never touch the network.

// overlayGraph marks each row hasGraph=true when the PR has blocks in the DB.
func overlayGraph(db *sql.DB, rows []inboxRow) {
	ingested, err := ingestedSet(db)
	if err != nil {
		return
	}
	for i := range rows {
		rows[i].HasGraph = ingested[rows[i].Number]
	}
}

// handleInbox serves GET /api/inbox — read-only from the pr_inbox read-model
// (the workflow, not this handler, talks to GitHub). Includes the workflow's
// runId so the UI can send a "refresh" signal + heartbeat to it.
func (s *server) handleInbox(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	snap, err := s.tasks.inbox.Get(r.Context(), repoSlug)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if snap == nil {
		// No snapshot fetched yet — the client falls back to /data/inbox.json.
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	sections := snap.Sections
	if len(sections) == 0 {
		sections = json.RawMessage("[]")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "live": true, "repo": snap.Repo,
		"generatedFor": snap.GeneratedFor, "updatedAt": snap.UpdatedAt,
		"runId": s.tasks.manager.InboxRunID(), "sections": sections,
	})
}

// handleInboxStatus serves GET /api/inbox/status?prs=12,13 — the per-PR pills,
// read from the same read-model snapshot (no GitHub call).
func (s *server) handleInboxStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	numbers := parsePRList(r.URL.Query().Get("prs"))
	out := map[string]prStatus{}
	if len(numbers) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "statuses": out})
		return
	}
	snap, err := s.tasks.inbox.Get(r.Context(), repoSlug)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if snap != nil && len(snap.Statuses) > 0 {
		var all map[string]prStatus
		if err := json.Unmarshal(snap.Statuses, &all); err == nil {
			for _, n := range numbers {
				if st, has := all[strconv.Itoa(n)]; has {
					out[strconv.Itoa(n)] = st
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "statuses": out})
}

// handleSearch serves GET /api/prs/search?q=… — all open PRs matching a query.
func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 200 {
		q = q[:200]
	}
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": []inboxRow{}})
		return
	}

	if ghDisabled() {
		rows := []inboxRow{}
		if f, ok := loadFixture(); ok {
			needle := strings.ToLower(q)
			for _, row := range fixtureRows(f) {
				if strings.Contains(strings.ToLower(row.Title), needle) ||
					strings.Contains(strconv.Itoa(row.Number), q) {
					rows = append(rows, row)
				}
			}
		}
		overlayGraph(s.db, rows)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
		return
	}

	term := q
	if isAllDigits(q) {
		term = q + " in:title"
	}
	// Scope to open PRs of the repo (repo: + sort are added by searchPRs).
	rows, err := searchPRs(r.Context(), "is:pr is:open archived:false "+term, false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	overlayGraph(s.db, rows)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
}

// parsePRList parses "12,13,14" into a bounded slice of positive ints.
func parsePRList(csv string) []int {
	var out []int
	for _, part := range strings.Split(csv, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 {
			continue
		}
		out = append(out, n)
		if len(out) >= 100 {
			break
		}
	}
	return out
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
