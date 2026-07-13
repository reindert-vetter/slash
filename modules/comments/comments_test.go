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

func TestSearchByPathPrefix(t *testing.T) {
	m := openTest(t)
	ctx := context.Background()
	seed := []Comment{
		{ID: "a", RunID: "a", PR: 123, File: "app/Foo.php", Body: "1", Path: "/pr-123/app/Foo.php/Foo::bar/group-5-9/comment-a"},
		{ID: "b", RunID: "b", PR: 123, File: "app/Foo.php", Body: "2", Path: "/pr-123/app/Foo.php/Foo::bar/line-7/comment-b"},
		{ID: "c", RunID: "c", PR: 123, File: "app/Other.php", Body: "3", Path: "/pr-123/app/Other.php/Other::baz/line-3/comment-c"},
		{ID: "d", RunID: "d", PR: 456, File: "app/Foo.php", Body: "4", Path: "/pr-456/app/Foo.php/Foo::bar/line-1/comment-d"},
	}
	for _, c := range seed {
		if err := m.Save(ctx, c); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		prefix string
		want   int
	}{
		{"/pr-123", 3},                             // whole PR
		{"/pr-123/app/Foo.php", 2},                 // one file
		{"/pr-123/app/Foo.php/Foo::bar/group-5-9", 1}, // one unit
		{"/pr-456", 1},
		{"/pr-999", 0},
	}
	for _, tc := range cases {
		got, err := m.Search(ctx, tc.prefix)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != tc.want {
			t.Errorf("Search(%q) = %d comments, want %d", tc.prefix, len(got), tc.want)
		}
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
