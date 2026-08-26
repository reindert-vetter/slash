package main

import (
	"path/filepath"
	"regexp"
	"strings"
)

// ScanBlocks splits a PHP source into blocks (functions/methods). If that fails
// (not .php, a Blade template, or an imbalance in braces/strings) it returns one
// whole-file block.
//
// It is a single-pass lexer with contexts (code/comment/string/heredoc) so that
// braces inside strings, comments and heredocs do not count toward the body span.
func ScanBlocks(src []byte, filename string) []Block {
	if strings.ToLower(filepath.Ext(filename)) != ".php" || isBladeTemplate(filename) {
		return []Block{wholeFileBlock(src, filename)}
	}
	blocks := scanBlocksRaw(src, filename)
	return splitClassHeaderMembers(blocks, src)
}

// scanBlocksRaw is ScanBlocks WITHOUT splitClassHeaderMembers: a class's header
// region stays the one coarse <class-header> block scanPHP produces.
//
// Only the callresolve analysis uses this. Its rules read a class's header
// region as a whole — rule 6b (classConstDecl: find a constant's declaration),
// rule 8 (trait usage) and rule 9 (resolveClassMembers: split the region into
// member cards) — and none of them wants the region already carved up into
// per-member blocks by the time they see it. Everything that deals in STORED
// blocks (the ingest pipeline, /api/code, blockstats, blockmove) must use
// ScanBlocks instead, so a member block's own symbol resolves.
func scanBlocksRaw(src []byte, filename string) []Block {
	if strings.ToLower(filepath.Ext(filename)) != ".php" || isBladeTemplate(filename) {
		return []Block{wholeFileBlock(src, filename)}
	}
	blocks, ok := scanPHP(string(src), filename)
	if !ok || len(blocks) == 0 {
		return []Block{wholeFileBlock(src, filename)}
	}
	return blocks
}

// splitClassHeaderMembers replaces every coarse <class-header> block with one
// block PER DECLARED MEMBER (constant/property) plus, if there is anything left
// above the first of them (the class's `use Trait;` statements), a residual
// <class-header> block covering just that.
//
// On explicit request: "header moet opgedeeld worden in losse blokken die per
// stuk goedgekeurd moeten worden" — a header used to be one blob whose members
// only ever existed as read-only callresolve cards (see classMember), so a
// changed constant could not be approved on its own and, once its cards hung
// off a sibling method, its changed rows sat in no approval counter at all.
// Now every member is an ordinary Block: its own id, its own diff, its own
// approval, its own row in the index — and, once something references it, an
// ordinary "Onderliggende code" child of the referencing method rather than a
// synthetic leaf card (see resolvedCallChildren in home.mjs).
//
// Each member block spans classMember.BlockLine..EndLine, so a leading
// `#[...]` attribute run and/or PHPDoc lands in that member's OWN code diff
// ("attributes moet je ook als code erboven laten zien"), and the PHPDoc's
// free text becomes the block's Description ("neem description mee als blok
// description") — exactly how scanPHP already treats a method's own
// attributes/doc.
//
// Deliberate boundaries:
//   - Line ranges never overlap, so no line is counted (or approved) twice:
//     the residual header stops one line before the first member block starts.
//   - Content that sits BETWEEN two members without being part of either (a
//     blank line, a loose `use Trait;` after the first constant) belongs to no
//     block — the same, pre-existing hole as the blank lines between two
//     methods, which no block covers either.
//   - A member whose Class::Name symbol is already taken by another block in
//     the same file (a method named exactly like a constant — legal PHP,
//     vanishingly rare) is left in the header rather than emitted, because
//     extractBlockSource/blockstats resolve a block by that symbol and would
//     otherwise read the wrong one.
//   - A header with no members at all is returned untouched.
func splitClassHeaderMembers(blocks []Block, src []byte) []Block {
	hasHeader := false
	for _, b := range blocks {
		if b.Name == classHeaderSentinel {
			hasHeader = true
			break
		}
	}
	if !hasHeader {
		return blocks
	}
	taken := map[string]bool{}
	for _, b := range blocks {
		taken[b.symbol()] = true
	}

	out := make([]Block, 0, len(blocks))
	for _, b := range blocks {
		if b.Name != classHeaderSentinel {
			out = append(out, b)
			continue
		}
		region := sliceLines(src, b.Line, b.EndLine)
		var members []classMember
		prevEnd := b.Line - 1
		for _, m := range scanClassMembers(region.Text, region.Start) {
			if m.BlockLine < b.Line || m.EndLine > b.EndLine {
				continue // defensive: never step outside the header's own range
			}
			// Two declarations sharing one physical line (`const A = 1; const
			// B = 2;`, or a doc comment inline between them) would otherwise
			// overlap, and an overlapping range means a line counted — and
			// approved — twice. The later one starts after its predecessor.
			if m.BlockLine <= prevEnd {
				m.BlockLine = prevEnd + 1
			}
			if m.BlockLine > m.EndLine {
				continue // nothing left of its own to show
			}
			probe := b.Class + "::" + m.Name
			if b.Class == "" {
				probe = m.Name
			}
			if taken[probe] {
				continue
			}
			taken[probe] = true
			prevEnd = m.EndLine
			members = append(members, m)
		}
		if len(members) == 0 {
			out = append(out, b)
			continue
		}
		// The residual header: everything above the first member block. Kept
		// only when it still holds a non-blank line — for the common class
		// whose header is nothing BUT constants/properties there is nothing
		// left to review and the "Class-header" row disappears entirely.
		if residual := b; members[0].BlockLine > residual.Line {
			residual.EndLine = members[0].BlockLine - 1
			if strings.TrimSpace(sliceLines(src, residual.Line, residual.EndLine).Text) != "" {
				out = append(out, residual)
			}
		}
		for _, m := range members {
			out = append(out, Block{
				File:        b.File,
				Class:       b.Class,
				Name:        m.Name,
				Line:        m.BlockLine,
				EndLine:     m.EndLine,
				Description: m.Doc,
				IsTrait:     b.IsTrait,
			})
		}
	}
	return out
}

