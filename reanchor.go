package main

import (
	"context"
	"os"
	"path/filepath"
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
//   - APPROVALS store no text, only row indices, so their old text has to be
//     recovered from the previous base/head SHAs (planReanchor materializes those
//     two sides into a shadow worktree pair) and looked up in the new rows. A row
//     that can't be found is DROPPED — you did not approve the code that replaced
//     it. That needs no new state: the row is simply unapproved again.
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
// approve tracker's existing `set` Signal already takes.
type approvalRemap struct {
	BlockID string   `json:"blockId"`
	Rows    []int    `json:"rows"`
	Calls   []string `json:"calls"`
}

// reanchorPlan is everything a refresh wants to change. Empty means every anchor
// in the changed files still resolves to the same rows (the common case for a
// commit that only touches files nobody has commented on or approved).
type reanchorPlan struct {
	Comments  []commentAnchorUpdate `json:"comments,omitempty"`
	Approvals []approvalRemap       `json:"approvals,omitempty"`
}

func (p reanchorPlan) empty() bool { return len(p.Comments) == 0 && len(p.Approvals) == 0 }

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

// planApprovalRemap remaps every approved row index of the touched blocks from the
// PREVIOUS aligned-row space (built from oldBaseDir/oldHeadDir — the worktree pair
// as of the last ingest) into the current one, by looking up the text each index
// used to display. An index whose text is gone, or now ambiguous, is dropped:
// approval means "I read this code", and the code it pointed at is no longer there.
//
// Approvals store no snippet of their own (unlike comments), which is exactly why
// this needs the old sides at all.
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
		oldRows, _, _ := blockAlignedRows(oldBaseDir, oldHeadDir, b)
		newRows, _, _ := blockAlignedRows(baseDir, headDir, b)
		if len(oldRows) == 0 {
			// The previous sides couldn't be read (a `git show` miss for this
			// path, e.g. the file was added since). Leave the approval alone
			// rather than dropping rows on a guess.
			continue
		}
		moved := remapRows(oldRows, newRows)

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
			if !ok || rowDisplayText(oldRows[from]) != rowDisplayText(newRows[to]) {
				continue
			}
			calls = append(calls, strconv.Itoa(to)+key[sep:])
		}
		if sameInts(a.Rows, rows) && sameStrings(a.Calls, calls) {
			continue
		}
		out = append(out, approvalRemap{BlockID: a.BlockID, Rows: rows, Calls: calls})
	}
	return out
}

// remapRows maps old row indices to new ones by their displayed text, keeping only
// unambiguous pairs: a text that occurs exactly once on each side. Anything else
// (a line that was duplicated, removed, or occurs several times to begin with) is
// left out, so its approval is dropped rather than guessed at.
func remapRows(oldRows, newRows []alignRow) map[int]int {
	oldAt := uniqueRowIndex(oldRows)
	newAt := uniqueRowIndex(newRows)
	moved := map[int]int{}
	for key, from := range oldAt {
		if to, ok := newAt[key]; ok {
			moved[from] = to
		}
	}
	return moved
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
			content, err := showFileAtSHA(ctx, sha, rel)
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
