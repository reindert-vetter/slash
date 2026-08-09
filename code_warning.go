package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"slash/modules/claude"
	"slash/modules/comments"
)

// This file is the LLM side of the code_warning workflow (package main; it
// reads the head worktree and shells out to the claude CLI, so it runs only
// inside a code_warning Activity). Unlike resolve_call/resolve_test_covers
// (Haiku first, agentic Sonnet only as an escalation that this repo has since
// removed), this workflow uses ONLY one agentic pass — deliberately: the
// whole point is to explore the checked-out repo for risks connected to, but
// not necessarily inside, the changed lines themselves (a caller a changed
// signature broke, a test still asserting the old shape, an event listener
// that doesn't handle a new payload field, …), which a context-only Haiku
// call — fed only what we chose to hand it — cannot discover on its own. The
// agentic model is Opus (claude.ModelOpus) — this is the "Diepgravend
// onderzoek" ("in-depth investigation") PR-wide menu item, deliberately the
// strongest available model since it's a manually-triggered, low-frequency
// action rather than something run on every navigation step.
// See the "AI-risicocontrole" decision in .claude/docs/tembed-workflows.md.

// warningReviewArg is the payload of the runAgenticReview Activity.
type warningReviewArg struct {
	PR          int      `json:"pr"`
	Files       []string `json:"files"`
	BlockCount  int      `json:"blockCount"`
	MaxFindings int      `json:"maxFindings"`
	// Existing is every open, human/GitHub-authored line comment already sitting
	// on a file in scope (Source != "ai" — an old AI comment in scope was already
	// deleted by supersedeFileWarnings before this Activity runs), so the model
	// can tell whether a risk it wants to flag has already been raised. Whether a
	// finding on such a line still adds something new is the model's own call
	// (see code_warning.md's system prompt) — this is context, not a Go-side
	// dedup filter.
	Existing []existingLineComment `json:"existing,omitempty"`
}

// existingLineComment is one open, non-AI comment already anchored to a
// file+line in the review scope, handed to the model as context (see
// warningReviewArg.Existing).
type existingLineComment struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Author string `json:"author"`
	Body   string `json:"body"`
}

// warningFinding is one entry of the JSON array the model is asked to return.
type warningFinding struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// warningAuthor is the display name every AI-authored warning comment carries
// (avatarHTML falls back to its first two letters — "AI" — for the initials
// circle, since these comments never carry an avatar URL).
const warningAuthor = "AI-controle"

// runCodeWarningReview makes the one agentic Opus call and returns the
// accepted findings — verified against the scope the model was actually
// given (never a fabricated file), sorted, and capped at arg.MaxFindings.
// Never returns an error: a model/CLI failure degrades to no findings (like
// resolveCallsWithModel), so the workflow always completes.
func runCodeWarningReview(ctx context.Context, cl claude.Client, dataDir string, arg warningReviewArg) []warningFinding {
	if cl == nil || len(arg.Files) == 0 {
		return nil
	}
	baseDir, headDir := worktreeDirs(dataDir, arg.PR)
	// Which lines this PR actually changed, per file in scope — used twice: to
	// TELL the model where it may anchor (warningPrompt) and to ENFORCE it
	// afterwards (the changed-lines guard below), the same
	// instruct-plus-verify shape the file-scope hallucination guard already
	// has. Computed once here rather than per finding: it shells out to git
	// per file.
	changed := changedLineSets(baseDir, headDir, arg.Files)
	req := claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       warningPrompt(arg, changed),
		SystemPrompt: claude.CodeWarningSystemPrompt,
		WorkDir:      headDir,
		Tools:        []string{"Read", "Grep", "Glob"},
	}
	raw, err := cl.Run(ctx, req)
	if err != nil {
		return nil
	}
	findings := parseWarningFindings(raw)

	// Hallucination guard: only trust a finding whose file is one we actually
	// told the model about — never a fabricated path elsewhere in the worktree.
	allowed := make(map[string]bool, len(arg.Files))
	for _, f := range arg.Files {
		allowed[f] = true
	}
	kept := make([]warningFinding, 0, len(findings))
	for _, f := range findings {
		if f.File == "" || f.Line <= 0 || strings.TrimSpace(f.Text) == "" || !allowed[f.File] {
			continue
		}
		// Changed-lines guard (see changedLineSets): the model may LOOK
		// anywhere, but a finding must anchor on a line this PR actually
		// touched. Dropped outright — deliberately not demoted to a PR-wide
		// finding, so an unrelated remark about untouched code simply
		// disappears instead of resurfacing without an anchor.
		if !changed[f.File].allows(f.Line) {
			continue
		}
		kept = append(kept, f)
	}
	sort.Slice(kept, func(i, j int) bool {
		if kept[i].File != kept[j].File {
			return kept[i].File < kept[j].File
		}
		return kept[i].Line < kept[j].Line
	})
	if arg.MaxFindings > 0 && len(kept) > arg.MaxFindings {
		kept = kept[:arg.MaxFindings]
	}
	return kept
}

