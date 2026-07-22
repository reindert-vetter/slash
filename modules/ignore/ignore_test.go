package ignore

import (
	"context"
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "ignore.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func TestSetListRoundTrip(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "org/repo", 12, 0); err != nil {
		t.Fatalf("set forever: %v", err)
	}
	if err := m.Set(ctx, "org/repo", 34, 1_700_000_000_000); err != nil {
		t.Fatalf("set until: %v", err)
	}
	// A different repo is isolated.
	if err := m.Set(ctx, "other/repo", 99, 0); err != nil {
		t.Fatalf("set other: %v", err)
	}
	list, err := m.List(ctx, "org/repo")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 entries, got %d (%+v)", len(list), list)
	}
	// Ordered by pr ascending.
	if list[0].PR != 12 || list[0].Until != 0 {
		t.Fatalf("entry 0 = %+v", list[0])
	}
	if list[1].PR != 34 || list[1].Until != 1_700_000_000_000 {
		t.Fatalf("entry 1 = %+v", list[1])
	}
}

func TestSetUpsertOverwrites(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "org/repo", 7, 100); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "org/repo", 7, 200); err != nil {
		t.Fatal(err)
	}
	list, _ := m.List(ctx, "org/repo")
	if len(list) != 1 || list[0].Until != 200 {
		t.Fatalf("want single entry until=200, got %+v", list)
	}
}

func TestSetNegativeClears(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Set(ctx, "org/repo", 7, 0); err != nil {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "org/repo", 7, -1); err != nil {
		t.Fatalf("clear: %v", err)
	}
	list, _ := m.List(ctx, "org/repo")
	if len(list) != 0 {
		t.Fatalf("want empty after clear, got %+v", list)
	}
}
