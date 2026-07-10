package main

import (
	"strconv"
	"strings"
)

// lineSet is a set of line numbers.
type lineSet map[int]bool

// fileDiff holds the changed lines of one file, in old and new numbering.
type fileDiff struct {
	changedOld lineSet
	changedNew lineSet
}

// parseUnifiedDiff parses `git diff` output into a map file->fileDiff. The keys
// are the new path names (b/<path>); for deleted files it falls back to the old
// path.
func parseUnifiedDiff(diff string) map[string]*fileDiff {
	out := map[string]*fileDiff{}
	var cur *fileDiff
	var oldLine, newLine int

	for _, raw := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(raw, "diff --git"):
			cur = nil
		case strings.HasPrefix(raw, "+++ "):
			path := stripDiffPrefix(strings.TrimPrefix(raw, "+++ "))
			if path == "" { // /dev/null → deleted file; keep the old path
				continue
			}
			cur = &fileDiff{changedOld: lineSet{}, changedNew: lineSet{}}
			out[path] = cur
		case strings.HasPrefix(raw, "--- "):
			// Remember the old path in case +++ is /dev/null.
			path := stripDiffPrefix(strings.TrimPrefix(raw, "--- "))
			if path != "" && cur == nil {
				cur = &fileDiff{changedOld: lineSet{}, changedNew: lineSet{}}
				out[path] = cur
			}
		case strings.HasPrefix(raw, "@@"):
			oldLine, newLine = parseHunkHeader(raw)
		case cur != nil && strings.HasPrefix(raw, "+") && !strings.HasPrefix(raw, "+++"):
			cur.changedNew[newLine] = true
			newLine++
		case cur != nil && strings.HasPrefix(raw, "-") && !strings.HasPrefix(raw, "---"):
			cur.changedOld[oldLine] = true
			oldLine++
		case cur != nil && strings.HasPrefix(raw, " "):
			oldLine++
			newLine++
		case cur != nil && raw == "":
			oldLine++
			newLine++
		}
	}
	return out
}

// stripDiffPrefix removes "a/" or "b/" and treats /dev/null as "".
func stripDiffPrefix(p string) string {
	p = strings.TrimSpace(p)
	// Drop a trailing timestamp after a tab.
	if idx := strings.IndexByte(p, '\t'); idx >= 0 {
		p = p[:idx]
	}
	if p == "/dev/null" {
		return ""
	}
	if strings.HasPrefix(p, "a/") || strings.HasPrefix(p, "b/") {
		return p[2:]
	}
	return p
}

// parseHunkHeader reads "@@ -oldStart,oldCount +newStart,newCount @@".
func parseHunkHeader(h string) (oldStart, newStart int) {
	for _, f := range strings.Fields(h) {
		if strings.HasPrefix(f, "-") {
			oldStart = parseStart(f[1:])
		} else if strings.HasPrefix(f, "+") {
			newStart = parseStart(f[1:])
		}
	}
	return oldStart, newStart
}

func parseStart(s string) int {
	if idx := strings.IndexByte(s, ','); idx >= 0 {
		s = s[:idx]
	}
	n, _ := strconv.Atoi(s)
	return n
}

// intersects checks whether [start,end] touches a line in the set.
func (fd *fileDiff) intersects(set lineSet, start, end int) bool {
	if end < start {
		end = start
	}
	for ln := start; ln <= end; ln++ {
		if set[ln] {
			return true
		}
	}
	return false
}

