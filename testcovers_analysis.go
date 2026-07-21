package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"slash/modules/testcovers"
)

// This file is the test-coverage analysis service (package main; it reads the
// head worktree = a side effect, so it is only called from a workflow
// Activity). It statically detects PHPUnit coverage annotations
// (#[CoversMethod], #[CoversClass], "@covers", "@coversDefaultClass") on a
// PR's changed test methods and links each test to the method it covers —
// even when that method lives in a file the PR did not change.
//
// A method-level annotation (names both class and method) resolves without
// AI: #[CoversMethod(Class::class, 'method')], "@covers Class::method", or a
// bare "@covers ::method" combined with the file's "@coversDefaultClass". A
// class-level-only annotation (names only a class — #[CoversClass], bare
// "@covers Class") cannot be resolved statically; it becomes "unresolved" and
// is offered to the resolve_test_covers LLM workflow. No annotation at all is
// the distinct terminal status "unannotated" — the UI shows a warning, never
// an LLM search.
//
// It mirrors callresolve_analysis.go: a whole-worktree symbol index (to
// verify a claimed method really exists) plus per-file annotation scanning,
// no external PHP parser.

var (
	// reCoversMethodAttr matches #[CoversMethod(Class::class, 'method')] — both
	// class and method are always named, so this always resolves statically
	// regardless of whether it sits above a test method or the whole class.
	reCoversMethodAttr = regexp.MustCompile(`#\[\s*CoversMethod\(\s*([\\A-Za-z0-9_]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*\]`)
	// reCoversClassAttr matches #[CoversClass(Class::class)] — names only a
	// class, so which method it covers needs the LLM.
	reCoversClassAttr = regexp.MustCompile(`#\[\s*CoversClass\(\s*([\\A-Za-z0-9_]+)::class\s*\)\s*\]`)
	// reCoversDocblock captures the raw @covers target — "Class::method",
	// "::method" or bare "Class" — disambiguated in Go (RE2 has no lookahead,
	// so we can't tell "Class" from "Class::method" with one regex alone).
	reCoversDocblock = regexp.MustCompile(`@covers\s+([:\\A-Za-z0-9_]+)`)
	// reCoversDefaultClass matches the class-level "@coversDefaultClass Class"
	// docblock tag that gives a bare "@covers ::method" its class.
	reCoversDefaultClass = regexp.MustCompile(`@coversDefaultClass\s+([\\A-Za-z0-9_]+)`)
	// reTestAttr / reTestDocblock mark a method as a PHPUnit test even when its
	// name doesn't start with "test" (the modern #[Test] attribute, or the old
	// "@test" docblock tag).
	reTestAttr     = regexp.MustCompile(`#\[\s*Test\s*\]`)
	reTestDocblock = regexp.MustCompile(`@test\b`)
	// reClassKeyword finds the file's class declaration — the boundary between
	// the "class zone" (file-wide annotations: @coversDefaultClass, or a
	// class-wide #[CoversClass]/"@covers Class") and everything below it.
	reClassKeyword = regexp.MustCompile(`(?m)^\s*(?:abstract\s+|final\s+)?class\s+[A-Za-z_]`)
	// reFunctionKeyword finds the actual `function` keyword within a block's own
	// span — see funcDeclLine. Attribute lines never contain the bare word
	// "function" in practice, but since phpscan.go also folds a leading
	// `/** ... */` PHPDoc into a block's own span (see
	// .claude/rules/blocks-and-ingest.md), a docblock's free-text prose CAN
	// plausibly mention the word "function" (e.g. "This function creates an
	// order."). A bare `\bfunction\b` would then false-match that prose line
	// instead of the real declaration below it. Requiring an opening `(` to
	// follow shortly after (allowing an optional `&` for a reference-return
	// and an optional name for a closure) keeps the match scoped to something
	// that actually looks like a declaration/call, which ordinary doc prose
	// essentially never does.
	reFunctionKeyword = regexp.MustCompile(`\bfunction\b\s*&?\s*\w*\s*\(`)
)

// funcDeclLine returns the absolute source line, within block b's own span,
// where its `function` keyword actually sits. Usually that is simply b.Line —
// but since phpscan.go pulls a block's Line back to its first leading
// `#[...]` attribute and/or `/** ... */` PHPDoc (see
// .claude/rules/blocks-and-ingest.md), a block with one or both now starts one
// or more lines before its `function` keyword. methodZone needs the real
// declaration line (not the attribute/doc line) as the upper bound of the
// "zone above the method" it scans for docblock-style annotations —
// attribute-style annotations living between b.Line and this line are, since
// that scanner change, already part of b's own span and thus already visible
// to a caller scanning b's source (methodZone folds them back in below).
// Falls back to b.Line if, somehow, no `function` keyword is found in the
// span (defensive; should not happen for a real function block).
func funcDeclLine(lines []string, b Block) int {
	limit := b.EndLine
	if limit > len(lines) {
		limit = len(lines)
	}
	for ln := b.Line; ln <= limit; ln++ {
		if reFunctionKeyword.MatchString(lines[ln-1]) {
			return ln
		}
	}
	return b.Line
}

