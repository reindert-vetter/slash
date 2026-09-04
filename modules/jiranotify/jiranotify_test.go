package jiranotify

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func openTest(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "jiranotify.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// The whole point of the local read_at column: once the reviewer opened a
// notification here, a later poll that still reports it unread in Jira must not
// resurrect it.
func TestMarkReadSurvivesTheNextRefresh(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	item := Item{ID: "n1", At: "2026-09-03T10:00:00Z", Title: "commented", URL: "https://x/browse/A-1", Unread: true}
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := m.MarkRead(ctx, "n1", "2026-09-03T11:00:00Z"); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	// The feed keeps calling it unread — it was never marked read in Jira.
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	list, err := m.List(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 row, got %d", len(list))
	}
	if list[0].Unread {
		t.Error("a notification opened here must stay read across refreshes")
	}
}

// Retention: anything older than the cutoff goes, everything newer stays.
func TestPurgeDropsOnlyOldRows(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	if err := m.Upsert(ctx, []Item{
		{ID: "old", At: now.Add(-40 * 24 * time.Hour).Format(time.RFC3339), URL: "u", Unread: true},
		{ID: "new", At: now.Add(-2 * 24 * time.Hour).Format(time.RFC3339), URL: "u", Unread: true},
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	n, err := m.Purge(ctx, now.Add(-30*24*time.Hour))
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n != 1 {
		t.Fatalf("want 1 purged row, got %d", n)
	}
	list, _ := m.List(ctx, 10)
	if len(list) != 1 || list[0].ID != "new" {
		t.Fatalf("want only the recent row left, got %+v", list)
	}
}
