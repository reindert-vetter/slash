package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestSteerReachesTheRunningTurn is the feature's core assertion: with a turn
// genuinely in flight (SetChatBlockUntilCancel — the same "still running"
// fixture the cancel test uses), a "steer" Signal on the conversation's OWN
// chat_steer Execution reaches that running claude call and is recorded as the
// reviewer's own message. It must NOT wait for the turn to finish — the whole
// point of the second Execution is that its lock is free while claude_chat's
// is held.
func TestSteerReachesTheRunningTurn(t *testing.T) {
	stubUnreachableGh(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970740, "comment-steer"

	fake.SetChatBlockUntilCancel(true)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	// SignalWorkflow drives the turn INLINE, so this blocks for as long as the
	// turn runs — hence its own goroutine (mirrors TestCancelledTurnDoesNotAutoRetry).
	signalDone := make(chan error, 1)
	go func() {
		signalDone <- engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
			ID: "msg-1", Author: "reviewer", Body: "Los deze bug op.",
		})
	}()
	waitFor(t, func() bool { return chatTurnSteerable(commentID) })

	steerRunID, err := m.EnsureChatSteer("", pr, commentID)
	if err != nil {
		t.Fatal(err)
	}
	steered := make(chan error, 1)
	go func() {
		steered <- engine.SignalWorkflow(steerRunID, SignalChatSteer, ChatSteerRequest{
			ID: "steer-1", Body: "kan je het mocken?",
		})
	}()
	select {
	case err := <-steered:
		if err != nil {
			t.Fatalf("steer signal failed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the steer signal blocked behind the running turn — the whole point of chat_steer is that it does not")
	}

	got := fake.Steered()
	// The CLI gets the reviewer's words plus chatSteerPrompt's framing (without
	// which the model reads a mid-turn instruction as an injection attempt).
	if len(got) != 1 || !strings.Contains(got[0], "kan je het mocken?") || !strings.Contains(got[0], "reviewer") {
		t.Fatalf("the running turn did not receive the steer message, got %+v", got)
	}
	// It is also visible as the reviewer's own message, immediately — not only
	// after the turn ends.
	list, _ := cm.List(ctx, commentID)
	if len(list) != 2 || list[1].Role != "user" || list[1].Body != "kan je het mocken?" {
		t.Fatalf("expected the steered message stored as a user turn, got %+v", list)
	}
	if list[1].ID != chatSteerMessageID("steer-1") {
		t.Fatalf("expected a message id derived from the signal id, got %q", list[1].ID)
	}

	// Clean up: unblock the turn so the inline Signal call returns.
	waitFor(t, func() bool { return cancelChatTurn(commentID) })
	select {
	case <-signalDone:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelling the turn did not unblock the blocked Signal call")
	}
}

// TestSteerWithNothingRunningFallsBackToAnOrdinaryTurn: no live claude call
// means nothing to steer, so the message must not vanish — the workflow's
// fallback forwards it to the conversation's own claude_chat run, where it
// becomes an ordinary next turn (stored once, by the usual saveChatMessage,
// never twice).
func TestSteerWithNothingRunningFallsBackToAnOrdinaryTurn(t *testing.T) {
	stubUnreachableGh(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970741, "comment-steer-fallback"

	fake.SetChatTurns("Prima, dat doe ik.")
	if _, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID}); err != nil {
		t.Fatal(err)
	}
	steerRunID, err := m.EnsureChatSteer("", pr, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if chatTurnSteerable(commentID) {
		t.Fatal("nothing is running, so this conversation must not report itself steerable")
	}
	if err := engine.SignalWorkflow(steerRunID, SignalChatSteer, ChatSteerRequest{
		ID: "steer-2", Body: "doe het toch maar",
	}); err != nil {
		t.Fatal(err)
	}

	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})
	list, _ := cm.List(ctx, commentID)
	if list[0].Role != "user" || list[0].Body != "doe het toch maar" {
		t.Fatalf("expected the forwarded message as an ordinary user turn, got %+v", list[0])
	}
	if list[1].Role != "assistant" {
		t.Fatalf("expected an assistant answer to the forwarded turn, got %+v", list[1])
	}
	if len(fake.Steered()) != 0 {
		t.Fatalf("nothing was running, so nothing may have been steered: %+v", fake.Steered())
	}
}