// changedLineSets returns, per file in scope, the head-side lines this PR
// changed — reusing changedNewLines (callresolve_analysis.go), so "changed"
// means exactly what classified a block as modified, and an added file (no
// base copy) counts as changed in its entirety.
func changedLineSets(baseDir, headDir string, files []string) map[string]*fileChangeSet {
	out := make(map[string]*fileChangeSet, len(files))
	for _, f := range files {
		out[f] = changedNewLines(baseDir, headDir, f)
	}
	return out
}

// allows reports whether line is one the PR changed. A nil set (a file we
// never diffed) and a non-restricting one (an added file) allow everything —
// the same permissive fallback keepChanged already uses, so a missing base
// worktree can never silently swallow every finding.
func (fc *fileChangeSet) allows(line int) bool {
	if fc == nil || !fc.restrict {
		return true
	}
	return fc.set[line]
}

// describeChangedLines renders a file's changed lines as compact ranges
// ("12-18, 44") for the prompt, so the model can aim at a line it is allowed
// to anchor on instead of spending findings that the guard then drops. An
// added file (nothing to restrict) says so in words rather than listing every
// line of the file.
func describeChangedLines(fc *fileChangeSet) string {
	if fc == nil || !fc.restrict {
		return "the whole file is new"
	}
	lines := make([]int, 0, len(fc.set))
	for ln := range fc.set {
		lines = append(lines, ln)
	}
	if len(lines) == 0 {
		return "no changed lines"
	}
	sort.Ints(lines)
	var parts []string
	start, prev := lines[0], lines[0]
	flush := func() {
		if start == prev {
			parts = append(parts, fmt.Sprintf("%d", start))
			return
		}
		parts = append(parts, fmt.Sprintf("%d-%d", start, prev))
	}
	for _, ln := range lines[1:] {
		if ln == prev+1 {
			prev = ln
			continue
		}
		flush()
		start, prev = ln, ln
	}
	flush()
	return strings.Join(parts, ", ")
}

// warningPrompt builds the call-specific part of the prompt: the scope
// (changed files + the lines changed in each) and the finding cap. The
// call-independent task framing and JSON contract are static across every
// code_warning run, so they travel separately as
// claude.CodeWarningSystemPrompt (--append-system-prompt) — see
// runCodeWarningReview and modules/claude/prompts.go.
func warningPrompt(arg warningReviewArg, changed map[string]*fileChangeSet) string {
	var b strings.Builder
	b.WriteString("Changed files in this PR to review, with the lines this PR changed in each:\n")
	for _, f := range arg.Files {
		fmt.Fprintf(&b, "- %s (changed lines: %s)\n", f, describeChangedLines(changed[f]))
	}
	b.WriteString("\nYou may read anything in the repository, but every finding must anchor on one of those changed lines and must be caused by this change.\n")
	fmt.Fprintf(&b, "\nThese files together touch %d changed function(s)/method(s). Report at most %d findings in total across all of them — on average about %d per changed function, never a fixed count per file — prioritizing the most important, best-justified risks over completeness.\n",
		arg.BlockCount, arg.MaxFindings, warningsPerBlock)
	if len(arg.Existing) > 0 {
		b.WriteString("\nExisting open comments already on these files (see the system prompt's rule about them before reporting a finding on the same line):\n")
		for _, c := range arg.Existing {
			fmt.Fprintf(&b, "- %s:%d — %s: %s\n", c.File, c.Line, c.Author, c.Body)
		}
	}
	return b.String()
}

// parseWarningFindings extracts the first [...] JSON array from the model
// output (models sometimes wrap it in prose or fences) and unmarshals it.
func parseWarningFindings(raw string) []warningFinding {
	start := strings.IndexByte(raw, '[')
	end := strings.LastIndexByte(raw, ']')
	if start < 0 || end <= start {
		return nil
	}
	var findings []warningFinding
	if err := json.Unmarshal([]byte(raw[start:end+1]), &findings); err != nil {
		return nil
	}
	return findings
}

