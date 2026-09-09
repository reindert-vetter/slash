package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// notifyfilters.go owns the reviewer's own "hide this kind of Jira
// notification" list — the noise filter behind the header bell on
// /pr-overview (see .claude/docs/pr-overview.md).
//
// Reviewer request: "filter notificaties weg met: assigned a work item to you.
// en assigned a story to you" followed by "maak daar een instelling van in de
// instellingen pagina" and "met een list die je kan aanvullen". So the two
// texts are not hardcoded behaviour but the first two entries of a list the
// reviewer manages himself on /settings, exactly like the praise-word list.
//
// One source, the praise-words.json pattern (see praisewords.go):
//
//	<dataDir>/notify-filters.json — a JSON array of strings, e.g.
//	["assigned a work item to you", "assigned a story to you"]. Missing or
//	unparsable → the built-in defaults below, never an error: a hand-edited
//	local file must not be able to break the bell.
//
// UNLIKE praise-words.json, an explicitly stored EMPTY array is a real,
// preserved state and means "filter nothing" — only a MISSING/unparsable file
// falls back to the defaults. A reviewer who removes every filter text wants
// every notification back, and silently reinstating the defaults would make
// that impossible; a praise-word list, by contrast, has no meaningful empty
// state (see savePraiseWordsFile's own note).
//
// MATCHING (notificationFilteredOut): case-insensitive "contains" against the
// notification's own TITLE — the "Robin Landweer assigned a work item to you"
// line — so "assigned a work item to you" hides every actor's variant of it,
// OR against its ACTOR, the display name behind the row's avatar ("Automation
// for Jira"). Deliberately substring rather than a regex or a glob: the
// reviewer types plain notification text, not a pattern language, and nothing
// else in this app asks him to.
//
// The actor axis exists because a whole SENDER is a filter a reviewer really
// wants ("ik wil geen automation meldingen krijgen. dus niks van Automation"),
// and the title alone cannot express it reliably: Jira's own message sentence
// only sometimes opens with the actor's name, so "automation for jira" would
// hide some of that sender's notifications and not others. One list, one rule,
// two fields.
//
// Still deliberately NOT the issue summary or the comment preview: those are
// the CONTENT of the notification, and hiding a notification because the
// ticket it points at happens to contain a phrase would be surprising. The
// actor is not content — it is who sent it.
//
// WHERE the filter is applied is a deliberate choice too: at READ time, in
// handleJiraNotifications (tasks_api.go), never in the jira_inbox tracker's
// own refresh. The read-model keeps every notification, so REMOVING a filter
// text makes those rows visible again on the very next GET — a tracker-side
// drop would be unrecoverable. It is also the ONE place the whole bell derives
// from: src/overview.mjs computes the row list, the "N ongelezen" count and
// the bell's unread dot all from the same fetched array, so a hidden
// notification can never keep counting silently.
//
// WRITE BOUNDARY: the READ side (notifyFilters/loadNotifyFiltersFile/
// handleNotifyFilters) is a pure read plus a process-lifetime, in-memory
// cache — nothing durable is written there, so it is allowed outside a
// workflow, the same operational carve-out as /api/praisewords. The WRITE goes
// through the sanctioned path: the app_settings tracker Workflow
// (workflows.go, WorkflowAppSettings/SignalAppSettings, Kind "notifyFilters")
// runs the "saveNotifyFilters" Activity, which calls saveNotifyFiltersFile
// below — the only writer of notify-filters.json.

// defaultNotifyFilters is the built-in list, used whenever there is no
// readable override file: the texts the reviewer named when asking for this.
// Lowercase, because matching is case-insensitive anyway.
//
// "automation for jira" is the third one and matches on the ACTOR axis (see
// MATCHING above): a Jira automation rule flipping a work item's status is
// never addressed at a person, so the bell is quiet about it out of the box.
// Like the other two it is an ordinary, REMOVABLE entry, not hardcoded
// behaviour — a reviewer who does want to see his automation rules firing
// deletes it on /settings. Note that an existing notify-filters.json is NOT
// migrated: a reviewer who already curated his own list keeps exactly the list
// he curated, and adds this text himself if he wants it.
var defaultNotifyFilters = []string{"assigned a work item to you", "assigned a story to you", "automation for jira"}

