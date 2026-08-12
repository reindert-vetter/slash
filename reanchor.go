package main

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"slash/modules/approvals"
	"slash/modules/comments"
)

// reanchor.go moves a review comment's and an approval's row anchor along with
// the code when a new commit arrives.
//
// Both anchors live in the aligned-row index space of a block (see
// blockAlignedRows in blockstats.go) and were, until this file existed, written
// exactly once — at placement (task_code_comment's saveComment) or at import
// (mapReviewComment) — and never recomputed. An ingest refresh replaces the blocks
// of the changed files (upsertPRFileBlocks) but deliberately leaves the separate
// comments/approvals read-models alone, so every anchor in a changed file silently
// went stale: a comment kept pointing at a row index that now holds different code
// (its 💬 marker landing on the wrong line, and in diff mode it only resurfaced if
// the cursor happened to land on a unit containing the stale range), and an
// approval re-applied its emerald ✓ to whatever now sat at that index — so lines
// inserted above an approved line silently inherited its approval.
//
// The matcher below re-derives each anchor against the new rows, or degrades it
// honestly when it can't:
//
//   - COMMENTS carry a snapshot of the code they were placed on (comments.Code,
//     built from whole aligned rows by commentTarget in home.mjs — the same side
//     choice as rowDisplayText), so re-anchoring is a search for that snippet in
//     the new rows. No match, or several → AnchorUnpinned (rowStart -1), the
//     pre-existing "block known, row unknown" convention: the comment then shows
//     anywhere within its block and claims no 💬 row. Block gone entirely →
//     AnchorOrphan, so the frontend can surface it instead of losing it.
//   - APPROVALS carry their own per-row anchors (approvals.RowAnchor: the row's
//     displayed text plus its two neighbours, written by persistApproval), so
//     they re-anchor exactly like a comment does: find that text again in the new
//     rows, disambiguating a repeated line by its neighbours. A row that can't be
//     found is DROPPED — you did not approve the code that replaced it. That
//     needs no new state: the row is simply unapproved again.
//     An approval stored BEFORE those anchors existed has only row indices, and
//     falls back to the older path: recover its old text from the previous
//     base/head SHAs (planReanchor materializes those two sides into a shadow
//     worktree pair) and look that up in the new rows. That fallback is exactly
//     what could not work when the PR's base moved (a rebase/merge of main makes
//     every file a "changed" file and the previous SHAs may not even resolve), so
//     the anchors are what make this robust rather than best-effort.
//
// READ-only, like blockstats.go: it reads worktree files and runs `git show`, but
// mutates nothing. The plan it returns is applied by the caller through the
// sanctioned write paths (a Signal per comment / per approval block), so the
// write-boundary rule holds — see planReanchor's own comment.

// commentAnchorUpdate is one comment's new anchor, addressed by its Run ID (which
// is also its comment id). Applied via the comment's own Execution.
type commentAnchorUpdate struct {
	RunID       string `json:"runId"`
	RowStart    int    `json:"rowStart"`
	RowEnd      int    `json:"rowEnd"`
	Seg         string `json:"seg"`
	Gran        string `json:"gran"`
	AnchorState string `json:"anchorState"`
}

// approvalRemap is one block's remapped approval set — the same shape the
// approve tracker's existing `set` Signal already takes. The anchors move along
// with the rows (same text, new row index), so a second refresh re-anchors from
// where this one left off instead of from stale indices.
type approvalRemap struct {
	BlockID string                `json:"blockId"`
	Rows    []int                 `json:"rows"`
	Calls   []string              `json:"calls"`
	Anchors []approvals.RowAnchor `json:"anchors"`
}

// reanchorPlan is everything a refresh wants to change. Empty means every anchor
// in the changed files still resolves to the same rows (the common case for a
// commit that only touches files nobody has commented on or approved).
type reanchorPlan struct {
	Comments  []commentAnchorUpdate `json:"comments,omitempty"`
	Approvals []approvalRemap       `json:"approvals,omitempty"`
}

func (p reanchorPlan) empty() bool { return len(p.Comments) == 0 && len(p.Approvals) == 0 }