// earliestLine returns the smallest non-zero of the given 1-based line numbers,
// or 0 when they are all zero. Used to pull a declaration's block start back to
// its leading attribute/PHPDoc, whichever sits highest.
func earliestLine(lines ...int) int {
	best := 0
	for _, ln := range lines {
		if ln > 0 && (best == 0 || ln < best) {
			best = ln
		}
	}
	return best
}

// isBladeTemplate reports whether the path is a Laravel Blade template
// (`*.blade.php`). Such a file ends in `.php` but is a TEMPLATE, not a class:
// its reviewable content lives in markup, `@php`/`@json` directives and inline
// `<script>` blocks, none of which the PHP block model describes.
//
// It gets the whole-file treatment for the same reason a non-.php file does,
// but it needs its own check because "scanPHP found nothing" is NOT the signal
// here: the brace lexer happily reads the JAVASCRIPT function declarations in
// an inline <script> as PHP functions, so a Blade template can yield one or
// more blocks that are real code but the wrong code. Every changed line outside
// those decoy spans then belongs to no block at all and silently disappears
// from the review tree — see .claude/docs/blocks-and-ingest.md.
func isBladeTemplate(filename string) bool {
	return strings.HasSuffix(strings.ToLower(filename), ".blade.php")
}

func wholeFileBlock(src []byte, filename string) Block {
	lines := 1
	for _, c := range src {
		if c == '\n' {
			lines++
		}
	}
	return Block{
		File:    filename,
		Name:    filepath.Base(filename),
		Line:    1,
		EndLine: lines,
	}
}

// classHeaderSentinel is the synthetic method name for a class's "header"
// region: everything between the class/trait/enum's opening brace and its
// first method declaration (trait use-statements, constants, properties —
// e.g. `$fillable`/`$casts` arrays). Captured as one block so changes there
// show up in the block list instead of vanishing. Deterministic and stable
// so added/modified/removed symbol-matching between commits works like any
// other block.
const classHeaderSentinel = "<class-header>"

// classFrame is a class/trait/interface/enum context on the stack.
type classFrame struct {
	name      string
	kind      string // "class" | "trait" | "interface" | "enum"
	openDepth int    // brace depth the body lives within
	// parent is the (possibly qualified) name from this class's `extends`
	// clause, "" when absent — only ever set for kind=="class" (a trait/enum
	// can't extend, and an interface's multiple `extends` is out of scope
	// for the `parent::` resolution rule this feeds, see
	// callresolve_analysis.go). Set for a named AND an anonymous class alike
	// (`new class extends Migration`, classHeaderName's `name==""` case).
	parent string

	// Header-block tracking (class/trait/enum only — see classHeaderSentinel).
	headerEligible bool // named class/trait/enum (not interface, not anonymous)
	headerLine     int  // first line inside the body; 0 = not yet seen
	headerClosed   bool // true once the first method declaration closed the region
}