// notifyFilters returns the effective filter list for one data dir, reading
// <dataDir>/notify-filters.json once (so a hand edit takes a restart, like
// praise-words.json — a write through the settings page updates the cache
// immediately, see saveNotifyFiltersFile). Cached per dataDir rather than once
// per process so a test can point at its own temp dir.
func notifyFilters(dataDir string) []string {
	notifyFilterMu.Lock()
	defer notifyFilterMu.Unlock()
	if f, ok := notifyFilterByDir[dataDir]; ok {
		return f
	}
	f := loadNotifyFiltersFile(filepath.Join(dataDir, "notify-filters.json"))
	notifyFilterByDir[dataDir] = f
	return f
}

var (
	notifyFilterMu    sync.Mutex
	notifyFilterByDir = map[string][]string{}
)

// loadNotifyFiltersFile parses a JSON array of texts and normalizes it. No
// file or bad JSON yields the defaults; a well-formed but EMPTY array is
// honoured as "filter nothing" (see the file header).
func loadNotifyFiltersFile(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return defaultNotifyFilters
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return defaultNotifyFilters
	}
	return normalizeNotifyFilterList(list)
}

// normalizeNotifyFilterList trims, lowercases and drops empties — shared by
// the read and the write path so both apply exactly the same rule. Lowercased
// because notificationFilteredOut compares case-insensitively; keeping the
// original casing would only make the stored file look like it mattered.
// Deliberately no dedup, same reasoning as normalizePraiseWordList.
func normalizeNotifyFilterList(list []string) []string {
	out := []string{}
	for _, f := range list {
		if f = strings.ToLower(strings.TrimSpace(f)); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// notificationFilteredOut answers "should this notification be hidden?" — the
// whole matching rule, in one testable function: case-insensitive substring of
// the notification's title OR of its actor (the sender's display name). An
// empty filter list hides nothing.
func notificationFilteredOut(title, actor string, filters []string) bool {
	if len(filters) == 0 {
		return false
	}
	lowerTitle, lowerActor := strings.ToLower(title), strings.ToLower(actor)
	for _, f := range filters {
		if f == "" {
			continue
		}
		f = strings.ToLower(f)
		if strings.Contains(lowerTitle, f) {
			return true
		}
		if lowerActor != "" && strings.Contains(lowerActor, f) {
			return true
		}
	}
	return false
}

// saveNotifyFiltersFile persists a new filter list to dataDir's
// notify-filters.json, replacing the file wholesale (the whole file IS this
// one list). Called only from the "saveNotifyFilters" workflow Activity
// (workflows.go), never directly, per the write-boundary rule. An empty list
// is written as an empty array on purpose — that is the reviewer saying "show
// me everything again", and the read path preserves it. Returns the normalized
// list (already updated in the in-memory cache, so the very next
// GET /api/notifyfilters and the very next bell fetch already reflect it,
// without a restart).
func saveNotifyFiltersFile(dataDir string, filters []string) ([]string, error) {
	notifyFilterMu.Lock()
	defer notifyFilterMu.Unlock()
	norm := normalizeNotifyFilterList(filters)
	path := filepath.Join(dataDir, "notify-filters.json")
	raw, err := json.MarshalIndent(norm, "", "  ")
	if err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return nil, fmt.Errorf("notifyfilters: write temp file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, fmt.Errorf("notifyfilters: rename temp file: %w", err)
	}
	notifyFilterByDir[dataDir] = norm
	return norm, nil
}

// handleNotifyFilters serves GET /api/notifyfilters →
// {"ok":true,"filters":[…]}. Read-only, always 200, same contract as
// handlePraiseWords (there is no failure mode a caller could act on).
func (s *server) handleNotifyFilters(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "filters": notifyFilters(s.dataDir)})
}