// reanchorResult is what the reanchorAfterRefresh Activity records in the workflow
// history: how many anchors actually moved, plus how many comments were
// auto-resolved along the way (see comment_autoresolve.go — a comment whose
// anchor just became orphan, asking to remove exactly that code). Zero is the
// common case.
type reanchorResult struct {
	Comments     int `json:"comments"`
	Approvals    int `json:"approvals"`
	AutoResolved int `json:"autoResolved"`
}

// blockForAnchor finds the block a stored anchor belongs to: same symbol
// (Class::Name, which is what a comment's Label holds and what a block id's last
// segment is) in the same file. It accepts the block's pre-rename path too, so an
// anchor written before the PR moved the file re-attaches instead of orphaning.
func blockForAnchor(blocks []Block, file, label string) (Block, bool) {
	for _, b := range blocks {
		if b.symbol() != label {
			continue
		}
		if b.File == file || b.oldPath() == file {
			return b, true
		}
	}
	return Block{}, false
}

// rowKeys returns the whitespace-insensitive key of every row's displayed text.
// Whitespace-insensitive because that is how the line alignment itself pairs lines
// (diffLines/wsKey, blockstats.go), so a pure re-indent of the anchored code still
// finds its row instead of unpinning the comment.
func rowKeys(rows []alignRow) []string {
	keys := make([]string, len(rows))
	for i, r := range rows {
		keys[i] = wsKey(rowDisplayText(r))
	}
	return keys
}

// matchSnippetRows locates snippet in rows and returns the inclusive row range it
// occupies. Blank rows (a filler row, or a blank line in the middle of an added
// block) are skipped on both sides, so they never break a match — they carry no
// text and are never approvable/landable anyway (rowHasContent).
//
// It requires a UNIQUE match. Several matches means the snippet is something like
// a bare `}` that occurs all over the block, and guessing which one the reviewer
// meant would silently move their comment to the wrong place; the caller then
// unpins it, which is visible and recoverable. Zero matches means the anchored
// code itself was edited — also unpinned.
func matchSnippetRows(rows []alignRow, snippet string) (start, end int, ok bool) {
	var want []string
	for _, line := range strings.Split(snippet, "\n") {
		if k := wsKey(line); k != "" {
			want = append(want, k)
		}
	}
	if len(want) == 0 {
		return 0, 0, false
	}
	keys := rowKeys(rows)
	matches := 0
	for i := range keys {
		if keys[i] != want[0] {
			continue
		}
		// Walk forward matching the remaining snippet lines in order, skipping
		// blank rows in between.
		at, j := i, 1
		for j < len(want) {
			at++
			if at >= len(keys) {
				break
			}
			if keys[at] == "" {
				continue
			}
			if keys[at] != want[j] {
				break
			}
			j++
		}
		if j < len(want) {
			continue
		}
		matches++
		if matches > 1 {
			return 0, 0, false
		}
		start, end = i, at
	}
	if matches != 1 {
		return 0, 0, false
	}
	return start, end, true
}

