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

	if err := m.EnsureConversation(ctx, convID, "", 5); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, convID, "", 5); err != nil { // idempotent
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
	if err := m.SaveMessage(ctx, Message{
		ID: "m2", ConversationID: convID, PR: 5, Role: "assistant", Body: "hallo terug",
		Model: "claude-sonnet-5", NoShell: true,
	}); err != nil {
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
	// NoShell round-trips just like Model does — the "Geen bestandstoegang"
	// pill (ClaudeChat.mjs) depends on it surviving a save/list cycle.
	if !list[1].NoShell || list[1].Model != "claude-sonnet-5" {
		t.Fatalf("Model/NoShell round trip = %+v", list[1])
	}
	if list[0].NoShell {
		t.Fatalf("a reviewer (user) turn must never carry NoShell: %+v", list[0])
	}
}

// A question turn's Options round-trip through JSON storage, and answering it
// records the Answer on the SAME row (not a new one) — the property the
// "refresh still shows which option was picked" requirement depends on.
func TestChatQuestionAndAnswer(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	const convID = "comment-2"

	if err := m.EnsureConversation(ctx, convID, "", 7); err != nil {
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

// ConversationsWithMessages reports only the conversations of the asked PR that
// really have turns — an ensured-but-empty conversation is nothing to come back
// to, so it must stay out (it is what decides whether the chat column exists).
func TestConversationsWithMessages(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()

	if err := m.EnsureConversation(ctx, "c-empty", "", 11); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c-talked", "", 11); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m1", ConversationID: "c-talked", PR: 11, Role: "user", Body: "hoi"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m2", ConversationID: "c-talked", PR: 11, Role: "assistant", Body: "hallo"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m3", ConversationID: "c-other-pr", PR: 12, Role: "user", Body: "elders"}); err != nil {
		t.Fatal(err)
	}

	ids, err := m.ConversationsWithMessages(ctx, "", 11)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "c-talked" {
		t.Fatalf("ids = %v, want exactly [c-talked]", ids)
	}
}

// MarkSeen/SeenAt/SeenAtForPR — the durable "has the reviewer opened this
// conversation" signal behind the "Openstaande chats" blue-eye indicator (see
// .claude/docs/claude-chat-panel.md). Never marked → "" (no seen_at row at
// all, not an error); MarkSeen stamps a real timestamp; SeenAtForPR only
// reports the conversations that HAVE been marked, scoped to repo+pr, and
// leaves an unmarked one out entirely.
func TestSeenAt(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()

	if err := m.EnsureConversation(ctx, "c-unseen", "", 7); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c-seen", "", 7); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c-other-pr", "", 8); err != nil {
		t.Fatal(err)
	}

	seenAt, err := m.SeenAt(ctx, "c-unseen")
	if err != nil {
		t.Fatal(err)
	}
	if seenAt != "" {
		t.Fatalf("seenAt = %q before MarkSeen, want empty", seenAt)
	}

	if err := m.MarkSeen(ctx, "c-seen"); err != nil {
		t.Fatal(err)
	}
	if err := m.MarkSeen(ctx, "c-other-pr"); err != nil {
		t.Fatal(err)
	}

	seenAt, err = m.SeenAt(ctx, "c-seen")
	if err != nil {
		t.Fatal(err)
	}
	if seenAt == "" {
		t.Fatal("seenAt still empty after MarkSeen")
	}

	// A conversation row that never existed at all: still a plain "" (no
	// error), same "unmarked" answer as one that exists but was never seen.
	seenAt, err = m.SeenAt(ctx, "does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	if seenAt != "" {
		t.Fatalf("seenAt = %q for a nonexistent conversation, want empty", seenAt)
	}

	bulk, err := m.SeenAtForPR(ctx, "", 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(bulk) != 1 {
		t.Fatalf("SeenAtForPR(pr=7) = %v, want exactly one entry", bulk)
	}
	if _, ok := bulk["c-seen"]; !ok {
		t.Fatalf("SeenAtForPR(pr=7) = %v, want c-seen", bulk)
	}
	if _, ok := bulk["c-unseen"]; ok {
		t.Fatalf("SeenAtForPR(pr=7) unexpectedly reports the never-seen conversation: %v", bulk)
	}
	if _, ok := bulk["c-other-pr"]; ok {
		t.Fatalf("SeenAtForPR(pr=7) leaked a conversation from a different PR: %v", bulk)
	}
}

// Purge removes every conversation + message of a PR and leaves other PRs
// untouched — the cleanup workflow's per-module contract.
func TestChatPurge(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()

	if err := m.EnsureConversation(ctx, "c-pr9", "", 9); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m9", ConversationID: "c-pr9", PR: 9, Role: "user", Body: "x"}); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c-pr10", "", 10); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m10", ConversationID: "c-pr10", PR: 10, Role: "user", Body: "y"}); err != nil {
		t.Fatal(err)
	}

	n, err := m.Purge(ctx, "", 9)
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

