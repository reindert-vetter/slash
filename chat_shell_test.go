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
// chat_checkout.go) — the graceful-degrade half of
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
	bareDir, _ := setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970730, "comment-shell"

	// The reviewer's OWN checkout — registered via settings.json, exactly the
	// way chat_checkout.go's selection ladder discovers it (see
	// todo/todo-local-checkout-chat-edits.md; the disposable shadow worktree
	// is gone).
	dataDir := t.TempDir()
	checkoutDir := cloneCheckoutDir(t, bareDir, headRefName)
	writeCheckoutSettings(t, dataDir, checkoutDir)

	fake.SetChatTurns(`{"type":"need_write"}`, "Ik heb het aangepast.")
	msg, _ := runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas foo.txt aan", TurnID: "msg-shell",
	})

	if msg.Kind == chat.KindError {
		t.Fatalf("expected an ordinary reply, got an error turn: %+v", msg)
	}
	if msg.Body != "Ik heb het aangepast." {
		t.Fatalf("expected the SECOND (shell) call's reply to be saved, got %q", msg.Body)
	}
	if msg.NoShell {
		t.Fatal("expected NoShell=false once the escalated call got the local checkout (no 'Geen bestandstoegang' pill)")
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
	if got.WorkDir != checkoutDir {
		t.Fatalf("expected WorkDir to be the reviewer's registered checkout %q, got %q", checkoutDir, got.WorkDir)
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

// TestRunOneClaudeTurnDegeneratesGracefullyOnRepeatedNeedWrite proves that a
// SECOND, already-shell-enabled call replying with the exact same
// {"type":"need_write"} directive (Claude getting stuck repeating the
// escalation signal instead of acting on the write access it was just
// granted) is surfaced as an ordinary, reviewer-facing notice — not the raw
// directive JSON verbatim, and not a chat.KindError bubble (nothing in the
// existing error/retry sense actually failed here, so there must be no
// "Opnieuw proberen" button on it).
func TestRunOneClaudeTurnDegeneratesGracefullyOnRepeatedNeedWrite(t *testing.T) {
	const headRefName = "feature/shell-turn-repeat"
	bareDir, _ := setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970734, "comment-shell-repeat"

	dataDir := t.TempDir()
	checkoutDir := cloneCheckoutDir(t, bareDir, headRefName)
	writeCheckoutSettings(t, dataDir, checkoutDir)

	fake.SetChatTurns(`{"type":"need_write"}`, `{"type":"need_write"}`)
	msg, action := runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Pas foo.txt aan", TurnID: "msg-shell-repeat",
	})

	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}
	if msg.Kind == chat.KindError {
		t.Fatalf("expected a plain notice, not a chat.KindError bubble: %+v", msg)
	}
	if msg.Body == `{"type":"need_write"}` {
		t.Fatal("expected a reviewer-facing sentence, not the raw directive JSON verbatim")
	}
	if msg.Body == "" {
		t.Fatal("expected a non-empty reviewer-facing explanation")
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected exactly 2 RunChat calls (read-only, then the escalated one that repeated the directive), got %d", len(fake.Calls))
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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

// TestRunOneClaudeTurnEscalatesOnProseWriteRefusal is the regression test for
// the reviewer-reported dead end that looksLikeWriteRefusal exists for: the
// read-only first attempt answers in ordinary prose that it has no Edit/Bash
// (plus the proposed replacement in a fence) instead of emitting the strict
// {"type":"need_write"} directive. That reply must never reach the transcript
// as the turn's answer — the turn escalates to the shell attempt anyway and
// only THAT reply is saved.
func TestRunOneClaudeTurnEscalatesOnProseWriteRefusal(t *testing.T) {
	const headRefName = "feature/shell-turn-prose"
	bareDir, _ := setupChatShadowRepo(t, headRefName, "hello\n")
	stubReachableGh(t, headRefName)

	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970736, "comment-shell-prose"

	dataDir := t.TempDir()
	checkoutDir := cloneCheckoutDir(t, bareDir, headRefName)
	writeCheckoutSettings(t, dataDir, checkoutDir)

	// Verbatim the shape of the reported reply (PR 13451): a refusal sentence
	// plus the replacement it proposes in a fence.
	const refusal = "Ik heb deze beurt alsnog geen Edit/Bash, dus ik kan het niet zelf doorvoeren. Dit is de vervanging van regels 63-67:\n\n```php\n// Registering statistics work now goes through this signal.\n```"
	fake.SetChatTurns(refusal, "Aangepast in één regel.")
	msg, action := runOneClaudeTurn(ctx, m, cm, fake, dataDir, chatTurnInput{
		PR: pr, ConversationID: commentID,
		Body: "Verander in 1 zin dat dit de nieuwe manier is", TurnID: "msg-shell-prose",
	})

	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected the prose refusal to escalate to a SECOND call, got %d call(s)", len(fake.Calls))
	}
	if msg.Body != "Aangepast in één regel." {
		t.Fatalf("expected the escalated call's reply to be saved, got %q", msg.Body)
	}
	got := fake.Calls[1]
	if got.SessionID == "" {
		t.Fatal("expected the escalated call to RESUME the read-only call's own session")
	}
	if got.WorkDir != checkoutDir {
		t.Fatalf("expected WorkDir to be the reviewer's registered checkout %q, got %q", checkoutDir, got.WorkDir)
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
	if !strings.HasPrefix(got.SystemPrompt, claude.ChatShellSystemPrompt) {
		t.Fatal("expected the shell system prompt on the escalated call")
	}
}

// TestLooksLikeWriteRefusalStaysNarrow pins the heuristic's boundaries: it
// must fire on the observed refusal wordings and stay silent on an ordinary
// answer, on an answer that merely CONTAINS such words inside a code fence,
// and on Claude's own structured directives.
func TestLooksLikeWriteRefusalStaysNarrow(t *testing.T) {
	fire := []string{
		"Ik heb deze beurt alsnog geen Edit/Bash, dus ik kan het niet zelf doorvoeren.",
		"Edit en Bash zijn in deze sessie uitgeschakeld, dus dit is de voorgestelde regel.",
		"Ik heb geen shell om dit te committen.",
		"Zonder schrijftoegang kan ik niets aanpassen; hier is het voorstel.",
		// PR 13730, verbatim from the stored transcript: the CLI retracted
		// Edit/Bash with cause "denied" on a resumed session and Claude
		// reported that as a permission rule instead of emitting the
		// need_write directive.
		"Ik kan deze beurt niets schrijven of draaien: `Edit` en `Bash` zijn door een permissieregel geblokkeerd (de tools zijn er wel, maar elke aanroep wordt geweigerd).",
	}
	for _, text := range fire {
		if !looksLikeWriteRefusal(text) {
			t.Fatalf("expected an escalation for %q", text)
		}
	}
	silent := []string{
		"Deze functie registreert de statistiek via de bus.",
		"Ik heb het aangepast en lokaal gecommit.",
		`{"type":"need_write"}`,
		`{"type":"question","question":"Welk bestand?","options":["a","b"]}`,
		// The words only appear INSIDE a fence — source/comment text must
		// never be able to trigger an escalation.
		"Zo ziet de regel eruit:\n\n```php\n// geen Edit hier, Bash is uitgeschakeld\n```",
		// An absence word next to a word that merely CONTAINS a tool name is
		// not a refusal — see writeToolNamePattern.
		"De creditfactuur werd geweigerd door de provider.",
	}
	for _, text := range silent {
		if looksLikeWriteRefusal(text) {
			t.Fatalf("did not expect an escalation for %q", text)
		}
	}
}

// TestCheckoutDeadEndForcesEscalation is the PR 13730 regression: the turn
// AFTER a checkout dead end must escalate to attempt 2 on that fact alone,
// without Claude having to emit {"type":"need_write"} again. In the reported
// session the resumed read-only attempt was told by the CLI that Edit/Bash
// were retracted with cause "denied" and answered in prose about a
// "permissieregel", so the werkmap choice the reviewer had just made resolved
// nothing and the turn dead ended a second time.
func TestCheckoutDeadEndForcesEscalation(t *testing.T) {
	cm := testChatModule(t)
	ctx := context.Background()
	const conv = "conv-deadend"
	if err := cm.EnsureConversation(ctx, conv, "plug-and-pay/plug-and-pay", 13730); err != nil {
		t.Fatalf("ensure conversation: %v", err)
	}
	save := func(id, role, body string, noShell bool) {
		t.Helper()
		if err := cm.SaveMessage(ctx, chat.Message{
			ID: id, ConversationID: conv, PR: 13730,
			Role: role, Body: body, NoShell: noShell,
		}); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
	}

	save("m1", "user", "oke, doe wat je moet doen", false)
	save("m2", "assistant", chatCheckoutChoiceOpenBody, true)
	if !lastTurnWasCheckoutDeadEnd(ctx, cm, conv) {
		t.Fatal("an open work-directory choice must count as a dead end")
	}

	// The reviewer's resume message does not clear it — only a real answer does.
	save("m3", "user", "Werkmap gekozen: Meenemen in de commit. Ga verder met mijn vorige verzoek.", false)
	if !lastTurnWasCheckoutDeadEnd(ctx, cm, conv) {
		t.Fatal("a following user message must not clear the dead end")
	}

	save("m4", "assistant", "Aangepast en gecommit.", false)
	if lastTurnWasCheckoutDeadEnd(ctx, cm, conv) {
		t.Fatal("a real answer after the dead end must clear it")
	}

	// The other two dead-end shapes the same branch produces.
	for i, body := range []string{chatNoCheckoutBody, chatCheckoutBlockedPrefix + "De checkout is bezet."} {
		id := fmt.Sprintf("m5-%d", i)
		save(id, "assistant", body, true)
		if !lastTurnWasCheckoutDeadEnd(ctx, cm, conv) {
			t.Fatalf("expected a dead end for %q", body)
		}
	}

	// A read-only turn that simply had no shell is NOT a dead end.
	save("m6", "assistant", "Deze functie registreert de statistiek via de bus.", true)
	if lastTurnWasCheckoutDeadEnd(ctx, cm, conv) {
		t.Fatal("an ordinary no-shell answer must not count as a dead end")
	}
}
