package claude

import _ "embed"

// These are the static, call-independent instruction blocks for the three
// context-only Haiku actions (resolve_call's Haiku pass, explain_code,
// pr_status's summary). Each holds byte-for-byte the same instruction text
// that used to be built inline, at a fixed position, inside the -p prompt
// string for that action — moved here so a caller can pass it once via
// RunRequest.SystemPrompt (--append-system-prompt) instead of re-typing it
// into the varying prompt on every call. The call-specific content (caller
// body, candidates, selected code, PR metadata) stays where it was, built by
// the Go prompt functions (resolvePrompt/explainPrompt/prSummaryPrompt).
//
// Kept under modules/claude/prompts/ rather than the repo's own .claude/ so
// they are never mistaken for (or accidentally merged into) this project's
// own CLAUDE.md/.claude/rules memory — they are prompt content for a
// subprocess call, not documentation for a `claude` session in this repo.

//go:embed prompts/resolve_call.md
var ResolveCallSystemPrompt string

//go:embed prompts/explain_code.md
var ExplainCodeSystemPrompt string

//go:embed prompts/pr_summary.md
var PRSummarySystemPrompt string

// CodeWarningSystemPrompt is the static instruction block for the
// code_warning workflow's one agentic Sonnet call: unlike the three above,
// this is NOT a context-only completion — Sonnet is given Read/Grep/Glob and
// explores the checked-out repo itself, so the call-specific part of the
// prompt (built by warningPrompt in code_warning.go) only needs to name the
// changed files in scope + the finding cap, not any pre-gathered context.
//
//go:embed prompts/code_warning.md
var CodeWarningSystemPrompt string

// CommentRemovalSystemPrompt is the static instruction block for the
// auto-resolve check that runs when a comment's row anchor becomes orphaned
// (the symbol it was placed on is gone from the PR — see reanchor.go's doc
// comment and workflows.go's reanchorAfterRefresh): a context-only Haiku call
// decides whether the comment's own text was asking for exactly that removal.
//
//go:embed prompts/comment_removal.md
var CommentRemovalSystemPrompt string

// ChatSystemPrompt is the static instruction block for the claude_chat
// workflow's reviewer-facing conversation (RunChat, one per turn): the
// assistant framing plus the strict JSON contract for an optional
// clarifying question (max 3 options) that runClaudeTurn (workflows.go)
// parses back out of the model's response.
//
//go:embed prompts/chat.md
var ChatSystemPrompt string

// ChatEditSystemPrompt is ChatSystemPrompt's sibling for a chatActionEdit turn
// (chat_workflow.go/chat_shadow.go): the same assistant framing and question
// contract, plus an explicit note that the Edit tool is available THIS turn,
// scoped to the conversation's own disposable shadow worktree, and that
// nothing is pushed to the real PR until the reviewer explicitly commits it.
// A full replacement of ChatSystemPrompt rather than a second
// --append-system-prompt (the CLI only takes one), used only for turns whose
// RunRequest.Tools includes "Edit".
//
//go:embed prompts/chat_edit.md
var ChatEditSystemPrompt string
