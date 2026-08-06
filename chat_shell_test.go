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
// claude.Client (RunRequest.WorkDir/Tools/SystemPrompt), the saved message's
// NoShell flag (see chat.Message.NoShell / the "Geen bestandstoegang" pill in
// ClaudeChat.mjs), and, in the failure case, that the turn still succeeds as
// an ordinary reply.

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

// TestRunOneClaudeTurnEscalatesToShellOnNeedWrite proves a turn that answers
// its cheap read-only first attempt with the {"type":"need_write"} directive
// (task 3) gets a SECOND call with Read/Grep/Glob/Edit/Bash against a real
// shadow worktree, resuming the same session, as soon as gh/git are
// reachable — no separate "edit" action needed, per the rule carve-out.
func TestRunOneClaudeTurnEscalatesToShellOnNeedWrite(t *testing.T) {
	const headRefName = "feature/shell-turn"
	setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970730, "comment-shell"

	fake.SetChatTurns(`{"type":"need_write"}`, "Ik heb het aangepast.")
	msg, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas foo.txt aan", TurnID: "msg-shell",
	})

	if msg.Kind == chat.KindError {
		t.Fatalf("expected an ordinary reply, got an error turn: %+v", msg)
	}
	if msg.Body != "Ik heb het aangepast." {
		t.Fatalf("expected the SECOND (shell) call's reply to be saved, got %q", msg.Body)
	}
	if msg.NoShell {
		t.Fatal("expected NoShell=false once the escalated call got the shadow worktree (no 'Geen bestandstoegang' pill)")
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected exactly 2 RunChat calls (read-only, then escalated), got %d", len(fake.Calls))
	}
	first := fake.Calls[0]
	if first.WorkDir != "" {
		t.Fatalf("expected the first (read-only) call to have no WorkDir since no head worktree exists, got %q", first.WorkDir)
	}
	got := fake.Calls[1]
	if got.SessionID == "" {
		t.Fatal("expected the escalated call to RESUME the read-only call's own session (a non-empty SessionID), not start a fresh one")
	}
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
		t.Fatal("expected the shell system prompt on the escalated call")
	}
}

// TestRunOneClaudeTurnUsesReadOnlyHeadWorktreeWithoutEscalating proves task
// 3's whole point: a turn that never asks to write gets ONE cheap call with
// Read/Grep/Glob against the PR's already-ingested, SHARED head worktree —
// never the disposable shadow worktree, and no gh/git round trip at all (this
// runs with gh deliberately unreachable, to prove the read-only path needs
// none of that).
func TestRunOneClaudeTurnUsesReadOnlyHeadWorktreeWithoutEscalating(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970732, "comment-readonly"

	dataDir := t.TempDir()
	_, headDir := worktreeDirs(dataDir, pr)
	if err := os.MkdirAll(headDir, 0o755); err != nil {
		t.Fatal(err)
	}

	fake.SetChatTurns("Deze functie doet X.")
	msg, action := runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Wat doet deze functie?", TurnID: "msg-readonly",
	})

	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}
	if msg.Kind == chat.KindError {
		t.Fatalf("expected an ordinary reply, got an error turn: %+v", msg)
	}
	if msg.NoShell {
		t.Fatal("expected NoShell=false: a plain question DID get real Read/Grep/Glob access, it just never escalated")
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("a turn that never asks to write must cost exactly 1 RunChat call, got %d", len(fake.Calls))
	}
	got := fake.Calls[0]
	if got.WorkDir != headDir {
		t.Fatalf("expected WorkDir to be the SHARED head worktree %q, got %q", headDir, got.WorkDir)
	}
	wantTools := map[string]bool{"Read": true, "Grep": true, "Glob": true}
	if len(got.Tools) != len(wantTools) {
		t.Fatalf("Tools = %v, want exactly %v (no Edit/Bash without escalating)", got.Tools, wantTools)
	}
	for _, tool := range got.Tools {
		if !wantTools[tool] {
			t.Fatalf("unexpected tool %q in %v", tool, got.Tools)
		}
	}
	if !strings.HasPrefix(got.SystemPrompt, claude.ChatReadOnlySystemPrompt) {
		t.Fatal("expected the read-only system prompt")
	}
}

// TestRunOneClaudeTurnDegradesWhenShellUnavailableAfterEscalating proves that
// a turn which DOES ask to write, but can't get the shadow worktree (gh/git
// unreachable), degrades to a visible, NoShell reply instead of an error turn
// — the same graceful-degrade philosophy as the plain read-only path, applied
// to the escalation step too.
func TestRunOneClaudeTurnDegradesWhenShellUnavailableAfterEscalating(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970733, "comment-escalate-degrade"

	fake.SetChatTurns(`{"type":"need_write"}`)
	msg, action := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas dit aan", TurnID: "msg-escalate-degrade",
	})

	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}
	if msg.Kind == chat.KindError {
		t.Fatalf("expected an ordinary (degraded) reply, not an error turn: %+v", msg)
	}
	if !msg.NoShell {
		t.Fatal("expected NoShell=true when the escalated shadow worktree is unavailable")
	}
	if msg.Body == "" {
		t.Fatal("expected a reviewer-facing explanation, not an empty body")
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call (the read-only attempt; the escalation never reached the CLI), got %d", len(fake.Calls))
	}
}

// TestRunOneClaudeTurnDegradesWhenGhUnreachable proves a pure conversational
// turn never breaks when gh/git are unreachable AND no head worktree exists
// yet either — the exact regression the project guards against (an earlier
// attempt defaulted every turn to the 'edit' action and made ordinary
// chatting hard-fail with "Kon geen werkkopie…" whenever gh was
// unreachable). See TestRunOneClaudeTurnUsesReadOnlyHeadWorktreeWithoutEscalating
// for the (now far more common) case where the head worktree DOES exist —
// that one needs no gh/git at all and is not degraded.
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
	if !msg.NoShell {
		t.Fatal("expected NoShell=true when the shadow worktree is unavailable, so the reviewer sees the 'Geen bestandstoegang' pill")
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