// planCommentReanchor re-derives the anchor of every block-scoped comment whose
// file the refresh touched, and returns only the ones that actually change.
// Returning nothing for an unchanged anchor is what makes a repeated refresh a
// no-op instead of a burst of identical Signals.
//
// dataDir/pr locate the (already refreshed) base/head worktrees; blocks are the
// PR's current blocks.
func planCommentReanchor(dataDir string, pr int, changedFiles []string, cs []comments.Comment, blocks []Block) []commentAnchorUpdate {
	baseDir, headDir := worktreeDirs(dataDir, pr)
	touched := make(map[string]bool, len(changedFiles))
	for _, f := range changedFiles {
		touched[f] = true
	}
	// One aligned-row build per block, not per comment: several comments on the
	// same method is the norm, and each build re-reads and re-diffs both sides.
	rowsFor := map[string][]alignRow{}

	var out []commentAnchorUpdate
	for _, c := range cs {
		// A PR-wide comment (issue/review summary/unanchorable AI finding) has no
		// row anchor to move. A deleted/deleting one is on its way out.
		if c.Kind != "" || c.Status == "deleting" || c.Status == "deleted" {
			continue
		}
		if !touched[c.File] {
			continue
		}
		b, found := blockForAnchor(blocks, c.File, c.Label)
		if !found {
			// The symbol is gone from the PR: renamed, deleted, or the whole
			// file dropped out. There is no row to re-derive, so keep the old
			// one (it still describes where the comment WAS, and shows in the
			// thread's stored snippet) and mark it so the UI can surface it.
			out = appendAnchorChange(out, c, c.RowStart, c.RowEnd, c.Seg, c.Gran, comments.AnchorOrphan)
			continue
		}
		rows, cached := rowsFor[b.ID()]
		if !cached {
			rows, _, _ = blockAlignedRows(baseDir, headDir, b)
			rowsFor[b.ID()] = rows
		}
		// Nothing to search for: a comment that was already unpinned, or a
		// legacy/seeded one with no stored snippet. Leave its rows exactly as they
		// are (the status quo for such a comment) and only clear a stale orphan
		// mark, now that its block is back.
		if c.RowStart < 0 || c.Code == "" {
			state := comments.AnchorPinned
			if c.RowStart < 0 {
				state = comments.AnchorUnpinned
			}
			out = appendAnchorChange(out, c, c.RowStart, c.RowEnd, c.Seg, c.Gran, state)
			continue
		}
		start, end, ok := matchSnippetRows(rows, c.Code)
		if !ok {
			out = appendAnchorChange(out, c, -1, -1, "", c.Gran, comments.AnchorUnpinned)
			continue
		}
		// A 'call' anchor addresses character offsets within its row (segKey in
		// home.mjs: "r:<min>-<max>"), so it only survives if the row's text is
		// byte-identical — a whitespace-insensitive match means the offsets have
		// shifted. Then the comment degrades to the whole line, which is still
		// exactly where the reviewer put it, just one granularity coarser.
		gran, seg := c.Gran, c.Seg
		if gran == "call" && rowDisplayText(rows[start]) != firstNonBlankLine(c.Code) {
			gran, seg = "line", ""
		}
		out = appendAnchorChange(out, c, start, end, seg, gran, comments.AnchorPinned)
	}
	return out
}

// appendAnchorChange appends an update only when it actually differs from what the
// comment already stores, so an unchanged anchor costs no Signal and no write.
func appendAnchorChange(out []commentAnchorUpdate, c comments.Comment, rowStart, rowEnd int, seg, gran, state string) []commentAnchorUpdate {
	if c.RowStart == rowStart && c.RowEnd == rowEnd && c.Seg == seg && c.Gran == gran && c.AnchorState == state {
		return out
	}
	return append(out, commentAnchorUpdate{
		RunID: c.RunID, RowStart: rowStart, RowEnd: rowEnd,
		Seg: seg, Gran: gran, AnchorState: state,
	})
}