// classZoneFromLine is the absolute file line classZone's returned text
// always starts at — line 1, since classZone slices from the top of the file.
const classZoneFromLine = 1

// coverTarget is one parsed coverage annotation: either a fully-named method
// (Class + Method set) or a class-only reference (Class set, Method empty).
type coverTarget struct {
	class, method, annotation string
	// line is the absolute source line, within the TEST's own file, where
	// this annotation sits (see matchLine in relations.go) — carried onto
	// testcovers.Entry.Line so the frontend can scope/reorder the
	// "Onderliggende code" panel by the reviewer's selected group/line (see
	// .claude/rules/detail-layout.md, "Group-herordening").
	line int
}

// scanTestCovers scans every changed TEST-category block in the PR (a
// PHPUnit test method) for coverage annotations and returns one or more
// testcovers.Entry per test: resolved (method-level annotation, verified),
// unresolved (class-level-only annotation — LLM territory), or unannotated
// (no annotation at all — never sent to an LLM).
func scanTestCovers(dataDir string, pr int, blocks []Block) []testcovers.Entry {
	_, headDir := worktreeDirs(dataDir, pr)
	idx := buildSymbolIndex(headDir)

	type fileInfo struct {
		lines      []string
		fileBlocks []Block
		classZone  string
	}
	cache := map[string]*fileInfo{}

	var out []testcovers.Entry
	for _, b := range blocks {
		if b.Side == SideOld || b.Category != "TEST" {
			continue
		}
		fi, cached := cache[b.File]
		if !cached {
			src, err := os.ReadFile(filepath.Join(headDir, b.File))
			if err != nil {
				cache[b.File] = nil
				continue
			}
			text := string(src)
			fi = &fileInfo{
				lines:      strings.Split(text, "\n"),
				fileBlocks: ScanBlocks(src, b.File),
				classZone:  classZone(text),
			}
			cache[b.File] = fi
		}
		if fi == nil {
			continue
		}

		zone, zoneFrom, hasTestAttr := methodZone(fi.lines, fi.fileBlocks, b)
		if !isTestMethod(b.Name, hasTestAttr) {
			continue
		}

		out = append(out, coverEntriesForTest(idx, headDir, pr, b, zone, zoneFrom, fi.classZone)...)
	}
	return out
}

// classZone returns the file text up to (not including) the first `class`
// keyword — the region a file-wide annotation (@coversDefaultClass, or a
// class-wide #[CoversClass]/bare "@covers Class") lives in. Falls back to the
// whole file if no class keyword is found (defensive — every scanned file is
// a test file with a class).
func classZone(src string) string {
	loc := reClassKeyword.FindStringIndex(src)
	if loc == nil {
		return src
	}
	return src[:loc[0]]
}

// methodZone returns the raw source text immediately above block b's actual
// `function` keyword — its docblock, plus (since phpscan.go now folds a
// method's leading `#[...]` attribute(s) into its own Block.Line/EndLine span,
// see .claude/rules/blocks-and-ingest.md) any attributes that are technically
// already part of b's own span, from b.Line up to that keyword. Bounded by the
// previous same-file block's end line (or a 40-line cap for the first method
// in a class, when no clean boundary is nearby), the absolute file line that
// text starts at (from — the anchor coverTargets converts a match offset into
// via matchLine), and whether a #[Test] attribute or "@test" docblock tag sits
// in that zone.
func methodZone(lines []string, fileBlocks []Block, b Block) (zone string, from int, hasTestAttr bool) {
	prevEnd := 0
	for _, fb := range fileBlocks {
		if fb.Line == b.Line && fb.Name == b.Name && fb.Class == b.Class {
			continue // this is b itself
		}
		if fb.EndLine < b.Line && fb.EndLine > prevEnd {
			prevEnd = fb.EndLine
		}
	}
	declLine := funcDeclLine(lines, b)
	from = prevEnd + 1
	if declLine-from > 40 {
		from = declLine - 40
	}
	if from < 1 {
		from = 1
	}
	to := declLine - 1
	if to < from || to > len(lines) {
		return "", 0, false
	}
	zone = strings.Join(lines[from-1:to], "\n")
	hasTestAttr = reTestAttr.MatchString(zone) || reTestDocblock.MatchString(zone)
	return zone, from, hasTestAttr
}

// isTestMethod reports whether a scanned block looks like a PHPUnit test
// method: the conventional "test..." name prefix, or an explicit #[Test]/
// "@test" marker in its own annotation zone (the modern attribute style does
// not require the name prefix).
func isTestMethod(name string, hasTestAttr bool) bool {
	return strings.HasPrefix(strings.ToLower(name), "test") || hasTestAttr
}

