package explanations

import (
	"context"
	"path/filepath"
	"testing"
)

func testModule(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "explanations.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// Round-trip: SaveSearching creates the row, Save finishes it, List reads it back.
func TestExplanationsRoundTrip(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	e := Entry{PR: 5, BlockID: "5:app/Foo.php:Foo::bar", UnitKey: "line-3", CodeHash: "abc123"}

	if err := m.SaveSearching(ctx, e); err != nil {
		t.Fatal(err)
	}
	list, err := m.List(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != StatusSearching || list[0].CodeHash != "abc123" {
		t.Fatalf("after SaveSearching list = %+v", list)
	}

	e.Status = StatusDone
	e.Text = "Deze conditie controleert of de waarde positief is."
	e.Model = "haiku"
	if err := m.Save(ctx, e); err != nil {
		t.Fatal(err)
	}
	list, err = m.List(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("list has %d rows, want 1: %+v", len(list), list)
	}
	got := list[0]
	if got.Status != StatusDone || got.Text != e.Text || got.Model != "haiku" || got.UpdatedAt == "" {
		t.Fatalf("round-trip entry = %+v", got)
	}
}

// A newer hash for the same unit overwrites the old row (one live explanation
// per unit) — and clears the stale text while searching.
func TestExplanationsNewHashSupersedes(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	e := Entry{PR: 6, BlockID: "b", UnitKey: "group-2-4", CodeHash: "old", Status: StatusDone, Text: "oud"}
	if err := m.Save(ctx, e); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveSearching(ctx, Entry{PR: 6, BlockID: "b", UnitKey: "group-2-4", CodeHash: "new"}); err != nil {
		t.Fatal(err)
	}
	list, err := m.List(ctx, 6)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].CodeHash != "new" || list[0].Status != StatusSearching || list[0].Text != "" {
		t.Fatalf("superseded entry = %+v", list)
	}
}
