package warnrevoke

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMarkIfNewOnlyOnce(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "warnrevoke.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	isNew, err := m.MarkIfNew(ctx, 1, "1:app/Foo.php:Foo::bar", 6)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew {
		t.Fatal("first MarkIfNew for a fresh (pr, block, row) = false, want true")
	}

	isNew, err = m.MarkIfNew(ctx, 1, "1:app/Foo.php:Foo::bar", 6)
	if err != nil {
		t.Fatal(err)
	}
	if isNew {
		t.Fatal("second MarkIfNew for the SAME (pr, block, row) = true, want false")
	}

	// A different row on the same block is a distinct key.
	isNew, err = m.MarkIfNew(ctx, 1, "1:app/Foo.php:Foo::bar", 7)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew {
		t.Fatal("MarkIfNew for a different row = false, want true")
	}

	// A different PR is also a distinct key.
	isNew, err = m.MarkIfNew(ctx, 2, "1:app/Foo.php:Foo::bar", 6)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew {
		t.Fatal("MarkIfNew for a different pr = false, want true")
	}
}

func TestPurgeRemovesOnlyThatPR(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "warnrevoke.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if _, err := m.MarkIfNew(ctx, 1, "1:app/Foo.php:Foo::bar", 6); err != nil {
		t.Fatal(err)
	}
	if _, err := m.MarkIfNew(ctx, 2, "2:app/Foo.php:Foo::bar", 6); err != nil {
		t.Fatal(err)
	}

	n, err := m.Purge(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("Purge(1) removed %d rows, want 1", n)
	}

	// PR 1's key is gone — marking it again reports "new".
	isNew, err := m.MarkIfNew(ctx, 1, "1:app/Foo.php:Foo::bar", 6)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew {
		t.Fatal("after Purge(1), the same key should be new again")
	}

	// PR 2's row must be untouched.
	isNew, err = m.MarkIfNew(ctx, 2, "2:app/Foo.php:Foo::bar", 6)
	if err != nil {
		t.Fatal(err)
	}
	if isNew {
		t.Fatal("Purge(1) must not remove PR 2's row")
	}
}