// scanPHP scans the source. ok=false means: imbalance → let the caller fall back
// to the whole-file block.
func scanPHP(s, filename string) (blocks []Block, ok bool) {
	line := 1
	depth := 0
	var classes []classFrame
	// pendingAttrLine is the line of the first `#[...]` attribute in an
	// uninterrupted run of attributes/modifier-keywords directly above the next
	// `function` declaration (0 = none pending). It lets a function's Block.Line
	// start at its leading attribute(s) instead of at the `function` keyword —
	// see the "function" case below and .claude/docs/blocks-and-ingest.md.
	// Reset to 0 whenever a token appears that is neither an attribute, a
	// modifier keyword, nor `function` itself (so it never leaks onto an
	// unrelated declaration, e.g. a property that happens to carry its own
	// attribute).
	pendingAttrLine := 0
	// pendingDocLine is the line of the most recent `/** ... */` PHPDoc
	// comment directly above the next `function` declaration (0 = none
	// pending) — set for EVERY real PHPDoc, regardless of whether it yields
	// any extractable free-text (see pendingDocText below), mirroring how
	// pendingAttrLine is set for every `#[...]` attribute regardless of its
	// contents. Reset on the exact same triggers as pendingAttrLine. A PHPDoc
	// may sit above a leading attribute run in either order (`/** */` then
	// `#[...]` then `function`, or `#[...]` then `/** */` then `function`),
	// so the "function" case below adopts the EARLIEST of pendingAttrLine/
	// pendingDocLine as the block's Line — a PHPDoc belongs to the function's
	// block just like a leading attribute does (see
	// .claude/docs/blocks-and-ingest.md).
	pendingDocLine := 0
	// pendingDocText is the extracted description from the most recent `/**
	// ... */` PHPDoc comment (see phpDocDescription), pending adoption by the
	// next `function` declaration — independent of, but reset on the exact
	// same triggers as, pendingAttrLine/pendingDocLine above: a PHPDoc may sit
	// above a leading attribute run, so it must survive the attribute/
	// modifier tokens that sit between it and `function`, without being
	// adopted by them. It only fills the Block.Description field; the block's
	// Line/EndLine adoption is driven by pendingDocLine instead.
	pendingDocText := ""

	n := len(s)

	// currentClass returns the name of the top frame (or "").
	currentClass := func() string {
		if len(classes) == 0 {
			return ""
		}
		return classes[len(classes)-1].name
	}
	// currentClassKind returns the kind ("class"/"trait"/"interface"/"enum")
	// of the top frame, or "" if there is none — used to stamp
	// Block.IsInterface on a method declared directly inside an `interface`
	// (see classify.go's category override; .claude/docs/blocks-and-ingest.md).
	currentClassKind := func() string {
		if len(classes) == 0 {
			return ""
		}
		return classes[len(classes)-1].kind
	}
	// currentParent returns the top frame's `extends` target (or "") — stamped
	// onto every method Block declared in that frame, see Block.Parent.
	currentParent := func() string {
		if len(classes) == 0 {
			return ""
		}
		return classes[len(classes)-1].parent
	}
	// popClasses removes frames whose body has been closed. A frame that never
	// saw a method declaration emits its class-header block here, spanning the
	// whole body (see classHeaderSentinel).
	popClasses := func() {
		for len(classes) > 0 && depth < classes[len(classes)-1].openDepth {
			top := classes[len(classes)-1]
			if top.headerEligible && !top.headerClosed && top.headerLine > 0 && top.headerLine <= line-1 {
				blocks = append(blocks, Block{
					File:    filename,
					Class:   top.name,
					Name:    classHeaderSentinel,
					Line:    top.headerLine,
					EndLine: line - 1,
					IsTrait: top.kind == "trait",
				})
			}
			classes = classes[:len(classes)-1]
		}
	}

	i := 0
	for i < n {
		c := s[i]

		switch {
		// --- newline ---
		case c == '\n':
			line++
			i++

		// --- line comment: // or # (but #[ is an attribute, not a comment) ---
		case c == '/' && i+1 < n && s[i+1] == '/':
			i = skipToEOL(s, i)
		case c == '#' && i+1 < n && s[i+1] == '[':
			// PHP attribute #[...] — may span multiple lines and nest brackets/
			// parens/strings (e.g. #[DataProvider('name')] or
			// #[Attr(['a', 'b'])]). Remember where the first one in a run
			// started so a following `function` can adopt it as its Block.Line.
			if pendingAttrLine == 0 {
				pendingAttrLine = line
			}
			j, nl, closed := skipAttribute(s, i)
			if !closed {
				return nil, false
			}
			line += nl
			i = j
		case c == '#':
			i = skipToEOL(s, i)

		// --- block comment ---
		case c == '/' && i+1 < n && s[i+1] == '*':
			// A PHPDoc comment (`/**`, two asterisks at open — as opposed to a
			// plain `/* ... */`, out of scope entirely) always pulls the next
			// function/method declaration's Block.Line back to its own opening
			// line (pendingDocLine) — even a doc with only @tag lines or no
			// content at all. It may ALSO carry a free-text description
			// (pendingDocText); that part still yields "" and leaves earlier
			// pending text alone for a content-less doc, but a later, non-empty
			// PHPDoc overwrites it (last one before the declaration wins for the
			// description — pendingDocLine instead remembers the FIRST one).
			isDoc := i+2 < n && s[i+2] == '*'
			start := i
			startLine := line
			j, nl, closed := skipBlockComment(s, i)
			if !closed {
				return nil, false
			}
			if isDoc {
				if pendingDocLine == 0 {
					pendingDocLine = startLine
				}
				if text := phpDocDescription(s[start:j]); text != "" {
					pendingDocText = text
				}
			}
			line += nl
			i = j

		// --- heredoc / nowdoc ---
		case c == '<' && i+2 < n && s[i+1] == '<' && s[i+2] == '<':
			j, nl, closed := skipHeredoc(s, i)
			if !closed {
				return nil, false
			}
			line += nl
			i = j

		// --- strings ---
		case c == '\'':
			j, nl, closed := skipSingleQuote(s, i)
			if !closed {
				return nil, false
			}
			line += nl
			i = j
		case c == '"':
			j, nl, closed := skipDoubleQuote(s, i)
			if !closed {
				return nil, false
			}
			line += nl
			i = j

		// --- statement end: drop any pending attribute/PHPDoc that never
		// reached a function (e.g. `#[Attr] private $x;`, or a PHPDoc above a
		// property) so it can't leak onto the next, unrelated declaration. ---
		case c == ';':
			pendingAttrLine = 0
			pendingDocLine = 0
			pendingDocText = ""
			i++

		// --- braces (only in code) ---
		case c == '{':
			depth++
			i++
			if len(classes) > 0 {
				top := &classes[len(classes)-1]
				if top.headerEligible && top.headerLine == 0 && depth == top.openDepth {
					top.headerLine = line + 1
				}
			}
		case c == '}':
			depth--
			i++
			popClasses()

		// --- keywords: class-like, or function ---
		case isIdentStart(c) && isWordBoundary(s, i):
			word, end := readWord(s, i)
			switch word {
			case "class", "trait", "interface", "enum":
				// A class/trait/interface/enum keyword ends any pending attribute
				// run — it was meant for a method, not the type declaration. Same
				// for a pending PHPDoc: a class-level doc comment is not (yet)
				// captured as a block description or adopted into a block's Line
				// (out of scope — only function/method blocks get either, see
				// blocks-and-ingest.md).
				pendingAttrLine = 0
				pendingDocLine = 0
				pendingDocText = ""
				// Find a class name (may be absent: anonymous class).
				name, bodyAt := classHeaderName(s, end)
				if bodyAt >= 0 {
					// Only a "class" (not trait/interface/enum) can `extends` a
					// single parent; classExtendsTarget scans the header text
					// between the keyword and the body/list of interfaces.
					parent := ""
					if word == "class" {
						parent = classExtendsTarget(s[end:bodyAt])
					}
					// Push a frame; the body opens at the next '{' (depth becomes
					// depth+1), so openDepth = depth+1.
					classes = append(classes, classFrame{
						name:      name,
						kind:      word,
						parent:    parent,
						openDepth: depth + 1,
						// Only a named class/trait/enum gets a header block —
						// interfaces have no header content worth capturing, and an
						// anonymous class has no stable name to key it on.
						headerEligible: name != "" && word != "interface",
					})
				}
				i = end
			case "public", "protected", "private", "static", "abstract", "final", "readonly", "var":
				// A visibility/modifier keyword sits between a leading attribute
				// and `function` (e.g. `#[DataProvider('x')]\npublic function
				// test()`) — keep pendingAttrLine intact across it.
				i = end
			case "function":
				// declLine is where this function's Block.Line starts: normally the
				// `function` keyword's own line, but a directly-preceding, still-
				// pending `#[...]` attribute run and/or `/** ... */` PHPDoc (see the
				// `#[`/block-comment cases above) pulls it back to the EARLIEST of
				// the two — either can sit above the other, and both are
				// conceptually part of this method's block
				// (.claude/docs/blocks-and-ingest.md).
				declLine := line
				earliestPending := 0
				if pendingAttrLine > 0 {
					earliestPending = pendingAttrLine
				}
				if pendingDocLine > 0 && (earliestPending == 0 || pendingDocLine < earliestPending) {
					earliestPending = pendingDocLine
				}
				if earliestPending > 0 {
					declLine = earliestPending
				}
				pendingAttrLine = 0
				pendingDocLine = 0
				doc := pendingDocText
				pendingDocText = ""
				var headerFrame *classFrame
				if len(classes) > 0 {
					top := &classes[len(classes)-1]
					if top.headerEligible && !top.headerClosed && depth == top.openDepth {
						headerFrame = top
					}
				}
				b, next, isDecl := scanFunction(s, end, &line, filename, currentClass(), declLine)
				if isDecl {
					b.Description = doc
					// A method declared directly inside an `interface` (resp.
					// `trait`) body gets flagged so classify.go can override
					// its category to "INTERFACE" (resp. "TRAIT") regardless
					// of the file's path (see
					// .claude/docs/blocks-and-ingest.md).
					b.IsInterface = currentClassKind() == "interface"
					b.IsTrait = currentClassKind() == "trait"
					b.Parent = currentParent()
					blocks = append(blocks, b)
					if headerFrame != nil {
						headerFrame.headerClosed = true
						if headerFrame.headerLine > 0 && headerFrame.headerLine <= declLine-1 {
							blocks = append(blocks, Block{
								File:    filename,
								Class:   headerFrame.name,
								Name:    classHeaderSentinel,
								Line:    headerFrame.headerLine,
								EndLine: declLine - 1,
								IsTrait: headerFrame.kind == "trait",
							})
						}
					}
				}
				i = next
			default:
				// Any other identifier (a type-hint, a variable name after `$`, a
				// property name, ...) means whatever pending attribute/PHPDoc run
				// there was was not directly above a function — drop it.
				pendingAttrLine = 0
				pendingDocLine = 0
				pendingDocText = ""
				i = end
			}

		default:
			i++
		}
	}

	if depth != 0 {
		return nil, false
	}
	return blocks, true
}

