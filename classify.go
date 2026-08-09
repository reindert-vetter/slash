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
// pendingAttrLine / .claude/docs/blocks-and-ingest.md) — i.e. the block only
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
		if nb.IsInterface {
			// A method declared directly inside an `interface` body wins over
			// the path-based category — the reviewer cares that this is an
			// interface, regardless of which directory it happens to sit in.
			nb.Category = "INTERFACE"
		}
		if nb.IsTrait {
			// Same override for a `trait` body — a trait file isn't confined
			// to a `Traits/` directory, so path alone isn't reliable here
			// either. See .claude/docs/blocks-and-ingest.md.
			nb.Category = "TRAIT"
		}
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
		if ob.IsInterface {
			ob.Category = "INTERFACE"
		}
		if ob.IsTrait {
			ob.Category = "TRAIT"
		}
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
	// Fallback naming-convention rule for `*Interface.php`, placed early (like
	// TEST) so it wins regardless of which app/* directory the file lives
	// under — the same "always wins" precedence the reliable, keyword-based
	// Block.IsInterface override already has in classifyFile. This path-based
	// rule only actually matters for the scanner's whole-file-fallback
	// scenario (a file it can't parse into real blocks — non-.php, or a
	// brace/string imbalance — so Block.IsInterface is never set, see
	// phpscan.go's ScanBlocks/wholeFileBlock): a reliably-parsed interface
	// never reaches this rule, since classifyFile's IsInterface override
	// already stamped "INTERFACE" on its blocks before this path-based
	// fallback would apply.
	{func(p string) bool { return strings.HasSuffix(p, "Interface.php") }, "INTERFACE"},
	// Fallback directory-convention rule for a trait file, placed early for
	// the same reason as the INTERFACE fallback above. Unlike an interface, a
	// trait has no reliable filename suffix convention (a trait can just be
	// `HasIncludeLabel.php`), so this keys on the `Traits/` directory segment
	// instead (e.g. `app/Traits/`, `packages/plugandpay/Traits/`). Like the
	// INTERFACE fallback, this only actually matters for the scanner's
	// whole-file-fallback scenario — a reliably-parsed trait method already
	// gets "TRAIT" from classifyFile's Block.IsTrait override, regardless of
	// path. See .claude/docs/blocks-and-ingest.md.
	{func(p string) bool { return hasSeg(p, "Traits/") }, "TRAIT"},
	{func(p string) bool { return hasSeg(p, "database/migrations/") }, "MIGRATION"},
	{func(p string) bool { return hasSeg(p, "database/factories/") }, "FACTORY"},
	// The three Laravel HTTP-layer directories match on the `Http/<Dir>/`
	// segment, NOT on an `app/` prefix: a module keeps the very same convention
	// under modules/<Name>/Http/Controllers|Requests|Resources/, and those files
	// used to fall through to the generic `modules/` → MODULE rule below. That
	// silently broke every controller-shaped relation for a module PR, since
	// relations.go's routeControllerDetector (and the controller→request/
	// resource/model detectors) filter hard on Category == "CONTROLLER" — a
	// `Route::get(..., [MerchantFeedController::class, 'show'])` therefore never
	// produced a route_controller edge and the controller never showed up as
	// underlying code. Deliberately `Http/Resources/` and not the bare
	// `Resources/`: modules/<Name>/Resources/ is a module's asset/lang
	// directory, which must keep reaching the TRANSLATION rule below.
	{func(p string) bool { return hasSeg(p, "Http/Controllers/") }, "CONTROLLER"},
	{func(p string) bool { return hasSeg(p, "Http/Requests/") }, "REQUEST"},
	{func(p string) bool { return hasSeg(p, "Http/Resources/") }, "RESOURCE"},
	// Laravel translation files: resources/lang/<locale>/<file>.php, the older
	// top-level lang/<locale>/<file>.php, or a module's own
	// modules/<Name>/Resources/lang/<locale>/<file>.php. Must come before the
	// MODULE rule below: a module's lang file also contains "modules/" and
	// would otherwise be misclassified as MODULE instead of TRANSLATION.
	{func(p string) bool {
		return strings.HasSuffix(p, ".php") && (hasSeg(p, "/lang/") || strings.HasPrefix(p, "lang/"))
	}, "TRANSLATION"},
	{func(p string) bool { return hasSeg(p, "routes/") }, "ROUTE"},
	{func(p string) bool { return strings.HasSuffix(p, ".yaml") || strings.HasSuffix(p, ".yml") }, "CONFIG"},
}

// --- module / layer / type directories --------------------------------------
//
// A path in this repo carries up to three independent, each OPTIONAL pieces of
// meaning, which the review tree shows as three separate labels:
//
//  1. the MODULE   — `app/…` or `modules/<Name>/…`; `app` counts as a module
//     name like any other (Reindert), so there is no special case for it;
//  2. the LAYER    — an optional Internal/Shared/Client grouping *inside* a
//     module;
//  3. the TYPE     — the directory saying what kind of thing this is
//     (`Services/` → SERVICE, `Features/` → FEATURE, …). That one is this
//     file's `Category`.
//
// Two directory styles live side by side in the repo and both must work:
//
//	modules/Checkouts/Internal/Services/Foo.php   (new: module/layer/type)
//	modules/Payments/Services/Foo.php             (old: module/type)
//	app/Features/PromotionCodesV2Feature.php      (app behaves like a module)
//	config/services.php                           (plain Laravel: type only)
//
// Only the TYPE is derived here and stored on the block. The module and the
// layer are derived in the frontend straight from `b.file`
// (src/blockPath.mjs), which needs no new column and therefore no re-ingest —
// but that split makes splitBlockPath below a PARITY implementation: keep the
// two in step, or a block could show a layer pill that Go never treated as a
// layer. See .claude/docs/blocks-and-ingest.md.

