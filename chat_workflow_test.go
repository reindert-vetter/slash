package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// newChatManager builds a TaskManager with only the comments + chat stores
// wired (post-construction, like newTasks does) plus a claude.Fake, which is
// all the claude_chat workflow touches.
func newChatManager(t *testing.T) (*TaskManager, *tembed.Engine, *chat.Module, *claude.Fake) {
	t.Helper()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	cm, err := chat.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cm.Close() })

	fake := claude.NewFake()
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
	m.chat = cm
	return m, engine, cm, fake
}

// The claude_chat workflow end-to-end: StartClaudeChat is idempotent per
// comment id, a "message" Signal stores the reviewer turn then runs a Claude
// turn (via the Fake) and stores its reply, and the transcript reads back in
// order.
func TestClaudeChatWorkflowRoundTrip(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970700, "comment-abc"

	fake.SetChatTurns("Hallo! Waarmee kan ik helpen?", "Dat is een goede vraag.")

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("StartClaudeChat returned empty run ID")
	}
	// Idempotent: starting again for the same comment reuses the Execution.
	again, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("StartClaudeChat returned a new run ID %q, want reuse of %q", again, runID)
	}

	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat betekent deze functie?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})

	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if list[0].Role != "user" || list[0].Body != "Wat betekent deze functie?" {
		t.Fatalf("first message = %+v", list[0])
	}
	if list[1].Role != "assistant" || list[1].Body != "Hallo! Waarmee kan ik helpen?" || list[1].Kind != "" {
		t.Fatalf("second message = %+v", list[1])
	}

	// The conversation's session id is recorded (from the Fake's first RunChat
	// call, which had SessionID == "") and reused on the NEXT call.
	sessionAfterFirst, err := cm.GetSession(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if sessionAfterFirst == "" {
		t.Fatal("expected a session id to be recorded after the first turn")
	}

	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Body: "En waarom staat die if daar?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 4
	})

	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 RunChat calls, got %d", len(fake.Calls))
	}
	if fake.Calls[0].SessionID != "" {
		t.Fatalf("first call should start a fresh session, got SessionID=%q", fake.Calls[0].SessionID)
	}
	if fake.Calls[1].SessionID != sessionAfterFirst {
		t.Fatalf("second call should resume the recorded session %q, got %q", sessionAfterFirst, fake.Calls[1].SessionID)
	}
}

// An assistant turn shaped as the strict question directive is stored as a
// KindQuestion message with its options, and the reviewer's next message
// (their picked option, or free text) is recorded as that SAME row's Answer —
// not a new row — so a refresh still shows question+answer tied together.
func TestClaudeChatQuestionTurnRecordsAnswerOnSameRow(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970701, "comment-question"

	fake.SetChatTurns(
		`{"type":"question","question":"Wil je optie A of B?","options":["Optie A","Optie B","Optie C","Optie D"]}`,
		"Duidelijk, ik ga verder met die keuze.",
	)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}

	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat moet ik hier doen?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})

	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	question := list[1]
	if question.Kind != chat.KindQuestion {
		t.Fatalf("expected a question turn, got %+v", question)
	}
	if question.Body != "Wil je optie A of B?" {
		t.Fatalf("question body = %q", question.Body)
	}
	// Capped at maxChatQuestionOptions (3), even though the Fake offered 4.
	if len(question.Options) != 3 || question.Options[2] != "Optie C" {
		t.Fatalf("question options = %+v", question.Options)
	}
	if question.Answer != "" {
		t.Fatalf("question should be unanswered yet, got Answer=%q", question.Answer)
	}

	// The reviewer answers (picks an option, or types free text — same path).
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Body: "Optie B",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 4
	})

	list, err = cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 4 {
		t.Fatalf("expected 4 rows (no extra row for the answer), got %d: %+v", len(list), list)
	}
	// The question row (still list[1] — created_at ordering unchanged) now
	// carries the answer, and the reviewer's own message (list[2]) is untouched.
	answered := list[1]
	if answered.ID != question.ID || answered.Answer != "Optie B" {
		t.Fatalf("question row after answer = %+v", answered)
	}
	if list[2].Role != "user" || list[2].Body != "Optie B" {
		t.Fatalf("reviewer's own message row = %+v", list[2])
	}
}

// A failing Claude call is stored as a KindError turn instead of failing the
// whole workflow, so the reviewer can simply try again in the same
// conversation.
func TestClaudeChatFailedTurnStoresErrorMessage(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970702, "comment-fail"

	fake.SetChatError(context.DeadlineExceeded)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Hoi",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})

	list, _ := cm.List(ctx, commentID)
	if list[1].Kind != chat.KindError || list[1].Body == "" {
		t.Fatalf("expected an error turn, got %+v", list[1])
	}
}
