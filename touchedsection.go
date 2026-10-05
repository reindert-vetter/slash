package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
)

// The "Migrations & API changes" setting: whether /pr-overview has that
// section (touchedSectionTitle) at all. Default OFF. When off, nothing of the
// section is built or derived: buildInbox skips its candidate query (so no
// statuses, no touch summaries, no touch_ai runs), autoIngestOwnPRs never
// generates a review tree for its rows, and handleInbox drops it from an
// already stored snapshot so turning it off takes effect immediately.
//
// Source of truth: <appDataDir>/touched-section.json ({"show":bool}).
//
// WRITE BOUNDARY: the read is a pure read (same carve-out as /api/blankrows).
// The write goes through the app_settings tracker (Kind "touchedSection")
// whose Activity "saveTouchedSection" calls saveTouchedSectionFile — the only
// writer of the file.

var touchedSectionOn atomic.Bool // zero value false => section off (default)

func touchedSectionShown() bool { return touchedSectionOn.Load() }

func touchedSectionPath(dir string) string { return filepath.Join(dir, "touched-section.json") }

// loadTouchedSectionFile applies the stored setting to the process; a missing
// or unreadable file means the default (off).
func loadTouchedSectionFile(dir string) {
	show := false
	if raw, err := os.ReadFile(touchedSectionPath(dir)); err == nil {
		var v struct {
			Show *bool `json:"show"`
		}
		if json.Unmarshal(raw, &v) == nil && v.Show != nil {
			show = *v.Show
		}
	}
	touchedSectionOn.Store(show)
}

func saveTouchedSectionFile(dir string, show bool) error {
	raw, err := json.Marshal(map[string]bool{"show": show})
	if err != nil {
		return err
	}
	tmp := touchedSectionPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return fmt.Errorf("touchedsection: write temp file: %w", err)
	}
	if err := os.Rename(tmp, touchedSectionPath(dir)); err != nil {
		return fmt.Errorf("touchedsection: rename temp file: %w", err)
	}
	touchedSectionOn.Store(show)
	return nil
}

// withoutTouchedSection returns sections minus the touchedSectionTitle one.
func withoutTouchedSection(sections []inboxSection) []inboxSection {
	out := make([]inboxSection, 0, len(sections))
	for _, s := range sections {
		if s.Title != touchedSectionTitle {
			out = append(out, s)
		}
	}
	return out
}

// filterTouchedSectionRaw drops the touchedSectionTitle section from a stored
// snapshot's raw sections JSON. On a decode error the input is returned as is.
func filterTouchedSectionRaw(raw json.RawMessage) json.RawMessage {
	var secs []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &secs); err != nil {
		return raw
	}
	kept := make([]map[string]json.RawMessage, 0, len(secs))
	for _, s := range secs {
		var title string
		_ = json.Unmarshal(s["title"], &title)
		if title != touchedSectionTitle {
			kept = append(kept, s)
		}
	}
	out, err := json.Marshal(kept)
	if err != nil {
		return raw
	}
	return out
}

// handleTouchedSection serves GET /api/touchedsection → {"ok":true,"show":bool}.
func (s *server) handleTouchedSection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "show": touchedSectionShown()})
}
