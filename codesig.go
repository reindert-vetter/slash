package main

import (
	"regexp"
	"sort"
	"strings"
)

// codesig.go folds a leading PHPDoc's @return/@param type annotations into the
// visible function signature — as if PHP were strict-typed — and removes the
// PHPDoc lines from the text shown to the reviewer. The free-text description
// already lives separately on Block.Description (phpscan.go), so once its
// @return/@param types are spliced into the signature there is nothing left in
// the doc worth showing as its own diff-able code.
//
// This is display-only: it does NOT touch extractBlockSource/blockSource
// themselves (relations.go / callresolve_analysis.go / testcovers_analysis.go
// still read the raw, line-accurate source for their own regex/offset work —
// see .claude/rules/blocks-and-ingest.md). It's applied, via code.go's
// enrichedCodeSide wrapper, at every place a block's source becomes something
// a reviewer actually reads:
//   - api.go's handleCode (what /api/code returns, i.e. what Block.mjs renders)
//   - blockstats.go's blockChangedRowCount (the approve-teller total) — the
//     exact same function feeding both keeps the diff and the approve count
//     in lockstep, mirroring the existing changedRowCount Go/JS-parity pattern
//   - the embedded "Onderliggende code" child snapshots taken at analysis
//     time for an UNCHANGED target (callresolve_analysis.go's method_call/
//     enum-case/migration_model/data_provider rules, testcovers_analysis.go's
//     method-level covers, and the LLM-found paths in resolve_call.go/
//     resolve_test_covers.go) — ChildCode/CoveredCode get the same signature
//     fold as a changed block's diff, and ChildLine/CoveredLine are bumped by
//     enrichedCodeSide's Start the same way, so they'd stay in lockstep with
//     Code if a future consumer ever reads those line fields.
//
// Deliberately "all or nothing" per block: either the whole signature is
// confidently located and rewritten (and the doc fully removed), or nothing at
// all is touched and the PHPDoc stays visible exactly like before. There is no
// partially-mangled middle state.
//
// Known, accepted v1 limitations (see .claude/rules/blocks-and-ingest.md):
//   - The PHPDoc must be the very first thing in the sliced block text — an
//     attribute run BEFORE the PHPDoc (`#[Foo]` then `/** */` then `function`)
//     is not supported; such a block is left untouched (doc stays visible).
//     An attribute AFTER the doc (`/** */` then `#[Foo]` then `function`) is
//     fine — it's simply preserved verbatim between the removed doc and the
//     rewritten signature.
//   - Multi-line signatures (a parameter list or return-type spanning several
//     lines, e.g. constructor property promotion) ARE supported — the parsing
//     below is byte-offset based, not line based, so it scans across newlines.
func enrichSignatureWithDocTypes(text string) (out string, removedLines int) {
	trimmed := strings.TrimLeft(text, " \t")
	if !strings.HasPrefix(trimmed, "/**") {
		return text, 0
	}
	docStart := len(text) - len(trimmed)
	closeRel := strings.Index(text[docStart+3:], "*/")
	if closeRel < 0 {
		return text, 0
	}
	docEnd := docStart + 3 + closeRel + 2 // just past the closing "*/"
	docRaw := text[docStart:docEnd]

	returnType, paramTypes := parseDocReturnParam(docRaw)
	if returnType == "" && len(paramTypes) == 0 {
		// Nothing to fold in (a plain free-text-only doc, or an unparseable
		// tag) — leave the doc fully visible, exactly like before.
		return text, 0
	}

	rest := text[docEnd:]
	loc := reSigFunctionKw.FindStringIndex(rest)
	if loc == nil {
		return text, 0
	}
	afterFn := rest[loc[1]:]
	openParenRel := strings.IndexByte(afterFn, '(')
	if openParenRel < 0 || !reSigFuncNameGap.MatchString(afterFn[:openParenRel]) {
		return text, 0
	}
	openParenAbs := loc[1] + openParenRel
	closeParenAbs, ok := matchBracket(rest, openParenAbs)
	if !ok {
		return text, 0
	}
	paramsRaw := rest[openParenAbs+1 : closeParenAbs]

	var edits []docEdit

	if returnType != "" {
		afterParams := rest[closeParenAbs+1:]
		hasColon, typeStart, typeEnd, okRT := locateReturnTypeRegion(afterParams)
		if !okRT {
			return text, 0
		}
		if hasColon {
			edits = append(edits, docEdit{closeParenAbs + 1 + typeStart, closeParenAbs + 1 + typeEnd, returnType})
		} else {
			edits = append(edits, docEdit{closeParenAbs + 1, closeParenAbs + 1, ": " + returnType})
		}
	}

	if len(paramTypes) > 0 {
		paramEdits, okP := spliceParamTypes(paramsRaw, paramTypes)
		if !okP {
			return text, 0
		}
		for _, pe := range paramEdits {
			edits = append(edits, docEdit{openParenAbs + 1 + pe.start, openParenAbs + 1 + pe.end, pe.repl})
		}
	}

	if len(edits) == 0 {
		// The doc had @param tags but none named an actual parameter of this
		// signature (typo, or the doc is stale) — nothing was actually spliced
		// in, so leave the doc visible rather than silently dropping it for no
		// visible benefit.
		return text, 0
	}

	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	out = rest
	for _, e := range edits {
		out = out[:e.start] + e.repl + out[e.end:]
	}
	strippedNL := false
	if strings.HasPrefix(out, "\n") {
		out = out[1:]
		strippedNL = true
	}
	removedLines = strings.Count(text[:docEnd], "\n")
	if strippedNL {
		removedLines++
	}
	return out, removedLines
}