// existingLineCommentsInScope filters a PR's comments down to the open,
// non-AI, line-anchored ones sitting on a file in scope — the context handed
// to the model via warningReviewArg.Existing so it can tell whether a risk it
// wants to flag has already been raised (see runAgenticReview,
// code_warning.md). Kind "" excludes a PR-wide comment (no real line);
// Source "ai" is excluded defensively — supersedeFileWarnings already deletes
// every AI comment in scope before this runs — and Status must be "open" (a
// resolved comment is treated as already handled). Sorted by file, line for a
// deterministic prompt.
func existingLineCommentsInScope(list []comments.Comment, files []string) []existingLineComment {
	allowed := make(map[string]bool, len(files))
	for _, f := range files {
		allowed[f] = true
	}
	out := make([]existingLineComment, 0, len(list))
	for _, c := range list {
		if c.Kind != "" || c.Source == "ai" || c.Status != "open" || c.Line <= 0 || !allowed[c.File] {
			continue
		}
		out = append(out, existingLineComment{File: c.File, Line: c.Line, Author: c.Author, Body: c.Body})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	return out
}

// anchoredWarning maps one LLM finding onto the existing comment-anchoring
// model, reusing blockForLine/rowForLine exactly as an imported GitHub review
// comment does (see comment_import.go). Three outcomes:
//
//   - The file+line pins to an exact row (rowForLine succeeds): a normal,
//     block-scoped warning (Kind "", Gran "line") anchored to that row like
//     any other line comment.
//   - The file+line falls inside a block, but not on a row rowForLine can
//     find — Kind still "", but
//     anchored on the block's own FIRST changed row instead of left
//     unpinned. Unpinned (row -1) used to mean "shown anywhere within this
//     block" for EVERY selection inside it (see commentUnder,
//     RelatedPanel.mjs) — reported bug: the finding kept surfacing under a
//     completely unrelated line/group of the same block. A real row anchor
//     fixes that; BlockWide (true here) tells the frontend to still badge it
//     as being about the whole block, not specifically that first row (see
//     comments.Comment.BlockWide).
//   - The file+line can't be pinned to any block at all — an unchanged/
//     context line outside every block, or a line the model got slightly
//     wrong — becomes a PR-wide warning (Kind "ai_warning") instead of being
//     dropped, so the reviewer still sees it (just without a precise row).
//
// Since the changed-lines guard in runCodeWarningReview, every finding
// reaching here anchors on a line the PR actually changed, so the last two
// outcomes are vangnets rather than the normal route: the second only fires
// when rowForLine cannot map a genuinely changed line onto a diff row, the
// third only when a changed line sits in no scanned block at all. Both are
// kept — narrowing them away would trade a rare, harmless fallback for a
// silently dropped finding.
//
// File is kept in all three cases, as a hint of what the finding is about.
// Every warning is Source "ai" + Local true (never posted to GitHub),
// regardless of whether/how it anchors.
//
// The second return value is the anchored block's id ("" when the finding
// didn't anchor to a block), carried along on warningToCreate.
func anchoredWarning(dataDir string, pr int, blocks []Block, f warningFinding) (CodeCommentInput, string) {
	in := CodeCommentInput{
		PR: pr, File: f.File, Line: f.Line, Author: warningAuthor,
		Body: f.Text, Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	}
	baseDir, headDir := worktreeDirs(dataDir, pr)
	b, ok := blockForLine(baseDir, headDir, blocks, f.File, f.Line, "RIGHT")
	if !ok {
		in.Kind = "ai_warning"
		return in, ""
	}
	in.Label = b.Label
	in.Gran = "line"
	if row, ok := rowForLine(baseDir, headDir, b, f.Line, "RIGHT"); ok {
		in.RowStart = row
		in.RowEnd = row
		return in, b.ID()
	}
	// Couldn't pin the exact row — anchor on the block's own first changed
	// row instead of leaving it unpinned, so this finding only ever shows
	// under a navigation unit that actually covers that row (in practice:
	// the block's first group/line), never under every other line of the
	// same block. The label says it's about the whole block, not that row.
	rows, _, _ := blockAlignedRows(baseDir, headDir, b)
	if row, ok := firstChangedRowIndex(rows); ok {
		in.RowStart = row
		in.RowEnd = row
		in.BlockWide = true
	}
	return in, b.ID()
}
