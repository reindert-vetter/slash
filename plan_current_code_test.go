package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadPlanCurrentFileStaysInsideTheWerkmap pins the one thing this
// read-only endpoint must never get wrong: the requested path is joined onto
// the reviewer's own checkout, so a traversal must come back as "not found"
// rather than as some file outside it. The pattern already refuses "..", this
// is the second, independent guard (.claude/rules/conventions.md: always
// validate input before it reaches the filesystem/a subprocess).
func TestReadPlanCurrentFileStaysInsideTheWerkmap(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "Foo.php"), []byte("<?php\nclass Foo {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, truncated, ok := readPlanCurrentFile(dir, "app/Foo.php")
	if !ok || truncated || !strings.Contains(code, "class Foo") {
		t.Fatalf("expected the real file back, got ok=%v truncated=%v code=%q", ok, truncated, code)
	}
	if _, _, ok := readPlanCurrentFile(dir, "../secret.txt"); ok {
		t.Fatalf("a traversal must never resolve to a file outside the werkmap")
	}
	if _, _, ok := readPlanCurrentFile(dir, "app/Missing.php"); ok {
		t.Fatalf("a file that does not exist must read as not-found (the page's \"nieuw bestand\")")
	}
	if _, _, ok := readPlanCurrentFile(dir, "app"); ok {
		t.Fatalf("a directory must never come back as code")
	}
	// The pattern the handler validates against: a repo-relative path only.
	for _, bad := range []string{"/etc/passwd", "app/../../x", "app/Foo.php;rm -rf /", "app/ Foo.php"} {
		if planCurrentFilePattern.MatchString(bad) && !strings.Contains(bad, "..") {
			t.Fatalf("the file pattern must refuse %q", bad)
		}
	}
}
