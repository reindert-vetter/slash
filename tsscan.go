package main

import (
	"regexp"
	"sort"
	"strings"
)

// scanTS splits a TypeScript source into top-level function blocks, PLUS one
// class's own methods/fields (see scanTSClassMembers below) — v1 scope: the
// declaration shapes documented on scanTSFunctions and scanTSClassMembers,
// each requiring a real `{ ... }` block body. Falls back to one whole-file
// block when nothing matches, mirroring ScanBlocks' PHP fallback so an empty
// result never drops the file from the review tree.
//
// This is deliberately the same pragmatic style as phpscan.go: regex +
// brace/paren counting over a source where strings/comments/template
// literals are blanked out first, not a real parser. See
// .claude/docs/blocks-and-ingest.md, "tsscan.go: TypeScript function
// splitting".
func scanTS(src []byte, filename string) []Block {
	blocks := scanTSFunctions(string(src), filename)
	if len(blocks) == 0 {
		return []Block{wholeFileBlock(src, filename)}
	}
	return blocks
}

var (
	// reTSFunctionDecl matches a top-level `function` declaration — optionally
	// `export`/`export default`/`async`, optionally a generator `*`. Group 1
	// is the function name; the match ends right after the opening `(` of the
	// parameter list.
	reTSFunctionDecl = regexp.MustCompile(`(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(`)
	// reTSArrowDecl matches a top-level `const|let|var name = (async)? (` —
	// an arrow function assignment with no left-side type annotation (v1
	// boundary, see scanTSFunctions' own doc comment: `const x: Handler = ...`
	// is not detected). Group 1 is the name; the match ends right after the
	// opening `(` of the parameter list, same shape as reTSFunctionDecl.
	reTSArrowDecl = regexp.MustCompile(`(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(`)
	// reTSClassDecl matches a top-level `class Name` declaration — optionally
	// `export`/`export default`/`abstract`. Group 1 is the class name; the
	// match ends right after the name, so callers still need to skip past an
	// `extends .../implements ...` clause to find the body `{` (done via
	// skipToTSBodyOpen, same helper the function/arrow shapes reuse).
	reTSClassDecl = regexp.MustCompile(`(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)`)
	// reTSMethodDecl matches a class member method signature, anchored at the
	// member's own line start (so a call expression inside a method body,
	// e.g. `this.init()`, is never mistaken for a declaration — a real method
	// signature is always the first token on its line, a call site never
	// is). Optional modifiers, optional generator `*`, then a name (plain
	// identifier or `#private`) or `constructor`, ending right after the
	// opening `(` of the parameter list. See scanTSClassMembers.
	reTSMethodDecl = regexp.MustCompile(`(?m)^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?[ \t]*(#?[A-Za-z_$][\w$]*)\s*\(`)
	// reTSComputedMethodOpen matches the START of a computed method name —
	// `[<expr>](` — up to and including the opening `[`; the matching `]` is
	// found separately via matchTSBracket. See scanTSClassMembers.
	reTSComputedMethodOpen = regexp.MustCompile(`(?m)^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?[ \t]*\[`)
	// reTSFieldArrowDecl matches a class field assigned an arrow function —
	// `name (: SimpleType)? = (async)? (` — no `const|let|var` keyword (class
	// fields don't have one), optional modifiers, optional single-line type
	// annotation (a type spanning a real `=>` inside it, e.g. a function
	// type, is a known v1 gap — see scanTSClassMembers). Group 1 is the name.
	reTSFieldArrowDecl = regexp.MustCompile(`(?m)^[ \t]*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^\n=]*)?=\s*(?:async\s+)?\(`)
)

// tsReservedWords excludes a control-flow/keyword token from ever being
// mistaken for a method/field name by reTSMethodDecl/reTSFieldArrowDecl (e.g.
// a bare `if (` or `while (` at a method body's own top level would otherwise
// match the same "name immediately followed by `(`" shape).
var tsReservedWords = map[string]bool{
	"if": true, "for": true, "while": true, "switch": true, "catch": true,
	"return": true, "throw": true, "new": true, "typeof": true, "function": true,
	"else": true, "do": true, "delete": true, "void": true, "await": true,
	"yield": true, "in": true, "of": true, "instanceof": true, "class": true,
	"const": true, "let": true, "var": true, "import": true, "export": true,
	"default": true, "case": true, "try": true, "finally": true, "super": true,
	"this": true, "null": true, "undefined": true, "true": true, "false": true,
	"break": true, "continue": true,
}