// firstNonBlankLine returns the first line of a snippet that carries text — the
// line matchSnippetRows anchored its start row on.
func firstNonBlankLine(snippet string) string {
	for _, line := range strings.Split(snippet, "\n") {
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return ""
}

// planApprovalRemap remaps every approved row index of the touched blocks into
// the CURRENT aligned-row space and returns only the blocks that actually
// change. An index whose code can no longer be found, or has become ambiguous,
// is dropped: approval means "I read this code", and the code it pointed at is
// no longer there.
//
// Two sources for "what did this row say":
//
//   - the approval's OWN anchors (approvals.RowAnchor, written by the UI at
//     approve time) — self-contained, so it works no matter what happened to the
//     PR in between (new commits, a rebase of the base branch, a force-push, a
//     full re-ingest);
//   - failing that (an approval stored before anchors existed), the previous
//     base/head sides materialized by planReanchor into oldBaseDir/oldHeadDir.
//
// Either way the result carries FRESH anchors for the rows that survived, built
// from the new rows — so a legacy approval upgrades itself on the first refresh
// and every later refresh starts from an accurate description again.
func planApprovalRemap(baseDir, headDir, oldBaseDir, oldHeadDir string, aps []approvals.Approval, blocks []Block, touched map[string]bool) []approvalRemap {
	byID := make(map[string]Block, len(blocks))
	for _, b := range blocks {
		byID[b.ID()] = b
	}

	var out []approvalRemap
	for _, a := range aps {
		b, ok := byID[a.BlockID]
		if !ok || !touched[b.File] {
			// Block gone → nothing to remap onto (the UI already drops such an
			// approval at restore); file untouched → its rows still line up.
			continue
		}
		newRows, _, _ := blockAlignedRows(baseDir, headDir, b)
		if len(newRows) == 0 {
			continue
		}

		// textAt reports the text an approved row USED to hold, for the
		// call-key check below (a "<row>:<segStart>" offset only survives while
		// the row's text is byte-identical).
		var moved map[int]int
		var textAt func(row int) (string, bool)
		if len(a.Anchors) > 0 {
			byRow := make(map[int]approvals.RowAnchor, len(a.Anchors))
			for _, an := range a.Anchors {
				byRow[an.Row] = an
			}
			moved = remapFromAnchors(a.Anchors, newRows)
			textAt = func(row int) (string, bool) {
				an, ok := byRow[row]
				return an.Text, ok
			}
		} else {
			oldRows, _, _ := blockAlignedRows(oldBaseDir, oldHeadDir, b)
			if len(oldRows) == 0 {
				// No anchors AND the previous sides couldn't be read (a
				// `git show` miss, e.g. the file was added since). Leave the
				// approval alone rather than dropping rows on a guess.
				continue
			}
			moved = remapRows(oldRows, newRows)
			textAt = func(row int) (string, bool) {
				if row < 0 || row >= len(oldRows) {
					return "", false
				}
				return rowDisplayText(oldRows[row]), true
			}
		}

		rows := make([]int, 0, len(a.Rows))
		for _, r := range a.Rows {
			if to, ok := moved[r]; ok {
				rows = append(rows, to)
			}
		}
		// A call key is "<row>:<segStart>": the row moves, the character offset
		// within it does not. As with a 'call' comment, the offset is only
		// meaningful while the row's text is byte-identical.
		calls := make([]string, 0, len(a.Calls))
		for _, key := range a.Calls {
			sep := strings.IndexByte(key, ':')
			if sep < 0 {
				continue
			}
			from, err := strconv.Atoi(key[:sep])
			if err != nil {
				continue
			}
			to, ok := moved[from]
			if !ok {
				continue
			}
			was, known := textAt(from)
			if !known || was != rowDisplayText(newRows[to]) {
				continue
			}
			calls = append(calls, strconv.Itoa(to)+key[sep:])
		}
		anchors := anchorsForRows(newRows, rows, calls)
		if sameInts(a.Rows, rows) && sameStrings(a.Calls, calls) && sameAnchors(a.Anchors, anchors) {
			continue
		}
		out = append(out, approvalRemap{BlockID: a.BlockID, Rows: rows, Calls: calls, Anchors: anchors})
	}
	return out
}

// remapFromAnchors resolves each stored anchor onto its row in the new rows.
// A text that occurs exactly once (among the rows not already claimed) wins
// outright — the same strict rule remapRows uses. Several candidates are only
// resolved when the anchor's recorded NEIGHBOURS single one out, and a tie is
// dropped rather than guessed at, mirroring contextRemap: a wrong ✓ on code the
// reviewer never read is worse than an approval they have to redo.
//
// Anchors are processed in ascending stored-row order and a claimed new row is
// removed from consideration for the rest of the pass, so two duplicate rows can
// never both land on the same one.
func remapFromAnchors(anchors []approvals.RowAnchor, newRows []alignRow) map[int]int {
	groups := groupRowsByKey(newRows)
	sorted := append([]approvals.RowAnchor(nil), anchors...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Row < sorted[j].Row })

	used := map[int]bool{}
	moved := map[int]int{}
	for _, an := range sorted {
		key := wsKey(an.Text)
		if key == "" {
			continue
		}
		var cands []int
		for _, idx := range groups[key] {
			if !used[idx] {
				cands = append(cands, idx)
			}
		}
		pick := -1
		switch len(cands) {
		case 0:
			continue
		case 1:
			pick = cands[0]
		default:
			ambiguous := false
			for _, idx := range cands {
				if !anchorContextMatches(an, newRows, idx) {
					continue
				}
				if pick != -1 {
					ambiguous = true
					break
				}
				pick = idx
			}
			if ambiguous {
				pick = -1
			}
		}
		if pick < 0 {
			continue
		}
		moved[an.Row] = pick
		used[pick] = true
	}
	return moved
}