// docEdit is one splice into `rest` (the block text after the removed doc):
// replace [start,end) with repl. Applied right-to-left (highest start first)
// so earlier edits' offsets never shift.
type docEdit struct {
	start, end int
	repl       string
}

var (
	reSigFunctionKw    = regexp.MustCompile(`\bfunction\b`)
	reSigFuncNameGap   = regexp.MustCompile(`^\s*&?\s*[A-Za-z_]\w*\s*$`)
	reSigParamModifier = regexp.MustCompile(`^(public|protected|private|readonly)\b`)
	reSigVarName       = regexp.MustCompile(`^\$[A-Za-z_]\w*`)
	reSigDocAtTag      = regexp.MustCompile(`^@(\w+)\s*(.*)$`)
)

// parseDocReturnParam extracts @return's type and every @param's type (keyed
// by variable name, without the leading $) from a PHPDoc's raw source
// (delimiters included), tolerating and skipping any tag it can't parse
// cleanly (mirrors phpDocDescription's leniency) rather than failing the
// whole doc. The first @return wins; the first @param for a given name wins.
func parseDocReturnParam(docRaw string) (returnType string, params map[string]string) {
	body := strings.TrimSuffix(strings.TrimPrefix(docRaw, "/**"), "*/")
	params = map[string]string{}
	for _, ln := range strings.Split(body, "\n") {
		ln = strings.TrimSpace(ln)
		ln = strings.TrimPrefix(ln, "*")
		ln = strings.TrimSpace(ln)
		if !strings.HasPrefix(ln, "@") {
			continue
		}
		m := reSigDocAtTag.FindStringSubmatch(ln)
		if m == nil {
			continue
		}
		tag, rest := m[1], m[2]
		switch tag {
		case "return":
			if returnType == "" {
				if t, _, ok := docTypeAt(rest); ok {
					returnType = t
				}
			}
		case "param":
			t, remainder, ok := docTypeAt(rest)
			if !ok {
				continue
			}
			remainder = strings.TrimSpace(remainder)
			nm := reSigVarName.FindString(remainder)
			if nm == "" {
				continue
			}
			name := strings.TrimPrefix(nm, "$")
			if _, exists := params[name]; !exists {
				params[name] = t
			}
		}
	}
	return returnType, params
}

// docTypeAt reads one PHPDoc type expression from the start of s (after
// leading spaces/tabs), generic/shape-aware: it tracks nesting depth over
// `<>`, `()`, `[]`, `{}` (PHPDoc generics like array<string, mixed>, array
// shapes like array{a: int}, …) and stops at the first depth-0 whitespace.
// Returns the type, the remainder of s after it, and ok=false if the brackets
// never balance (a malformed/truncated tag) or there's no type at all.
func docTypeAt(s string) (typ, remainder string, ok bool) {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	start := i
	depth := 0
	for i < len(s) {
		c := s[i]
		if depth == 0 && (c == ' ' || c == '\t') {
			break
		}
		switch c {
		case '<', '(', '[', '{':
			depth++
		case '>', ')', ']', '}':
			depth--
			if depth < 0 {
				return "", "", false
			}
		}
		i++
	}
	if depth != 0 || i == start {
		return "", "", false
	}
	return s[start:i], s[i:], true
}

