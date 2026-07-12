package comments

import (
	"context"
	"path/filepath"
	"testing"
)

func openTest(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func TestSetStatus(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Save(ctx, Comment{ID: "c1", RunID: "c1", PR: 1, File: "a.php", Line: 1, Body: "hi"}); err != nil {
		t.Fatal(err)
	}

	if err := m.SetStatus(ctx, "c1", "deleting"); err != nil {
		t.Fatal(err)
	}
	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != "deleting" {
		t.Fatalf("comments = %+v, want status=deleting", list)
	}

	// A Save after SetStatus must not clobber the status back to "open" — Save
	// preserves the existing status (COALESCE), same as the resolved path.
	if err := m.Save(ctx, Comment{ID: "c1", RunID: "c1", PR: 1, File: "a.php", Line: 1, Body: "hi"}); err != nil {
		t.Fatal(err)
	}
	list, _ = m.List(ctx, 1)
	if list[0].Status != "deleting" {
		t.Fatalf("status after re-save = %q, want deleting (preserved)", list[0].Status)
	}
}

func TestDeleteCascadesReactions(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	if err := m.Save(ctx, Comment{ID: "c1", RunID: "c1", PR: 1, File: "a.php", Line: 1, Body: "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := m.AddReaction(ctx, Reaction{ID: "r1", CommentID: "c1", Source: "ui", Body: "reply"}); err != nil {
		t.Fatal(err)
	}

	if err := m.Delete(ctx, "c1"); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("comments = %+v, want none after delete", list)
	}

	var n int
	if err := m.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM reactions WHERE comment_id = ?`, "c1").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("reactions left = %d, want 0 (cascade)", n)
	}
}

func TestDeleteUnknownIDIsNoop(t *testing.T) {
	m := openTest(t)
	if err := m.Delete(context.Background(), "does-not-exist"); err != nil {
		t.Fatalf("delete unknown id: %v", err)
	}
}
