package main

import (
	"context"
	"encoding/json"
	"strings"

	"slash/modules/claude"
	"slash/modules/comments"
)

// This file decides whether a comment whose row anchor just became
// AnchorOrphan (see reanchor.go's own doc comment: the symbol it hung on is
// entirely gone from the PR — renamed, deleted, or the whole file dropped)
// may be auto-resolved because it was asking for exactly that: removing the
// code. It's driven from workflows.go's reanchorAfterRefresh Activity — see
// that Activity's own doc comment for why deciding this live, inside the
// Activity function body, stays replay-safe (the workflow body's own
// ExecuteActivity/WaitSignal sequence never changes; only what this one
// Activity does internally, exactly like its existing per-comment/per-block
// Signal loop already does).
//
// Resolving used to be IRREVERSIBLE (it completed the thread's Execution, and
// a completed Execution can never receive another Signal). It no longer is —
// the reviewer can unresolve a thread, see the "unresolve" action in
// taskCodeCommentWorkflow — but the guardrails in shouldConsiderAutoResolve
// stay deliberately strict anyway: an automated pass silently closing a live
// conversation is still wrong, just no longer permanent. The reply text below
// remains the main place a reviewer sees this happened, so it has to explain
// itself on its own.

// autoResolveAuthor is the display name the auto-resolve reply carries —
// reuses the same "AI-controle" branding as the code_warning feature
// (warningAuthor, code_warning.go), so a reviewer recognizes it as the same
// kind of automated helper.
const autoResolveAuthor = warningAuthor

// autoResolveNote is the reply body posted when a comment is auto-resolved.
// Resolving is irreversible and this reply is the only trace of it, so the
// text names WHAT happened (resolved automatically) and WHY (the code the
// comment was about is gone from the PR) — understandable on its own, even
// read back months later, without relying on any other UI state.
const autoResolveNote = "Automatisch opgelost door AI-controle: de code waar dit comment op sloeg is niet meer aanwezig in deze PR (het symbool is verwijderd of hernoemd), en dit comment vroeg om precies die code te verwijderen."

// removalAnswer is the JSON shape Haiku is asked to answer with — mirrors
// resolve_call.go's llmAnswer shape (a bool plus a high/low confidence,
// never a finer-grained numeric score: there is no second-guessing/
// escalation loop here that a finer score would feed into).
type removalAnswer struct {
	RemoveCode bool   `json:"removeCode"`
	Confidence string `json:"confidence"` // high | low
}

// shouldConsiderAutoResolve is every guardrail EXCEPT the model call itself —
// checked first because it costs nothing, so a comment that fails it never
// triggers an LLM call at all:
//
//   - Only Status "open" — an already resolved/deleting/deleted comment needs
//     no second resolve (and a deleted or long-ago-resolved one can't even be
//     signalled any more); skip the wasted classification too.
//   - Only Kind "" (an ordinary block-scoped comment) — true by construction
//     already (planCommentReanchor never orphans a Kind != "" / PR-wide
//     comment), checked explicitly anyway so this function's own contract
//     doesn't silently depend on that elsewhere.
//   - Only ZERO existing replies (from anyone, for any reason) — any reply at
//     all means there is an active conversation, which an automated pass must
//     never silently close.
//
// The caller (reanchorAfterRefresh) additionally only ever considers a
// comment here when its anchor is a genuinely NEW transition to AnchorOrphan
// (plan.Comments only carries actual changes, via appendAnchorChange) — so a
// comment that was already orphan before this feature shipped, or on an
// earlier refresh, is never reconsidered.
func shouldConsiderAutoResolve(c comments.Comment) bool {
	return c.Status == "open" && c.Kind == "" && len(c.Reactions) == 0
}

// classifyRemovalRequest asks a cheap model whether body was asking for the
// code it was placed on (code, when known) to be removed. Never returns an
// error: a missing client (SLASH_CLAUDE=off), a CLI error, empty/unparseable
// output, or anything short of an explicit high-confidence "yes" all degrade
// to false — the caller then simply does nothing, mirroring
// resolveCallsWithModel's "a model/CLI failure never blocks the workflow"
// style.
func classifyRemovalRequest(ctx context.Context, cl claude.Client, body, code string) bool {
	if cl == nil || strings.TrimSpace(body) == "" {
		return false
	}
	raw, err := cl.Run(ctx, claude.RunRequest{
		Model:        claude.ModelHaiku,
		SystemPrompt: claude.CommentRemovalSystemPrompt,
		Prompt:       removalCheckPrompt(body, code),
	})
	if err != nil {
		return false
	}
	var ans removalAnswer
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &ans); err != nil {
		return false
	}
	return ans.RemoveCode && ans.Confidence == "high"
}

// removalCheckPrompt builds the call-specific part of the prompt: the
// comment's own text, plus — when known — the code snippet it was placed on
// (already stored on the comment at placement time, so this is free context
// that helps disambiguate a terse body like "remove this").
func removalCheckPrompt(body, code string) string {
	var b strings.Builder
	b.WriteString("Comment text:\n")
	b.WriteString(body)
	if strings.TrimSpace(code) != "" {
		b.WriteString("\n\nCode the comment was placed on:\n")
		b.WriteString(code)
	}
	return b.String()
}
