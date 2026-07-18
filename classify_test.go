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

	blocks, errs := parseFiles(7, []string{deleted, kept}, baseDir, headDir, map[string]*fileDiff{})
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

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