// anchorContextMatches checks whether the rows around idx are the ones the
// anchor recorded. Whitespace-insensitive, like every other comparison in this
// file; a missing neighbour (the block's very first/last row) is the empty
// string on both sides, so an edge row still matches an edge row.
func anchorContextMatches(an approvals.RowAnchor, rows []alignRow, idx int) bool {
	prev, next := "", ""
	if idx > 0 {
		prev = wsKey(rowDisplayText(rows[idx-1]))
	}
	if idx < len(rows)-1 {
		next = wsKey(rowDisplayText(rows[idx+1]))
	}
	return prev == wsKey(an.Prev) && next == wsKey(an.Next)
}

// anchorsForRows describes, in the CURRENT rows, every row an approval still
// covers — the approved rows themselves plus the rows its call keys sit on, so
// a partially approved row can be found back too. Sorted by row, so the stored
// value is stable and sameAnchors can compare it cheaply.
func anchorsForRows(rows []alignRow, approvedRows []int, calls []string) []approvals.RowAnchor {
	want := map[int]bool{}
	for _, r := range approvedRows {
		want[r] = true
	}
	for _, key := range calls {
		if sep := strings.IndexByte(key, ':'); sep >= 0 {
			if row, err := strconv.Atoi(key[:sep]); err == nil {
				want[row] = true
			}
		}
	}
	idxs := make([]int, 0, len(want))
	for r := range want {
		idxs = append(idxs, r)
	}
	sort.Ints(idxs)

	out := make([]approvals.RowAnchor, 0, len(idxs))
	for _, r := range idxs {
		if r < 0 || r >= len(rows) {
			continue
		}
		an := approvals.RowAnchor{Row: r, Text: rowDisplayText(rows[r])}
		if r > 0 {
			an.Prev = rowDisplayText(rows[r-1])
		}
		if r < len(rows)-1 {
			an.Next = rowDisplayText(rows[r+1])
		}
		out = append(out, an)
	}
	return out
}

func sameAnchors(a, b []approvals.RowAnchor) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// remapRows maps old row indices to new ones by their displayed text, keeping only
// unambiguous pairs: a text that occurs exactly once on each side. Anything else
// (a line that was duplicated, removed, or occurs several times to begin with) is
// left out, so its approval is dropped rather than guessed at.
//
// A second, narrower pass (contextRemap) then recovers a subset of the rows this
// strict pass had to drop purely because their text repeats within the block — see
// contextRemap's own doc comment for why and how. It never overrides or competes
// with a row this pass already placed.
func remapRows(oldRows, newRows []alignRow) map[int]int {
	oldAt := uniqueRowIndex(oldRows)
	newAt := uniqueRowIndex(newRows)
	moved := map[int]int{}
	for key, from := range oldAt {
		if to, ok := newAt[key]; ok {
			moved[from] = to
		}
	}
	for from, to := range contextRemap(oldRows, newRows, moved) {
		moved[from] = to
	}
	return moved
}

