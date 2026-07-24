package main

import (
	"regexp"
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

// reBareTestAttribute matches a source line that, once surrounding whitespace
// is trimmed, consists of nothing but a bare PHPUnit `#[Test]` attribute — no
// arguments, no other attribute sharing the line.
var reBareTestAttribute = regexp.MustCompile(`^#\[\s*Test\s*\]$`)

// isBareTestAttributeOnlyChange reports whether every changed line
// intersecting old block ob / new block nb is a bare `#[Test]` attribute line
// within that block's leading-attribute prefix (see phpscan.go's
// pendingAttrLine / .claude/rules/blocks-and-ingest.md) — i.e. the block only
// picked up "modified" because a `#[Test]` was added, removed, or otherwise
// touched, with nothing else in the method changed.
//
// This is deliberately narrow: a DIFFERENT leading attribute (e.g.
// `#[DataProvider(...)]`) still counts as a real, reviewable change and must
// keep classifying as modified — see TestAttributeOnlyChangeClassifiesAsModified.
func isBareTestAttributeOnlyChange(fd *fileDiff, oldLines, newLines []string, ob, nb Block) bool {
	if fd == nil {
		return false
	}
	return onlyBareTestAttributeLinesChanged(fd.changedNew, newLines, nb) &&
		onlyBareTestAttributeLinesChanged(fd.changedOld, oldLines, ob)
}

// onlyBareTestAttributeLinesChanged reports whether every line of `set` that
// falls within b's span is both inside its leading-attribute prefix (up to,
// not including, its actual `function` keyword line — funcDeclLine, shared
// with testcovers_analysis.go) and is itself nothing but a bare `#[Test]`.
// A block with no leading attribute at all (funcDeclLine == b.Line) trivially
// fails this for any changed line, since the prefix is then empty.
func onlyBareTestAttributeLinesChanged(set lineSet, lines []string, b Block) bool {
	attrEnd := funcDeclLine(lines, b) - 1
	for ln := b.Line; ln <= b.EndLine; ln++ {
		if !set[ln] {
			continue
		}
		if ln > attrEnd || !reBareTestAttribute.MatchString(strings.TrimSpace(sourceLine(lines, ln))) {
			return false
		}
	}
	return true
}

// sourceLine returns lines[ln-1] (1-indexed), or "" if out of range.
func sourceLine(lines []string, ln int) string {
	if ln < 1 || ln > len(lines) {
		return ""
	}
	return lines[ln-1]
}

// classifyFile determines the status of each block in one file, given the old
// and new blocks and the diff. It returns added/removed/modified blocks;
// unchanged blocks are dropped.
//
// fileAdded/fileDeleted force all new resp. old blocks to be included.
// oldSrc/newSrc are the two versions' full source text — needed (only) to
// tell a bare `#[Test]`-only change apart from a real one, see
// isBareTestAttributeOnlyChange.
//
// oldFile is the file's pre-rename path when the PR moved it (else ""); it is
// stamped on every emitted block so the frontend can show old-above-new path
// and /api/code/blockstats read the old side from there. The old and new
// blocks are matched on symbol() as usual, so a method present in both a
// renamed file's old and new version pairs up as one modified block instead of
// a removed+added pair.
func classifyFile(pr int, path, oldFile string, oldBlocks, newBlocks []Block, fd *fileDiff, fileAdded, fileDeleted bool, oldSrc, newSrc string) []Block {
	category := categoryFor(path)

	oldBySym := indexBySymbol(oldBlocks)
	newBySym := indexBySymbol(newBlocks)

	// Split once, not per block — only needed for the bare-#[Test]-only check
	// below, so skip the work entirely when there is no diff to check against.
	var oldLines, newLines []string
	if fd != nil {
		oldLines = strings.Split(oldSrc, "\n")
		newLines = strings.Split(newSrc, "\n")
	}

	var out []Block

	// New side: added or modified.
	for _, nb := range newBlocks {
		nb.PR = pr
		nb.Category = category
		nb.Side = SideNew
		nb.OldFile = oldFile
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
		if modified && isBareTestAttributeOnlyChange(fd, oldLines, newLines, ob, nb) {
			// The only lines that changed are a bare `#[Test]` attribute line —
			// no argument, no other attribute sharing it, nothing else in the
			// method touched. That carries no reviewable meaning, so drop the
			// block entirely instead of surfacing the whole, otherwise-
			// untouched method as "modified".
			modified = false
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
		ob.OldFile = oldFile
		sym := ob.symbol()
		if _, inNew := newBySym[sym]; !inNew || fileDeleted {
			ob.Status = StatusRemoved
			// A whole-file deletion (file absent from the head worktree — git's
			// `+++ /dev/null` case) is a stronger signal than a single removed
			// method; persist it so the frontend can mark the file prominently.
			ob.FileDeleted = fileDeleted
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
	{func(p string) bool { return hasSeg(p, "app/Policies/") }, "POLICY"},
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
	// Laravel translation files: resources/lang/<locale>/<file>.php (or the
	// older top-level lang/<locale>/<file>.php). Not under app/, so this never
	// clashes with any rule above.
	{func(p string) bool {
		return strings.HasSuffix(p, ".php") && (hasSeg(p, "/lang/") || strings.HasPrefix(p, "lang/"))
	}, "TRANSLATION"},
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