// tsDeclScanCap bounds how far skipToTSBodyOpen scans past a parameter
// list's closing `)` looking for the body — a return type/annotation this
// long is pathological. Hitting the cap just means the declaration is
// skipped (never a wrong match), mirroring ARG_LIST_MAX_ROWS's own reasoning
// on the frontend (home.mjs).
const tsDeclScanCap = 4000

// scanTSFunctions finds every TOP-LEVEL (brace-depth 0) declaration of the
// two free-function shapes, PLUS every top-level `class` — recursing into a
// class body via scanTSClassMembers — and turns each into a Block spanning
// its declaration keyword through its closing `}`.
//
// v1 boundaries, deliberate and documented (not bugs):
//   - Only a `{ ... }` BLOCK body counts. An expression-bodied arrow
//     (`=> x.foo`, `=> ({ ... })`) is skipped entirely — no block, same
//     "silently nothing" precedent as several PHP callresolve rules.
//   - No `.tsx`, no left-side type annotation on a top-level const/let/var
//     arrow assignment, no cross-file anything. A future session may widen
//     this; don't assume any of it is accidental.
//   - A leading JSDoc directly above a declaration IS pulled into the
//     block (Line + Description), like PHP's PHPDoc — see tsBlockWithJSDoc.
//     Otherwise a block's Line starts at its own declaration keyword, never
//     at a blank line above it.
func scanTSFunctions(s, filename string) []Block {
	masked := maskTSStringsAndComments(s)

	type kind int
	const (
		kFunc kind = iota
		kArrow
		kClass
	)
	type candidate struct {
		kind      kind
		name      string
		start     int // offset of the declaration's own first token
		paramOpen int // kFunc/kArrow: offset right after the consumed '(' of the param list
		classEnd  int // kClass: offset right after the consumed class name
	}
	var candidates []candidate
	for _, m := range reTSFunctionDecl.FindAllStringSubmatchIndex(masked, -1) {
		candidates = append(candidates, candidate{kind: kFunc, name: masked[m[2]:m[3]], start: m[0], paramOpen: m[1]})
	}
	for _, m := range reTSArrowDecl.FindAllStringSubmatchIndex(masked, -1) {
		candidates = append(candidates, candidate{kind: kArrow, name: masked[m[2]:m[3]], start: m[0], paramOpen: m[1]})
	}
	for _, m := range reTSClassDecl.FindAllStringSubmatchIndex(masked, -1) {
		candidates = append(candidates, candidate{kind: kClass, name: masked[m[2]:m[3]], start: m[0], classEnd: m[1]})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].start < candidates[j].start })

	var blocks []Block
	pos := 0
	depth := 0
	for _, cand := range candidates {
		if cand.start < pos {
			// Nested inside a region we've already consumed (accepted) or
			// walked past (rejected) — never top-level, skip without
			// touching depth/pos.
			continue
		}
		for i := pos; i < cand.start; i++ {
			switch masked[i] {
			case '{':
				depth++
			case '}':
				if depth > 0 {
					depth--
				}
			}
		}
		pos = cand.start
		if depth != 0 {
			// A nested declaration (inside another function/object/control
			// block) — not top-level, leave it alone.
			continue
		}

		if cand.kind == kClass {
			bodyOpen, ok := skipToTSBodyOpen(masked, cand.classEnd, false)
			if !ok {
				pos = cand.classEnd
				continue
			}
			bodyClose, ok := matchTSBrace(masked, bodyOpen)
			if !ok {
				pos = bodyOpen + 1
				continue
			}
			members, firstMemberStart := scanTSClassMembers(masked, s, filename, cand.name, bodyOpen, bodyClose)
			if len(members) > 0 && firstMemberStart > bodyOpen+1 {
				headerStart := tsLineAt(s, bodyOpen) + 1
				headerEnd := tsLineAt(s, firstMemberStart) - 1
				if headerEnd >= headerStart {
					blocks = append(blocks, Block{
						File: filename, Class: cand.name, Name: classHeaderSentinel,
						Line: headerStart, EndLine: headerEnd,
					})
				}
			}
			blocks = append(blocks, members...)
			// Same "brace-balanced by construction" reasoning as the
			// function/arrow branch below — jump straight past the whole
			// class region.
			pos = bodyClose + 1
			continue
		}

		closeParen, ok := matchTSParen(masked, cand.paramOpen)
		if !ok {
			pos = cand.paramOpen
			continue
		}
		bodyOpen, ok := skipToTSBodyOpen(masked, closeParen+1, cand.kind == kArrow)
		if !ok {
			// No block body at depth 0 within the scan cap — an
			// expression-bodied arrow, an overload signature, or a
			// pathological return type. Silently no block, per this
			// function's own doc comment.
			pos = closeParen + 1
			continue
		}
		bodyClose, ok := matchTSBrace(masked, bodyOpen)
		if !ok {
			pos = bodyOpen + 1
			continue
		}
		b, _ := tsBlockWithJSDoc(s, filename, "", cand.name, cand.start, bodyClose)
		blocks = append(blocks, b)
		// The consumed region [cand.start, bodyClose] is brace-balanced by
		// construction (matchTSBrace found the exact matching close), so
		// depth is unchanged and we can jump straight past it — any
		// candidate whose start falls inside is nested and gets skipped by
		// the `cand.start < pos` guard above.
		pos = bodyClose + 1
	}
	return blocks
}

