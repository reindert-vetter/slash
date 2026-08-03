package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/chat"
	"slash/modules/claude"
)

// chat_shell_test.go covers runOneClaudeTurn's own decision of whether a turn
// gets real shell/file access this turn (prepareChatShellWorkDir,
// chat_shadow.go) — the graceful-degrade half of
// .claude/rules/workflows-write-boundary.md's "Exception: the Claude chat
// turn may act through a shell". The two tests below exercise the same
// runOneClaudeTurn call with the ONLY difference being whether gh/git are
// reachable, asserting the observable difference in what gets sent to
// claude.Client (RunRequest.WorkDir/Tools/SystemPrompt) and, in the failure
// case, that the turn still succeeds as an ordinary reply.

// stubReachableGh drops a fake "gh" script on PATH that answers `gh pr view
// ... --json ...` with valid PR metadata for headRefName, so fetchPRMeta
// (gh.go) succeeds without ever touching the real GitHub CLI/network. Mirrors
// stubUnreachableGh's PATH-shim technique for the opposite outcome.
func stubReachableGh(t *testing.T, headRefName string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "gh")
	script := fmt.Sprintf("#!/bin/sh\necho '{\"files\":[],\"baseRefOid\":\"\",\"headRefOid\":\"\",\"baseRefName\":\"\",\"headRefName\":\"%s\"}'\n", headRefName)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestRunOneClaudeTurnUsesShellByDefaultWhenReachable proves the default
// ("" action) turn gets Read/Grep/Glob/Edit/Bash against a real shadow
// worktree as soon as gh/git are reachable — no separate "edit" action
// needed, per the rule carve-out.
func TestRunOneClaudeTurnUsesShellByDefaultWhenReachable(t *testing.T) {
	const headRefName = "feature/shell-turn"
	setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970730, "comment-shell"

	fake.SetChatTurns("Ik heb het aangepast.")
	msg, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas foo.txt aan", TurnID: "msg-shell",
	})

	if msg.Kind == chat.KindError {
		t.Fatalf("expected an ordinary reply, got an error turn: %+v", msg)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call, got %d", len(fake.Calls))
	}
	got := fake.Calls[0]
	if got.WorkDir == "" {
		t.Fatal("expected WorkDir to be set to the shadow worktree")
	}
	wantTools := map[string]bool{"Read": true, "Grep": true, "Glob": true, "Edit": true, "Bash": true}
	if len(got.Tools) != len(wantTools) {
		t.Fatalf("Tools = %v, want exactly %v", got.Tools, wantTools)
	}
	for _, tool := range got.Tools {
		if !wantTools[tool] {
			t.Fatalf("unexpected tool %q in %v", tool, got.Tools)
		}
	}
	// runOneClaudeTurn appends a dynamic "comment thread id" line after
	// picking the base prompt (see chat_workflow.go), so this must check a
	// prefix, not equality.
	if !strings.HasPrefix(got.SystemPrompt, claude.ChatShellSystemPrompt) {
		t.Fatal("expected the shell system prompt when the shadow worktree is available")
	}
}

// TestRunOneClaudeTurnDegradesWhenGhUnreachable proves a pure conversational
// turn never breaks when gh/git are unreachable — the exact regression the
// project guards against (an earlier attempt defaulted every turn to the
// 'edit' action and made ordinary chatting hard-fail with "Kon geen
// werkkopie…" whenever gh was unreachable).
func TestRunOneClaudeTurnDegradesWhenGhUnreachable(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970731, "comment-degrade"

	fake.SetChatTurns("Hallo!")
	msg, action := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Hoi", TurnID: "msg-degrade",
	})

	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}
	if msg.Kind == chat.KindError {
		t.Fatalf("a pure conversational turn must not fail when gh is unreachable, got: %+v", msg)
	}
	if msg.Body != "Hallo!" {
		t.Fatalf("saved assistant body = %q", msg.Body)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call, got %d", len(fake.Calls))
	}
	got := fake.Calls[0]
	if got.WorkDir != "" {
		t.Fatalf("expected no WorkDir when gh is unreachable, got %q", got.WorkDir)
	}
	if len(got.Tools) != 0 {
		t.Fatalf("expected no Tools when gh is unreachable, got %v", got.Tools)
	}
	if !strings.HasPrefix(got.SystemPrompt, claude.ChatSystemPrompt) {
		t.Fatal("expected the plain (tool-less) system prompt when the shadow worktree is unavailable")
	}
}
