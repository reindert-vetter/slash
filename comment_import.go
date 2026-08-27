package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"slash/modules/github"
)

// comment_import.go maps existing GitHub comments onto the block/aligned-row
// coordinate space this app navigates in, producing the CodeCommentInput a
// task_code_comment Execution is started from. It is a pure function of the PR's
// blocks + the base/head worktrees on disk (a read-only side effect, like
// blockstats.go / /api/code), so it is safe to call from an Activity.
//
// The row anchor lives in the SAME aligned-row index space as approvals and
// app-placed comments (dedent4 → alignRows, see blockstats.go), so an imported
// comment lands on exactly the row the reviewer sees.

// mapReviewComment turns a GitHub thread-root review comment into a
// CodeCommentInput, reusing blockForLine/rowForLine like anchoredWarning
// (code_warning.go) does for an AI finding. Four outcomes:
//
//   - The file+line pins to an exact row (rowForLine succeeds) AND that row is
//     itself one of the block's changed rows (rowChanged + rowHasContent, the
//     same predicates firstChangedRowIndex uses): a normal, block-scoped line
//     comment (Kind ""), anchored to that row.
//   - The file+line pins to a row, but that row is NOT a changed row — a
//     GitHub review comment can sit on any context line the diff shows around
//     a hunk, unlike an AI finding (already guarded to a changed line before
//     it ever reaches here, see anchoredWarning's own comment) — anchored on
//     the block's own FIRST changed row instead, with BlockWide=true so the
//     frontend badges it as being about the whole block, not specifically
//     that row. Mirrors anchoredWarning's identical fallback one-for-one:
//     without this, the comment stays pinned to a row with no navigable unit
//     of its own at line granularity (see commentUnder/unitAtRow, home.mjs/
//     RelatedPanel.mjs), so it silently fails to show under any drilled
//     cursor — reported bug. (If the block has no changed row at all — a
//     degenerate case that shouldn't happen for a block a real diff ever
//     surfaced — the originally pinned row is kept as-is rather than
//     discarded: a real row beats none.)
//   - The file+line falls inside a block, but not on any row rowForLine can
//     find at all: RowStart stays -1 (shown anywhere within the block), the
//     same "unknown anchor" convention app-placed legacy comments use.
//   - No block contains the anchor at all: degrades to a PR-wide comment
//     (Kind "review", empty File/Label) so it still shows up somewhere.
//
// ImportedRootID/Source/Author/CreatedAt are always carried through.
func mapReviewComment(dataDir string, repo string, pr int, blocks []Block, gc github.ReviewComment) CodeCommentInput {
	in := CodeCommentInput{
		Repo:           repo,
		PR:             pr,
		Body:           gc.Body,
		Author:         gc.Author,
		AvatarURL:      gc.AvatarURL,
		CreatedAt:      gc.CreatedAt,
		ImportedRootID: gc.ID,
		Source:         "github",
		RowStart:       -1,
		RowEnd:         -1,
	}

	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
	side := gc.Side
	if side == "" {
		side = "RIGHT"
	}

	b, ok := blockForLine(baseDir, headDir, blocks, gc.Path, gc.Line, side)
	if !ok {
		// No block contains the anchor (e.g. a comment on an unchanged region, or
		// a file this PR's blocks don't cover) → PR-wide.
		in.Kind = "review"
		in.File = gc.Path // keep for reference; the frontend shows it PR-wide
		return in
	}

	in.File = b.File
	in.Label = b.Label
	in.Line = gc.Line
	in.Side = side
	in.Gran = "line"

	if row, ok := rowForLine(baseDir, headDir, b, gc.Line, side); ok {
		rows, _, _ := blockAlignedRows(baseDir, headDir, b)
		if row < len(rows) && rowChanged(rows[row]) && rowHasContent(rows[row]) {
			in.RowStart = row
			in.RowEnd = row
			return in
		}
		// Pinned to a real row, but not a changed one (e.g. unchanged context
		// shown around a hunk) — fall back to the block's first changed row
		// instead of leaving it pinned to a row with no navigable unit of its
		// own. See the doc comment above. If the block has no changed row at
		// all (shouldn't happen for a block a real diff ever surfaced, but
		// checked rather than assumed), keep the originally pinned row rather
		// than discarding it to unpinned (-1) — a real row beats none.
		if fr, ok := firstChangedRowIndex(rows); ok {
			in.RowStart = fr
			in.RowEnd = fr
			in.BlockWide = true
			return in
		}
		in.RowStart = row
		in.RowEnd = row
		return in
	}
	// Block found but row not pinned: RowStart stays -1 (shown anywhere in the
	// block), which is the same "unknown anchor" convention app-placed legacy
	// comments use.
	return in
}

