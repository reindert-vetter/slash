package main

import (
	"path/filepath"
	"strings"
	"unicode"
)

// blockstats.go computes, per block, how many aligned diff rows a reviewer must
// approve for that block to count as fully approved — the "total" the sidebar and
// the "Start" header show. This is a faithful Go port of the frontend's
// changedRows(blockRows(b)) (Block.mjs): it reads the old/new source from the
// base/head worktrees (like /api/code), applies the same dedent4 + LCS line
// alignment, and counts the changed, non-whitespace-only rows. Keeping the count
// server-side means the "total" is known immediately (before a block's code has
// been lazily fetched), and it lives in exactly the same row-index space as the
// approved rows in approvals.db, so done/total is always consistent.
//
// READ-only: it only reads worktree files (a side effect, but no mutation), so it
// is free to run from a read-only HTTP handler per the write-boundary rule.

// blockAlignedRows builds a block's aligned diff rows — the canonical row-index
// space that /api/code's rendered diff, approvals.db's approved row indices and a
// comment's row_start/row_end anchor all share. It is the single place that reads
// the two sides and applies the display transform, so no consumer can drift out of
// that space:
//
//   - The OLD side is read from the block's pre-move path AND pre-move symbol
//     (b.oldPath() / b.OldClass+b.OldName, mirroring b.oldSymbol()) so a moved
//     file — or a renamed/moved METHOD, see blockmove.go — is diffed against
//     where its source actually was in the base worktree. Both fall back to the
//     block's current path/symbol when the PR didn't move it.
//   - Both sides go through enrichedCodeSides (codesig.go): fold a leading
//     PHPDoc's @return/@param types into the signature, else drop the leading
//     doc outright, then trim one wholly-blank trailing line — unless the doc
//     itself was actually edited between old and new, in which case it stays
//     visible as ordinary code on both sides (see enrichedCodeSides' own doc
//     comment). Exactly what /api/code applies for display, so a row index
//     always means the row the reviewer actually sees — never a since-hidden
//     docblock line, and a changed PHPDoc counts toward the approve total
//     exactly like any other visible changed line.
//
// The returned sides are post-transform, so their Start is already corrected for
// the removed doc lines: a caller converting between a row index and an absolute
// source line (rowForLine) must count from these, not from the raw
// extractBlockSource. dedent4 only strips a leading indent, never a line, so the
// line counts still line up with Start.
func blockAlignedRows(baseDir, headDir string, b Block) (rows []alignRow, oldSide, newSide codeSide) {
	oldRel := b.oldPath()
	oldClass, oldName := b.Class, b.Name
	if b.OldName != "" {
		oldClass, oldName = b.OldClass, b.OldName
	}
	oldSide, newSide, _ = enrichedCodeSidesFor(b.File,
		extractBlockSource(filepath.Join(baseDir, oldRel), oldRel, oldClass, oldName),
		extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name),
	)
	oldText, newText := dedent4(oldSide.Text, newSide.Text)
	return alignRows(oldText, newText), oldSide, newSide
}

// rowDisplayText returns the text a reviewer actually sees on an aligned row: the
// new/right side, or the old/left side when the row has no right side at all (a
// pure deletion). The same side choice approveHere/commentedHere make on the
// frontend. It deliberately keys off presence rather than rowHasContent's
// rightMark == "ins" test: the two only disagree on a context row, where both
// sides carry the same text modulo whitespace.
func rowDisplayText(r alignRow) string {
	if r.right != nil {
		return *r.right
	}
	if r.left != nil {
		return *r.left
	}
	return ""
}

// blockChangedRowCount returns the number of changed, non-ws-only aligned rows
// for a block, read from the base/head worktrees. Mirrors changedRows(blockRows).
func blockChangedRowCount(baseDir, headDir string, b Block) int {
	rows, _, _ := blockAlignedRows(baseDir, headDir, b)
	return countChangedRows(rows)
}

// changedRowCount is the exact port of the frontend changedRows(blockRows(b)):
// dedent4 → alignRows → count rows that carry a del/ins mark, aren't a
// whitespace-only re-alignment, and aren't a blank line (rowHasContent).
func changedRowCount(oldText, newText string) int {
	oldText, newText = dedent4(oldText, newText)
	return countChangedRows(alignRows(oldText, newText))
}

// countChangedRows counts the approvable rows of an already-aligned row list.
func countChangedRows(rows []alignRow) int {
	n := 0
	for _, r := range rows {
		if rowChanged(r) && rowHasContent(r) {
			n++
		}
	}
	return n
}

// firstChangedRowIndex returns the index of the first approvable (changed,
// non-ws-only) row, for a caller that needs ONE representative row to anchor
// something onto the block as a whole — see anchoredWarning (code_warning.go)
// for why: a finding that pins to a block but not to any specific row still
// needs a real row_start/row_end (an unpinned -1/-1 falls back to "shown
// anywhere in the block" for EVERY selection within it, not just the block-wide
// one, see commentUnder in RelatedPanel.mjs). false when the block has no
// changed row at all (shouldn't happen for a block the diff ever surfaced, but
// checked rather than assumed).
func firstChangedRowIndex(rows []alignRow) (int, bool) {
	for i, r := range rows {
		if rowChanged(r) && rowHasContent(r) {
			return i, true
		}
	}
	return 0, false
}