// contextRemap is the "option 3" fallback discussed for the reported bug (see the
// "Comment/approval anchors are RE-ANCHORED" section in tembed-workflows.md): a
// block whose changed code is a repeated shape — the mirrored try/catch
// `return [...]` arrays and the repeated `];`/`}` lines that motivated this — makes
// every one of those lines fail remapRows's strict, block-wide uniqueness test,
// even when that specific occurrence never actually changed. This pass recovers
// exactly those rows, but ONLY when the row's own position is corroborated by its
// immediate neighbour(s) — never by its content alone, and never for a row
// remapRows already placed (it only fills gaps, it never re-decides an already
// resolved row).
//
// Deliberately NOT a full LCS/positional diff between oldRows and newRows (the
// same technique alignRows itself already uses for old-vs-new source): an LCS
// resolves duplicate lines by relative ORDER, which is exactly the wrong tool
// here — a genuine reordering (the two return blocks swapped, or a duplicated
// block moved elsewhere in the function) looks to an LCS exactly like "the Nth
// occurrence maps to the Nth occurrence", and would silently reattach an old
// approval to code the reviewer never actually reviewed in its new place. The
// coordinator explicitly chose this narrower, context-anchored approach over that
// one for that reason: a wrong ✓ on unreviewed code is worse than a dropped
// approval the reviewer has to redo. See TestRemapRowsDuplicateReorderedRowDropped.
//
// Neighbour requirement (rowContextMatches):
//   - An INTERIOR row (not the block's first or last row) must agree with the
//     candidate on BOTH the previous and the next row.
//   - An EDGE row (the block's very first or very last row) only has one
//     neighbour to begin with, so only that one is required.
//   - A block of a single row has neither neighbour and can therefore never be
//     disambiguated this way — such a row simply stays dropped, same as before.
//   - The comparison is the same whitespace-insensitive wsKey text this whole
//     file already keys on. A required neighbour that doesn't exist on the
//     CANDIDATE's side (e.g. the old row sits in the interior but the candidate
//     sits at the very edge of the new rows) counts as a mismatch, not a pass —
//     that asymmetry is itself a sign the candidate is a different occurrence.
//   - A blank source line (wsKey == "" — a literal empty code line, never a
//     nil/filler alignRow field: rowDisplayText always falls back to whichever
//     side does have text) is compared like any other text, so "" == "" still
//     counts as agreement. This is a DELIBERATE, documented residual weak spot
//     rather than a special case: two blank neighbours carry weaker evidence
//     than two matching lines of real code, but the repeated-boilerplate shapes
//     this pass targets (`}`/`];`/mirrored array literals) always have real code
//     immediately next to them, so in practice this never comes up for them —
//     accepted rather than adding a third neighbour tier for a case that doesn't
//     occur in the motivating scenario.
//   - A candidate is only accepted if it is the UNIQUE surviving candidate among
//     every same-text position that (a) isn't already the target of a
//     higher-confidence mapping and (b) passes its neighbour check. More than
//     one surviving candidate is exactly the same ambiguity remapRows's strict
//     pass already refuses to guess at, so it's dropped here too — never picked
//     arbitrarily. Rows are resolved in ascending old-row order, and a claimed
//     new-row target is removed from consideration for every later row in this
//     same pass, so two duplicate old rows can never both land on the same new
//     row.
func contextRemap(oldRows, newRows []alignRow, already map[int]int) map[int]int {
	newGroups := groupRowsByKey(newRows)
	used := make(map[int]bool, len(already))
	for _, to := range already {
		used[to] = true
	}

	moved := map[int]int{}
	for oldIdx := range oldRows {
		if _, ok := already[oldIdx]; ok {
			continue
		}
		key := wsKey(rowDisplayText(oldRows[oldIdx]))
		if key == "" {
			continue
		}
		match := -1
		ambiguous := false
		for _, newIdx := range newGroups[key] {
			if used[newIdx] {
				continue
			}
			if !rowContextMatches(oldRows, newRows, oldIdx, newIdx) {
				continue
			}
			if match != -1 {
				ambiguous = true
				break
			}
			match = newIdx
		}
		if ambiguous || match == -1 {
			continue
		}
		moved[oldIdx] = match
		used[match] = true
	}
	return moved
}

// rowContextMatches checks whether newIdx's neighbour(s) corroborate that it is
// the same row as oldIdx — see contextRemap's doc comment for the exact rule.
func rowContextMatches(oldRows, newRows []alignRow, oldIdx, newIdx int) bool {
	needPrev := oldIdx > 0
	needNext := oldIdx < len(oldRows)-1
	if !needPrev && !needNext {
		// A single-row block: no neighbour exists on either side to corroborate
		// with, so this row can never be disambiguated from its duplicates.
		return false
	}
	if needPrev {
		if newIdx == 0 {
			return false
		}
		if wsKey(rowDisplayText(oldRows[oldIdx-1])) != wsKey(rowDisplayText(newRows[newIdx-1])) {
			return false
		}
	}
	if needNext {
		if newIdx >= len(newRows)-1 {
			return false
		}
		if wsKey(rowDisplayText(oldRows[oldIdx+1])) != wsKey(rowDisplayText(newRows[newIdx+1])) {
			return false
		}
	}
	return true
}