// scanTSClassMembers splits ONE class's body [bodyOpen, bodyClose) (the
// offsets of its outer `{`/`}`) into member blocks, mirroring phpscan.go's
// splitClassHeaderMembers: everything between the class's opening brace and
// its first recognised member (field declarations, comments) becomes ONE
// residual "<class-header>" block (classHeaderSentinel, reused verbatim from
// phpscan.go) — "a part that can't be split goes in one block" — and every
// recognised member becomes its own Block with Class set to the class name.
// A class with ZERO recognised members contributes nothing at all (as if it
// hadn't been detected as a class) — same "silently nothing" precedent as
// scanTSFunctions' own expression-bodied-arrow case. Returns the member
// blocks plus the offset of the first recognised member (-1 if none), which
// the caller uses to size the header block.
//
// Three member shapes are recognised, all requiring a real `{ ... }` block
// body and all anchored at the member's own physical LINE START (so a call
// expression inside a method body, e.g. `this.init()`, is never mistaken for
// a declaration — a real member signature is always the first token on its
// line, a call site never is; reTSMethodDecl/reTSFieldArrowDecl also filter
// out a handful of reserved words, e.g. a bare `if (`/`while (`, via the same
// "name immediately followed by `(`" shape):
//
//  1. A method, including a getter/setter (`get`/`set` as a modifier) and a
//     generator (`*name(...) {...}`/`async *name(...) {...}`) —
//     reTSMethodDecl.
//  2. A computed-name method — `[<expr>](...) {...}` — reTSComputedMethodOpen
//     finds the opening `[`, matchTSBracket finds its matching `]`, and the
//     block's Name becomes the bracket's own (trimmed) source text wrapped in
//     brackets, e.g. `[Symbol.iterator]` — a deliberately literal, readable
//     choice over inventing a synthetic name; two computed members with
//     differently-formatted but equivalent expressions (whitespace aside)
//     would collide, an accepted v1 edge case.
//  3. A field assigned an arrow function — `name = (...) => {...}`, optional
//     modifiers and a single-line type annotation — reTSFieldArrowDecl. A
//     type annotation containing a real `=>` (e.g. a function type) is a
//     known v1 gap: the regex stops at the first `=`, which would be the
//     `=>` inside such a type, and the field is then not recognised as a
//     method (falls into the header/residual instead) — not observed in
//     this codebase's style, accepted rather than solved with backtracking.
//
// Not supported, deliberately out of v1 scope: a computed FIELD (no `(` right
// after `]`, e.g. a TS index signature `[key: string]: number` or a plain
// computed field `[k] = v`), and a decorator line (`@Foo()`) directly above a
// member — it is not pulled into the member's own span (unlike PHP's
// attribute pull), so it either sits in the header (if before the first real
// member) or, between two members, in the same documented "belongs to no
// block" gap phpscan.go's own class-header splitting accepts.
func scanTSClassMembers(masked, s, filename, className string, bodyOpen, bodyClose int) (out []Block, firstMemberStart int) {
	type mkind int
	const (
		mMethod mkind = iota
		mComputed
		mArrowField
	)
	type memberCand struct {
		kind  mkind
		name  string // set for mMethod/mArrowField; resolved later for mComputed
		start int    // offset of the member's own first token
		after int    // offset right after the matched head: '(' for mMethod/mArrowField, '[' for mComputed
	}
	region := masked[bodyOpen+1 : bodyClose]
	var cands []memberCand
	for _, m := range reTSMethodDecl.FindAllStringSubmatchIndex(region, -1) {
		name := region[m[2]:m[3]]
		if tsReservedWords[strings.TrimPrefix(name, "#")] {
			continue
		}
		cands = append(cands, memberCand{kind: mMethod, name: name, start: bodyOpen + 1 + m[0], after: bodyOpen + 1 + m[1]})
	}
	for _, m := range reTSComputedMethodOpen.FindAllStringIndex(region, -1) {
		cands = append(cands, memberCand{kind: mComputed, start: bodyOpen + 1 + m[0], after: bodyOpen + 1 + m[1]})
	}
	for _, m := range reTSFieldArrowDecl.FindAllStringSubmatchIndex(region, -1) {
		name := region[m[2]:m[3]]
		if tsReservedWords[strings.TrimPrefix(name, "#")] {
			continue
		}
		cands = append(cands, memberCand{kind: mArrowField, name: name, start: bodyOpen + 1 + m[0], after: bodyOpen + 1 + m[1]})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].start < cands[j].start })

	firstMemberStart = -1
	pos := bodyOpen + 1
	depth := 0
	for _, c := range cands {
		if c.start < pos {
			continue
		}
		for i := pos; i < c.start; i++ {
			switch masked[i] {
			case '{':
				depth++
			case '}':
				if depth > 0 {
					depth--
				}
			}
		}
		pos = c.start
		if depth != 0 {
			continue
		}

		switch c.kind {
		case mMethod:
			closeParen, ok := matchTSParen(masked, c.after)
			if !ok {
				pos = c.after
				continue
			}
			bOpen, ok := skipToTSBodyOpen(masked, closeParen+1, false)
			if !ok {
				pos = closeParen + 1
				continue
			}
			bClose, ok := matchTSBrace(masked, bOpen)
			if !ok {
				pos = bOpen + 1
				continue
			}
			b, start := tsBlockWithJSDoc(s, filename, className, c.name, c.start, bClose)
			if firstMemberStart == -1 {
				firstMemberStart = start
			}
			out = append(out, b)
			pos = bClose + 1
		case mComputed:
			bracketClose, ok := matchTSBracket(masked, c.after)
			if !ok {
				pos = c.after
				continue
			}
			j := bracketClose + 1
			for j < len(masked) && isTSSpace(masked[j]) {
				j++
			}
			if j >= len(masked) || masked[j] != '(' {
				// Not a method — a computed field or index signature.
				// Accepted v1 gap, see this function's own doc comment.
				pos = bracketClose + 1
				continue
			}
			closeParen, ok := matchTSParen(masked, j+1)
			if !ok {
				pos = j + 1
				continue
			}
			bOpen, ok := skipToTSBodyOpen(masked, closeParen+1, false)
			if !ok {
				pos = closeParen + 1
				continue
			}
			bClose, ok := matchTSBrace(masked, bOpen)
			if !ok {
				pos = bOpen + 1
				continue
			}
			name := "[" + strings.TrimSpace(s[c.after:bracketClose]) + "]"
			b, start := tsBlockWithJSDoc(s, filename, className, name, c.start, bClose)
			if firstMemberStart == -1 {
				firstMemberStart = start
			}
			out = append(out, b)
			pos = bClose + 1
		case mArrowField:
			closeParen, ok := matchTSParen(masked, c.after)
			if !ok {
				pos = c.after
				continue
			}
			bOpen, ok := skipToTSBodyOpen(masked, closeParen+1, true)
			if !ok {
				pos = closeParen + 1
				continue
			}
			bClose, ok := matchTSBrace(masked, bOpen)
			if !ok {
				pos = bOpen + 1
				continue
			}
			b, start := tsBlockWithJSDoc(s, filename, className, c.name, c.start, bClose)
			if firstMemberStart == -1 {
				firstMemberStart = start
			}
			out = append(out, b)
			pos = bClose + 1
		}
	}
	return out, firstMemberStart
}

