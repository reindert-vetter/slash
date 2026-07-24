package taskinbox

import (
	"context"
	"path/filepath"
	"testing"
)

func openTemp(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "taskinbox.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func TestReplaceListRoundTrip(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()

	tasks := []Task{
		{ID: "pr:1", Kind: "pr_review", Title: "Fix thing", Points: 20, PR: 1, URL: "https://x", UpdatedAt: 100},
		{ID: "jira:INTEG-1", Kind: "jira", Title: "Ticket", Points: 10, UpdatedAt: 50},
	}
	if err := m.Replace(ctx, tasks); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, err := m.List(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 tasks, got %d (%+v)", len(got), got)
	}
	// Defaults for empty PointNotes/Detail land as "[]"/"{}".
	for _, tk := range got {
		if tk.PointNotes != "[]" {
			t.Fatalf("pointNotes default = %q, want []", tk.PointNotes)
		}
		if tk.Detail != "{}" {
			t.Fatalf("detail default = %q, want {}", tk.Detail)
		}
	}
}

func TestReplaceIsAFullSwap(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()

	if err := m.Replace(ctx, []Task{{ID: "a", Kind: "jira", Title: "A"}, {ID: "b", Kind: "jira", Title: "B"}}); err != nil {
		t.Fatal(err)
	}
	// A second Replace with a different (smaller) set must remove "a"/"b", not
	// merge with them.
	if err := m.Replace(ctx, []Task{{ID: "c", Kind: "jira", Title: "C"}}); err != nil {
		t.Fatal(err)
	}
	got, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "c" {
		t.Fatalf("want only task c after replace, got %+v", got)
	}
}

func TestReplaceEmptyClearsEverything(t *testing.T) {
	m := openTemp(t)
	ctx := context.Background()
	if err := m.Replace(ctx, []Task{{ID: "a", Kind: "jira", Title: "A"}}); err != nil {
		t.Fatal(err)
	}
	if err := m.Replace(ctx, nil); err != nil {
		t.Fatal(err)
	}
	got, err := m.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty after clearing replace, got %+v", got)
	}
}