// coverTargets extracts every coverage target named for one test method:
// first the method-level annotations found in its own zone (each explicit
// about class+method, or a bare "::method" combined with the file's
// "@coversDefaultClass"), then any class-wide annotation — checked in the
// method's own zone first, falling back to the file's class zone only when
// the method named nothing at all (a per-method annotation always wins over
// the file-wide default). zoneFrom/classZoneFrom are the absolute file lines
// zone/classZoneText each start at (see methodZone/classZoneFromLine), used
// to anchor each target's line via matchLine.
func coverTargets(zone, classZoneText string, zoneFrom, classZoneFrom int) []coverTarget {
	var targets []coverTarget

	for _, m := range reCoversMethodAttr.FindAllStringSubmatch(zone, -1) {
		targets = append(targets, coverTarget{class: m[1], method: m[2], annotation: "CoversMethod", line: matchLine(zone, m[0], zoneFrom)})
	}

	defaultClass := ""
	if m := reCoversDefaultClass.FindStringSubmatch(classZoneText); m != nil {
		defaultClass = m[1]
	}
	for _, m := range reCoversDocblock.FindAllStringSubmatch(zone, -1) {
		line := matchLine(zone, m[0], zoneFrom)
		for _, t := range docblockTarget(m[1], defaultClass) {
			t.line = line
			targets = append(targets, t)
		}
	}

	for _, m := range reCoversClassAttr.FindAllStringSubmatch(zone, -1) {
		targets = append(targets, coverTarget{class: m[1], annotation: "CoversClass", line: matchLine(zone, m[0], zoneFrom)})
	}

	if len(targets) == 0 {
		for _, m := range reCoversClassAttr.FindAllStringSubmatch(classZoneText, -1) {
			targets = append(targets, coverTarget{class: m[1], annotation: "CoversClass", line: matchLine(classZoneText, m[0], classZoneFrom)})
		}
		for _, m := range reCoversDocblock.FindAllStringSubmatch(classZoneText, -1) {
			if !strings.Contains(m[1], "::") && !strings.HasPrefix(m[1], "::") {
				targets = append(targets, coverTarget{class: m[1], annotation: "@covers-class", line: matchLine(classZoneText, m[0], classZoneFrom)})
			}
		}
	}
	return targets
}

// docblockTarget interprets one raw "@covers" capture: "Class::method" (both
// named, resolves), "::method" (needs defaultClass to resolve; dropped if
// none is known), or a bare "Class" (class-only, LLM territory).
func docblockTarget(raw, defaultClass string) []coverTarget {
	switch {
	case strings.HasPrefix(raw, "::"):
		if defaultClass == "" {
			return nil
		}
		return []coverTarget{{class: defaultClass, method: strings.TrimPrefix(raw, "::"), annotation: "@covers"}}
	case strings.Contains(raw, "::"):
		parts := strings.SplitN(raw, "::", 2)
		return []coverTarget{{class: parts[0], method: parts[1], annotation: "@covers"}}
	default:
		return []coverTarget{{class: raw, annotation: "@covers-class"}}
	}
}

// coverEntriesForTest turns the parsed targets for one test block into
// testcovers.Entry rows: a method-level target is verified against the
// worktree symbol index (an unverifiable claim — e.g. a typo'd method name —
// is dropped, as if it wasn't annotated); a class-only target is skipped when
// a method-level annotation already resolved that same class precisely (no
// point asking the LLM again). No target surviving at all → one "unannotated"
// row.
func coverEntriesForTest(idx *symbolIndex, headDir string, pr int, b Block, zone string, zoneFrom int, classZoneText string) []testcovers.Entry {
	targets := coverTargets(zone, classZoneText, zoneFrom, classZoneFromLine)

	resolvedClasses := map[string]bool{}
	seen := map[string]bool{}
	var rows []testcovers.Entry
	for _, t := range targets {
		if t.method == "" {
			continue
		}
		def := methodOnClass(idx, t.class, t.method)
		if def == nil {
			continue
		}
		key := "method:" + def.Class + "::" + def.Name
		if seen[key] {
			continue
		}
		seen[key] = true
		resolvedClasses[shortName(t.class)] = true
		code := blockSource(headDir, *def)
		rows = append(rows, testcovers.Entry{
			PR: pr, TestID: b.ID(), TargetKey: key, Status: testcovers.StatusResolved, Annotation: t.annotation, Line: t.line,
			CoveredFile: def.File, CoveredClass: def.Class, CoveredMethod: def.Name, CoveredLine: def.Line, CoveredCode: code.Text,
		})
	}
	for _, t := range targets {
		if t.method != "" {
			continue
		}
		short := shortName(t.class)
		if resolvedClasses[short] {
			continue
		}
		key := "class:" + short
		if seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, testcovers.Entry{
			PR: pr, TestID: b.ID(), TargetKey: key, Status: testcovers.StatusUnresolved,
			Annotation: t.annotation, CoveredClass: short, Line: t.line,
		})
	}
	if len(rows) == 0 {
		return []testcovers.Entry{{PR: pr, TestID: b.ID(), TargetKey: "none", Status: testcovers.StatusUnannotated}}
	}
	return rows
}
