package reviewerusage

import (
	"context"
	"testing"
)

func TestBumpAndList(t *testing.T) {
	m, err := Open("file:reviewerusage_test?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	// alice assigned 3x, bob 1x, carol 0x (never bumped).
	for i := 0; i < 3; i++ {
		if err := m.Bump(ctx, "o/r", []string{"alice"}); err != nil {
			t.Fatal(err)
		}
	}
	// A single call with a duplicate login counts bob once, not twice.
	if err := m.Bump(ctx, "o/r", []string{"bob", "bob"}); err != nil {
		t.Fatal(err)
	}
	// Empty logins are skipped, other repo is isolated.
	if err := m.Bump(ctx, "o/r", []string{""}); err != nil {
		t.Fatal(err)
	}
	if err := m.Bump(ctx, "other/repo", []string{"alice"}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, "o/r")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 rows, got %d: %+v", len(list), list)
	}
	// Most-used first: alice(3) before bob(1).
	if list[0].Login != "alice" || list[0].Count != 3 {
		t.Fatalf("row 0 = %+v, want alice/3", list[0])
	}
	if list[1].Login != "bob" || list[1].Count != 1 {
		t.Fatalf("row 1 = %+v, want bob/1", list[1])
	}
}
