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

// classFrame is a class/trait/interface/enum context on the stack.
type classFrame struct {
	name      string
	openDepth int // brace depth the body lives within
}

// scanPHP scans the source. ok=false means: imbalance → let the caller fall back
// to the whole-file block.
func scanPHP(s, filename string) (blocks []Block, ok bool) {
	line := 1
	depth := 0
	var classes []classFrame

	n := len(s)

	// currentClass returns the name of the top frame (or "").
	currentClass := func() string {
		if len(classes) == 0 {
			return ""
		}
		return classes[len(classes)-1].name
	}
	// popClasses removes frames whose body has been closed.
	popClasses := func() {
		for len(classes) > 0 && depth < classes[len(classes)-1].openDepth {
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
		case c == '#' && !(i+1 < n && s[i+1] == '['):
			i = skipToEOL(s, i)

		// --- block comment ---
		case c == '/' && i+1 < n && s[i+1] == '*':
			j, nl, closed := skipBlockComment(s, i)
			if !closed {
				return nil, false
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

		// --- braces (only in code) ---
		case c == '{':
			depth++
			i++
		case c == '}':
			depth--
			i++
			popClasses()

		// --- keywords: class-like, or function ---
		case isIdentStart(c) && isWordBoundary(s, i):
			word, end := readWord(s, i)
			switch word {
			case "class", "trait", "interface", "enum":
				// Find a class name (may be absent: anonymous class).
				name, bodyAt := classHeaderName(s, end)
				if bodyAt >= 0 {
					// Push a frame; the body opens at the next '{' (depth becomes
					// depth+1), so openDepth = depth+1.
					classes = append(classes, classFrame{name: name, openDepth: depth + 1})
				}
				i = end
			case "function":
				b, next, isDecl := scanFunction(s, end, &line, filename, currentClass())
				if isDecl {
					blocks = append(blocks, b)
				}
				i = next
			default:
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
// still counted by the main loop.
func scanFunction(s string, from int, line *int, filename, class string) (Block, int, bool) {
	declLine := *line
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

// --- lexer primitives ------------------------------------------------------

func skipToEOL(s string, i int) int {
	for i < len(s) && s[i] != '\n' {
		i++
	}
	return i
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
