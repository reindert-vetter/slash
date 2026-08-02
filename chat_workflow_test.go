package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

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

// newChatManagerWithStore is newChatManager plus direct access to the
// underlying tembed.Store — only TestClaudeChatCommentActionSkipsTerminalRun
// needs this, to force a comment thread's Execution into a genuinely
// completed status (which never happens naturally while the comment row
// still exists, but the applyChatCommentAction Activity must still degrade to
// a KindError turn rather than crash if it ever did).
func newChatManagerWithStore(t *testing.T) (*TaskManager, *tembed.Engine, tembed.Store, *chat.Module, *claude.Fake) {
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
	store := tembed.NewMemoryStore()
	engine := tembed.New(store)
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
	m.chat = cm
	return m, engine, store, cm, fake
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

// The reviewer explicitly asking Claude to reply on the comment thread yields
// a comment_action directive; the workflow applies it via the EXISTING "reply"
// Signal on the comment's own task_code_comment Execution (Source "ai") and
// the chat transcript shows a single KindAction confirmation turn — never the
// raw JSON directive.
func TestClaudeChatCommentActionAppliesReplyToCommentThread(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970710, "comment-action-reply"

	// The target comment thread this conversation hangs on must itself be a
	// running task_code_comment Execution for the Signal to land anywhere.
	commentRunID := startTestComment(t, m, pr, commentID)

	fake.SetChatTurns(`{"type":"comment_action","action":"reply","commentId":"` + commentID + `","body":"Klopt, dit moet anders."}`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Zet dit als reactie op de comment.",
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
	if list[1].Kind != chat.KindAction || list[1].Body == "" {
		t.Fatalf("expected a KindAction confirmation turn, got %+v", list[1])
	}
	if list[1].Body == `{"type":"comment_action","action":"reply","commentId":"`+commentID+`","body":"Klopt, dit moet anders."}` {
		t.Fatal("the raw directive JSON must never be shown verbatim")
	}

	// The comment thread itself received the reply, mirrored with Source "ai".
	waitForComment(t, m, commentRunID, func(cs []comments.Comment) bool { return len(cs) > 0 })
	replies := listReplies(t, m, commentRunID)
	if len(replies) != 1 || replies[0].Source != "ai" || replies[0].Body != "Klopt, dit moet anders." {
		t.Fatalf("expected one ai-sourced reply on the comment thread, got %+v", replies)
	}
}

// The same directive with action "resolve" resolves the target thread and
// needs no Body.
func TestClaudeChatCommentActionResolvesCommentThread(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970711, "comment-action-resolve"

	startTestComment(t, m, pr, commentID)

	fake.SetChatTurns(`{"type":"comment_action","action":"resolve","commentId":"` + commentID + `"}`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Los deze comment maar op.",
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
	if list[1].Kind != chat.KindAction || list[1].Body == "" {
		t.Fatalf("expected a KindAction confirmation turn, got %+v", list[1])
	}

	waitFor(t, func() bool {
		cs, ok, _ := m.comments.Get(ctx, commentID)
		return ok && cs.Status == "resolved"
	})
}

// A directive whose commentId does NOT match the conversation's own thread is
// rejected — never signalled anywhere — and shows as a KindError turn.
func TestClaudeChatCommentActionRejectsOtherComment(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID, otherCommentID = 970712, "comment-action-own", "comment-action-other"

	startTestComment(t, m, pr, commentID)
	otherRunID := startTestComment(t, m, pr, otherCommentID)

	fake.SetChatTurns(`{"type":"comment_action","action":"reply","commentId":"` + otherCommentID + `","body":"Dit hoort niet hier."}`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Zet dit als reactie op de comment.",
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
	if list[1].Kind != chat.KindError {
		t.Fatalf("expected a KindError turn for a mismatched commentId, got %+v", list[1])
	}

	// The other comment thread was never touched.
	replies := listReplies(t, m, otherRunID)
	if len(replies) != 0 {
		t.Fatalf("the other comment thread must never be signalled, got replies=%+v", replies)
	}
}

// A comment_action directive targeting an already-completed/failed Execution
// (which can no longer receive a Signal) degrades to a KindError turn instead
// of crashing the claude_chat workflow.
func TestClaudeChatCommentActionSkipsTerminalRun(t *testing.T) {
	m, engine, store, cm, fake := newChatManagerWithStore(t)
	ctx := context.Background()
	const pr, commentID = 970713, "comment-action-terminal"

	// The comment row exists (so the "not found/deleted" branch above this one
	// does NOT fire), but its Execution is forced into a genuinely completed
	// status — which never happens naturally while the comment still exists,
	// but must still degrade to a KindError turn rather than crash.
	commentRunID := startTestComment(t, m, pr, commentID)
	if err := store.SetStatus(commentRunID, tembed.StatusCompleted, time.Now()); err != nil {
		t.Fatal(err)
	}

	fake.SetChatTurns(`{"type":"comment_action","action":"reply","commentId":"` + commentID + `","body":"Te laat."}`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Zet dit als reactie op de comment.",
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
	if list[1].Kind != chat.KindError {
		t.Fatalf("expected a KindError turn, got %+v", list[1])
	}
}

// A malformed comment_action directive (missing body for "reply") degrades to
// a plain text turn — the existing "malformed directive shows verbatim"
// degrade rule, unchanged by Phase 4.
func TestParseAssistantTurnIgnoresMalformedCommentAction(t *testing.T) {
	raw := `{"type":"comment_action","action":"reply","commentId":"c1"}`
	msg, action := parseAssistantTurn(1, "c1", raw)
	if action != nil {
		t.Fatalf("expected no action for a directive missing body, got %+v", action)
	}
	if msg.Body != raw || msg.Kind != "" {
		t.Fatalf("expected the raw text as a plain turn, got %+v", msg)
	}
}

// startTestComment starts a real task_code_comment Execution with the given
// Run ID == commentID (mirroring how the app always derives a comment's own
// RunID) and returns that Run ID, so applyChatCommentAction has something
// real to look up/signal.
func startTestComment(t *testing.T, m *TaskManager, pr int, commentID string) string {
	t.Helper()
	runID, err := m.engine.StartWorkflowID(commentID, WorkflowTaskCodeComment, CodeCommentInput{
		PR: pr, File: "app/Foo.php", Line: 1, Author: "reviewer", Body: "seed", Local: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runID
}

// listReplies returns every reaction recorded on the comment with the given
// Run ID.
func listReplies(t *testing.T, m *TaskManager, runID string) []comments.Reaction {
	t.Helper()
	list, err := m.comments.List(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range list {
		if c.RunID == runID {
			return c.Reactions
		}
	}
	return nil
}

// waitForComment is waitFor specialized for a comments.Module predicate.
func waitForComment(t *testing.T, m *TaskManager, runID string, ok func([]comments.Comment) bool) {
	t.Helper()
	waitFor(t, func() bool {
		list, err := m.comments.List(context.Background(), 0)
		if err != nil {
			return false
		}
		var mine []comments.Comment
		for _, c := range list {
			if c.RunID == runID {
				mine = append(mine, c)
			}
		}
		return ok(mine)
	})
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
