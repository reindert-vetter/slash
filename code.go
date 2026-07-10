package main

import (
	"os"
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