// ClearConversation wipes the transcript + stored session but keeps the
// conversation row itself (so the id keeps anchoring to the same comment
// thread), and leaves an unrelated conversation untouched.
func TestClearConversation(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()

	if err := m.EnsureConversation(ctx, "c1", "", 5); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m1", ConversationID: "c1", PR: 5, Role: "user", Body: "hoi"}); err != nil {
		t.Fatal(err)
	}
	if err := m.SetSession(ctx, "c1", "sess-abc"); err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureConversation(ctx, "c2", "", 5); err != nil {
		t.Fatal(err)
	}
	if err := m.SaveMessage(ctx, Message{ID: "m2", ConversationID: "c2", PR: 5, Role: "user", Body: "andere"}); err != nil {
		t.Fatal(err)
	}

	if err := m.ClearConversation(ctx, "c1"); err != nil {
		t.Fatal(err)
	}

	if list, err := m.List(ctx, "c1"); err != nil || len(list) != 0 {
		t.Fatalf("c1 messages survived clear: %+v, %v", list, err)
	}
	if got, err := m.GetSession(ctx, "c1"); err != nil || got != "" {
		t.Fatalf("GetSession after clear = %q, %v", got, err)
	}
	if list, err := m.List(ctx, "c2"); err != nil || len(list) != 1 {
		t.Fatalf("c2 messages wrongly affected: %+v, %v", list, err)
	}
}

// TestSaveMessageBackfillsRepoFromConversation pins the multi-repo backfill:
// most message constructors never thread Repo through (they predate
// multi-repo), and "" is a VALID value (the primary repo) — so a non-primary
// repo's message used to be silently filed under the primary repo, invisible
// to every repo-scoped read (ConversationsWithMessages, SeenAtForPR) and
// unreachable for Purge(repo, pr).
func TestSaveMessageBackfillsRepoFromConversation(t *testing.T) {
	m := testModule(t)
	ctx := context.Background()
	const convID, repo = "comment-multi", "acme/ops"

	if err := m.EnsureConversation(ctx, convID, repo, 12); err != nil {
		t.Fatal(err)
	}
	// Deliberately no Repo on the message — the shape nearly every writer has.
	if err := m.SaveMessage(ctx, Message{ID: "m1", ConversationID: convID, PR: 12, Role: "user", Body: "hoi"}); err != nil {
		t.Fatal(err)
	}

	list, err := m.List(ctx, convID)
	if err != nil || len(list) != 1 {
		t.Fatalf("List = %v, %v", list, err)
	}
	if list[0].Repo != repo {
		t.Fatalf("stored repo = %q, want %q (backfilled from the conversation row)", list[0].Repo, repo)
	}
	ids, err := m.ConversationsWithMessages(ctx, repo, 12)
	if err != nil || len(ids) != 1 || ids[0] != convID {
		t.Fatalf("ConversationsWithMessages(%q, 12) = %v, %v — the conversation must be visible under its own repo", repo, ids, err)
	}
	if ids, _ := m.ConversationsWithMessages(ctx, "", 12); len(ids) != 0 {
		t.Fatalf("the message must not ALSO be filed under the primary repo, got %v", ids)
	}
	if n, err := m.Purge(ctx, repo, 12); err != nil || n != 1 {
		t.Fatalf("Purge(%q, 12) = %d, %v — want the one message removed", repo, n, err)
	}

	// An explicit Repo on the message still wins; a message for a conversation
	// nobody ensured degrades to what it carries (here: the primary repo).
	if err := m.SaveMessage(ctx, Message{ID: "m2", ConversationID: "ghost", PR: 12, Role: "user", Body: "x"}); err != nil {
		t.Fatal(err)
	}
	list, _ = m.List(ctx, "ghost")
	if len(list) != 1 || list[0].Repo != "" {
		t.Fatalf("ghost conversation message repo = %+v, want \"\"", list)
	}
}