// scanFunction handles everything after the `function` keyword. It returns the
// block and the index where the caller continues. isDecl=false means: anonymous
// closure (no name) — then it is not a separate block, but its body braces are
// still counted by the main loop. declLine is the line the resulting Block's
// Line should start at — normally the `function` keyword's own line, but the
// caller passes back the line of a directly-preceding `#[...]` attribute run
// instead, so the attribute is treated as part of this function's block (see
// scanPHP's pendingAttrLine and .claude/docs/blocks-and-ingest.md).
func scanFunction(s string, from int, line *int, filename, class string, declLine int) (Block, int, bool) {
	i := skipSpacesNL(s, from, line)
	// reference-return: `function &name`
	if i < len(s) && s[i] == '&' {
		i = skipSpacesNL(s, i+1, line)
	}
	// Anonymous closure: `function (` or `function() use(...)`.
	if i < len(s) && s[i] == '(' {
		return Block{}, i, false
	}
	if i >= len(s) || !isIdentStart(s[i]) {
		return Block{}, i, false
	}
	name, end := readWord(s, i)

	// Walk to the end of the function: the next '{' (body) or ';' (abstract/
	// interface method). Along the way there may be return types, use(...) etc.;
	// skip those lexically.
	j := end
	for j < len(s) {
		switch s[j] {
		case '\n':
			*line++
			j++
		case '{':
			endLine, next := skipBody(s, j, line)
			b := Block{File: filename, Class: class, Name: name, Line: declLine, EndLine: endLine}
			return b, next, true
		case ';':
			// No body (abstract/interface) → ends on the line the ';' itself
			// is on. That's usually declLine (a leading attribute/PHPDoc-free,
			// single-line stub), but NOT when declLine was pulled back to a
			// leading #[...]/PHPDoc (see the "function" case above) or when the
			// signature itself spans multiple lines — *line has been tracked
			// correctly all along via the newline case just above, so use that
			// instead of declLine (which would otherwise chop the block down to
			// just its opening attribute/PHPDoc line).
			b := Block{File: filename, Class: class, Name: name, Line: declLine, EndLine: *line}
			return b, j + 1, true
		case '/':
			if j+1 < len(s) && s[j+1] == '/' {
				j = skipToEOL(s, j)
			} else if j+1 < len(s) && s[j+1] == '*' {
				nj, nl, closed := skipBlockComment(s, j)
				if !closed {
					return Block{File: filename, Class: class, Name: name, Line: declLine, EndLine: declLine}, len(s), true
				}
				*line += nl
				j = nj
			} else {
				j++
			}
		default:
			j++
		}
	}
	// End of file without a body — treat as a single-line block.
	return Block{File: filename, Class: class, Name: name, Line: declLine, EndLine: declLine}, j, true
}

