package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// Per-PR file filter ("all" | "backend" | "frontend"): the review-tree index
// hides the files outside the chosen side, and those hidden ("ignored") blocks
// COUNT AS DONE in every progress bar (review-tree bottom bar, /pr-overview
// ring) — shown in a different fill so they stay distinguishable.
//
// Source of truth: <appDataDir>/file-filters.json ({"<statusKey>":"backend"},
// "all" is never stored). The read (GET /api/filefilters) is a pure read; the
// write goes through the app_settings tracker (Kind "fileFilter") whose
// Activity "saveFileFilter" calls setFileFilterFile — the only writer.

var frontendFileRe = regexp.MustCompile(`(?i)\.(vue|[cm]?[jt]sx?)$`)

// phpFileRe: "frontend" hides ONLY PHP files (reviewer decision) and keeps
// everything else visible — vue/js/ts, but also markdown, config, images and a
// submodule pointer. "backend" still hides only the vue/js/ts family.
var phpFileRe = regexp.MustCompile(`(?i)\.php$`)

// fileFilterIgnores reports whether file is hidden (ignored) under mode.
// Keep in sync with FRONTEND_FILE_RE/PHP_FILE_RE in src/home.mjs.
func fileFilterIgnores(mode, file string) bool {
	switch mode {
	case "backend":
		return frontendFileRe.MatchString(file)
	case "frontend":
		return phpFileRe.MatchString(file)
	}
	return false
}

func validFileFilterMode(m string) bool { return m == "all" || m == "backend" || m == "frontend" }

var (
	fileFiltersMu sync.RWMutex
	fileFilters   = map[string]string{}
)

func fileFilterFor(repo string, pr int) string {
	fileFiltersMu.RLock()
	defer fileFiltersMu.RUnlock()
	if m := fileFilters[statusKey(repo, pr)]; m != "" {
		return m
	}
	return "all"
}

func fileFiltersPath(dir string) string { return filepath.Join(dir, "file-filters.json") }

func loadFileFiltersFile(dir string) {
	m := map[string]string{}
	if raw, err := os.ReadFile(fileFiltersPath(dir)); err == nil {
		_ = json.Unmarshal(raw, &m)
	}
	fileFiltersMu.Lock()
	fileFilters = m
	fileFiltersMu.Unlock()
}

// setFileFilterFile stores one PR's mode (key is normalised through
// parseStatusKey so "name#n" and "owner/name#n" land on the same entry).
func setFileFilterFile(dir, key, mode string) error {
	repo, n := parseStatusKey(key)
	if n == 0 || !validFileFilterMode(mode) {
		return fmt.Errorf("filefilter: invalid key/mode %q/%q", key, mode)
	}
	k := statusKey(repo, n)
	fileFiltersMu.Lock()
	defer fileFiltersMu.Unlock()
	next := map[string]string{}
	for kk, v := range fileFilters {
		next[kk] = v
	}
	if mode == "all" {
		delete(next, k)
	} else {
		next[k] = mode
	}
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	tmp := fileFiltersPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("filefilter: write temp file: %w", err)
	}
	if err := os.Rename(tmp, fileFiltersPath(dir)); err != nil {
		return fmt.Errorf("filefilter: rename temp file: %w", err)
	}
	fileFilters = next
	return nil
}

// approvalRollup sums changed rows over blocks: an ignored block's rows count as
// both done and ignored; any other block contributes its approved rows (clamped).
func approvalRollup(mode string, files []string, rows, approved []int) (done, total, ignored int) {
	for i := range files {
		total += rows[i]
		if fileFilterIgnores(mode, files[i]) {
			done += rows[i]
			ignored += rows[i]
			continue
		}
		d := approved[i]
		if d > rows[i] {
			d = rows[i]
		}
		if d > 0 {
			done += d
		}
	}
	return
}

// handleFileFilters serves GET /api/filefilters → {"ok":true,"filters":{key:mode}}.
func (s *server) handleFileFilters(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	fileFiltersMu.RLock()
	out := make(map[string]string, len(fileFilters))
	for k, v := range fileFilters {
		out[k] = v
	}
	fileFiltersMu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "filters": out})
}
