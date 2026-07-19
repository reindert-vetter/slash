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