// classifyFile determines the status of each block in one file, given the old
// and new blocks and the diff. It returns added/removed/modified blocks;
// unchanged blocks are dropped.
//
// fileAdded/fileDeleted force all new resp. old blocks to be included.
func classifyFile(pr int, path string, oldBlocks, newBlocks []Block, fd *fileDiff, fileAdded, fileDeleted bool) []Block {
	category := categoryFor(path)

	oldBySym := indexBySymbol(oldBlocks)
	newBySym := indexBySymbol(newBlocks)

	var out []Block

	// New side: added or modified.
	for _, nb := range newBlocks {
		nb.PR = pr
		nb.Category = category
		nb.Side = SideNew
		sym := nb.symbol()
		if _, inOld := oldBySym[sym]; !inOld || fileAdded {
			nb.Status = StatusAdded
			out = append(out, nb)
			continue
		}
		// Present in both: modified if new-lines or old-lines hit the span.
		ob := oldBySym[sym]
		modified := fileAdded
		if fd != nil {
			if fd.intersects(fd.changedNew, nb.Line, nb.EndLine) ||
				fd.intersects(fd.changedOld, ob.Line, ob.EndLine) {
				modified = true
			}
		}
		if modified {
			nb.Status = StatusModified
			out = append(out, nb)
		}
	}

	// Old side: removed (symbols that disappeared).
	for _, ob := range oldBlocks {
		ob.PR = pr
		ob.Category = category
		ob.Side = SideOld
		sym := ob.symbol()
		if _, inNew := newBySym[sym]; !inNew || fileDeleted {
			ob.Status = StatusRemoved
			out = append(out, ob)
		}
	}

	return out
}

// indexBySymbol builds a lookup by symbol key; on duplicate keys the first wins
// (v1 behavior; collisions are rare and handled stably this way).
func indexBySymbol(blocks []Block) map[string]Block {
	m := make(map[string]Block, len(blocks))
	for _, b := range blocks {
		if _, ok := m[b.symbol()]; !ok {
			m[b.symbol()] = b
		}
	}
	return m
}

// categoryRule maps a path pattern to a category tag.
type categoryRule struct {
	match func(path string) bool
	tag   string
}

func hasSeg(path, seg string) bool { return strings.Contains(path, seg) }

// categoryRules: first match wins. TEST comes before the app/* rules.
var categoryRules = []categoryRule{
	{func(p string) bool {
		return hasSeg(p, "tests/") || hasSeg(p, "Tests/") || strings.HasSuffix(p, "Test.php")
	}, "TEST"},
	{func(p string) bool { return hasSeg(p, "database/migrations/") }, "MIGRATION"},
	{func(p string) bool { return hasSeg(p, "database/factories/") }, "FACTORY"},
	{func(p string) bool { return hasSeg(p, "app/Actions/") }, "ACTION"},
	{func(p string) bool { return hasSeg(p, "app/Http/Controllers/") }, "CONTROLLER"},
	{func(p string) bool { return hasSeg(p, "app/Http/Requests/") }, "REQUEST"},
	{func(p string) bool { return hasSeg(p, "app/Http/Resources/") }, "RESOURCE"},
	{func(p string) bool { return hasSeg(p, "app/Models/") }, "MODEL"},
	{func(p string) bool { return hasSeg(p, "app/Enums/") }, "ENUM"},
	{func(p string) bool { return hasSeg(p, "app/Jobs/") }, "JOB"},
	{func(p string) bool { return hasSeg(p, "app/Events/") }, "EVENT"},
	{func(p string) bool { return hasSeg(p, "app/Listeners/") }, "LISTENER"},
	{func(p string) bool { return hasSeg(p, "app/Services/") }, "SERVICE"},
	{func(p string) bool { return hasSeg(p, "app/Repository/") || hasSeg(p, "app/Repositories/") }, "REPOSITORY"},
	{func(p string) bool { return hasSeg(p, "app/Builders/") }, "BUILDER"},
	{func(p string) bool { return hasSeg(p, "modules/") }, "MODULE"},
	{func(p string) bool { return hasSeg(p, "routes/") }, "ROUTE"},
	{func(p string) bool { return strings.HasSuffix(p, ".yaml") || strings.HasSuffix(p, ".yml") }, "CONFIG"},
}

// categoryFor derives a category tag from the file path.
func categoryFor(path string) string {
	for _, r := range categoryRules {
		if r.match(path) {
			return r.tag
		}
	}
	return "OTHER"
}