// skipBody scans from a '{' to the matching '}' with full lexer context.
func skipBody(s string, open int, line *int) (endLine, next int) {
	depth := 0
	i := open
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == '\n':
			*line++
			i++
		case c == '/' && i+1 < n && s[i+1] == '/':
			i = skipToEOL(s, i)
		case c == '#' && !(i+1 < n && s[i+1] == '['):
			i = skipToEOL(s, i)
		case c == '/' && i+1 < n && s[i+1] == '*':
			j, nl, closed := skipBlockComment(s, i)
			if !closed {
				return *line, n
			}
			*line += nl
			i = j
		case c == '<' && i+2 < n && s[i+1] == '<' && s[i+2] == '<':
			j, nl, closed := skipHeredoc(s, i)
			if !closed {
				return *line, n
			}
			*line += nl
			i = j
		case c == '\'':
			j, nl, closed := skipSingleQuote(s, i)
			if !closed {
				return *line, n
			}
			*line += nl
			i = j
		case c == '"':
			j, nl, closed := skipDoubleQuote(s, i)
			if !closed {
				return *line, n
			}
			*line += nl
			i = j
		case c == '{':
			depth++
			i++
		case c == '}':
			depth--
			i++
			if depth == 0 {
				return *line, i
			}
		default:
			i++
		}
	}
	return *line, n
}

// phpDocDescription extracts the free-text description from a PHPDoc
// comment's raw source text (raw = the full `/** ... */`, delimiters
// included). Every line has its leading `*`/whitespace stripped; the scan
// STOPS at the first tag line (`@param`, `@return`, `@var`, ...). The
// remaining free text keeps its PARAGRAPH structure: lines are joined with a
// space within a paragraph, paragraphs are separated by "\n\n" (the frontend
// renders the result as Markdown, see src/Block.mjs). `{@see X}`/`{@link X}`
// are unwrapped to `X`. Returns "" for a tags-only or empty doc.
// Deterministic, plain text extraction — no AI
// (.claude/docs/blocks-and-ingest.md).
//
// Stopping at the first tag — rather than skipping tag lines individually,
// which is what this did originally — is what keeps a MULTI-LINE tag out of
// the description. Only the `@param` line itself starts with `@`; its
// continuation lines do not, so an array-shape parameter leaked its whole
// type declaration plus every following bullet into the description:
//
//	@param array{
//	    tenant_ids?: list<int>|null,
//	    ...
//	} $input
//	  - `tenant_ids`: an explicit, hand-picked set. ...
//
// all of which ended up glued into one wall of text on the block card
// (observed on ImportSubscriptionStatsFlow::run, PR 13255). A break is safe
// because PHPDoc puts the summary/description FIRST and the tag block after
// it; free text placed BELOW the tags is not a convention we support, and
// losing it is much better than showing raw type syntax to a reviewer.
// A PHPDoc INLINE tag that only wraps a symbol reference: `{@see Foo::bar()}`
// and `{@link https://…}`. The braces and the tag word are pure docblock
// framing that means nothing to a reviewer reading prose, so they are unwrapped
// to the reference itself. Deliberately only these two — any other inline tag
// (`{@inheritDoc}`, …) is left verbatim rather than guessed at.
var reDocInlineRef = regexp.MustCompile(`\{@(?:see|link)\s+([^}]+)\}`)

