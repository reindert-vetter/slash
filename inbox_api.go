package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// inbox_api.go wires the read-only inbox endpoints:
//   GET /api/inbox               — sectioned live PR list (light rows)
//   GET /api/inbox/status?prs=…  — heavy status backfill for those PRs
//   GET /api/prs/search?q=…      — PRs matching a query (full rows): open ones
//                                  first, closed/merged ones ranked below them
// All three are read-only. Under SLASH_GITHUB=off they serve the SLASH_INBOX
// fixture so tests never touch the network.

// overlayGraph marks each row hasGraph=true when the PR has blocks in the DB.
// Keyed by (repo, number), so a PR 12 in another repo is not credited with the
// primary repo's PR 12 tree.
func overlayGraph(db *sql.DB, rows []inboxRow) {
	ingested, err := ingestedSet(db)
	if err != nil {
		return
	}
	for i := range rows {
		rows[i].HasGraph = ingested[prKey{canonRepo(rows[i].Repo), rows[i].Number}]
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
		// The configured repos, so the client can tell a row from a repo it can
		// actually open a review tree for from a row of a repo that is only
		// still present in a stored snapshot (see treeSupported in
		// src/overview.mjs). The primary repo is listed as "" — the canonical
		// internal form every row uses.
		"repos": configuredRepoList(),
	})
}

// handleInboxStatus serves GET /api/inbox/status?prs=12,13 — the per-PR pills,
// read from the same read-model snapshot (no GitHub call).
func (s *server) handleInboxStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A `prs=` entry is either a bare number (the primary repo, the historical
	// form) or "<owner/name>#<number>" for a PR in another repo — the same
	// statusKey shape the snapshot is keyed by, so the client can echo back
	// exactly the keys it wants (see statusKeysOf in src/overview.mjs).
	wanted := parseStatusKeyList(r.URL.Query().Get("prs"))
	out := map[string]prStatus{}
	if len(wanted) == 0 {
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
			for _, k := range wanted {
				key := statusKey(k.Repo, k.PR)
				if st, has := all[key]; has {
					out[key] = st
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
					strings.Contains(strconv.Itoa(row.Number), q) ||
					strings.Contains(strings.ToLower(row.Author), needle) {
					rows = append(rows, row)
				}
			}
		}
		overlayGraph(s.db, rows)
		// A fixture row carries no state, so every row ranks as open here —
		// the sort still applies the own-vs-someone-else half.
		sortSearchRows(rows, ghLogin(r.Context()))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
		return
	}

	if s.tasks != nil {
		ensureCollaboratorsLoaded(r.Context(), s.tasks.manager)
	}

	term := q
	if isAllDigits(q) {
		term = q + " in:title"
	}
	// A bare number resolves to that exact PR first, in whatever state it is —
	// GitHub search has no `number:` qualifier, so this is the only way to find
	// a PR BY its number (see pullRequestByNumber). Kept alongside the text
	// search below, because a number can also be a genuine title match.
	var rows []inboxRow
	if isAllDigits(q) {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			rows = append(rows, pullRequestByNumber(r.Context(), n)...)
		}
	}
	// Scope to open PRs of the repo (repo: + sort are added by searchPRs).
	openRows, err := searchPRs(r.Context(), "is:pr is:open archived:false "+term, false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false})
		return
	}
	rows = append(rows, openRows...)
	// GitHub's own free-text PR search matches title/body/comments, never the
	// author's real name — so also search by AUTHOR NAME via every collaborator
	// login whose login or resolved name matches q, merged in and deduped.
	// Deliberately OPEN-only: running the same loop against is:closed would
	// double up to matchingLoginsCap extra gh calls per keystroke for little
	// gain, and a closed PR is still findable by title/number/author-login.
	for _, login := range matchingLogins(s.dataDir, q) {
		extra, err := searchPRs(r.Context(), "is:pr is:open archived:false author:"+login, false)
		if err == nil {
			rows = append(rows, extra...)
		}
	}
	// Closed PRs are searched too, but land BELOW every open hit (sortSearchRows).
	// `is:closed` covers merged and plain-closed alike. A failure here is not
	// fatal: the open results are still worth serving.
	if closed, err := searchPRs(r.Context(), "is:pr is:closed archived:false "+term, false); err == nil {
		rows = append(rows, closed...)
	}
	rows = dedupeRowsByNumber(rows)
	overlayGraph(s.db, rows)
	sortSearchRows(rows, ghLogin(r.Context()))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prs": rows})
}

// searchRank orders a search result: the reviewer's own open PRs first, then
// everyone else's open ones, then the same split for closed/merged PRs. The
// reviewer asked for closed PRs and other people's PRs to be findable "wel in
// een lagere volgorde" — this is that ordering, and it is the ONLY thing that
// separates the four groups now that the search view renders one flat,
// heading-less list.
//
// An unknown login (offline, or `gh` not authenticated) collapses ranks 0/1
// and 2/3 into each other, leaving the open-before-closed half intact.
func searchRank(row inboxRow, login string) int {
	rank := 0
	if row.State != "" && row.State != "OPEN" {
		rank += 2
	}
	if login == "" || row.Author != login {
		rank++
	}
	return rank
}

// sortSearchRows sorts rows in place by searchRank, STABLY — so gh's own
// `sort:updated-desc` ordering survives inside each rank.
func sortSearchRows(rows []inboxRow, login string) {
	sort.SliceStable(rows, func(i, j int) bool {
		return searchRank(rows[i], login) < searchRank(rows[j], login)
	})
}

// dedupeRowsByNumber drops later duplicates of a PR, keeping the first
// occurrence's ordering — used when merging the title/number text-search rows
// with the extra author-name matches (the same PR can appear in both). Keyed by
// repo AND number: two repos can each have a PR 12.
func dedupeRowsByNumber(rows []inboxRow) []inboxRow {
	seen := map[string]bool{}
	out := make([]inboxRow, 0, len(rows))
	for _, row := range rows {
		k := rowKey(row)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, row)
	}
	return out
}

// configuredRepoList is the canonical repo string of every configured repo: ""
// for the primary one, the slug for the others (see repos.go).
func configuredRepoList() []string {
	all := allRepos()
	out := make([]string, 0, len(all))
	for _, r := range all {
		if r.Primary {
			out = append(out, "")
			continue
		}
		out = append(out, r.Slug)
	}
	return out
}

// parseStatusKeyList parses a `prs=` list of statusKey values ("13000",
// "plug-and-pay/plug-and-pay-ops#12") into a bounded slice of prKeys, dropping
// anything unparsable. Mirrors parsePRList's cap.
func parseStatusKeyList(csv string) []prKey {
	var out []prKey
	for _, part := range strings.Split(csv, ",") {
		repo, n := parseStatusKey(part)
		if n <= 0 {
			continue
		}
		out = append(out, prKey{repo, n})
		if len(out) >= 100 { // same cap as parsePRList below
			break
		}
	}
	return out
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
