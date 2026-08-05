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
// It is the concatenation of TWO embeds, kept as separate files on purpose:
// prompts/code_warning.md is the fixed task framing + JSON contract (rarely
// changes), prompts/code_warning_patterns.md is plug-and-pay/plug-and-pay's
// own, team-specific checklist of recurring review patterns (mined from real
// PR comments) that is expected to keep growing over time. Splitting them
// means a future addition to the checklist is a diff of one file, never a
// touch to the contract file. A new team pattern belongs in
// code_warning_patterns.md, never inline here.
//
//go:embed prompts/code_warning.md
var codeWarningTaskPrompt string

//go:embed prompts/code_warning_patterns.md
var codeWarningPatternsPrompt string

var CodeWarningSystemPrompt = codeWarningTaskPrompt + "\n" + codeWarningPatternsPrompt

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

// ChatShellSystemPrompt is ChatSystemPrompt's sibling for a turn that got real
// shell/file access this turn (chat_workflow.go's runOneClaudeTurn, via
// prepareChatShellWorkDir/chat_shadow.go): the same assistant framing plus
// question/comment_action contracts, plus an explicit note that the Edit tool
// AND a real shell (Bash) are available THIS turn, scoped to the
// conversation's own disposable shadow worktree, so Claude can run
// git/gh/acli itself — including committing and pushing — when the reviewer
// explicitly asks for it in the message. See
// .claude/rules/workflows-write-boundary.md's "Exception: the Claude chat
// turn may act through a shell". A full replacement of ChatSystemPrompt
// rather than a second --append-system-prompt (the CLI only takes one), used
// whenever RunRequest.WorkDir/Tools were successfully set up for this turn —
// which is the normal case, not a special "edit action" (see
// runOneClaudeTurn's doc comment for why arg.Action no longer gates this).
//
//go:embed prompts/chat_shell.md
var ChatShellSystemPrompt string

// ChatConflictSystemPrompt is the static instruction block for chat_merge's
// one begrensde Claude attempt when an automatic `git merge` of two chat
// conversations' shadow-worktree edits leaves real conflicts. A one-shot,
// non-conversational agentic call (Run, not RunChat — no session, this is a
// mechanical fix, not a turn in the reviewer's own conversation), scoped to
// that conversation's own disposable shadow worktree with the Edit tool,
// asked to remove every conflict marker without touching unrelated files. See
// chat_merge.go (resolveConflictWithClaude).
//
//go:embed prompts/chat_conflict.md
var ChatConflictSystemPrompt string
