package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// import_inline.go shows a changed `use` import INSIDE the block that needs it.
//
// Reviewer request: "imports die worden gedaan zodat het gebruikt kan worden in
// een blok (alleen als het is aangepast) in de blok zelf zichtbaar bovenin met -
// of +, die moet ik dan ook goedkeuren (als ze in een andere blok al zijn
// goedgekeurd, zijn ze daar ook goedgekeurd)". So:
//
//   - A changed row of a file's <file-header> block ("Imports", see
//     withFileHeader in phpscan.go) whose NEW side is a `use` line importing a
//     name a changed block of the same file uses is prepended to that block's
//     aligned rows (a copy, flagged imp). Several users → in every one of them.
//   - In the header block itself such a row is flagged hidden: it stays in the
//     row-index space (so line counting and every stored row index keep
//     working) but is not changed, not rendered and not counted. A header with
//     nothing left (every changed row inlined somewhere) leaves the index.
//   - A pure deletion (no new side) or a row nobody uses stays in the header,
//     as before.
//
// The prefix is part of the user block's canonical row space: /api/code,
// blockstats, comment import, reanchor and code_warning all build rows via
// prBlockRows, so a row index means the same everywhere. Keep in lockstep with
// blockRows in src/Block.mjs (it prepends code.imports and applies
// code.hiddenRows).

// importRow is one inlined header row, as /api/code sends it to the frontend.
type importRow struct {
	Left      *string `json:"left"`
	Right     *string `json:"right"`
	LeftMark  string  `json:"leftMark,omitempty"`
	RightMark string  `json:"rightMark,omitempty"`
	HeaderRow int     `json:"headerRow"`         // row index in the header block
	OldLine   int     `json:"oldLine,omitempty"` // 1-based file line on the base side, 0 if absent
	NewLine   int     `json:"newLine,omitempty"` // 1-based file line on the head side, 0 if absent
}

// importPlan is the inlining decision for one set of PR blocks.
type importPlan struct {
	prefix map[string][]importRow  // user block id → its prepended rows, header order
	hidden map[string]map[int]bool // header block id → header rows inlined elsewhere
	empty  map[string]bool         // header block id → no changed row left at all
}

func (p importPlan) prefixFor(b Block) []importRow {
	if p.prefix == nil {
		return nil
	}
	return p.prefix[b.ID()]
}

// importUser is one candidate block for inlineImportRows: its id and head source.
type importUser struct {
	id  string
	src string
}

// inlineImportRows is the pure core: for each user, the header row indices
// (ascending) it should show. A row qualifies when it is changed, has a new side
// and that side imports a short name (importedShortNames) the user's source
// references as an identifier.
func inlineImportRows(headerRows []alignRow, users []importUser) map[string][]int {
	out := map[string][]int{}
	for i, r := range headerRows {
		if r.right == nil || !rowChanged(r) || !rowHasContent(r) {
			continue
		}
		names := importedShortNames(*r.right)
		if len(names) == 0 {
			continue
		}
		res := make([]*regexp.Regexp, 0, len(names))
		for _, n := range names {
			if n != "" {
				res = append(res, regexp.MustCompile(`(^|[^\\A-Za-z0-9_$])`+regexp.QuoteMeta(n)+`\b`))
			}
		}
		for _, u := range users {
			for _, re := range res {
				if re.MatchString(u.src) {
					out[u.id] = append(out[u.id], i)
					break
				}
			}
		}
	}
	return out
}

