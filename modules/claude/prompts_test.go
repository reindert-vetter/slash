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
