package main

import (
	"encoding/json"
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
// WRITE BOUNDARY: a pure read plus a process-lifetime, in-memory cache —
// nothing durable is written, so it is allowed outside a workflow. Same
// operational carve-out as /api/names and /api/me; see
// .claude/rules/workflows-write-boundary.md.

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
	out := []string{}
	for _, w := range list {
		if w = strings.ToLower(strings.TrimSpace(w)); w != "" {
			out = append(out, w)
		}
	}
	if len(out) == 0 {
		return defaultPraiseWords
	}
	return out
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
