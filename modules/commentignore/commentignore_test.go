package commentignore

import (
	"context"
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "commentignore.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func TestSetListRoundTrip(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "", 12903, "comment-b", true); err != nil {
		t.Fatalf("set b: %v", err)
	}
	if err := m.Set(ctx, "", 12903, "comment-a", true); err != nil {
		t.Fatalf("set a: %v", err)
	}
	list, err := m.List(ctx, "", 12903)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// Ordered by comment_id ascending.
	if len(list) != 2 || list[0] != "comment-a" || list[1] != "comment-b" {
		t.Fatalf("want [comment-a comment-b], got %v", list)
	}
}

// The store is scoped per PR: the same comment id ignored on one PR must not
// leak into another PR's list.
func TestListIsScopedPerPR(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "", 1, "shared-id", true); err != nil {
		t.Fatal(err)
	}
	list, err := m.List(ctx, "", 2)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("want empty list for pr 2, got %v", list)
	}
}

// Set is idempotent in both directions, so a replayed Activity is safe.
func TestSetIsIdempotent(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := m.Set(ctx, "", 7, "c1", true); err != nil {
			t.Fatalf("set %d: %v", i, err)
		}
	}
	if list, _ := m.List(ctx, "", 7); len(list) != 1 {
		t.Fatalf("want a single row after repeated set, got %v", list)
	}
	for i := 0; i < 3; i++ {
		if err := m.Set(ctx, "", 7, "c1", false); err != nil {
			t.Fatalf("unset %d: %v", i, err)
		}
	}
	if list, _ := m.List(ctx, "", 7); len(list) != 0 {
		t.Fatalf("want empty after repeated unset, got %v", list)
	}
}

// Un-ignoring a comment that was never ignored is a no-op, not an error.
func TestUnsetUnknownIsNoop(t *testing.T) {
	m := openTemp(t)
	if err := m.Set(context.Background(), "", 7, "never-seen", false); err != nil {
		t.Fatalf("unset unknown: %v", err)
	}
}

func TestPurgeRemovesOnlyThatPR(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "", 1, "c1", true); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "", 1, "c2", true); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "", 2, "c3", true); err != nil {
		t.Fatal(err)
	}
	n, err := m.Purge(ctx, "", 1)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if n != 2 {
		t.Fatalf("want 2 rows purged, got %d", n)
	}
	if list, _ := m.List(ctx, "", 1); len(list) != 0 {
		t.Fatalf("want pr 1 empty after purge, got %v", list)
	}
	if list, _ := m.List(ctx, "", 2); len(list) != 1 {
		t.Fatalf("want pr 2 untouched, got %v", list)
	}
	// Idempotent: purging again removes nothing and errors not.
	if n, err := m.Purge(ctx, "", 1); err != nil || n != 0 {
		t.Fatalf("second purge = %d, %v; want 0, nil", n, err)
	}
}
