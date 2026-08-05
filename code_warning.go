package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
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
	_, headDir := worktreeDirs(dataDir, arg.PR)
	req := claude.RunRequest{
		Model:        claude.ModelOpus,
		Prompt:       warningPrompt(arg),
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

// warningPrompt builds the call-specific part of the prompt: the scope
// (changed files) and the finding cap. The call-independent task framing and
// JSON contract are static across every code_warning run, so they travel
// separately as claude.CodeWarningSystemPrompt (--append-system-prompt) —
// see runCodeWarningReview and modules/claude/prompts.go.
func warningPrompt(arg warningReviewArg) string {
	var b strings.Builder
	b.WriteString("Changed files in this PR to review:\n")
	for _, f := range arg.Files {
		fmt.Fprintf(&b, "- %s\n", f)
	}
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
// comment does (see comment_import.go): a finding whose file+line falls
// inside one of this PR's blocks becomes a normal, block-scoped warning
// (Kind "", Gran "line") anchored to its row like any other line comment; a
// finding that can't be pinned to a block — an unchanged/context line, or a
// line the model got slightly wrong — becomes a PR-wide warning (Kind
// "ai_warning") instead of being dropped, so the reviewer still sees it (just
// without a precise row). File is kept either way, as a hint of what the
// finding is about. Every warning is Source "ai" + Local true (never posted
// to GitHub), regardless of whether it anchors.
//
// The second return value is the anchored block's id ("" when the finding
// didn't anchor to a block) — codeWarningWorkflow needs it to know which
// block's approval to retract (see revokeApprovalForWarning).
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
	}
	return in, b.ID()
}

// removeApprovalRowRange drops every row in [rowStart, rowEnd] from rows, plus
// any calls entry ("<row>:<segStart>") whose row falls in that range —
// mirroring the frontend's revokeApprovalForComment (home.mjs) for the
// group/line case (a code_warning finding always anchors at line granularity,
// never call). changed reports whether anything was actually removed, so the
// caller can skip a no-op Signal.
func removeApprovalRowRange(rows []int, calls []string, rowStart, rowEnd int) (newRows []int, newCalls []string, changed bool) {
	newRows = make([]int, 0, len(rows))
	for _, r := range rows {
		if r >= rowStart && r <= rowEnd {
			changed = true
			continue
		}
		newRows = append(newRows, r)
	}
	newCalls = make([]string, 0, len(calls))
	for _, c := range calls {
		row, ok := callRowOf(c)
		if ok && row >= rowStart && row <= rowEnd {
			changed = true
			continue
		}
		newCalls = append(newCalls, c)
	}
	return newRows, newCalls, changed
}

// callRowOf parses the row prefix out of a "<row>:<segStart>" call-segment
// key. ok is false for a malformed key (kept as-is by the caller rather than
// silently dropped).
func callRowOf(key string) (int, bool) {
	idx := strings.IndexByte(key, ':')
	if idx < 0 {
		return 0, false
	}
	row, err := strconv.Atoi(key[:idx])
	if err != nil {
		return 0, false
	}
	return row, true
}
