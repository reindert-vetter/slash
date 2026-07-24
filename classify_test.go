package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const deletedFilePHP = `<?php

class LegacyExporter
{
    public function export(): void
    {
        echo "export";
    }

    public function cleanup(): void
    {
        echo "cleanup";
    }
}
`

const keptFileOldPHP = `<?php

class OrderService
{
    public function build(): void
    {
        echo "build";
    }

    public function legacyTotals(): int
    {
        return 0;
    }
}
`

const keptFileNewPHP = `<?php

class OrderService
{
    public function build(): void
    {
        echo "build";
    }
}
`

// TestFileDeletedFlag is the reliable "file really deleted" signal: a file
// absent from the head worktree (git's `+++ /dev/null` case) must yield
// removed blocks with FileDeleted set, while a single removed method in a
// file that still exists must not.
func TestFileDeletedFlag(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	deleted := "app/Services/LegacyExporter.php"
	kept := "app/Services/OrderService.php"

	writeFileT(t, filepath.Join(baseDir, deleted), deletedFilePHP)
	writeFileT(t, filepath.Join(baseDir, kept), keptFileOldPHP)
	// deleted is intentionally absent from headDir.
	writeFileT(t, filepath.Join(headDir, kept), keptFileNewPHP)

	blocks, errs := parseFiles(7, []string{deleted, kept}, nil, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}

	var deletedBlocks, looseRemoved []Block
	for _, b := range blocks {
		switch b.File {
		case deleted:
			deletedBlocks = append(deletedBlocks, b)
		case kept:
			if b.Status == StatusRemoved {
				looseRemoved = append(looseRemoved, b)
			} else if b.FileDeleted {
				t.Errorf("kept-file block %s unexpectedly FileDeleted", b.Label)
			}
		}
	}

	if len(deletedBlocks) != 2 {
		t.Fatalf("deleted file: want 2 blocks, got %d", len(deletedBlocks))
	}
	for _, b := range deletedBlocks {
		if b.Status != StatusRemoved {
			t.Errorf("deleted-file block %s: status %q, want removed", b.symbol(), b.Status)
		}
		if !b.FileDeleted {
			t.Errorf("deleted-file block %s: FileDeleted false, want true", b.symbol())
		}
	}

	if len(looseRemoved) != 1 || looseRemoved[0].Name != "legacyTotals" {
		t.Fatalf("kept file: want 1 removed block (legacyTotals), got %v", looseRemoved)
	}
	if looseRemoved[0].FileDeleted {
		t.Errorf("loose removed method must not be FileDeleted (file still exists)")
	}
}

// TestFileDeletedRoundTrip verifies both blocks-table write paths (full swap
// and file-scoped upsert) persist the flag, and that blocksByPR — the read
// behind /api/blocks — returns it.
func TestFileDeletedRoundTrip(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	pr := 7
	del := Block{PR: pr, File: "app/A.php", Class: "A", Name: "x", Line: 3, EndLine: 6,
		Status: StatusRemoved, FileDeleted: true, Side: SideOld}
	loose := Block{PR: pr, File: "app/B.php", Class: "B", Name: "y", Line: 3, EndLine: 6,
		Status: StatusRemoved, Side: SideOld}

	if err := replacePRBlocks(db, pr, []Block{del, loose}); err != nil {
		t.Fatal(err)
	}
	assertFlags := func(stage string) {
		t.Helper()
		got, err := blocksByPR(db, pr)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Fatalf("%s: want 2 blocks, got %d", stage, len(got))
		}
		byFile := map[string]Block{}
		for _, b := range got {
			byFile[b.File] = b
		}
		if !byFile["app/A.php"].FileDeleted {
			t.Errorf("%s: A.php block lost FileDeleted", stage)
		}
		if byFile["app/B.php"].FileDeleted {
			t.Errorf("%s: B.php block gained FileDeleted", stage)
		}
	}
	assertFlags("replacePRBlocks")

	if err := upsertPRFileBlocks(db, pr, []string{"app/A.php"}, []Block{del}); err != nil {
		t.Fatal(err)
	}
	assertFlags("upsertPRFileBlocks")

	// The computed JSON (what /api/blocks serves) carries the flag too.
	raw, err := del.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"fileDeleted":true`) {
		t.Errorf("MarshalJSON missing fileDeleted flag: %s", raw)
	}
}

// TestFileDeletedMigration opens a DB created before the file_deleted column
// existed and expects openDB's light ALTER TABLE migration to add it.
func TestFileDeletedMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE blocks (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, class TEXT NOT NULL DEFAULT '',
		file TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', line INTEGER NOT NULL,
		end_line INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '',
		side TEXT NOT NULL DEFAULT 'new', pr INTEGER NOT NULL DEFAULT 0,
		approved INTEGER NOT NULL DEFAULT 0)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	db, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB on pre-migration DB: %v", err)
	}
	defer db.Close()

	b := Block{PR: 1, File: "app/A.php", Class: "A", Name: "x", Line: 1, EndLine: 2,
		Status: StatusRemoved, FileDeleted: true, Side: SideOld}
	if err := replacePRBlocks(db, 1, []Block{b}); err != nil {
		t.Fatalf("write after migration: %v", err)
	}
	got, err := blocksByPR(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !got[0].FileDeleted {
		t.Fatalf("migrated DB lost FileDeleted: %v", got)
	}
}

// TestAttributeOnlyChangeClassifiesAsModified proves the latent classify.go
// gap that leading-attribute inclusion (phpscan.go, see
// .claude/rules/blocks-and-ingest.md) fixes: before that scanner change, a
// method's Block.Line started at the `function` keyword, so a diff that only
// touches the line(s) above it (a newly added #[DataProvider(...)]) never
// intersected the block's [Line, EndLine] span and the method silently never
// showed up as "modified" at all. With the attribute folded into the block's
// own span, the same attribute-only diff now does intersect.
func TestAttributeOnlyChangeClassifiesAsModified(t *testing.T) {
	oldSrc := `<?php
