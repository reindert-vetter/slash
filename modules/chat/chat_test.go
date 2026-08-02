package chat

import (
	"context"
	"path/filepath"
	"testing"
)

func testModule(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// Round-trip: EnsureConversation is idempotent, SaveMessage stores both roles
// in order, and SetSession/GetSession round-trip the CLI session id.
func TestChatRoundTrip(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	const convID = "comment-1"

	if err := m.EnsureConversation(ctx, convID, 5); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, convID, 5); err != nil { // idempotent
		t.Fatal(err)
	}

	if got, err := m.GetSession(ctx, convID); err != nil || got != "" {
		t.Fatalf("GetSession before any turn = %q, %v", got, err)
	}

	if err := m.SaveMessage(ctx, Message{ID: "m1", ConversationID: convID, PR: 5, Role: "user", Body: "hoi"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetSession(ctx, convID, "sess-abc"); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m2", ConversationID: convID, PR: 5, Role: "assistant", Body: "hallo terug"}); err != nil {
		t.Fatal(err)
	}

	if got, err := m.GetSession(ctx, convID); err != nil || got != "sess-abc" {
		t.Fatalf("GetSession after SetSession = %q, %v", got, err)
	}

	list, err := m.List(ctx, convID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Role != "user" || list[1].Role != "assistant" {
		t.Fatalf("List order/roles = %+v", list)
	}
}

// A question turn's Options round-trip through JSON storage, and answering it
// records the Answer on the SAME row (not a new one) — the property the
// "refresh still shows which option was picked" requirement depends on.
func TestChatQuestionAndAnswer(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	const convID = "comment-2"

	if err := m.EnsureConversation(ctx, convID, 7); err != nil {
		t.Fatal(err)
	}
	q := Message{
		ID: "q1", ConversationID: convID, PR: 7, Role: "assistant",
		Kind: KindQuestion, Body: "Welke aanpak wil je?",
		Options: []string{"Optie A", "Optie B", "Optie C"},
	}
	if err := m.SaveMessage(ctx, q); err != nil {
		t.Fatal(err)
	}
	if err := m.SetAnswer(ctx, "q1", "Optie B"); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, convID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("expected exactly one row (the question), got %d", len(list))
	}
	got := list[0]
	if got.Kind != KindQuestion || got.Answer != "Optie B" {
		t.Fatalf("question row after answer = %+v", got)
	}
	if len(got.Options) != 3 || got.Options[1] != "Optie B" {
		t.Fatalf("options round-trip = %+v", got.Options)
	}
}

// Purge removes every conversation + message of a PR and leaves other PRs
// untouched — the cleanup workflow's per-module contract.
func TestChatPurge(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()

	if err := m.EnsureConversation(ctx, "c-pr9", 9); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m9", ConversationID: "c-pr9", PR: 9, Role: "user", Body: "x"}); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c-pr10", 10); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m10", ConversationID: "c-pr10", PR: 10, Role: "user", Body: "y"}); err != nil {
		t.Fatal(err)
	}

	n, err := m.Purge(ctx, 9)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("Purge removed %d messages, want 1", n)
	}
	if list, _ := m.List(ctx, "c-pr9"); len(list) != 0 {
		t.Fatalf("pr 9 messages survived purge: %+v", list)
	}
	if list, err := m.List(ctx, "c-pr10"); err != nil || len(list) != 1 {
		t.Fatalf("pr 10 messages wrongly affected: %+v, %v", list, err)
	}
}