func phpDocDescription(raw string) string {
	body := strings.TrimSuffix(strings.TrimPrefix(raw, "/**"), "*/")
	// One entry per PARAGRAPH; a blank doc line starts a new one. Lines inside
	// a paragraph are joined with a space (a docblock hard-wraps its prose at
	// ~110 columns, so a lone newline is never meant as a line break), but the
	// blank line between two paragraphs IS meant, and flattening it turned a
	// well-structured docblock into one unreadable run-on.
	var paras []string
	var cur []string
	flush := func() {
		if len(cur) > 0 {
			paras = append(paras, strings.Join(cur, " "))
			cur = nil
		}
	}
	for _, ln := range strings.Split(body, "\n") {
		ln = strings.TrimSpace(ln)
		ln = strings.TrimPrefix(ln, "*")
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, "@") {
			break
		}
		if ln == "" {
			flush()
			continue
		}
		cur = append(cur, ln)
	}
	flush()
	// "\n\n" so the frontend can render this as Markdown paragraphs — see the
	// b.description binding in src/Block.mjs. Harmless for any plain-text
	// consumer: a single-paragraph description is byte-identical to before.
	return reDocInlineRef.ReplaceAllString(strings.Join(paras, "\n\n"), "$1")
}

// --- class members (properties/constants) ----------------------------------

// classMember is one property or constant declaration inside a class body.
//
// It is BOTH the unit splitClassHeaderMembers turns into a real PR block (its
// own id, approval and row in the block index — see that function) and the
// unit resolveClassMembers (callresolve_analysis.go) emits as an
// "Onderliggende code" child descriptor. It used to be only the latter; the
// "a member never becomes a Block" rule this comment carried is WITHDRAWN, on
// explicit request ("header moet opgedeeld worden in losse blokken die per
// stuk goedgekeurd moeten worden").
type classMember struct {
	Kind    string // "const" | "prop"
	Name    string // "MAX_TRIES" resp. "$listen"
	Line    int    // absolute 1-based first line of the declaration
	EndLine int    // absolute 1-based line of its terminating ';'
	Text    string // the declaration source, verbatim
	// BlockLine is where this member's own BLOCK starts: normally Line, but
	// pulled back to a directly-preceding `#[...]` attribute run and/or
	// `/** ... */` PHPDoc, whichever sits highest — exactly what scanPHP's
	// declLine does for a function/method (see blocks-and-ingest.md). That is
	// what puts a member's attributes in its own code diff instead of in the
	// residual header's.
	BlockLine int
	// Doc is the free-text description from a directly-preceding PHPDoc, the
	// same phpDocDescription a method block's Block.Description comes from.
	Doc string
}

// reMemberConst matches a `const NAME =` declaration, with any modifier run
// (final/public/protected/private) already consumed by the statement split and
// an optional PHP 8.3 type between `const` and the name. Greedy-optional type
// group: for a plain `const FOO =` it backtracks to empty and NAME wins.
var reMemberConst = regexp.MustCompile(`\bconst\s+(?:[?\w\\|]+\s+)?([A-Za-z_]\w*)\s*=`)

// reMemberProp matches a property declaration at the START of a statement: at
// least one modifier keyword, an optional type, then `$name`. Anchored, so a
// `$var` deeper inside some other statement never counts.
var reMemberProp = regexp.MustCompile(`^(?:(?:public|protected|private|static|readonly|var|final)\s+)+(?:[?\w\\|]+\s+)?\$([A-Za-z_]\w*)`)

