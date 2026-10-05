package main

import (
	"path/filepath"
	"testing"
)

// TestImportOnlyChangeSurfacesAsFileHeader: a PR that only rewrites a `use`
// line (PR 14017, a namespace move) used to leave the file without any block.
func TestImportOnlyChangeSurfacesAsFileHeader(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	rel := "app/Services/Svc.php"
	body := "\nclass Svc\n{\n    public function run()\n    {\n        return 1;\n    }\n}\n"
	writeFileT(t, filepath.Join(baseDir, rel), "<?php\n\nnamespace App\\Services;\n\nuse Modules\\Forms\\Models\\Form;\n"+body)
	writeFileT(t, filepath.Join(headDir, rel), "<?php\n\nnamespace App\\Services;\n\nuse Modules\\Forms\\Internal\\Models\\Form;\n"+body)
	diffs := parseUnifiedDiff("diff --git a/" + rel + " b/" + rel + "\n--- a/" + rel + "\n+++ b/" + rel + "\n" +
		"@@ -5 +5 @@\n-use Modules\\Forms\\Models\\Form;\n+use Modules\\Forms\\Internal\\Models\\Form;\n")

	blocks, errs := parseFiles(1, []string{rel}, nil, baseDir, headDir, diffs)
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	if len(blocks) != 1 {
		t.Fatalf("want only the file-header block, got %s", blockSymbols(blocks))
	}
	b := blocks[0]
	if b.Name != fileHeaderSentinel || b.Class != "Svc" || b.Status != StatusModified || b.Line != 1 || b.EndLine != 8 {
		t.Fatalf("got %s %s::%s %d-%d", b.Status, b.Class, b.Name, b.Line, b.EndLine)
	}
	b.makeLabel()
	if b.Label != "Imports" {
		t.Errorf("label = %q, want Imports", b.Label)
	}
}

// TestPureRenameGetsOneApprovableRow: a file moved without any content change
// gets one <renamed-file> row whose old/new "source" is its old/new path.
func TestPureRenameGetsOneApprovableRow(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	from := "modules/Forms/Database/Migrations/2023_create_forms.php"
	to := "modules/Forms/Internal/Database/Migrations/2023_create_forms.php"
	src := "<?php\n\nreturn new class extends Migration\n{\n    public function up()\n    {\n    }\n};\n"
	writeFileT(t, filepath.Join(baseDir, from), src)
	writeFileT(t, filepath.Join(headDir, to), src)

	blocks, errs := parseFiles(1, []string{to}, map[string]string{to: from}, baseDir, headDir, map[string]*fileDiff{})
	if len(errs) != 0 {
		t.Fatalf("parseFiles errors: %v", errs)
	}
	if len(blocks) != 1 || blocks[0].Name != renamedFileSentinel || blocks[0].OldFile != from || blocks[0].Status != StatusModified {
		t.Fatalf("want one modified <renamed-file> block, got %s", blockSymbols(blocks))
	}
	_, oldSide, newSide := blockAlignedRows(baseDir, headDir, blocks[0])
	if oldSide.Text != from || newSide.Text != to {
		t.Fatalf("sides = %q / %q, want the old and new path", oldSide.Text, newSide.Text)
	}
	if n := blockChangedRowCount(baseDir, headDir, blocks[0]); n != 1 {
		t.Errorf("changed rows = %d, want 1 (so the row is approvable)", n)
	}
}
