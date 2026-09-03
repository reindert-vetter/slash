package main

import "testing"

// TestParsePRFilesPagesFlattensEveryPage guards the >100-changed-files fix:
// `gh pr view --json files` silently stops at one page of 100, so a big PR
// ingested only its first 100 files. fetchPRFilesPaged reads the REST list
// instead, whose `--slurp` output is an array OF PAGES with a different field
// name (`filename`), and every page must end up in the flat result.
func TestParsePRFilesPagesFlattensEveryPage(t *testing.T) {
	out := []byte(`[
		[{"filename":"app/A.php","additions":3,"deletions":1},
		 {"filename":"app/B.php","additions":0,"deletions":2}],
		[{"filename":"resources/ts/c.ts","additions":7,"deletions":0}]
	]`)

	files, err := parsePRFilesPages(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("got %d files, want 3: %+v", len(files), files)
	}
	if files[0].Path != "app/A.php" || files[0].Additions != 3 || files[0].Deletions != 1 {
		t.Fatalf("first file mis-parsed: %+v", files[0])
	}
	if files[2].Path != "resources/ts/c.ts" {
		t.Fatalf("second page dropped: %+v", files)
	}
}

// TestParsePRFilesPagesEmpty keeps the no-pages case a clean empty result
// rather than an error, so a caller can fall back to gh pr view's own list.
func TestParsePRFilesPagesEmpty(t *testing.T) {
	files, err := parsePRFilesPages([]byte(`[[]]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("want no files, got %+v", files)
	}
}
