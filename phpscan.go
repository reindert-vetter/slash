package main

import (
	"path/filepath"
	"strings"
)

// ScanBlocks splits a PHP source into blocks (functions/methods). If that fails
// (not .php, or an imbalance in braces/strings) it returns one whole-file block.
//
// It is a single-pass lexer with contexts (code/comment/string/heredoc) so that
// braces inside strings, comments and heredocs do not count toward the body span.
func ScanBlocks(src []byte, filename string) []Block {
	if strings.ToLower(filepath.Ext(filename)) != ".php" {
		return []Block{wholeFileBlock(src, filename)}
	}
	blocks, ok := scanPHP(string(src), filename)
	if !ok || len(blocks) == 0 {
		return []Block{wholeFileBlock(src, filename)}
	}
	return blocks
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
	openDepth int // brace depth the body lives within

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
	// see the "function" case below and .claude/rules/blocks-and-ingest.md.
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
	// .claude/rules/blocks-and-ingest.md).
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
					// Push a frame; the body opens at the next '{' (depth becomes
					// depth+1), so openDepth = depth+1.
					classes = append(classes, classFrame{
						name:      name,
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
				// (.claude/rules/blocks-and-ingest.md).
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
// scanPHP's pendingAttrLine and .claude/rules/blocks-and-ingest.md).
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
			// No body (abstract/interface) → single-line block.
			b := Block{File: filename, Class: class, Name: name, Line: declLine, EndLine: declLine}
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
// included). Every line has its leading `*`/whitespace stripped; a line that
// is empty or starts with `@` (a tag: `@param`, `@return`, `@var`, ...) is
// dropped. The remaining lines are joined with a single space into one
// paragraph. Returns "" for a tags-only or empty doc. Deterministic, plain
// text extraction — no AI (.claude/rules/blocks-and-ingest.md).
func phpDocDescription(raw string) string {
	body := strings.TrimSuffix(strings.TrimPrefix(raw, "/**"), "*/")
	var parts []string
	for _, ln := range strings.Split(body, "\n") {
		ln = strings.TrimSpace(ln)
		ln = strings.TrimPrefix(ln, "*")
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "@") {
			continue
		}
		parts = append(parts, ln)
	}
	return strings.Join(parts, " ")
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
