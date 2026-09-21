// chat_commit_message.go — helpers for the content-aware git commit subject a
// chat-edit landing gets: the diff-scoped Haiku prompt
// (chatCommitSubjectPrompt), the call itself (generateChatCommitSubject), and
// the sanitizing/"never mention Claude" safety net
// (sanitizeChatCommitSubject) applied to whatever comes back. Used by
// commitCheckoutEditsAt (chat_checkout.go) — see "Content-aware, English
// subject without 'Claude'" in .claude/docs/pending-push.md.
//
// Same shape as comment_titles.go's Haiku call: a small, context-only,
// best-effort prompt — a Claude hiccup here never fails the landing, it just
// falls back to chatEditCommitFallbackSubject.
package main

import (
	"context"
	"regexp"
	"strings"

	"slash/modules/claude"
)

// maxChatCommitDiffPrompt clips the diff handed to the model. A one-line
// subject needs the gist of what changed, never a full huge diff — and
// keeping this bounded matters more here than for most other prompts, since
// a single reviewer edit can span many files.
const maxChatCommitDiffPrompt = 6000

// chatEditCommitFallbackSubject is the commit subject used whenever the
// content-aware Haiku call is unavailable, empty, or its answer fails the
// sanitizing/safety checks below (offline, SLASH_CLAUDE=off, a rate limit, an
// answer that still slipped in "Claude"/"AI"). Deliberately static and
// generic, never mentioning Claude/AI — see chatCommitSubjectSystemPromptDoc
// in chat_checkout.go for the full reasoning.
const chatEditCommitFallbackSubject = "Apply reviewer-requested edit"

// chatCommitSubjectPrompt builds the call-specific part of the prompt: the
// diff about to be committed, clipped to a sane budget. The task framing
// (English, imperative mood, length cap, the "never mention Claude/AI" rule)
// travels separately as claude.ChatCommitMessageSystemPrompt
// (--append-system-prompt).
func chatCommitSubjectPrompt(diff string) string {
	var b strings.Builder
	b.WriteString("Diff:\n\n")
	b.WriteString(clipForPrompt(diff, maxChatCommitDiffPrompt))
	return b.String()
}

// forbiddenChatCommitWordsRE matches "claude"/"ai" as a whole word,
// case-insensitively — the hard safety net behind the prompt's own
// instruction not to mention Claude/AI/assistant/tool names. Word-bounded so
// it never misfires on an ordinary word merely containing "ai" (e.g.
// "maintain", "remains").
var forbiddenChatCommitWordsRE = regexp.MustCompile(`(?i)\b(claude|ai|assistant|chatbot)\b`)

// sanitizeChatCommitSubject normalizes a raw model answer into a safe,
// one-line commit subject, or returns "" when the answer is empty or fails a
// safety check — the caller then falls back to
// chatEditCommitFallbackSubject. A pure function, safe to call from the
// Activity without touching determinism.
func sanitizeChatCommitSubject(raw string) string {
	s := strings.TrimSpace(raw)
	// A chatty model sometimes still answers with more than one line; only
	// the first non-empty line is ever a candidate subject.
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	s = strings.Trim(s, "`\"'")
	s = strings.Join(strings.Fields(s), " ")
	s = strings.TrimRight(s, ".")
	if s == "" || forbiddenChatCommitWordsRE.MatchString(s) {
		return ""
	}
	const maxSubjectRunes = 72
	if r := []rune(s); len(r) > maxSubjectRunes {
		s = strings.TrimRight(string(r[:maxSubjectRunes]), " ")
	}
	return s
}

// generateChatCommitSubject asks Haiku for a one-line English commit subject
// summarizing diff, sanitizes the answer, and falls back to
// chatEditCommitFallbackSubject whenever cl is nil, the call errors, or the
// answer doesn't survive sanitizing. Best-effort by design — the same
// contract every other context-only Haiku action in this codebase follows
// (see generateCommentTitles in workflows.go): never lets a Claude hiccup
// sink the landing itself.
func generateChatCommitSubject(ctx context.Context, cl claude.Client, diff string) string {
	if cl == nil || strings.TrimSpace(diff) == "" {
		return chatEditCommitFallbackSubject
	}
	raw, err := cl.Run(ctx, claude.RunRequest{
		Prompt:       chatCommitSubjectPrompt(diff),
		Model:        claude.ModelHaiku,
		SystemPrompt: claude.ChatCommitMessageSystemPrompt,
	})
	if err != nil {
		return chatEditCommitFallbackSubject
	}
	if s := sanitizeChatCommitSubject(raw); s != "" {
		return s
	}
	return chatEditCommitFallbackSubject
}