// alignRow mirrors one row of the frontend alignRows output. A nil pointer means
// the side is absent (a filler row); leftMark/rightMark are "del"/"ins" or "".
type alignRow struct {
	left, right         *string
	leftMark, rightMark string
}

// dedent4 is the Go port of Block.mjs dedent4: when every non-blank line of BOTH
// sides starts with 4 spaces, drop those 4 spaces everywhere; otherwise leave the
// text untouched. Blank lines are left as-is.
func dedent4(oldText, newText string) (string, string) {
	combined := oldText + "\n" + newText
	all := true
	any := false
	for _, l := range strings.Split(combined, "\n") {
		if strings.TrimSpace(l) == "" {
			continue
		}
		any = true
		if !strings.HasPrefix(l, "    ") {
			all = false
			break
		}
	}
	if !any || !all {
		return oldText, newText
	}
	strip := func(t string) string {
		lines := strings.Split(t, "\n")
		for i, l := range lines {
			if strings.HasPrefix(l, "    ") {
				lines[i] = l[4:]
			}
		}
		return strings.Join(lines, "\n")
	}
	return strip(oldText), strip(newText)
}

// splitLines mirrors JS `text ? text.split('\n') : []`: an empty string yields no
// lines (not one empty line, as strings.Split would).
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// alignRows is the Go port of Block.mjs alignRows.
func alignRows(oldText, newText string) []alignRow {
	a := splitLines(oldText)
	b := splitLines(newText)
	ops := diffLines(a, b)

	var rows []alignRow
	var dels, inss []string
	flush := func() {
		n := len(dels)
		if len(inss) > n {
			n = len(inss)
		}
		for i := 0; i < n; i++ {
			var left, right *string
			var leftMark, rightMark string
			if i < len(dels) {
				v := dels[i]
				left = &v
				leftMark = "del"
			}
			if i < len(inss) {
				v := inss[i]
				right = &v
				rightMark = "ins"
			}
			rows = append(rows, alignRow{left: left, right: right, leftMark: leftMark, rightMark: rightMark})
		}
		dels = nil
		inss = nil
	}
	for _, op := range ops {
		switch op.op {
		case "eq":
			flush()
			l, r := op.left, op.right
			if op.left == op.right {
				rows = append(rows, alignRow{left: &l, right: &r})
			} else {
				// Equal but for whitespace: a pure re-indent — emit as a paired
				// del/ins so wsOnly catches it downstream (not counted as changed).
				rows = append(rows, alignRow{left: &l, right: &r, leftMark: "del", rightMark: "ins"})
			}
		case "del":
			dels = append(dels, op.left)
		default: // "ins"
			inss = append(inss, op.right)
		}
	}
	flush()
	return rows
}

// diffOp mirrors one op of the frontend diffLines.
type diffOp struct {
	op          string // "eq" | "del" | "ins"
	left, right string
}

// diffLines is the Go port of Block.mjs diffLines: a classic LCS line diff that
// matches lines whitespace-insensitively (via wsKey, à la `git diff -w`).
func diffLines(a, b []string) []diffOp {
	n := len(a)
	m := len(b)
	ka := make([]string, n)
	for i, s := range a {
		ka[i] = wsKey(s)
	}
	kb := make([]string, m)
	for j, s := range b {
		kb[j] = wsKey(s)
	}
	// dp[i][j] = LCS length of ka[i:], kb[j:].
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if ka[i] == kb[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	var ops []diffOp
	i, j := 0, 0
	for i < n && j < m {
		if ka[i] == kb[j] {
			ops = append(ops, diffOp{op: "eq", left: a[i], right: b[j]})
			i++
			j++
		} else if dp[i+1][j] >= dp[i][j+1] {
			ops = append(ops, diffOp{op: "del", left: a[i]})
			i++
		} else {
			ops = append(ops, diffOp{op: "ins", right: b[j]})
			j++
		}
	}
	for i < n {
		ops = append(ops, diffOp{op: "del", left: a[i]})
		i++
	}
	for j < m {
		ops = append(ops, diffOp{op: "ins", right: b[j]})
		j++
	}
	return ops
}

// wsKey mirrors JS s.replace(/\s+/g, ”): drop every whitespace character.
func wsKey(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// wsOnly is the Go port of Block.mjs wsOnly: a paired del/ins row whose two sides
// differ only in whitespace (a re-indent) — noise, not a real change.
func wsOnly(r alignRow) bool {
	return r.leftMark == "del" && r.rightMark == "ins" &&
		r.left != nil && r.right != nil &&
		wsKey(*r.left) == wsKey(*r.right)
}

// rowChanged is the Go port of Block.mjs rowChanged: the row carries a del/ins
// mark and isn't a whitespace-only re-alignment.
func rowChanged(r alignRow) bool {
	return (r.leftMark != "" || r.rightMark != "") && !wsOnly(r)
}

// rowHasContent is the Go port of Block.mjs rowHasContent: whether a changed
// row's display side (the new/right side for an ins row, else the old/left
// side) actually carries non-blank text, so a blank line that's purely part
// of the diff (e.g. inside a wholly added function) doesn't count toward the
// approve total. Keep in lockstep with Block.mjs — see its comment for the
// full rationale.
func rowHasContent(r alignRow) bool {
	text := r.left
	if r.rightMark == "ins" {
		text = r.right
	}
	return text != nil && strings.TrimSpace(*text) != ""
}
