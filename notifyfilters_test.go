package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestNotificationFilteredOutMatchesCaseInsensitiveSubstring pins the whole
// matching rule the reviewer types against: "contains", case-insensitive,
// against the notification's own title line.
func TestNotificationFilteredOutMatchesCaseInsensitiveSubstring(t *testing.T) {
	filters := []string{"assigned a work item to you", "assigned a story to you"}
	cases := []struct {
		title string
		want  bool
	}{
		{"Robin Landweer assigned a work item to you", true},
		{"Robin Landweer assigned a story to you", true},
		{"Robin Landweer ASSIGNED A WORK ITEM TO YOU", true},
		{"Robin Landweer mentioned you on PROD-254", false},
		{"Robin Landweer commented on your work item", false},
		{"", false},
	}
	for _, c := range cases {
		if got := notificationFilteredOut(c.title, filters); got != c.want {
			t.Errorf("notificationFilteredOut(%q) = %v, want %v", c.title, got, c.want)
		}
	}
	// No filters at all hides nothing — the "I removed every text" state.
	if notificationFilteredOut("Robin Landweer assigned a story to you", nil) {
		t.Error("an empty filter list must hide nothing")
	}
	if notificationFilteredOut("Robin Landweer assigned a story to you", []string{}) {
		t.Error("an empty filter list must hide nothing")
	}
}

// TestNotifyFiltersDefaultsWithoutAFile checks the out-of-the-box behaviour:
// the two texts the reviewer named are the DEFAULT list, so the bell is quiet
// before he ever opens the settings page.
func TestNotifyFiltersDefaultsWithoutAFile(t *testing.T) {
	dir := t.TempDir()
	got := notifyFilters(dir)
	if len(got) != 2 || got[0] != "assigned a work item to you" || got[1] != "assigned a story to you" {
		t.Fatalf("defaults = %q", got)
	}
}

// TestSaveNotifyFiltersTakesEffectImmediately is the write path's own
// requirement: the very next read must see the new list, without a restart.
func TestSaveNotifyFiltersTakesEffectImmediately(t *testing.T) {
	dir := t.TempDir()
	if _, err := saveNotifyFiltersFile(dir, []string{"  Assigned A Story To You ", "", "watched"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	got := notifyFilters(dir)
	if len(got) != 2 || got[0] != "assigned a story to you" || got[1] != "watched" {
		t.Fatalf("after save = %q, want normalized [assigned a story to you watched]", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "notify-filters.json")); err != nil {
		t.Fatalf("file not written: %v", err)
	}
}

// TestSaveNotifyFiltersEmptyIsPreserved is the deliberate DIFFERENCE from
// praise-words: removing the last filter text must persist as "hide nothing",
// not silently fall back to the built-in defaults — otherwise a reviewer could
// never get his filtered notifications back.
func TestSaveNotifyFiltersEmptyIsPreserved(t *testing.T) {
	dir := t.TempDir()
	if _, err := saveNotifyFiltersFile(dir, []string{}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := notifyFilters(dir); len(got) != 0 {
		t.Fatalf("after clearing = %q, want an empty list", got)
	}
	// And it survives a fresh read from disk (a restart), i.e. the empty array
	// really is on disk rather than only in the cache.
	if got := loadNotifyFiltersFile(filepath.Join(dir, "notify-filters.json")); len(got) != 0 {
		t.Fatalf("reloaded from disk = %q, want an empty list", got)
	}
}