// matchBracket finds the index of the closing bracket that matches the
// opening bracket at s[openIdx] (one of '(', '[', '{'): it scans forward,
// tracking any nested (), [], {} and skipping quoted string literals (so a
// bracket character inside a default-value string never miscounts), and
// requires the bracket that brings the depth back to 0 to be the exact
// matching closer type — a mismatched pair (malformed/unbalanced source)
// returns ok=false instead of a wrong offset.
func matchBracket(s string, openIdx int) (closeIdx int, ok bool) {
	const openers = "([{"
	const closers = ")]}"
	oi := strings.IndexByte(openers, s[openIdx])
	if oi < 0 {
		return 0, false
	}
	want := closers[oi]
	depth := 0
	i := openIdx
	n := len(s)
	for i < n {
		c := s[i]
		if c == '\'' || c == '"' {
			j, closed := skipQuoted(s, i)
			if !closed {
				return 0, false
			}
			i = j
			continue
		}
		if strings.IndexByte(openers, c) >= 0 {
			depth++
			i++
			continue
		}
		if strings.IndexByte(closers, c) >= 0 {
			depth--
			if depth == 0 {
				if c != want {
					return 0, false
				}
				return i, true
			}
			if depth < 0 {
				return 0, false
			}
			i++
			continue
		}
		i++
	}
	return 0, false
}

// skipQuoted returns the index just past the closing quote of the string
// starting at s[i] (s[i] is ' or "), honouring backslash escapes.
func skipQuoted(s string, i int) (next int, closed bool) {
	q := s[i]
	i++
	n := len(s)
	for i < n {
		if s[i] == '\\' {
			i += 2
			continue
		}
		if s[i] == q {
			return i + 1, true
		}
		i++
	}
	return i, false
}

// splitTopLevel splits s on every occurrence of sep that sits at bracket
// depth 0 (outside any (), [], {} and outside any quoted string) — a
// parameter-list comma split that never breaks inside a default value like
// `array $x = ['a', 'b']` or an attribute `#[Attr(1, 2)]`. Returns the
// [start,end) byte ranges of each segment (never trimmed, so offsets stay
// exact for the caller), or ok=false if the brackets never balance.
func splitTopLevel(s string, sep byte) (segs []struct{ start, end int }, ok bool) {
	depth := 0
	segStart := 0
	i := 0
	n := len(s)
	for i < n {
		c := s[i]
		if c == '\'' || c == '"' {
			j, closed := skipQuoted(s, i)
			if !closed {
				return nil, false
			}
			i = j
			continue
		}
		if c == '(' || c == '[' || c == '{' {
			depth++
			i++
			continue
		}
		if c == ')' || c == ']' || c == '}' {
			depth--
			if depth < 0 {
				return nil, false
			}
			i++
			continue
		}
		if c == sep && depth == 0 {
			segs = append(segs, struct{ start, end int }{segStart, i})
			segStart = i + 1
			i++
			continue
		}
		i++
	}
	if depth != 0 {
		return nil, false
	}
	segs = append(segs, struct{ start, end int }{segStart, n})
	return segs, true
}

// locateReturnTypeRegion looks at whatever follows a signature's closing ')'
// (afterParams — may start with whitespace/newlines, since the return type or
// even the opening `{` can sit on the next line): if it finds a `:`, the
// native return-type token that follows is [typeStart,typeEnd) (hasColon=
// true); if there's no `:` at all, ok is true with hasColon=false as long as
// the next real token is `{` or `;` (a stub/abstract method) — meaning
// "no native return type here, safe to insert one". Anything else (an
// unexpected token, or an unterminated type) is ok=false — the caller bails
// on the whole signature rather than guess.
func locateReturnTypeRegion(afterParams string) (hasColon bool, typeStart, typeEnd int, ok bool) {
	i := 0
	n := len(afterParams)
	for i < n && isSpaceOrNL(afterParams[i]) {
		i++
	}
	if i < n && afterParams[i] == ':' {
		i++
		for i < n && isSpaceOrNL(afterParams[i]) {
			i++
		}
		start := i
		end, balanced := scanNativeReturnTypeEnd(afterParams, i)
		if !balanced || end == start {
			return false, 0, 0, false
		}
		return true, start, end, true
	}
	if i < n && (afterParams[i] == '{' || afterParams[i] == ';') {
		return false, 0, 0, true
	}
	return false, 0, 0, false
}