// planImportInlining computes the importPlan for blocks (any subset of one PR's
// blocks; only the files of headers present in it are considered). Reads each
// involved head file once.
func planImportInlining(baseDir, headDir string, blocks []Block) importPlan {
	plan := importPlan{prefix: map[string][]importRow{}, hidden: map[string]map[int]bool{}, empty: map[string]bool{}}
	for _, hdr := range blocks {
		if hdr.Side == SideOld || hdr.Name != fileHeaderSentinel {
			continue
		}
		var cands []Block
		for _, u := range blocks {
			if u.Side != SideOld && u.File == hdr.File && u.Name != fileHeaderSentinel {
				cands = append(cands, u)
			}
		}
		if len(cands) == 0 {
			continue
		}
		rows, oldSide, newSide := blockAlignedRows(baseDir, headDir, hdr)
		if len(rows) == 0 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(headDir, hdr.File))
		if err != nil {
			continue
		}
		srcBySym := map[string]string{}
		for _, sb := range ScanBlocks(raw, hdr.File) {
			srcBySym[sb.symbol()] = sliceLines(raw, sb.Line, sb.EndLine).Text
		}
		users := make([]importUser, 0, len(cands))
		for _, u := range cands {
			if src := srcBySym[u.symbol()]; src != "" {
				users = append(users, importUser{id: u.ID(), src: src})
			}
		}
		byUser := inlineImportRows(rows, users)
		if len(byUser) == 0 {
			continue
		}
		oldLines, newLines := rowLineNumbers(rows, oldSide.Start, newSide.Start)
		hid := map[int]bool{}
		ids := make([]string, 0, len(byUser))
		for id := range byUser {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			for _, i := range byUser[id] {
				hid[i] = true
				r := rows[i]
				plan.prefix[id] = append(plan.prefix[id], importRow{
					Left: r.left, Right: r.right, LeftMark: r.leftMark, RightMark: r.rightMark,
					HeaderRow: i, OldLine: oldLines[i], NewLine: newLines[i],
				})
			}
		}
		plan.hidden[hdr.ID()] = hid
		left := false
		for i, r := range rows {
			if !hid[i] && rowChanged(r) && rowHasContent(r) {
				left = true
				break
			}
		}
		if !left {
			plan.empty[hdr.ID()] = true
		}
	}
	return plan
}

// rowLineNumbers returns, per aligned row, its 1-based file line on each side
// (0 where the row has no text on that side), counted from the sides' Start.
func rowLineNumbers(rows []alignRow, oldStart, newStart int) (oldLines, newLines []int) {
	oldLines = make([]int, len(rows))
	newLines = make([]int, len(rows))
	o, n := oldStart, newStart
	for i, r := range rows {
		if r.left != nil {
			oldLines[i] = o
			o++
		}
		if r.right != nil {
			newLines[i] = n
			n++
		}
	}
	return
}

// applyImportPlan turns a block's plain aligned rows into its canonical rows:
// the inlined imports prepended (flagged imp, carrying their own file lines),
// or — for a header — the inlined rows flagged hidden.
func applyImportPlan(rows []alignRow, b Block, plan importPlan) []alignRow {
	if hid := plan.hidden[b.ID()]; len(hid) > 0 {
		out := make([]alignRow, len(rows))
		copy(out, rows)
		for i := range out {
			if hid[i] {
				out[i].hidden = true
			}
		}
		return out
	}
	pre := plan.prefixFor(b)
	if len(pre) == 0 {
		return rows
	}
	out := make([]alignRow, 0, len(pre)+len(rows))
	for _, p := range pre {
		out = append(out, alignRow{left: p.Left, right: p.Right, leftMark: p.LeftMark, rightMark: p.RightMark, imp: true})
	}
	return append(out, rows...)
}

// prBlockRows is blockAlignedRows plus the import inlining, computed against the
// PR's blocks of b's file. The canonical row space for every consumer that has
// the PR's block list. The returned sides are the body's own (prefix rows are
// flagged imp and carry no line of the body's sides).
func prBlockRows(baseDir, headDir string, b Block, blocks []Block) (rows []alignRow, oldSide, newSide codeSide) {
	rows, oldSide, newSide = blockAlignedRows(baseDir, headDir, b)
	if len(blocks) == 0 || filepath.Ext(b.File) != ".php" {
		return
	}
	var same []Block
	for _, x := range blocks {
		if x.File == b.File {
			same = append(same, x)
		}
	}
	return applyImportPlan(rows, b, planImportInlining(baseDir, headDir, same)), oldSide, newSide
}

// redirectInlinedImport maps a row of a header block that is hidden there
// (inlined into a user block) to that user block and its prefix row — the
// first user in id order. moved is false for any other row.
func redirectInlinedImport(baseDir, headDir string, b Block, blocks []Block, row int) (Block, int, bool) {
	if b.Name != fileHeaderSentinel || len(blocks) == 0 {
		return b, row, false
	}
	var same []Block
	for _, x := range blocks {
		if x.File == b.File {
			same = append(same, x)
		}
	}
	plan := planImportInlining(baseDir, headDir, same)
	if !plan.hidden[b.ID()][row] {
		return b, row, false
	}
	var best *Block
	bestIdx := 0
	for i := range same {
		for k, p := range plan.prefixFor(same[i]) {
			if p.HeaderRow == row && (best == nil || same[i].ID() < best.ID()) {
				best, bestIdx = &same[i], k
			}
		}
	}
	if best == nil {
		return b, row, false
	}
	return *best, bestIdx, true
}
