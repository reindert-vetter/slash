package claude

import (
	"strings"
	"testing"
)

// TestChatShellSystemPromptInstructsARealPush guards against a reported bug:
// asked to push, the assistant deflected to the review-tree's "not pushed
// yet" todo row instead of just running `git push` itself in the checkout it
// already has Bash access to. The prompt must explicitly say to push for
// real on request, and must not tell the model to point the reviewer at the
// todo row as an answer to a push request made IN this conversation (that
// row is only for the reviewer to push on their own, without Claude).
func TestChatShellSystemPromptInstructsARealPush(t *testing.T) {
	p := ChatShellSystemPrompt
	if !strings.Contains(p, "git push") {
		t.Fatal("expected the shell prompt to instruct an actual `git push` on explicit request")
	}
	if !strings.Contains(strings.ToLower(p), "zelf, direct") && !strings.Contains(strings.ToLower(p), "doe dat dan zelf") {
		t.Fatal("expected the prompt to tell Claude to push itself, not defer it")
	}
	if strings.Contains(p, "wegwerpbaar klonetje") {
		t.Fatal("expected the stale disposable-shadow-worktree wording to be gone")
	}
}

// TestChatReadOnlySystemPromptCoversConfirmationAndForbidsAskingPermission
// guards against a reported bug (two reviewer screenshots): the read-only
// first attempt answered an edit request with prose proposing the diff and
// asking the reviewer to confirm it ("Keur je hem goed, dan pas ik dit
// toe?"), and when the reviewer then typed exactly that confirmation, the
// NEXT turn's own read-only attempt again answered in prose instead of
// emitting the strict {"type":"need_write"} directive — so the escalation
// that would have granted real Edit/Bash access never ran, and the app has
// no button/key anywhere for the reviewer to approve a pending edit. The
// prompt must say both things: there is no separate approval step to wait
// for, and a reviewer reply that approves/confirms a change Claude itself
// already proposed counts as an explicit request too, same as "pas dit aan".
func TestChatReadOnlySystemPromptCoversConfirmationAndForbidsAskingPermission(t *testing.T) {
	p := strings.ToLower(ChatReadOnlySystemPrompt)
	if !strings.Contains(p, "keur ik goed") {
		t.Fatal("expected the prompt to list a plain confirmation reply (e.g. \"keur ik goed\") as also triggering need_write")
	}
	if !strings.Contains(p, "geen aparte goedkeurknop") && !strings.Contains(p, "geen apart goedkeurmechanisme") {
		t.Fatal("expected the prompt to state there is no separate approval step/button in this app")
	}
	if !strings.Contains(p, `"type":"need_write"`) {
		t.Fatal("expected the need_write directive to still be documented")
	}
}

// TestPromptsAllowOneMessageToAskForBothAChangeAndAReply guards the reviewer
// report that a single message asking for both ("maak een comment en reageer
// kort erop") only produced the drafted reply: the read-only attempt picked
// the comment_action format and the code change never happened, so the
// reviewer had to send a second message. The read-only prompt must escalate
// with need_write on such a combined request, and the shell prompt must allow
// the prose answer plus the directive on its own last line — the shape
// parseAssistantTurn (chat_workflow.go) now parses.
func TestPromptsAllowOneMessageToAskForBothAChangeAndAReply(t *testing.T) {
	ro := strings.ToLower(ChatReadOnlySystemPrompt)
	if !strings.Contains(ro, "in een bericht om allebei") {
		t.Fatal("expected the read-only prompt to cover a combined change+reply request")
	}
	if !strings.Contains(ro, "nooit alvast het") {
		t.Fatal("expected the read-only prompt to forbid a comment_action while a change is still pending")
	}
	sh := strings.ToLower(ChatShellSystemPrompt)
	if !strings.Contains(sh, "eigen, laatste regel") {
		t.Fatal("expected the shell prompt to allow prose plus a trailing comment_action line")
	}
}

// TestChatShellSystemPromptNeverDeniesAutomaticLanding guards against a
// reported bug: a shell-attempt reply claimed "Niet gecommit, want daar vroeg
// je niet om" about its own Edit-tool change, directly contradicted moments
// later by the app's own automatic-landing outcome bubble in the same
// conversation (see "Automatic landing after a shell turn" in
// .claude/docs/workflows-comments.md) — the app commits and lands any
// Edit-tool change regardless of whether Claude itself ran `git commit`. The
// prompt must say so explicitly, so the model never denies it.
func TestChatShellSystemPromptNeverDeniesAutomaticLanding(t *testing.T) {
	p := strings.ToLower(ChatShellSystemPrompt)
	if !strings.Contains(p, "automatisch gecommit") {
		t.Fatal("expected the shell prompt to state that an edit is committed automatically by the app")
	}
	if !strings.Contains(p, "nooit dat een aanpassing") {
		t.Fatal("expected the shell prompt to forbid claiming a change is not (yet) committed")
	}
}

// TestEditingPromptsKeepDocblocksSmall guards a reviewer request: a docblock
// Claude adds/edits alongside a code change must stay small (at most 1 line
// per code group, 2-3 lines per function/method), skip functions that don't
// need one, explain WHY rather than HOW/WHAT, and never name a Jira ticket,
// file, or function. Checked on both prompts that grant the Edit tool.
func TestEditingPromptsKeepDocblocksSmall(t *testing.T) {
	for name, p := range map[string]string{
		"ChatShellSystemPrompt":    strings.ToLower(ChatShellSystemPrompt),
		"CommentBatchSystemPrompt": strings.ToLower(CommentBatchSystemPrompt),
	} {
		if !strings.Contains(p, "docblok") {
			t.Fatalf("%s: expected docblock guidance", name)
		}
		if !strings.Contains(p, "jira-ticketnummer") {
			t.Fatalf("%s: expected the prompt to forbid naming a Jira ticket in a docblock", name)
		}
		if !strings.Contains(p, "waarom") {
			t.Fatalf("%s: expected the prompt to say a docblock explains WHY, not how/what", name)
		}
	}
}
