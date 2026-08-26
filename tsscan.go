package main

import (
	"regexp"
	"sort"
	"strings"
)

// scanTS splits a TypeScript source into top-level function blocks — v1
// scope: only two declaration shapes, both requiring a real `{ ... }` block
// body (see scanTSFunctions' own doc comment). Falls back to one whole-file
// block when nothing matches, mirroring ScanBlocks' PHP fallback so an empty
// result never drops the file from the review tree.
//
// This is deliberately the same pragmatic style as phpscan.go: regex +
// brace/paren counting over a source where strings/comments/template
// literals are blanked out first, not a real parser. See
// .claude/docs/blocks-and-ingest.md, "tsscan.go: TypeScript function
// splitting (v1, functions only)".
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
)

// tsDeclScanCap bounds how far skipToTSBodyOpen scans past a parameter
// list's closing `)` looking for the body — a return type/annotation this
// long is pathological. Hitting the cap just means the declaration is
// skipped (never a wrong match), mirroring ARG_LIST_MAX_ROWS's own reasoning
// on the frontend (home.mjs).
const tsDeclScanCap = 4000

// scanTSFunctions finds every TOP-LEVEL (brace-depth 0) declaration of the
// two supported shapes and turns each into a Block spanning its declaration
// keyword through its closing `}`.
//
// v1 boundaries, deliberate and documented (not bugs):
//   - Only a `{ ... }` BLOCK body counts. An expression-bodied arrow
//     (`=> x.foo`, `=> ({ ... })`) is skipped entirely — no block, same
//     "silently nothing" precedent as several PHP callresolve rules.
//   - No classes/methods, no `.tsx`, no left-side type annotation on a
//     const/let/var arrow assignment, no cross-file anything. A future
//     session may widen this; don't assume any of it is accidental.
//   - No leading-JSDoc inclusion (unlike PHP's PHPDoc/attribute pull): a
//     block's Line starts at its own declaration keyword. See
//     .claude/docs/blocks-and-ingest.md for why this side-steps
//     code.go's enrichedCodeSide/stripLeadingPhpDoc safely.
func scanTSFunctions(s, filename string) []Block {
	masked := maskTSStringsAndComments(s)

	type candidate struct {
		name      string
		start     int // offset of the declaration's own first token
		paramOpen int // offset right after the consumed '(' of the param list
		isArrow   bool
	}
	var candidates []candidate
	for _, m := range reTSFunctionDecl.FindAllStringSubmatchIndex(masked, -1) {
		candidates = append(candidates, candidate{name: masked[m[2]:m[3]], start: m[0], paramOpen: m[1], isArrow: false})
	}
	for _, m := range reTSArrowDecl.FindAllStringSubmatchIndex(masked, -1) {
		candidates = append(candidates, candidate{name: masked[m[2]:m[3]], start: m[0], paramOpen: m[1], isArrow: true})
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
		closeParen, ok := matchTSParen(masked, cand.paramOpen)
		if !ok {
			pos = cand.paramOpen
			continue
		}
		bodyOpen, ok := skipToTSBodyOpen(masked, closeParen+1, cand.isArrow)
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
		blocks = append(blocks, Block{
			File:    filename,
			Name:    cand.name,
			Line:    tsLineAt(s, cand.start),
			EndLine: tsLineAt(s, bodyClose),
		})
		// The consumed region [cand.start, bodyClose] is brace-balanced by
		// construction (matchTSBrace found the exact matching close), so
		// depth is unchanged and we can jump straight past it — any
		// candidate whose start falls inside is nested and gets skipped by
		// the `cand.start < pos` guard above.
		pos = bodyClose + 1
	}
	return blocks
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