// matchTSBracket finds the offset of the `]` matching the `[` that ended just
// before `from` (so `from` is the first byte AFTER that opening bracket) —
// the bracket-counting sibling of matchTSParen, used for a computed member
// name.
func matchTSBracket(masked string, from int) (int, bool) {
	depth := 1
	for i := from; i < len(masked); i++ {
		switch masked[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

// matchTSParen finds the offset of the `)` matching the `(` that ended just
// before `from` (so `from` is the first byte AFTER that opening paren).
// Depth counts `(`/`)` only — nested brackets/braces inside a parameter list
// (destructuring, default object/array values, a callback param type) don't
// throw this off since they never change the paren count on their own.
func matchTSParen(masked string, from int) (int, bool) {
	depth := 1
	for i := from; i < len(masked); i++ {
		switch masked[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

// matchTSBrace finds the offset of the `}` matching the `{` at `open`.
func matchTSBrace(masked string, open int) (int, bool) {
	depth := 1
	for i := open + 1; i < len(masked); i++ {
		switch masked[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

// skipToTSBodyOpen scans forward from `from` (right after a parameter list's
// closing `)`) looking for the declaration's block body, skipping over an
// optional return type / arrow (`=>` for the arrow-declaration shape).
// `<`/`>`/`(`/`[`/`)`/`]` are tracked as one combined nesting depth so a
// generic return type (`Promise<void>`) or an array type (`number[]`)
// doesn't trip up the search for the real `{`/`=>`/`;` at the declaration's
// OWN top level.
//
//   - Function declaration: the first `{` found at nesting depth 0 is the
//     body; a `;` at depth 0 first means a body-less signature (e.g. an
//     overload) — no block.
//   - Arrow declaration: the first `=>` found at nesting depth 0 must be
//     followed (after whitespace) by a `{` — anything else is an
//     expression body, out of v1 scope, no block.
func skipToTSBodyOpen(masked string, from int, isArrow bool) (int, bool) {
	n := len(masked)
	limit := from + tsDeclScanCap
	if limit > n {
		limit = n
	}
	depth := 0
	for i := from; i < limit; i++ {
		c := masked[i]
		switch c {
		case '(', '[', '<':
			depth++
			continue
		case ')', ']', '>':
			if depth > 0 {
				depth--
			}
			continue
		}
		if depth != 0 {
			continue
		}
		if isArrow {
			if c == '=' && i+1 < n && masked[i+1] == '>' {
				j := i + 2
				for j < n && isTSSpace(masked[j]) {
					j++
				}
				if j < n && masked[j] == '{' {
					return j, true
				}
				return 0, false
			}
			continue
		}
		if c == '{' {
			return i, true
		}
		if c == ';' {
			return 0, false
		}
	}
	return 0, false
}

func isTSSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// tsBlockWithJSDoc builds the Block for a declaration starting at byte
// offset declStart and ending on the `}` at bodyClose, pulling Line back to a
// leading JSDoc (`/** ... */`) directly above it — the TS sibling of
// phpscan.go's pendingDocLine/pendingDocText: the doc's free text becomes
// Block.Description (same phpDocDescription, JSDoc and PHPDoc share the
// delimiter and the "prose first, @tags after" convention), and the doc
// lines themselves are clipped from the displayed code by code.go's
// enrichedCodeSide, exactly as for a PHP method. start is the block's
// effective first byte (the doc's `/**` when one was pulled in), which the
// class splitter needs so its residual <class-header> stops before it.
func tsBlockWithJSDoc(s, filename, class, name string, declStart, bodyClose int) (b Block, start int) {
	start = declStart
	b = Block{File: filename, Class: class, Name: name, EndLine: tsLineAt(s, bodyClose)}
	if docStart, raw, ok := tsLeadingJSDoc(s, declStart); ok {
		start = docStart
		b.Description = phpDocDescription(raw)
	}
	b.Line = tsLineAt(s, start)
	return b, start
}

// tsLeadingJSDoc reports whether the declaration at declStart is directly
// preceded — only whitespace in between — by a `/** ... */` comment that
// opens its own line, and returns that comment's start offset and raw text.
// A plain `/* ... */` (single star) or a `//` comment is not a doc and is
// left out, same two-star-only rule as phpscan.go.
func tsLeadingJSDoc(s string, declStart int) (docStart int, raw string, ok bool) {
	j := declStart
	for j > 0 && isTSSpace(s[j-1]) {
		j--
	}
	if j < 2 || s[j-2:j] != "*/" {
		return 0, "", false
	}
	open := strings.LastIndex(s[:j-2], "/**")
	if open < 0 || strings.Contains(s[open+3:j-2], "*/") {
		return 0, "", false
	}
	ls := open
	for ls > 0 && (s[ls-1] == ' ' || s[ls-1] == '\t') {
		ls--
	}
	if ls > 0 && s[ls-1] != '\n' {
		return 0, "", false
	}
	return open, s[open:j], true
}

// tsLineAt returns the 1-based line number of byte offset `pos` in `s`.
func tsLineAt(s string, pos int) int {
	if pos > len(s) {
		pos = len(s)
	}
	return strings.Count(s[:pos], "\n") + 1
}

// maskTSStringsAndComments returns a same-length copy of `s` with every
// single/double-quoted string, template literal (BACKTICKS — including the
// `${...}` interpolation content, deliberately left fully opaque, see this
// function's own boundary note below) and comment (`//`, `/* */`) replaced by
// spaces, newlines kept as-is so line numbers stay aligned with the original.
// Used only to find declaration keywords/braces/parens reliably — the actual
// Block.Line/EndLine are read off byte OFFSETS, which are identical between
// `s` and this masked copy.
//
// v1 boundary: a nested template literal, or a backtick, inside a `${...}`
// interpolation is not specially handled (the whole “ `...` “ run up to the
// next unescaped backtick is masked as one opaque span) — vanishingly rare in
// practice and the same kind of pragmatic simplification phpscan.go makes for
// PHP heredocs.
func maskTSStringsAndComments(s string) string {
	b := []byte(s)
	out := make([]byte, len(b))
	copy(out, b)
	n := len(b)
	blank := func(from, to int) {
		for j := from; j < to; j++ {
			if out[j] != '\n' {
				out[j] = ' '
			}
		}
	}
	i := 0
	for i < n {
		c := b[i]
		switch {
		case c == '/' && i+1 < n && b[i+1] == '/':
			start := i
			for i < n && b[i] != '\n' {
				i++
			}
			blank(start, i)
		case c == '/' && i+1 < n && b[i+1] == '*':
			start := i
			i += 2
			for i+1 < n && !(b[i] == '*' && b[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
			blank(start, i)
		case c == '\'' || c == '"' || c == '`':
			quote := c
			start := i
			i++
			for i < n && b[i] != quote {
				if b[i] == '\\' && i+1 < n {
					i++
				}
				i++
			}
			if i < n {
				i++ // consume the closing quote
			}
			blank(start, i)
		default:
			i++
		}
	}
	return string(out)
}
