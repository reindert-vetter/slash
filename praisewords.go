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

// praisewords.go serves the list of "meaningless praise" words that the review
// clipboard summary uses to decide a comment is NOT an open point. A reviewer
// who leaves "Nice" under a diff has not left work behind, so counting it in
// "<pr-url> ✅ met N comments" overstates what the PR author has to look at.
// The matching itself lives in the frontend (isPraiseComment, src/home.mjs),
// which is where the count is computed; this file only answers "which words".
//
// One source, exactly the names.json pattern (see usernames.go):
//
//	<dataDir>/praise-words.json — a hand-maintained JSON array of strings,
//	e.g. ["nice","goed","lekker","top"]. Missing or unparsable → the built-in
//	defaults below, never an error: a hand-edited local file must not be able
//	to break the review flow.
//
// Deliberately NOT shipped in the repo (unlike data/names.json, which is a
// team-wide list): this file is one reviewer's personal vocabulary, and without
// it the defaults already cover the words that prompted it.
//
// WRITE BOUNDARY: the READ side (praiseWords/loadPraiseWordsFile/
// handlePraiseWords) is a pure read plus a process-lifetime, in-memory cache —
// nothing durable is written there, so it is allowed outside a workflow. Same
// operational carve-out as /api/names and /api/me; see
// .claude/rules/workflows-write-boundary.md.
//
// Unlike settings.json's "me" block, the FULL list here is genuinely editable
// from the settings page (.claude/docs/settings-page.md) — there is no
// GitHub-derived field to defer to. The write goes through the sanctioned
// path: the app_settings tracker Workflow (workflows.go,
// WorkflowAppSettings/SignalAppSettings) runs the "savePraiseWords" Activity,
// which calls savePraiseWordsFile below — the only writer of
// praise-words.json. Same two requirements as settings.json's write path: an
// atomic write (temp file + rename) so a hand edit never finds a half-written
// file, and an immediate praiseByDir cache update in the same locked section
// as the disk write, so the very next GET /api/praisewords already reflects
// the change instead of requiring a restart.

// defaultPraiseWords is the built-in list, used whenever there is no readable
// override file. Lowercase, because matching is case-insensitive.
var defaultPraiseWords = []string{"nice", "goed", "lekker"}

// praiseWords returns the effective word list for one data dir, reading
// <dataDir>/praise-words.json once (so editing it takes a restart, like
// names.json). Cached per dataDir rather than once per process so a test can
// point at its own temp dir.
func praiseWords(dataDir string) []string {
	praiseMu.Lock()
	defer praiseMu.Unlock()
	if w, ok := praiseByDir[dataDir]; ok {
		return w
	}
	w := loadPraiseWordsFile(filepath.Join(dataDir, "praise-words.json"))
	praiseByDir[dataDir] = w
	return w
}

var (
	praiseMu    sync.Mutex
	praiseByDir = map[string][]string{}
)

// loadPraiseWordsFile parses a JSON array of words and normalizes it: trimmed,
// lowercased, empties dropped. Anything that goes wrong — no file, bad JSON, an
// array that normalizes to nothing — yields the defaults, so the caller never
// has to handle an error or an empty list. Split out from the cached wrapper so
// it is directly testable.
func loadPraiseWordsFile(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return defaultPraiseWords
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return defaultPraiseWords
	}
	out := normalizePraiseWordList(list)
	if len(out) == 0 {
		return defaultPraiseWords
	}
	return out
}

// normalizePraiseWordList trims, lowercases and drops empties — shared by the
// read path (loadPraiseWordsFile) and the write path (savePraiseWordsFile) so
// both apply exactly the same rule. Deliberately no dedup (unlike aliases): a
// duplicate word is harmless and dedup would silently reorder a
// hand-maintained list, which the read path's own long-standing behaviour
// never did either.
func normalizePraiseWordList(list []string) []string {
	out := []string{}
	for _, w := range list {
		if w = strings.ToLower(strings.TrimSpace(w)); w != "" {
			out = append(out, w)
		}
	}
	return out
}

// savePraiseWordsFile persists a new word list to dataDir's praise-words.json,
// replacing the file wholesale (unlike settings.json there is no OTHER field
// to preserve — the whole file is this one list). Called only from the
// "savePraiseWords" workflow Activity (workflows.go), never directly, per the
// write-boundary rule. words must already be non-empty after normalization —
// enforced by the HTTP handler (tasks_api.go) before the Signal is even sent,
// so an accidental "clear everything" can never silently fall back to the
// built-in defaults without the reviewer seeing why. Returns the normalized
// list (already updated in the in-memory cache).
func savePraiseWordsFile(dataDir string, words []string) ([]string, error) {
	praiseMu.Lock()
	defer praiseMu.Unlock()
	norm := normalizePraiseWordList(words)
	if len(norm) == 0 {
		norm = defaultPraiseWords
	}
	path := filepath.Join(dataDir, "praise-words.json")
	raw, err := json.MarshalIndent(norm, "", "  ")
	if err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return nil, fmt.Errorf("praisewords: write temp file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, fmt.Errorf("praisewords: rename temp file: %w", err)
	}
	praiseByDir[dataDir] = norm
	return norm, nil
}

// handlePraiseWords serves GET /api/praisewords → {"ok":true,"words":[…]}.
// Read-only, always 200 (see loadPraiseWordsFile: there is no failure mode a
// caller could act on), same contract as handleMe/handleNames.
func (s *server) handlePraiseWords(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "words": praiseWords(s.dataDir)})
}
