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

// TestMarkAllReadMarksEveryUnreadRow pins the "Alles gelezen maken" bulk
// action: every row still unread here (read_at == '') gets the given
// timestamp, and a row already marked read earlier keeps its ORIGINAL
// read_at rather than being overwritten — the same "don't reset an earlier
// read_at" guarantee MarkRead already gives per row, just applied in bulk.
func TestMarkAllReadMarksEveryUnreadRow(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Upsert(ctx, []Item{
		{ID: "n1", At: "2026-09-03T10:00:00Z", URL: "https://x/browse/A-1", Unread: true},
		{ID: "n2", At: "2026-09-03T09:00:00Z", URL: "https://x/browse/A-2", Unread: true},
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := m.MarkRead(ctx, "n2", "2026-09-03T09:30:00Z"); err != nil {
		t.Fatalf("mark read n2: %v", err)
	}
	if err := m.MarkAllRead(ctx, "2026-09-03T12:00:00Z"); err != nil {
		t.Fatalf("mark all read: %v", err)
	}
	list, err := m.List(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, it := range list {
		if it.Unread {
			t.Errorf("id=%s still reports unread after MarkAllRead", it.ID)
		}
	}
	var readAtN2 string
	if err := m.db.QueryRowContext(ctx, `SELECT read_at FROM jira_notifications WHERE id = ?`, "n2").Scan(&readAtN2); err != nil {
		t.Fatalf("query n2 read_at: %v", err)
	}
	if readAtN2 != "2026-09-03T09:30:00Z" {
		t.Errorf("n2's earlier read_at was overwritten: got %q", readAtN2)
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

// TestUpsertRoundTripsRichFields pins the columns added for the richer
// per-notification detail (issue summary/status/type icon, the "+N updates
// from X" grouping note, a comment preview) — a plain Upsert→List round trip
// must return exactly what was stored, and a GroupSize of 0 (an ungrouped
// notification the caller forgot to normalize) must come back as 1, never 0.
func TestUpsertRoundTripsRichFields(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Upsert(ctx, []Item{
		{
			ID: "n1", At: "2026-09-03T10:00:00Z", URL: "https://x/browse/A-1", Unread: true,
			IssueTitle: "Fix the checkout flow", IssueStatus: "To Do",
			IssueIconURL: "https://x/bug.png", GroupSize: 3, OtherActor: "Alex",
			CommentPreview: "Helemaal top!",
		},
		{ID: "n2", At: "2026-09-03T09:00:00Z", URL: "https://x/browse/A-2", Unread: true}, // GroupSize left zero
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	list, err := m.List(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 rows, got %d", len(list))
	}
	first := list[0] // newest first
	if first.IssueTitle != "Fix the checkout flow" || first.IssueStatus != "To Do" ||
		first.IssueIconURL != "https://x/bug.png" || first.GroupSize != 3 ||
		first.OtherActor != "Alex" || first.CommentPreview != "Helemaal top!" {
		t.Errorf("rich fields did not round-trip: %+v", first)
	}
	second := list[1]
	if second.GroupSize != 1 {
		t.Errorf("GroupSize: got %d, want 1 (zero-value normalized)", second.GroupSize)
	}
}

// TestMarkUnreadSurvivesTheNextRefresh is the mirror of
// TestMarkReadSurvivesTheNextRefresh and the whole point of the local
// forced_unread column: the reviewer's right-click "Markeer als ongelezen"
// must hold even when the FEED itself calls the row read (this app never writes
// into Jira), so the very next poll's Upsert may not undo it. Marking it read
// again afterwards clears the override.
func TestMarkUnreadSurvivesTheNextRefresh(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	// A row Jira itself already considers read.
	item := Item{ID: "n1", At: "2026-09-03T10:00:00Z", Title: "commented", URL: "https://x/browse/A-1", Unread: false}
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := m.MarkUnread(ctx, "n1"); err != nil {
		t.Fatalf("mark unread: %v", err)
	}
	if list, err := m.List(ctx, 10); err != nil {
		t.Fatalf("list: %v", err)
	} else if len(list) != 1 || !list[0].Unread {
		t.Fatalf("want the row unread right after MarkUnread, got %+v", list)
	}
	// The next poll reports it read again — the override must win.
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	if list, err := m.List(ctx, 10); err != nil {
		t.Fatalf("list: %v", err)
	} else if !list[0].Unread {
		t.Error("a notification marked unread here must stay unread across refreshes")
	}
	// And marking it read again drops the override for good.
	if err := m.MarkRead(ctx, "n1", "2026-09-03T12:00:00Z"); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("re-upsert 2: %v", err)
	}
	if list, err := m.List(ctx, 10); err != nil {
		t.Fatalf("list: %v", err)
	} else if list[0].Unread {
		t.Error("marking read again must clear the forced-unread override")
	}
}

// TestMarkAllReadClearsAForcedUnreadRow: the bulk "Alles gelezen maken" is the
// escape hatch for a row the reviewer marked unread, so it must clear the
// override too — otherwise one such row would stay unread forever and keep the
// "N ongelezen" counter above zero.
func TestMarkAllReadClearsAForcedUnreadRow(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	item := Item{ID: "n1", At: "2026-09-03T10:00:00Z", URL: "https://x/browse/A-1", Unread: false}
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := m.MarkUnread(ctx, "n1"); err != nil {
		t.Fatalf("mark unread: %v", err)
	}
	if err := m.MarkAllRead(ctx, "2026-09-03T13:00:00Z"); err != nil {
		t.Fatalf("mark all read: %v", err)
	}
	if err := m.Upsert(ctx, []Item{item}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	list, err := m.List(ctx, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if list[0].Unread {
		t.Error("MarkAllRead must clear a forced-unread row")
	}
}