// scanClassMembers splits a class body (typically the <class-header> region,
// whose first line is startLine) into `;`-terminated statements and returns
// the ones that declare a property or a constant. It reuses the same lexer
// primitives as scanPHP, so a `;` inside a string, comment, heredoc, attribute
// or bracket pair never ends a statement — which is what keeps a multi-line
// array default (`protected $listen = [...]`) one single member.
//
// Deliberate limits, all silent (a member that doesn't fit is simply not
// returned, never a half-parsed one):
//   - A grouped declaration (`const A = 1, B = 2;`) yields ONE member, named
//     after the first name, whose Text is the whole statement.
//   - A leading PHPDoc/`#[...]` above the declaration is not folded into the
//     member's Text (unlike a method block's Line, see blocks-and-ingest.md).
//   - A trailing statement with no terminating `;` (truncated source) is
//     dropped rather than swallowing the remainder.
//   - An enum `case X = 'x';` matches neither regex and is skipped, as is a
//     `use TraitName;` (which has its own callresolve rule 8).
func scanClassMembers(src string, startLine int) []classMember {
	var out []classMember
	if startLine < 1 {
		startLine = 1
	}
	line := startLine
	depth := 0
	stmtStart, stmtLine := -1, 0
	n := len(src)
	// pendingAttrLine/pendingDocLine/pendingDocText mirror scanPHP's own
	// trackers of the same name: the leading `#[...]` attribute run and/or
	// `/** ... */` PHPDoc directly above the NEXT declaration, which become
	// that member's BlockLine and Doc. Both are reset at the end of every
	// statement — a member's, but also a non-member's (a `use Trait;`), so a
	// doc written for one never leaks onto the next.
	pendingAttrLine, pendingDocLine := 0, 0
	pendingDocText := ""
	// begin marks the current position as the statement's first character if
	// no statement is open yet.
	begin := func(i int) {
		if stmtStart < 0 {
			stmtStart, stmtLine = i, line
		}
	}

	i := 0
	for i < n {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '/' && i+1 < n && src[i+1] == '/':
			i = skipToEOL(src, i)
		case c == '#' && i+1 < n && src[i+1] == '[':
			if pendingAttrLine == 0 {
				pendingAttrLine = line
			}
			j, nl, closed := skipAttribute(src, i)
			if !closed {
				return out
			}
			line += nl
			i = j
		case c == '#':
			i = skipToEOL(src, i)
		case c == '/' && i+1 < n && src[i+1] == '*':
			docStart, docLine := i, line
			j, nl, closed := skipBlockComment(src, i)
			if !closed {
				return out
			}
			// Only a real `/** ... */` PHPDoc counts (a plain `/* */` is not a
			// doc block), and only the FIRST one of a run supplies BlockLine —
			// same rule as scanPHP's own pendingDocLine.
			if strings.HasPrefix(src[docStart:j], "/**") {
				if pendingDocLine == 0 {
					pendingDocLine = docLine
				}
				if text := phpDocDescription(src[docStart:j]); text != "" {
					pendingDocText = text
				}
			}
			line += nl
			i = j
		case c == '<' && i+2 < n && src[i+1] == '<' && src[i+2] == '<':
			begin(i)
			j, nl, closed := skipHeredoc(src, i)
			if !closed {
				return out
			}
			line += nl
			i = j
		case c == '\'':
			begin(i)
			j, nl, closed := skipSingleQuote(src, i)
			if !closed {
				return out
			}
			line += nl
			i = j
		case c == '"':
			begin(i)
			j, nl, closed := skipDoubleQuote(src, i)
			if !closed {
				return out
			}
			line += nl
			i = j
		case c == '(' || c == '[' || c == '{':
			begin(i)
			depth++
			i++
		case c == ')' || c == ']' || c == '}':
			begin(i)
			depth--
			i++
			if depth < 0 {
				return out // left the class body — stop, don't guess
			}
		case c == ';' && depth == 0:
			if stmtStart >= 0 {
				if m, ok := classifyMemberStatement(src[stmtStart:i], stmtLine, line); ok {
					m.BlockLine = earliestLine(pendingAttrLine, pendingDocLine, m.Line)
					m.Doc = pendingDocText
					out = append(out, m)
				}
			}
			stmtStart = -1
			pendingAttrLine, pendingDocLine, pendingDocText = 0, 0, ""
			i++
		default:
			begin(i)
			i++
		}
	}
	return out
}

// classifyMemberStatement turns one `;`-terminated statement into a member, or
// reports ok=false when it declares neither a property nor a constant.
func classifyMemberStatement(text string, startLine, endLine int) (classMember, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return classMember{}, false
	}
	if m := reMemberProp.FindStringSubmatch(trimmed); m != nil {
		return classMember{Kind: "prop", Name: "$" + m[1], Line: startLine, EndLine: endLine, Text: trimmed}, true
	}
	if m := reMemberConst.FindStringSubmatch(trimmed); m != nil {
		return classMember{Kind: "const", Name: m[1], Line: startLine, EndLine: endLine, Text: trimmed}, true
	}
	return classMember{}, false
}

// --- lexer primitives ------------------------------------------------------

func skipToEOL(s string, i int) int {
	for i < len(s) && s[i] != '\n' {
		i++
	}
	return i
}

// skipAttribute scans a PHP attribute `#[...]` (i points at the '#') to its
// matching ']', respecting nested brackets (an argument can itself contain an
// array literal, e.g. `#[Attr(['a', 'b'])]`) and string literals (so a `]`
// inside a quoted argument doesn't end it early). closed=false means
// unterminated → the caller falls back to the whole-file block, same as an
// unbalanced brace.
func skipAttribute(s string, i int) (next, newlines int, closed bool) {
	i += 2 // "#["
	depth := 1
	n := len(s)
	for i < n {
		c := s[i]
		switch {
		case c == '\n':
			newlines++
			i++
		case c == '\'':
			j, nl, ok := skipSingleQuote(s, i)
			if !ok {
				return n, newlines, false
			}
			newlines += nl
			i = j
		case c == '"':
			j, nl, ok := skipDoubleQuote(s, i)
			if !ok {
				return n, newlines, false
			}
			newlines += nl
			i = j
		case c == '[':
			depth++
			i++
		case c == ']':
			depth--
			i++
			if depth == 0 {
				return i, newlines, true
			}
		default:
			i++
		}
	}
	return n, newlines, false
}

