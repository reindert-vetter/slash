// chat_summary.go — helpers for the summarize_chat workflow: the deterministic
// Run ID that makes a repeated request for the same conversation+message-count
// an idempotent no-op (mirrors explain.go's explainRunID), and the Dutch
// transcript prompt asking Haiku for a short summary of an embedded Claude
// conversation.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"slash/modules/chat"
)

// chatSummaryRunID derives a deterministic, filename-safe Run ID from the
// conversation's identity + how many messages it currently has.
// StartWorkflowID then dedups repeated starts: asking again with no new
// messages never triggers a second LLM call, while a further reply yields a
// fresh Execution (a new count = a new hash).
func chatSummaryRunID(commentID string, msgCount int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", commentID, msgCount)))
	return "csum-" + hex.EncodeToString(sum[:12])
}

// chatSummaryPrompt builds the call-specific part of the context-only Haiku
// prompt: the conversation's own transcript, oldest first, labeled per
// speaker — no tools, no worktree access. The call-independent task framing
// (summarize, in Dutch, in at most 2 sentences, comma/period punctuation only,
// backticks/code fences allowed) travels separately as
// claude.ChatSummarySystemPrompt (--append-system-prompt). Question turns'
// Options/Answer are folded into the same line as the assistant's own body —
// the summary only needs to read as a conversation, not reproduce the
// button-choice UI.
func chatSummaryPrompt(msgs []chat.Message) string {
	var b strings.Builder
	b.WriteString("Gesprek:\n\n")
	for _, m := range msgs {
		switch m.Kind {
		case chat.KindError, chat.KindRetrying:
			// A failed/still-retrying attempt carries no content worth
			// summarizing — skip it so the summary doesn't dwell on a hiccup.
			continue
		}
		who := "Reviewer"
		if m.Role == "assistant" {
			who = "Claude"
		}
		body := m.Body
		if m.Answer != "" {
			body += " (antwoord: " + m.Answer + ")"
		}
		fmt.Fprintf(&b, "%s: %s\n\n", who, body)
	}
	return b.String()
}
