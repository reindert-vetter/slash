package main

import (
	"context"
	"strings"
	"testing"

	"slash/modules/claude"
)

// The commit subject a chat-edit landing gets must never mention Claude/AI —
// this is the hard, reviewer-requested rule (see chat_checkout.go's
// chatEditCommitMarker doc comment and .claude/docs/pending-push.md). The
// prompt itself asks the model not to, but sanitizeChatCommitSubject is the
// safety net for when it slips in anyway.
func TestSanitizeChatCommitSubjectRejectsClaudeMentions(t *testing.T) {
	cases := []string{
		"Claude fixed the payment flow",
		"Have Claude retry the refund logic",
		"AI cleaned up the validator",
		"Ask the assistant to simplify this",
	}
	for _, raw := range cases {
		if got := sanitizeChatCommitSubject(raw); got != "" {
			t.Fatalf("sanitizeChatCommitSubject(%q) = %q, want rejected (empty)", raw, got)
		}
	}
}

// An ordinary word that happens to contain "ai" (e.g. "remains", "maintain")
// must not be mistaken for the forbidden word "AI" — the check is
// word-bounded.
func TestSanitizeChatCommitSubjectKeepsOrdinaryWordsContainingAi(t *testing.T) {
	got := sanitizeChatCommitSubject("Maintain backward compatibility in the invoice export")
	if got == "" {
		t.Fatal("expected an ordinary subject containing 'ai' mid-word to survive sanitizing")
	}
}

func TestSanitizeChatCommitSubjectTrimsQuotesFencesAndLength(t *testing.T) {
	got := sanitizeChatCommitSubject("\"Fix null check in payment validation.\"\n\nExtra prose the model added anyway.")
	if got != "Fix null check in payment validation" {
		t.Fatalf("got %q", got)
	}

	long := strings.Repeat("a", 100)
	got = sanitizeChatCommitSubject(long)
	if len([]rune(got)) > 72 {
		t.Fatalf("expected the subject clipped to at most 72 runes, got %d", len([]rune(got)))
	}
}

func TestGenerateChatCommitSubjectFallsBackWhenUnavailable(t *testing.T) {
	ctx := context.Background()

	if got := generateChatCommitSubject(ctx, nil, "diff --git a/x b/x"); got != chatEditCommitFallbackSubject {
		t.Fatalf("nil client: got %q, want fallback", got)
	}

	errClient := &claude.Fake{}
	errClient.SetError(claude.ModelHaiku, context.DeadlineExceeded)
	if got := generateChatCommitSubject(ctx, errClient, "diff --git a/x b/x"); got != chatEditCommitFallbackSubject {
		t.Fatalf("erroring client: got %q, want fallback", got)
	}

	emptyClient := &claude.Fake{}
	if got := generateChatCommitSubject(ctx, emptyClient, "diff --git a/x b/x"); got != chatEditCommitFallbackSubject {
		t.Fatalf("empty answer: got %q, want fallback", got)
	}

	claudeMentionClient := &claude.Fake{}
	claudeMentionClient.SetOutput(claude.ModelHaiku, "Claude simplified the retry loop")
	if got := generateChatCommitSubject(ctx, claudeMentionClient, "diff --git a/x b/x"); got != chatEditCommitFallbackSubject {
		t.Fatalf("a Claude-mentioning answer: got %q, want fallback", got)
	}

	ok := &claude.Fake{}
	ok.SetOutput(claude.ModelHaiku, "Fix null check in payment validation")
	if got := generateChatCommitSubject(ctx, ok, "diff --git a/x b/x"); got != "Fix null check in payment validation" {
		t.Fatalf("got %q", got)
	}
}
