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
// CodeCommentInput. When it can pin the comment to a block + aligned row, the
// result is a normal block-scoped line comment (Kind ""); when it can find the
// block but not the exact row, RowStart stays -1 (shown anywhere within the
// block); when no block contains the anchor at all, it degrades to a PR-wide
// comment (Kind "review", empty File/Label) so it still shows up somewhere.
// ImportedRootID/Source/Author/CreatedAt are always carried through.
func mapReviewComment(dataDir string, pr int, blocks []Block, gc github.ReviewComment) CodeCommentInput {
	in := CodeCommentInput{
		PR:             pr,
		Body:           gc.Body,
		Author:         gc.Author,
		CreatedAt:      gc.CreatedAt,
		ImportedRootID: gc.ID,
		Source:         "github",
		RowStart:       -1,
		RowEnd:         -1,
	}

	baseDir, headDir := worktreeDirs(dataDir, pr)
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
		in.RowStart = row
		in.RowEnd = row
	}
	// Block found but row not pinned: RowStart stays -1 (shown anywhere in the
	// block), which is the same "unknown anchor" convention app-placed legacy
	// comments use.
	return in
}

// mapGeneralComment turns a PR-wide GitHub comment (issue comment / review
// summary) into a CodeCommentInput with no block anchor.
func mapGeneralComment(pr int, gc github.GeneralComment) CodeCommentInput {
	return CodeCommentInput{
		PR:             pr,
		Body:           gc.Body,
		Author:         gc.Author,
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
// rows (dedent4 → alignRows, the same space approvals/comments use). It walks the
// rows tracking each side's running source-line number, which starts at the
// block's un-dedented source Start on that side.
func rowForLine(baseDir, headDir string, b Block, line int, side string) (int, bool) {
	oldSide := extractBlockSource(filepath.Join(baseDir, b.File), b.File, b.Class, b.Name)
	newSide := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
	oldText, newText := dedent4(oldSide.Text, newSide.Text)
	rows := alignRows(oldText, newText)

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

// importedRunID is the deterministic Run ID an imported GitHub comment's thread
// gets, so a repeated import (a re-poll, a restart) is a no-op reuse via
// StartWorkflowID rather than a duplicate Execution.
func importedRunID(commentID int64) string {
	return fmt.Sprintf("gh-%d", commentID)
}