// groupRowsByKey indexes every non-blank row by its whitespace-insensitive text,
// keeping every occurrence (unlike uniqueRowIndex, which keeps only the unique
// ones) — contextRemap needs the full candidate list to disambiguate via
// neighbours.
func groupRowsByKey(rows []alignRow) map[string][]int {
	g := map[string][]int{}
	for i, r := range rows {
		if key := wsKey(rowDisplayText(r)); key != "" {
			g[key] = append(g[key], i)
		}
	}
	return g
}

// uniqueRowIndex indexes non-blank rows by their whitespace-insensitive text,
// keeping only the ones that occur exactly once.
func uniqueRowIndex(rows []alignRow) map[string]int {
	at := map[string]int{}
	dup := map[string]bool{}
	for i, r := range rows {
		key := wsKey(rowDisplayText(r))
		if key == "" {
			continue
		}
		if _, seen := at[key]; seen {
			dup[key] = true
			continue
		}
		at[key] = i
	}
	for key := range dup {
		delete(at, key)
	}
	return at
}

func sameInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// planReanchor is the glue the refresh Activity calls: it materializes the
// previous base/head sides of the touched files into a shadow worktree pair (so
// approvals can be remapped from the row space they were written in — the real
// head worktree has already been checked out to the new SHA in place by
// refreshIngestDelta) and runs both matchers.
//
// prevBase/prevHead may be empty (no previous ingest recorded); comments are still
// re-anchored then, since they carry their own snippet — only the approval remap
// needs the old sides.
func planReanchor(ctx context.Context, dataDir string, pr int, changedFiles []string,
	prevBase, prevHead string, cs []comments.Comment, aps []approvals.Approval, blocks []Block) reanchorPlan {

	plan := reanchorPlan{Comments: planCommentReanchor(dataDir, pr, changedFiles, cs, blocks)}
	if prevBase == "" || prevHead == "" {
		return plan
	}
	touched := make(map[string]bool, len(changedFiles))
	for _, f := range changedFiles {
		touched[f] = true
	}
	// Only the touched blocks' files need their old sides; both the current and
	// the pre-rename path, since a block may have moved.
	var paths []string
	seen := map[string]bool{}
	for _, b := range blocks {
		if !touched[b.File] {
			continue
		}
		for _, p := range []string{b.File, b.oldPath()} {
			if !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	oldBaseDir, oldHeadDir, cleanup, err := shadowWorktrees(ctx, prevBase, prevHead, paths)
	if err != nil {
		// Without the old sides an approval remap would be a guess; comments
		// (which carry their own snippet) are unaffected.
		return plan
	}
	defer cleanup()

	baseDir, headDir := worktreeDirs(dataDir, pr)
	plan.Approvals = planApprovalRemap(baseDir, headDir, oldBaseDir, oldHeadDir, aps, blocks, touched)
	return plan
}

// shadowWorktrees writes the given paths as they were at baseSHA/headSHA into a
// throwaway directory pair laid out like a worktree, so the ordinary
// blockAlignedRows (which reads files from a base/head directory) can be reused
// verbatim on a historical revision. A path missing at either SHA is simply not
// written — extractBlockSource then reads an absent file and yields empty text,
// which planApprovalRemap treats as "couldn't read the old side".
func shadowWorktrees(ctx context.Context, baseSHA, headSHA string, paths []string) (baseDir, headDir string, cleanup func(), err error) {
	root, err := os.MkdirTemp("", "slash-reanchor-")
	if err != nil {
		return "", "", func() {}, err
	}
	cleanup = func() { os.RemoveAll(root) }
	baseDir = filepath.Join(root, "base")
	headDir = filepath.Join(root, "head")
	for dir, sha := range map[string]string{baseDir: baseSHA, headDir: headSHA} {
		for _, rel := range paths {
			content, err := showFileAtSHA(ctx, "", sha, rel)
			if err != nil {
				continue // absent at that revision — see the doc comment
			}
			full := filepath.Join(dir, rel)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				continue
			}
			_ = os.WriteFile(full, content, 0o644)
		}
	}
	return baseDir, headDir, cleanup, nil
}
