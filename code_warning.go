package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"slash/modules/claude"
)

// This file is the LLM side of the code_warning workflow (package main; it
// reads the head worktree and shells out to the claude CLI, so it runs only
// inside a code_warning Activity). Unlike resolve_call/resolve_test_covers
// (Haiku first, agentic Sonnet only as an escalation that this repo has since
// removed), this workflow uses ONLY the agentic Sonnet pass — deliberately:
// the whole point is to explore the checked-out repo for risks connected to,
// but not necessarily inside, the changed lines themselves (a caller a
// changed signature broke, a test still asserting the old shape, an event
// listener that doesn't handle a new payload field, …), which a context-only
// Haiku call — fed only what we chose to hand it — cannot discover on its own.
// See the "AI-risicocontrole" decision in .claude/rules/tembed-workflows.md.

// warningReviewArg is the payload of the runAgenticReview Activity.
type warningReviewArg struct {
	PR          int      `json:"pr"`
	Files       []string `json:"files"`
	BlockCount  int      `json:"blockCount"`
	MaxFindings int      `json:"maxFindings"`
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

// runCodeWarningReview makes the one agentic Sonnet call and returns the
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
		Model:        claude.ModelSonnet,
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
func anchoredWarning(dataDir string, pr int, blocks []Block, f warningFinding) CodeCommentInput {
	in := CodeCommentInput{
		PR: pr, File: f.File, Line: f.Line, Author: warningAuthor,
		Body: f.Text, Source: "ai", Local: true, RowStart: -1, RowEnd: -1,
	}
	baseDir, headDir := worktreeDirs(dataDir, pr)
	b, ok := blockForLine(baseDir, headDir, blocks, f.File, f.Line, "RIGHT")
	if !ok {
		in.Kind = "ai_warning"
		return in
	}
	in.Label = b.Label
	in.Gran = "line"
	if row, ok := rowForLine(baseDir, headDir, b, f.Line, "RIGHT"); ok {
		in.RowStart = row
		in.RowEnd = row
	}
	return in
}