// scanNativeReturnTypeEnd reads a native PHP return-type token starting at
// s[start] (nullable `?`, namespaced `\Foo\Bar`, unions `|`, and
// parenthesised DNF intersections like `(A&B)|C` all just ride along as plain
// characters — only `(`/`[` are tracked as nesting so the scan doesn't stop
// on an internal paren) up to the first depth-0 whitespace, `{` or `;`.
// balanced=false means the brackets never closed — a malformed signature.
func scanNativeReturnTypeEnd(s string, start int) (end int, balanced bool) {
	depth := 0
	i := start
	n := len(s)
	for i < n {
		c := s[i]
		if depth == 0 && (isSpaceOrNL(c) || c == '{' || c == ';') {
			return i, true
		}
		switch c {
		case '(', '[':
			depth++
		case ')', ']':
			depth--
			if depth < 0 {
				return i, false
			}
		}
		i++
	}
	return i, depth == 0
}

// spliceParamTypes rewrites each parameter of paramsRaw (the raw text between
// a signature's outer parens) whose variable name has a docblock type in
// paramTypes: it replaces just the native type-hint portion of that one
// parameter (leading visibility modifiers, a leading attribute, `&`
// by-reference and `...` variadic markers are all preserved verbatim) with
// the docblock's type, or inserts it if the parameter had no native type at
// all. A parameter whose name isn't in paramTypes is left completely
// untouched. Returns edits in paramsRaw's own byte offsets (the caller shifts
// them into the outer text), or ok=false if the parameter list itself can't
// be confidently split (unbalanced brackets/quotes).
func spliceParamTypes(paramsRaw string, paramTypes map[string]string) (edits []docEdit, ok bool) {
	segs, ok := splitTopLevel(paramsRaw, ',')
	if !ok {
		return nil, false
	}
	for _, seg := range segs {
		text := paramsRaw[seg.start:seg.end]
		dollarRel := strings.IndexByte(text, '$')
		if dollarRel < 0 {
			continue // no variable in this segment — nothing to anchor on
		}
		nm := reSigVarName.FindString(text[dollarRel:])
		if nm == "" {
			continue
		}
		newType, wanted := paramTypes[strings.TrimPrefix(nm, "$")]
		if !wanted {
			continue
		}

		pos := 0
		for {
			for pos < dollarRel && isSpaceOrNL(text[pos]) {
				pos++
			}
			if pos < dollarRel && text[pos] == '#' && pos+1 < dollarRel && text[pos+1] == '[' {
				end, matched := matchBracket(text, pos+1)
				if !matched {
					return nil, false
				}
				pos = end + 1
				continue
			}
			if m := reSigParamModifier.FindString(text[pos:dollarRel]); m != "" {
				pos += len(m)
				continue
			}
			break
		}
		typeStart := pos
		typeEnd := typeStart
		for typeEnd < dollarRel {
			c := text[typeEnd]
			if c == '.' {
				break // start of the "..." variadic marker
			}
			if c == '&' {
				j := typeEnd + 1
				for j < dollarRel && isSpaceOrNL(text[j]) {
					j++
				}
				// A '&' immediately leading into the variable (or "...") is
				// the by-reference marker — stop before it. A '&' followed by
				// another type name is a PHP 8.1 intersection type — part of
				// the type, keep scanning through it.
				if j < dollarRel && (text[j] == '$' || text[j] == '.') {
					break
				}
			}
			typeEnd++
		}
		for typeEnd > typeStart && isSpaceOrNL(text[typeEnd-1]) {
			typeEnd--
		}

		absStart := seg.start + typeStart
		absEnd := seg.start + typeEnd
		if typeEnd > typeStart {
			edits = append(edits, docEdit{absStart, absEnd, newType})
		} else {
			edits = append(edits, docEdit{absStart, absEnd, newType + " "})
		}
	}
	return edits, true
}

func isSpaceOrNL(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}