// mapGeneralComment turns a PR-wide GitHub comment (issue comment / review
// summary) into a CodeCommentInput with no block anchor.
func mapGeneralComment(repo string, pr int, gc github.GeneralComment) CodeCommentInput {
	return CodeCommentInput{
		Repo:           repo,
		PR:             pr,
		Body:           gc.Body,
		Author:         gc.Author,
		AvatarURL:      gc.AvatarURL,
		CreatedAt:      gc.CreatedAt,
		ImportedRootID: gc.ID,
		Source:         "github",
		Kind:           gc.Kind, // "issue" | "review_summary"
		RowStart:       -1,
		RowEnd:         -1,
	}
}

// blockForLine finds the block of file that contains source line on side. For a
// RIGHT (new) comment it matches the head-coordinate declaration range the
// blocks were scanned in; for a LEFT (old) comment it matches the block's old
// source range (read from the base worktree), since the stored Line/EndLine are
// head coordinates.
func blockForLine(baseDir, headDir string, blocks []Block, file string, line int, side string) (Block, bool) {
	for _, b := range blocks {
		if b.File != file {
			continue
		}
		if side == "LEFT" {
			old := extractBlockSource(filepath.Join(baseDir, b.File), b.File, b.Class, b.Name)
			if old.Start > 0 && line >= old.Start && line <= old.End {
				return b, true
			}
			continue
		}
		if b.Line > 0 && line >= b.Line && line <= b.EndLine {
			return b, true
		}
	}
	return Block{}, false
}

// rowForLine maps a source line on side to its index in the block's aligned
// rows — the same space approvals/comments use, built by the one shared
// blockAlignedRows (blockstats.go). It walks the rows tracking each side's running
// source-line number, which starts at that side's post-transform Start.
//
// Going through blockAlignedRows is load-bearing, not just tidiness: this used to
// read the raw extractBlockSource, so on a block with a leading PHPDoc it landed
// an imported comment N rows off (N = the folded doc lines), since /api/code and
// the approve total both count the post-fold rows.
func rowForLine(baseDir, headDir string, b Block, line int, side string) (int, bool) {
	rows, oldSide, newSide := blockAlignedRows(baseDir, headDir, b)

	curOld := oldSide.Start
	curNew := newSide.Start
	for i, r := range rows {
		switch side {
		case "LEFT":
			if r.left != nil && curOld == line {
				return i, true
			}
		default: // RIGHT
			if r.right != nil && curNew == line {
				return i, true
			}
		}
		if r.left != nil {
			curOld++
		}
		if r.right != nil {
			curNew++
		}
	}
	return 0, false
}

// isPRWide reports whether a comment Kind is a PR-wide comment (no file:line
// anchor): an issue comment, a review summary, or a review comment that couldn't
// be pinned to a block. These live in the PR-info column's comment block, not the
// block-scoped sidebar, and their replies mirror to GitHub as new issue comments.
func isPRWide(kind string) bool {
	return kind == "issue" || kind == "review_summary" || kind == "review" || kind == "ai_warning"
}

// isKiloReview reports whether a comment body is a kilo-review bot summary we
// deliberately never import — matched on BOTH markers (AND) to avoid false
// positives. Mirrors the frontend isKiloReview in RelatedPanel.mjs; the
// import-skip here keeps new ones out of the read-model entirely (no Execution
// started, so within the write-boundary — we simply don't start a workflow).
func isKiloReview(body string) bool {
	return strings.Contains(body, "<!-- kilo-review -->") && strings.Contains(body, "Code Review Summary")
}

// kiloBotAuthor is the GitHub login of the kilo-code review bot (exact match,
// mirrors isKiloReview's own "matched on a fixed marker" reasoning — see
// autoStartKiloCheck in workflows.go, which gates the automatic
// claude_chat verification turn on this).
const kiloBotAuthor = "kilo-code-bot[bot]"

// isKiloComment reports whether an imported comment's author is the kilo-code
// review bot. Unlike isKiloReview this matches every individual finding kilo
// posts (a normal review-comment thread), not just its PR-wide summary — the
// summary never reaches this check at all, since importPRComments skips it
// via isKiloReview before a thread is ever started for it.
func isKiloComment(author string) bool {
	return author == kiloBotAuthor
}

// importedRunID is the deterministic Run ID an imported GitHub comment's thread
// gets, so a repeated import (a re-poll, a restart) is a no-op reuse via
// StartWorkflowID rather than a duplicate Execution.
func importedRunID(commentID int64) string {
	return fmt.Sprintf("gh-%d", commentID)
}
