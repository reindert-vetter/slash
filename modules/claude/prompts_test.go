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
