package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// tinyPNG returns a minimal, genuinely valid 1x1 PNG in the given colour byte —
// two calls with different colours produce byte-different files of the SAME
// length, which is exactly the case the placeholder's content hash has to
// survive (size alone can't tell them apart).
func tinyPNG(colour byte) string {
	// A hand-built PNG is overkill here: any byte string works for the
	// classify/placeholder logic, and it must contain a NUL and a high byte so
	// it is unmistakably binary (not valid UTF-8 text).
	return "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + string([]byte{colour, 0xff, 0x00, 0xfe}) + "IEND"
}

// TestImageBlockHasExactlyOneChangedRow pins the placeholder contract: a
// changed raster image's block must present ONE changed row (so a single Space
// approves it) instead of hundreds of mojibake rows, and the two sides'
// placeholder text must genuinely differ — same-length-but-different bytes
// included, which is what the sha in the line is for.
func TestImageBlockHasExactlyOneChangedRow(t *testing.T) {
	baseDir, headDir := t.TempDir(), t.TempDir()
	rel := "public/images/logo.png"
	writeFileT(t, filepath.Join(baseDir, rel), tinyPNG(0x01))
	writeFileT(t, filepath.Join(headDir, rel), tinyPNG(0x02))

	b := Block{File: rel, Name: filepath.Base(rel)}
	if got := blockChangedRowCount(baseDir, headDir, b); got != 1 {
		t.Errorf("changed rows = %d, want 1", got)
	}

	oldSide := extractBlockSource(filepath.Join(baseDir, rel), rel, "", b.Name)
	newSide := extractBlockSource(filepath.Join(headDir, rel), rel, "", b.Name)
	if !strings.Contains(oldSide.Text, "PNG") || !strings.Contains(oldSide.Text, "sha ") {
		t.Errorf("placeholder = %q, want the format + a sha", oldSide.Text)
	}
	if strings.ContainsRune(oldSide.Text, '�') {
		t.Errorf("placeholder must never carry raw image bytes: %q", oldSide.Text)
	}
	if oldSide.Text == newSide.Text {
		t.Errorf("both sides got the same placeholder %q, so no row would read as changed", oldSide.Text)
	}

	// An UNCHANGED image (identical bytes) must read as zero changed rows — the
	// hash is per content, not per call.
	writeFileT(t, filepath.Join(headDir, rel), tinyPNG(0x01))
	if got := blockChangedRowCount(baseDir, headDir, b); got != 0 {
		t.Errorf("identical image: changed rows = %d, want 0", got)
	}
}

// TestClassifyFileSurfacesModifiedImage pins the ingest half: git reports only
// "Binary files … differ" for an image, so the diff carries no changed lines at
// all and the whole-file block used to be dropped as unchanged — a changed
// image never reached the review tree.
func TestClassifyFileSurfacesModifiedImage(t *testing.T) {
	file := "public/images/logo.png"
	oldSrc, newSrc := tinyPNG(0x01), tinyPNG(0x02)
	oldBlocks := ScanBlocks([]byte(oldSrc), file)
	newBlocks := ScanBlocks([]byte(newSrc), file)
	// Empty line sets: exactly what parseUnifiedDiff yields for a binary file.
	fd := &fileDiff{changedOld: lineSet{}, changedNew: lineSet{}}

	out := classifyFile(1, file, "", oldBlocks, newBlocks, fd, false, false, oldSrc, newSrc)
	if len(out) != 1 || out[0].Status != StatusModified {
		t.Fatalf("changed image: got %d block(s) %+v, want 1 modified", len(out), out)
	}

	// Control: identical bytes stay unchanged and must NOT be surfaced.
	same := classifyFile(1, file, "", oldBlocks, oldBlocks, fd, false, false, oldSrc, oldSrc)
	if len(same) != 0 {
		t.Errorf("unchanged image: got %d block(s), want none", len(same))
	}
}

// TestHandleImageServesWorktreeBytes covers the endpoint: the right side's
// bytes with a whitelisted Content-Type, and a refusal for every way the query
// could try to read something else.
func TestHandleImageServesWorktreeBytes(t *testing.T) {
	dataDir := t.TempDir()
	baseDir, headDir := worktreeDirs(dataDir, canonRepo(""), 42)
	rel := "public/images/logo.png"
	writeFileT(t, filepath.Join(baseDir, rel), tinyPNG(0x01))
	writeFileT(t, filepath.Join(headDir, rel), tinyPNG(0x02))
	writeFileT(t, filepath.Join(headDir, "app/Secret.php"), "<?php // not an image\n")

	s := &server{dataDir: dataDir}
	get := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/image?"+query, nil)
		rr := httptest.NewRecorder()
		s.handleImage(rr, req)
		return rr
	}

	for _, tc := range []struct{ side, want string }{
		{"new", tinyPNG(0x02)},
		{"old", tinyPNG(0x01)},
	} {
		rr := get("pr=42&side=" + tc.side + "&file=" + rel)
		if rr.Code != http.StatusOK {
			t.Fatalf("side=%s: got %d, want 200", tc.side, rr.Code)
		}
		if got := rr.Body.String(); got != tc.want {
			t.Errorf("side=%s: served the wrong worktree's bytes", tc.side)
		}
		if ct := rr.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("side=%s: Content-Type = %q, want image/png", tc.side, ct)
		}
		if rr.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("side=%s: missing nosniff", tc.side)
		}
	}

	for name, query := range map[string]string{
		"non-image extension": "pr=42&side=new&file=app/Secret.php",
		"path traversal":      "pr=42&side=new&file=../../../../etc/hosts.png",
		"missing side":        "pr=42&file=" + rel,
		"unknown pr":          "pr=43&side=new&file=" + rel,
		"absent file":         "pr=42&side=new&file=public/images/nope.png",
	} {
		if rr := get(query); rr.Code == http.StatusOK {
			t.Errorf("%s: got 200, want a refusal", name)
		}
	}
}