// moduleLayerDirs — the optional middle layer. Verified against every module
// in the real repo: only these three ever occur as a grouping directory.
var moduleLayerDirs = map[string]bool{
	"Client":   true,
	"Internal": true,
	"Shared":   true,
}

// typeDirCategory maps a "what kind of thing is this" directory segment to its
// category tag. Deliberately a closed table with no fuzzy matching: a segment
// that isn't in it yields "" and the block falls through to OTHER, rather than
// inventing a label from a directory name nobody agreed on.
//
// Deliberately ABSENT, each for its own reason:
//   - `Resources` — under a module that is the assets/lang directory, not a
//     Laravel API resource; it must keep reaching the TRANSLATION rule above.
//     The API resource is `Http/Resources/`, handled there.
//   - `Http`, `Database`, `Tests` — already covered by the earlier, more
//     specific rules (Http/<Dir>/, database/migrations|factories/, TEST).
//   - `Statistics`, `Domain`, `Mapping`, `Application`, `Bridge`, … — too rare
//     or too vague in this repo to mean anything to a reviewer.
var typeDirCategory = map[string]string{
	"Actions":       "ACTION",
	"Adapters":      "ADAPTER",
	"Attributes":    "ATTRIBUTE",
	"Builders":      "BUILDER",
	"Casts":         "CAST",
	"Channels":      "CHANNEL",
	"Charts":        "CHART",
	"Client":        "CLIENT",
	"Clients":       "CLIENT",
	"Collections":   "COLLECTION",
	"Commands":      "COMMAND",
	"Console":       "COMMAND",
	"Config":        "CONFIG",
	"config":        "CONFIG",
	"Contract":      "INTERFACE",
	"Contracts":     "INTERFACE",
	"Interfaces":    "INTERFACE",
	"Data":          "DTO",
	"DTO":           "DTO",
	"DTOs":          "DTO",
	"Drivers":       "DRIVER",
	"Entities":      "ENTITY",
	"Entity":        "ENTITY",
	"Enums":         "ENUM",
	"Events":        "EVENT",
	"Exceptions":    "EXCEPTION",
	"Exports":       "EXPORT",
	"Facades":       "FACADE",
	"Features":      "FEATURE",
	"Filters":       "FILTER",
	"Helpers":       "SUPPORT",
	"Libs":          "SUPPORT",
	"Support":       "SUPPORT",
	"Imports":       "IMPORT",
	"Jobs":          "JOB",
	"Listeners":     "LISTENER",
	"Macros":        "MACRO",
	"Mail":          "MAIL",
	"Mcp":           "MCP",
	"Models":        "MODEL",
	"Notifications": "NOTIFICATION",
	"Nova":          "NOVA",
	"Observers":     "OBSERVER",
	"Plugins":       "PLUGIN",
	"Policies":      "POLICY",
	"Providers":     "PROVIDER",
	"Queries":       "QUERY",
	"Repositories":  "REPOSITORY",
	"Repository":    "REPOSITORY",
	"Routes":        "ROUTE",
	"routes":        "ROUTE",
	"Rules":         "RULE",
	"Validation":    "RULE",
	"Scopes":        "SCOPE",
	"Services":      "SERVICE",
	"Traits":        "TRAIT",
	"ValueObjects":  "VALUE_OBJECT",
	"Workflows":     "WORKFLOW",
}

// splitBlockPath splits a repo-relative path into its optional module, its
// optional layer and its type directory. Any of the three may come back "".
//
// The layer guard is the subtle part. `Client` is genuinely ambiguous in this
// repo: `modules/Checkouts/Client/Services/Foo.php` uses it as a LAYER, while
// `modules/Payments/Client/MollieClient.php` and `app/Client/OrderClient.php`
// use it as a TYPE directory holding files directly. Requiring at least three
// remaining segments (layer / type / file) tells the two apart from the path
// alone, with no filesystem access — which matters, because this runs during
// ingest against paths, not against a checkout.
//
// Mirrored in src/blockPath.mjs for the module/layer labels; keep in step.
func splitBlockPath(path string) (module, layer, typeDir string) {
	segs := strings.Split(path, "/")
	switch {
	case len(segs) > 1 && segs[0] == "app":
		module = "app"
		segs = segs[1:]
	case len(segs) > 2 && segs[0] == "modules":
		module = segs[1]
		segs = segs[2:]
	}
	if len(segs) >= 3 && moduleLayerDirs[segs[0]] {
		layer = segs[0]
		segs = segs[1:]
	}
	// >= 2 so the segment is a real directory and never the file name itself.
	if len(segs) >= 2 {
		typeDir = segs[0]
	}
	return module, layer, typeDir
}

// categoryForTypeDir returns the category of a path's type directory, or ""
// when there is none / it isn't a known type.
func categoryForTypeDir(path string) string {
	_, _, typeDir := splitBlockPath(path)
	if typeDir == "" {
		return ""
	}
	return typeDirCategory[typeDir]
}

// categoryFor derives a category tag from the file path: the explicit rules
// above first (they encode conventions a bare directory name can't, like
// `Http/Controllers/` or a lang file), then the generic module/layer/type
// directory table.
func categoryFor(path string) string {
	for _, r := range categoryRules {
		if r.match(path) {
			return r.tag
		}
	}
	if tag := categoryForTypeDir(path); tag != "" {
		return tag
	}
	return "OTHER"
}