func skipBlockComment(s string, i int) (next, newlines int, closed bool) {
	i += 2 // "/*"
	for i+1 < len(s) {
		if s[i] == '\n' {
			newlines++
		}
		if s[i] == '*' && s[i+1] == '/' {
			return i + 2, newlines, true
		}
		i++
	}
	return len(s), newlines, false
}

func skipSingleQuote(s string, i int) (next, newlines int, closed bool) {
	i++ // opening quote
	for i < len(s) {
		switch s[i] {
		case '\\':
			i += 2
		case '\n':
			newlines++
			i++
		case '\'':
			return i + 1, newlines, true
		default:
			i++
		}
	}
	return len(s), newlines, false
}

func skipDoubleQuote(s string, i int) (next, newlines int, closed bool) {
	i++ // opening quote
	for i < len(s) {
		switch s[i] {
		case '\\':
			i += 2
		case '\n':
			newlines++
			i++
		case '"':
			return i + 1, newlines, true
		default:
			// We deliberately ignore `{$..}` interpolation: a '{' inside a string
			// does not count as a code brace because we are in the string context.
			i++
		}
	}
	return len(s), newlines, false
}

// skipHeredoc handles <<<LABEL ... LABEL and <<<'LABEL' ... LABEL (nowdoc).
func skipHeredoc(s string, i int) (next, newlines int, closed bool) {
	i += 3 // "<<<"
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	if i < len(s) && (s[i] == '\'' || s[i] == '"') {
		i++
	}
	labelStart := i
	for i < len(s) && isIdentPart(s[i]) {
		i++
	}
	label := s[labelStart:i]
	if label == "" {
		return len(s), newlines, false
	}
	// Consume to the end of the opening line.
	for i < len(s) && s[i] != '\n' {
		i++
	}
	// Find a line that (after optional indent) starts with label, followed by a
	// non-identifier char (or end of input).
	for i < len(s) {
		if s[i] == '\n' {
			newlines++
			j := i + 1
			for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
				j++
			}
			if strings.HasPrefix(s[j:], label) {
				after := j + len(label)
				if after >= len(s) || !isIdentPart(s[after]) {
					return after, newlines, true
				}
			}
			i++
		} else {
			i++
		}
	}
	return len(s), newlines, false
}

// skipSpacesNL skips whitespace and counts newlines.
func skipSpacesNL(s string, i int, line *int) int {
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\r':
			i++
		case '\n':
			*line++
			i++
		default:
			return i
		}
	}
	return i
}

// classHeaderName reads the name after a class/trait/interface/enum keyword. For
// an anonymous class (`new class extends X {`) there is no name. bodyAt is the
// index of the '{' that opens the body, or -1 if no body follows.
func classHeaderName(s string, from int) (name string, bodyAt int) {
	i := from
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n') {
		i++
	}
	if i < len(s) && isIdentStart(s[i]) {
		w, _ := readWord(s, i)
		// An anonymous class ("new class extends X {") has no name — the next
		// word is a keyword, not an identifier.
		if w != "extends" && w != "implements" {
			name = w
		}
	}
	// Look for the body '{' or a ';' (forward decl / no body). Stop at ';'.
	for i < len(s) {
		switch s[i] {
		case '{':
			return name, i
		case ';':
			return name, -1
		default:
			i++
		}
	}
	return name, -1
}

// reClassExtends matches a class header's `extends X` clause, X possibly
// namespace-qualified (`extends \App\Base\Foo`). Anchored to the keyword, not
// to the start of the string, so it works on the header segment
// classExtendsTarget is handed (from right after the `class` keyword up to
// the body-opening `{`) regardless of an anonymous class's constructor args
// or an `implements ...` clause following it.
var reClassExtends = regexp.MustCompile(`\bextends\s+([\\\w]+)`)

// classExtendsTarget returns the (possibly qualified) parent class name from
// a class header segment, "" when there is none. Only ever called for a
// `class` frame (never trait/interface/enum) — see the classFrame.parent doc
// comment. header is everything between the `class` keyword and the body's
// opening `{`, so this never crosses into the class body itself (a nested
// `extends`-like string inside a method could otherwise confuse a whole-file
// regex).
func classExtendsTarget(header string) string {
	m := reClassExtends.FindStringSubmatch(header)
	if m == nil {
		return ""
	}
	return m[1]
}

// --- char classification ---------------------------------------------------

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}

// readWord reads an identifier starting at i.
func readWord(s string, i int) (word string, end int) {
	start := i
	for i < len(s) && isIdentPart(s[i]) {
		i++
	}
	return s[start:i], i
}

// isWordBoundary verifies the char before i is not part of an identifier (so
// `myfunction` is not seen as the keyword `function`).
func isWordBoundary(s string, i int) bool {
	if i == 0 {
		return true
	}
	return !isIdentPart(s[i-1])
}
