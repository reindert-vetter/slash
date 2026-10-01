package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
)

// The "show whitespace lines" display setting: whether a blank/whitespace-only
// CHANGED diff row is a real, selectable, approvable row (default: yes) or diff
// noise that does not count (rowHasContent, blockstats.go / Block.mjs).
//
// Both sides must agree, because the approve total is computed here AND in the
// browser. The single source of truth is <appDataDir>/blank-rows.json
// ({"show":bool}); the browser reads it through GET /api/blankrows and the Go
// side keeps a process-wide copy in blankRowsShown.
//
// WRITE BOUNDARY: the read is a pure read (operational carve-out like
// /api/notifyfilters). The write goes through the app_settings tracker (Kind
// "blankRows") whose Activity "saveBlankRows" calls saveBlankRowsFile — the
// only writer of the file.

var blankRowsHidden atomic.Bool // zero value false => rows are shown (default)

func blankRowsShown() bool { return !blankRowsHidden.Load() }

func blankRowsPath(dir string) string { return filepath.Join(dir, "blank-rows.json") }

// loadBlankRowsFile applies the stored setting to the process; a missing or
// unreadable file means the default (shown).
func loadBlankRowsFile(dir string) {
	show := true
	if raw, err := os.ReadFile(blankRowsPath(dir)); err == nil {
		var v struct {
			Show *bool `json:"show"`
		}
		if json.Unmarshal(raw, &v) == nil && v.Show != nil {
			show = *v.Show
		}
	}
	blankRowsHidden.Store(!show)
}

func saveBlankRowsFile(dir string, show bool) error {
	raw, err := json.Marshal(map[string]bool{"show": show})
	if err != nil {
		return err
	}
	tmp := blankRowsPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("blankrows: write temp file: %w", err)
	}
	if err := os.Rename(tmp, blankRowsPath(dir)); err != nil {
		return fmt.Errorf("blankrows: rename temp file: %w", err)
	}
	blankRowsHidden.Store(!show)
	return nil
}

// handleBlankRows serves GET /api/blankrows → {"ok":true,"show":bool}.
func (s *server) handleBlankRows(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "show": blankRowsShown()})
}
