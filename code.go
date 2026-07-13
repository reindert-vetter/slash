package main

import (
	"os"
	"path/filepath"
	"strings"
)

// codeSide is the source of one block on one worktree side (old/base or
// new/head). Text is empty when the block is absent on that side (e.g. an added
// block has no old side).
type codeSide struct {
	Start int    `json:"start"` // 1-based first line, 0 if absent
	End   int    `json:"end"`   // 1-based last line
	Text  string `json:"text"`
}

// extractBlockSource reads path, scans it into blocks and returns the source of
// the block whose symbol matches (class,name). Absent file or block → zero value
// (Text == "").
func extractBlockSource(path, relFile, class, name string) codeSide {
	src, err := os.ReadFile(path)
	if err != nil {
		return codeSide{}
	}
	target := name
	if class != "" {
		target = class + "::" + name
	}
	for _, b := range ScanBlocks(src, relFile) {
		if b.symbol() == target {
			return sliceLines(src, b.Line, b.EndLine)
		}
	}
	return codeSide{}
}

// resolveWithinWorktree cleans file (stripping any leading ../ or absolute
// prefix) and joins it onto dir, then checks that the result both stays inside
// dir and actually exists. Used to allow reads of files a PR didn't touch
// (e.g. an unrelated method-call target) without letting untrusted input
// escape the worktree. Returns the joined path and the cleaned relative file.
func resolveWithinWorktree(dir, file string) (full, rel string, ok bool) {
	rel = filepath.Clean("/" + file)[1:] // strip any leading .. / absolute
	full = filepath.Join(dir, rel)
	if !within(dir, full) {
		return "", "", false
	}
	if _, err := os.Stat(full); err != nil {
		return "", "", false
	}
	return full, rel, true
}

// within reports whether path is inside dir.
func within(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// blockSource returns a block's source from the given worktree root. It first
// tries a symbol lookup (works for top-level functions/methods); if that misses —
// e.g. a macro closure nested inside a boot method's body, which ScanBlocks does
// not surface as its own block — it falls back to the block's recorded line range.
func blockSource(root string, def Block) codeSide {
	path := filepath.Join(root, def.File)
	if cs := extractBlockSource(path, def.File, def.Class, def.Name); cs.Text != "" {
		return cs
	}
	src, err := os.ReadFile(path)
	if err != nil {
		return codeSide{}
	}
	return sliceLines(src, def.Line, def.EndLine)
}

// sliceLines returns lines [start,end] (1-based, inclusive) of src, clamped to
// the file bounds.
func sliceLines(src []byte, start, end int) codeSide {
	if start < 1 {
		start = 1
	}
	lines := strings.Split(string(src), "\n")
	if start > len(lines) {
		return codeSide{}
	}
	if end > len(lines) {
		end = len(lines)
	}
	return codeSide{Start: start, End: end, Text: strings.Join(lines[start-1:end], "\n")}
}