class PermissionTest {
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	newSrc := `<?php
class PermissionTest {
    #[DataProvider('permissionAccessDataProvider')]
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	file := "tests/Feature/PermissionTest.php"
	oldBlocks := ScanBlocks([]byte(oldSrc), file)
	newBlocks := ScanBlocks([]byte(newSrc), file)

	// A real unified diff for this change would show exactly one added line —
	// the new attribute — and nothing removed.
	fd := &fileDiff{changedOld: lineSet{}, changedNew: lineSet{3: true}}

	out := classifyFile(1, file, "", oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)

	var found *Block
	for i := range out {
		if out[i].symbol() == "PermissionTest::testPermissionAccess" {
			found = &out[i]
		}
	}
	if found == nil {
		t.Fatalf("attribute-only change did not classify the method as changed at all; got %v", symbols(out))
	}
	if found.Status != StatusModified {
		t.Errorf("expected status=%q, got %q", StatusModified, found.Status)
	}
}

// TestRenamePairsBlocks proves the rename-as-one-block path: when the PR moved
// a file (git-detected rename), parseOneFile scans the OLD source from the
// pre-rename path and the NEW source from the head path but keys both block
// sets on the NEW file, so classifyFile pairs them on symbol() exactly as it
// would for an in-place edit. A method present in both versions becomes a
// single MODIFIED block (not the removed@old + added@new pair the user saw
// before); a method only in the new version is added, only in the old is
// removed; and every emitted block carries oldFile (the pre-rename path) so
// the card can show old-above-new and /api/code reads the old side from there.
func TestRenamePairsBlocks(t *testing.T) {
	// The OLD (base-worktree) content of the file, before it moved.
	oldSrc := `<?php
class Foo {
    public function bar() {
        return 1;
    }
    public function baz() {
        return 2;
    }
    public function gone() {
        return 3;
    }
}
`
	// The NEW (head-worktree) content, after the move + edits: bar changed,
	// baz untouched, gone removed, fresh added.
	newSrc := `<?php
class Foo {
    public function bar() {
        return 100;
    }
    public function baz() {
        return 2;
    }
    public function fresh() {
        return 4;
    }
}
`
	newPath := "app/New/Foo.php"
	oldPath := "app/Old/Foo.php"
	// parseOneFile scans both sides under the NEW path (only the source text
	// differs — old from the base worktree, new from head).
	oldBlocks := ScanBlocks([]byte(oldSrc), newPath)
	newBlocks := ScanBlocks([]byte(newSrc), newPath)

	// The rename+edit diff, keyed on the new path by parseUnifiedDiff: bar's
	// body line plus the removed `gone` / added `fresh` line runs.
	fd := &fileDiff{
		changedOld: lineSet{4: true, 9: true, 10: true, 11: true},
		changedNew: lineSet{4: true, 9: true, 10: true, 11: true},
	}

	out := classifyFile(1, newPath, oldPath, oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)

	byStatus := map[string]*Block{}
	for i := range out {
		byStatus[out[i].symbol()] = &out[i]
	}
	want := map[string]string{
		"Foo::bar":   StatusModified,
		"Foo::gone":  StatusRemoved,
		"Foo::fresh": StatusAdded,
	}
	for sym, status := range want {
		b := byStatus[sym]
		if b == nil {
			t.Fatalf("%s missing from classify output; got %v", sym, symbols(out))
		}
		if b.Status != status {
			t.Errorf("%s: status=%q, want %q", sym, b.Status, status)
		}
		if b.File != newPath {
			t.Errorf("%s: file=%q, want new path %q", sym, b.File, newPath)
		}
		if b.OldFile != oldPath {
			t.Errorf("%s: oldFile=%q, want %q", sym, b.OldFile, oldPath)
		}
	}
	// The unchanged method must NOT appear as a removed+added pair — it's just
	// dropped, exactly like an unchanged method in an in-place edit.
	if _, ok := byStatus["Foo::baz"]; ok {
		t.Errorf("unchanged Foo::baz should be dropped, not surfaced; got %v", symbols(out))
	}
}

// TestPHPDocOnlyChangeClassifiesAsModified is the PHPDoc mirror of
// TestAttributeOnlyChangeClassifiesAsModified above: since phpscan.go now
// folds a leading `/** ... */` PHPDoc into the block's own [Line, EndLine]
// span (just like a leading attribute), a diff that only touches the doc's
// prose (no attribute, no body edit) intersects the block's span and the
// method correctly shows up as "modified" — before that change it silently
// never showed up at all.
func TestPHPDocOnlyChangeClassifiesAsModified(t *testing.T) {
	oldSrc := `<?php
class OrderService {
    /**
     * Creates an order for the given customer.
     */
    public function create($customerId) {
        return new Order();
    }
}
`
	newSrc := `<?php
class OrderService {
    /**
     * Creates and persists an order for the given customer.
     */
    public function create($customerId) {
        return new Order();
    }
}
`
	file := "app/Services/OrderService.php"
	oldBlocks := ScanBlocks([]byte(oldSrc), file)
	newBlocks := ScanBlocks([]byte(newSrc), file)

	// A real unified diff for this change would show exactly the one changed
	// docblock line, on both sides.
	fd := &fileDiff{changedOld: lineSet{4: true}, changedNew: lineSet{4: true}}

	out := classifyFile(1, file, "", oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)

	var found *Block
	for i := range out {
		if out[i].symbol() == "OrderService::create" {
			found = &out[i]
		}
	}
	if found == nil {
		t.Fatalf("PHPDoc-only change did not classify the method as changed at all; got %v", symbols(out))
	}
	if found.Status != StatusModified {
		t.Errorf("expected status=%q, got %q", StatusModified, found.Status)
	}
}

// TestBareTestAttributeOnlyChangeIsIgnored is the narrow carve-out on top of
// TestAttributeOnlyChangeClassifiesAsModified above: a bare `#[Test]` (no
// arguments) added above an otherwise completely untouched method carries no
// reviewable meaning, so the block must NOT be surfaced as "modified" at all
// — unlike a #[DataProvider(...)]-only change, which still must be (see the
// test above; that behavior is unchanged).
func TestBareTestAttributeOnlyChangeIsIgnored(t *testing.T) {
	oldSrc := `<?php
class PermissionTest {
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	newSrc := `<?php
class PermissionTest {
    #[Test]
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	file := "tests/Feature/PermissionTest.php"
	oldBlocks := ScanBlocks([]byte(oldSrc), file)
	newBlocks := ScanBlocks([]byte(newSrc), file)

	// A real unified diff for this change would show exactly one added line —
	// the new `#[Test]` attribute — and nothing removed.
	fd := &fileDiff{changedOld: lineSet{}, changedNew: lineSet{3: true}}

	out := classifyFile(1, file, "", oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)

	for _, b := range out {
		if b.symbol() == "PermissionTest::testPermissionAccess" {
			t.Fatalf("expected a bare #[Test]-only change to be ignored, got %v", b)
		}
	}
}

// TestBareTestAttributeChangeStillModifiedWithRealEdit proves the carve-out
// above only applies when the bare `#[Test]` is the SOLE change: add it
// together with a real body edit, and the method must still classify as
// modified — a normal test-block edit must never be silently dropped.
func TestBareTestAttributeChangeStillModifiedWithRealEdit(t *testing.T) {
	oldSrc := `<?php
class PermissionTest {
    public function testPermissionAccess($perm) {
        return true;
    }
}
`
	newSrc := `<?php
class PermissionTest {
    #[Test]
    public function testPermissionAccess($perm) {
        return false;
    }
}
`
	file := "tests/Feature/PermissionTest.php"
	oldBlocks := ScanBlocks([]byte(oldSrc), file)
	newBlocks := ScanBlocks([]byte(newSrc), file)

	// New line 3 is the added `#[Test]` attribute, new line 5 is the changed
	// body (`return true;` -> `return false;`); old line 4 (`return true;`) is
	// the corresponding removed line.
	fd := &fileDiff{changedOld: lineSet{4: true}, changedNew: lineSet{3: true, 5: true}}

	out := classifyFile(1, file, "", oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)

	var found *Block
	for i := range out {
		if out[i].symbol() == "PermissionTest::testPermissionAccess" {
			found = &out[i]
		}
	}
	if found == nil {
		t.Fatalf("expected the method with a real body edit to still classify as changed, got %v", symbols(out))
	}
	if found.Status != StatusModified {
		t.Errorf("expected status=%q, got %q", StatusModified, found.Status)
	}
}

// TestCategoryForTranslation: a Laravel lang file classifies as TRANSLATION,
// both under resources/lang and the older top-level lang/, and an ordinary
// app file keeps its existing category (no accidental overlap).
func TestCategoryForTranslation(t *testing.T) {
	cases := map[string]string{
		"resources/lang/nl/checkout.php":           "TRANSLATION",
		"lang/en/cart.php":                         "TRANSLATION",
		"app/Http/Controllers/OrderController.php": "CONTROLLER",
		"app/Models/Order.php":                     "MODEL",
	}
	for path, want := range cases {
		if got := categoryFor(path); got != want {
			t.Errorf("categoryFor(%q) = %q, want %q", path, got, want)
		}
	}
}

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
