package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// stubUnreachableGh drops a fake, always-failing "gh" script onto PATH for the
// duration of the test — so fetchPRMeta (chat_shadow.go/gh.go) fails fast and
// deterministically, regardless of whether the real gh CLI happens to be
// installed/authenticated/network-reachable in the environment this test runs
// in. Used by every runOneClaudeTurn test that doesn't care about the shadow
// worktree, so they stay hermetic (mirrors modules/claude/timeout_test.go's
// writeSlowBinary, same PATH-shim technique, opposite outcome).
func stubUnreachableGh(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "gh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

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
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
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
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
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

// Reported bug, end to end through the real workflow: this PR's open
// work-directory choice used to intercept a conversation's very next message
// — even a plain, read-only question that never asked for a code change at
// all — turning it into a bogus "Dat antwoord herkende ik niet als een van de
// keuzes" reply, and later into an unanswerable "een andere Claude-conversatie
// wacht nog op een keuze" bubble. This proves BOTH halves of the fix: the
// choice never surfaces in a conversation's transcript, AND a plain question
// never triggers the write machinery in the first place (still only the cheap
// read-only RunChat attempt, per task 3's two-step access).
func TestClaudeChatPlainQuestionNeverTouchesThePendingWorkDirChoice(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr = 970750
	const otherCommentID = "comment-simple"

	// The PR already has an unresolved dirty-tree work-directory choice — set
	// up directly, mirroring how a real write-needing turn would have left it
	// (chat_checkout_test.go's own assignPendingDecisionForTest).
	owned := &chatCheckoutDecision{
		Stage:   checkoutStageDirtyTree,
		Dir:     "/some/other/checkout",
		Body:    "`/some/other/checkout` heeft nog niet-gerelateerde, niet-gecommitte wijzigingen. Wat moet daarmee gebeuren voordat ik hier iets aanpas?",
		Options: []string{optDiscard, optStashManual, optStashAuto, optKeepSeparate, optKeepCombined},
	}
	assignPendingDecisionForTest(t, "", pr, owned)

	// A completely unrelated, brand-new conversation on the SAME PR: a plain,
	// purely conversational question — no request to change any code.
	fake.SetChatTurns("Ja, die zit in diezelfde flow.")
	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: otherCommentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "maar hij komt wel in die flow toch?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, otherCommentID)
		return len(list) == 2
	})

	list, err := cm.List(ctx, otherCommentID)
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range list {
		if msg.Kind == chat.KindDirectoryDecision {
			t.Fatalf("the PR's work-directory choice must never surface as a chat bubble, got %+v", msg)
		}
		if strings.Contains(msg.Body, "herkende ik niet") {
			t.Fatalf("this conversation's own message must never be read as an answer to the work-directory choice, got %+v", msg)
		}
	}
	if list[1].Role != "assistant" || list[1].Body != "Ja, die zit in diezelfde flow." || list[1].Kind != "" {
		t.Fatalf("expected a plain, ordinary assistant reply, got %+v", list[1])
	}

	// Only the cheap read-only attempt ran — a plain question never escalates
	// into the write/checkout machinery at all (task 3's two-step access).
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call (the read-only attempt only), got %d: %+v", len(fake.Calls), fake.Calls)
	}

	// The open choice is completely untouched — still there, still waiting for
	// its answer in the overlay.
	if !checkoutChoiceOpen("", pr) {
		t.Fatal("the PR's open work-directory choice must survive an unrelated conversation's turn")
	}
	a := getCheckoutAssignment("", pr)
	if a == nil || a.Pending != owned {
		t.Fatalf("the open choice must be the exact same, untouched object, got %+v", a)
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
// a comment_action directive; a "reply" action is now a DRAFT only (Reindert's
// explicit request: he wants to edit it in the comment composer before it is
// ever sent) — the chat transcript shows a single KindDraftReply turn holding
// exactly the drafted body, and the comment thread itself receives no reply.
func TestClaudeChatCommentActionDraftsReplyWithoutTouchingCommentThread(t *testing.T) {
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970710, "comment-action-reply"

	// The target comment thread this conversation hangs on.
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
	if list[1].Kind != chat.KindDraftReply || list[1].Body != "Klopt, dit moet anders." {
		t.Fatalf("expected a KindDraftReply turn carrying the drafted body verbatim, got %+v", list[1])
	}

	// The comment thread itself must receive NOTHING — only the reviewer's own
	// edit + explicit send in the comment composer may ever post there.
	replies := listReplies(t, m, commentRunID)
	if len(replies) != 0 {
		t.Fatalf("expected the comment thread to stay untouched by a reply draft, got %+v", replies)
	}
}

// The same directive with action "resolve" is still applied immediately —
// there is no text to review first — and needs no Body.
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

// A comment_action "resolve" directive targeting an already-completed/failed
// Execution (which can no longer receive a Signal) degrades to a KindError
// turn instead of crashing the claude_chat workflow. Only "resolve" is tested
// here — "reply" no longer signals the target thread at all, so its own
// Execution status is irrelevant (see the next test).
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
	if list[1].Kind != chat.KindError {
		t.Fatalf("expected a KindError turn, got %+v", list[1])
	}
}

// A "reply" directive drafts successfully even when the target thread's own
// Execution is already terminal — a draft never signals that thread, so its
// status can't block it. This is the one deliberate behaviour difference from
// "resolve" above.
func TestClaudeChatCommentActionDraftsReplyEvenOnTerminalRun(t *testing.T) {
	m, engine, store, cm, fake := newChatManagerWithStore(t)
	ctx := context.Background()
	const pr, commentID = 970714, "comment-action-reply-terminal"

	commentRunID := startTestComment(t, m, pr, commentID)
	if err := store.SetStatus(commentRunID, tembed.StatusCompleted, time.Now()); err != nil {
		t.Fatal(err)
	}

	fake.SetChatTurns(`{"type":"comment_action","action":"reply","commentId":"` + commentID + `","body":"Nog steeds relevant."}`)

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
	if list[1].Kind != chat.KindDraftReply || list[1].Body != "Nog steeds relevant." {
		t.Fatalf("expected a KindDraftReply turn despite the terminal target Execution, got %+v", list[1])
	}
}

// A malformed comment_action directive (missing body for "reply") degrades to
// a plain text turn — the existing "malformed directive shows verbatim"
// degrade rule, unchanged by Phase 4.
func TestParseAssistantTurnIgnoresMalformedCommentAction(t *testing.T) {
	raw := `{"type":"comment_action","action":"reply","commentId":"c1"}`
	msg, action := parseAssistantTurn(1, "c1", "turn-1", raw)
	if action != nil {
		t.Fatalf("expected no action for a directive missing body, got %+v", action)
	}
	if msg.Body != raw || msg.Kind != "" {
		t.Fatalf("expected the raw text as a plain turn, got %+v", msg)
	}
}

// A comment_action "reply" body carrying an em dash is sanitized before it
// ever reaches the drafted comment reply (Reindert's explicit preference).
func TestParseAssistantTurnStripsEmDashFromReplyBody(t *testing.T) {
	raw := `{"type":"comment_action","action":"reply","commentId":"c1","body":"Klopt — dit moet anders."}`
	_, action := parseAssistantTurn(1, "c1", "turn-1", raw)
	if action == nil {
		t.Fatal("expected a comment_action directive")
	}
	if strings.Contains(action.Body, "—") {
		t.Fatalf("expected the em dash to be stripped, got %q", action.Body)
	}
	if action.Body != "Klopt - dit moet anders." {
		t.Fatalf("body = %q, want the em dash replaced with a hyphen", action.Body)
	}
}

// One reviewer message may ask for BOTH a code change and a reply on the
// comment thread ("pas dit aan en reageer kort op de comment"). The write turn
// then answers with its ordinary prose plus the comment_action directive on its
// own last line, and parseAssistantTurn returns both: the explanation as a
// visible turn, the reply as a drafted comment reply.
func TestParseAssistantTurnAcceptsProseWithTrailingCommentAction(t *testing.T) {
	raw := "De test bestond nog niet; hij staat er nu en is groen.\n" +
		`{"type":"comment_action","action":"reply","commentId":"c1","body":"Toegevoegd, met een data provider."}`
	msg, action := parseAssistantTurn(1, "c1", "turn-1", raw)
	if action == nil {
		t.Fatal("expected the trailing comment_action directive to be picked up")
	}
	if action.Body != "Toegevoegd, met een data provider." {
		t.Fatalf("directive body = %q", action.Body)
	}
	if msg.Body != "De test bestond nog niet; hij staat er nu en is groen." {
		t.Fatalf("expected the prose to stay as the visible turn, got %q", msg.Body)
	}
	if msg.ID == "" || msg.Kind != "" {
		t.Fatalf("expected an ordinary text turn, got %+v", msg)
	}
}

// Same, but the model wrapped the trailing directive in a markdown fence — the
// one deviation from the prompt worth tolerating. The fence must not end up in
// the visible prose.
func TestParseAssistantTurnAcceptsAFencedTrailingCommentAction(t *testing.T) {
	raw := "Aangepast in `Foo.php`.\n\n```json\n" +
		`{"type":"comment_action","action":"resolve","commentId":"c1"}` + "\n```\n"
	msg, action := parseAssistantTurn(1, "c1", "turn-1", raw)
	if action == nil || action.Action != "resolve" {
		t.Fatalf("expected a resolve directive, got %+v", action)
	}
	if msg.Body != "Aangepast in `Foo.php`." {
		t.Fatalf("prose = %q, want the fence stripped", msg.Body)
	}
}

// Prose that merely ENDS on some other JSON-ish line stays plain text — the
// trailing-directive path may never swallow part of an ordinary answer.
func TestParseAssistantTurnKeepsProseWithAnUnrelatedTrailingJSON(t *testing.T) {
	raw := "De config ziet er zo uit:\n" + `{"type":"config","foo":1}`
	msg, action := parseAssistantTurn(1, "c1", "turn-1", raw)
	if action != nil {
		t.Fatalf("expected no directive, got %+v", action)
	}
	if msg.Body != raw {
		t.Fatalf("expected the raw text verbatim, got %q", msg.Body)
	}
}

// A chat on a live comment thread is started as a CHILD of that thread's own
// task_code_comment Execution (via its "chat" Action Signal), keeping the
// derived chat-<commentID> Run ID — and starting it twice adds no second child.
func TestClaudeChatStartsAsChildOfCommentThread(t *testing.T) {
	m, _, store, _, _ := newChatManagerWithStore(t)
	const pr, commentID = 970720, "comment-child-chat"

	commentRunID := startTestComment(t, m, pr, commentID)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if want := chatConversationRunID(commentID); runID != want {
		t.Fatalf("run ID = %q, want the unchanged derived %q", runID, want)
	}
	rec, _, err := store.LoadRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.ParentRunID != commentRunID {
		t.Fatalf("ParentRunID = %q, want the comment thread %q", rec.ParentRunID, commentRunID)
	}

	// Idempotent: a second start reuses the same child, so the parent's history
	// holds exactly one EventChildWorkflowStarted.
	again, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if again != runID {
		t.Fatalf("second start returned %q, want reuse of %q", again, runID)
	}
	_, hist, err := store.LoadRun(commentRunID)
	if err != nil {
		t.Fatal(err)
	}
	started := 0
	for _, ev := range hist {
		if ev.Type == tembed.EventChildWorkflowStarted {
			started++
		}
	}
	if started != 1 {
		t.Fatalf("parent recorded %d child starts, want exactly 1", started)
	}
}

// A thread whose Execution is no longer signallable (it ended on a resolve or a
// delete) must not lose its chat: the conversation then falls back to a
// top-level Execution with the same Run ID and no parent.
func TestClaudeChatFallsBackToTopLevelForTerminalThread(t *testing.T) {
	m, _, store, _, _ := newChatManagerWithStore(t)
	const pr, commentID = 970721, "comment-terminal-chat"

	commentRunID := startTestComment(t, m, pr, commentID)
	if err := store.SetStatus(commentRunID, tembed.StatusCompleted, time.Now()); err != nil {
		t.Fatal(err)
	}

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if want := chatConversationRunID(commentID); runID != want {
		t.Fatalf("run ID = %q, want %q", runID, want)
	}
	rec, _, err := store.LoadRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.ParentRunID != "" {
		t.Fatalf("ParentRunID = %q, want empty (top-level fallback)", rec.ParentRunID)
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
	list, err := m.comments.List(context.Background(), "", 0)
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
		list, err := m.comments.List(context.Background(), "", 0)
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

// A failing Claude call is stored as a visible turn instead of failing the
// whole workflow, so the conversation stays alive: KindRetrying while the
// automatic ladder still has a rung left, KindError once it is exhausted.
func TestClaudeChatFailedTurnStoresErrorMessage(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
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
		return len(list) == 2 && list[1].Kind == chat.KindError
	})

	list, _ := cm.List(ctx, commentID)
	if list[1].Kind != chat.KindError || list[1].Body == "" {
		t.Fatalf("expected an error turn, got %+v", list[1])
	}
}

// "wis gesprek" (chatActionClear) wipes the transcript + stored session, and
// drops any pending question so a message right after a clear is treated as
// an ordinary NEW turn rather than an "answer" to the question turn that
// clear just wiped. It never touches the PR's shared local checkout
// (chat_checkout.go), so stubUnreachableGh here only affects THIS test's own
// (never-escalating) turns, not the clear itself.
func TestClaudeChatClearWipesTranscriptAndSession(t *testing.T) {
	stubUnreachableGh(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970720, "comment-clear"

	fake.SetChatTurns(`{"type":"question","question":"Welke aanpak?","options":["A","B"]}`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Hoe pak ik dit aan?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})
	sessionBeforeClear, err := cm.GetSession(ctx, commentID)
	if err != nil || sessionBeforeClear == "" {
		t.Fatalf("expected a session id before clear, got %q, %v", sessionBeforeClear, err)
	}

	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-clear", Author: "reviewer", Action: chatActionClear,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 0
	})
	if got, err := cm.GetSession(ctx, commentID); err != nil || got != "" {
		t.Fatalf("GetSession after clear = %q, %v", got, err)
	}

	// A message right after a clear must be treated as an ordinary NEW turn —
	// never as an "answer" to the (now-gone) question turn, which would
	// otherwise silently no-op a SetAnswer against a deleted row — and must
	// start a FRESH session rather than --resume the wiped one.
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Body: "Nieuwe vraag na het wissen",
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
	if list[1].Kind != chat.KindQuestion || list[1].Answer != "" {
		t.Fatalf("expected a fresh, unanswered question turn after clear, got %+v", list[1])
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 RunChat calls, got %d", len(fake.Calls))
	}
	if fake.Calls[1].SessionID != "" {
		t.Fatalf("post-clear turn should start a FRESH session, got SessionID=%q", fake.Calls[1].SessionID)
	}
}

// The "seen" Signal action (chatActionSeen) stamps chat_conversations.seen_at
// via its own markChatSeen Activity — no Claude call, no user/assistant turn
// — the durable counterpart of the "Openstaande chats" blue-eye indicator
// (see modules/chat's own TestSeenAt for the module-level round-trip).
func TestClaudeChatSeenSignalStampsSeenAt(t *testing.T) {
	stubUnreachableGh(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970730, "comment-seen"

	fake.SetChatTurns(`hallo`)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "hoi",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2
	})

	seenAt, err := cm.SeenAt(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if seenAt != "" {
		t.Fatalf("seenAt = %q before any \"seen\" Signal, want empty", seenAt)
	}

	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-seen", Author: "reviewer", Action: chatActionSeen,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		got, _ := cm.SeenAt(ctx, commentID)
		return got != ""
	})

	// No extra turn/RunChat call — "seen" is purely bookkeeping.
	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected still exactly 2 messages after a \"seen\" Signal, got %d", len(list))
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call, got %d", len(fake.Calls))
	}
}

// A re-executed Activity must OVERWRITE its assistant turn, never append a
// second one. An Activity's side effects land before its result is recorded,
// so a process killed in that window re-runs the whole Activity on recovery —
// with the old random message id that produced a duplicate, orphaned turn.
// Every message id a turn writes is now derived from the reviewer Signal's own
// id (chatMessageID), which is part of the recorded input and therefore
// identical on every replay.
func TestChatTurnMessageIDsAreDerivedFromTheTurn(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970710, "comment-idem"

	fake.SetChatTurns("Eerste antwoord", "Tweede poging")
	// The conversation row must exist, exactly as the workflow creates it
	// before it ever runs a turn: SetSession is an UPDATE, so without the row
	// the first turn's session id is silently dropped and the replay below
	// starts a SECOND fake session (which, with the Fake's per-session turn
	// cursor, would replay turn 1 instead of moving on to turn 2).
	if err := cm.EnsureConversation(ctx, commentID, "", pr); err != nil {
		t.Fatal(err)
	}
	arg := chatTurnInput{PR: pr, ConversationID: commentID, Body: "Hoi", TurnID: "msg-42"}

	first, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), arg)
	second, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), arg) // the replay
	if first.ID != second.ID || first.ID != "asst-msg-42" {
		t.Fatalf("ids differ across replay: %q vs %q", first.ID, second.ID)
	}
	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("replay produced %d rows, want 1: %+v", len(list), list)
	}
	if list[0].Body != "Tweede poging" {
		t.Fatalf("the replay should have overwritten the row, got %q", list[0].Body)
	}
	// An input recorded before TurnID existed keeps the old random-id
	// behaviour rather than colliding on a shared fallback id.
	if a, b := chatMessageID("", ""), chatMessageID("", ""); a == b {
		t.Fatalf("empty turn id must fall back to a random id, got %q twice", a)
	}
}

// The live-progress side of a turn: while the Activity runs, the streamed
// fragments go out over the event bus, and once it returns nothing volatile is
// left — while the DURABLE message is exactly the CLI's final result, byte for
// byte the same as it would be without any listener. That split is what keeps
// the transcript reproducible under replay: fragments are throwaway, the saved
// row is a pure function of the recorded input.
func TestChatTurnPublishesProgressButPersistsOnlyTheResult(t *testing.T) {
	stubUnreachableGh(t)
	resetChatProgress()
	defer resetChatProgress()
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970711, "comment-progress"

	id, sub := events.subscribe(statusKey("", pr))
	defer events.unsubscribe(id)

	fake.SetChatTurns("Hallo daar")
	fake.SetChatEvents(
		claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Read", Detail: "src/Foo.php"},
		claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "Hallo "},
	)

	msg, action := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Hoi", TurnID: "msg-7",
	})
	if action != nil {
		t.Fatalf("unexpected directive: %+v", action)
	}

	var sawTool, sawPartial, sawFinished bool
	for len(sub.ch) > 0 {
		ev := <-sub.ch
		if ev.Type != eventChatProgress || ev.Key != commentID {
			continue
		}
		var p chatProgress
		if err := json.Unmarshal(ev.Data, &p); err != nil {
			t.Fatal(err)
		}
		if p.Tool == "Read" && p.Detail == "src/Foo.php" {
			sawTool = true
		}
		if p.Partial == "Hallo " {
			sawPartial = true
		}
		if !p.Running {
			sawFinished = true
		}
	}
	if !sawTool || !sawPartial || !sawFinished {
		t.Fatalf("expected tool + partial + finished frames (got %v/%v/%v)", sawTool, sawPartial, sawFinished)
	}
	if _, ok := chatProgressFor(commentID); ok {
		t.Fatal("progress must be forgotten once the turn returned")
	}

	// Only ONE row, holding the CLI's final result — never the fragments.
	if msg.Body != "Hallo daar" {
		t.Fatalf("returned body = %q", msg.Body)
	}
	list, _ := cm.List(ctx, commentID)
	if len(list) != 1 || list[0].Body != "Hallo daar" {
		t.Fatalf("transcript = %+v, want exactly the final result", list)
	}
}

// ChatMessageSignal.Context (the reviewer's selection: file, old/new line
// range, code excerpt — built by RelatedPanel.mjs's claudeContextBlock for a
// conversation's first turn only) must enrich the CLI PROMPT but never leak
// into the saved chat.Message.Body, which stays exactly what the reviewer
// typed. See buildChatPrompt/saveChatMessage in chat_workflow.go.
func TestChatTurnContextEnrichesPromptNotBody(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970720, "comment-context"

	fake.SetChatTurns("Ik zie het.")
	const selectionContext = "Bestand: src/Order.php\nNieuwe regels: 41-44\nVoorbeeldcode:\n```php\n$order->total();\n```"
	msg, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "Wat doet dit?", TurnID: "msg-ctx",
		Context: selectionContext,
	})

	if msg.Body != "Ik zie het." {
		t.Fatalf("saved assistant body = %q, want the CLI's plain reply", msg.Body)
	}
	if len(fake.Calls) != 1 {
		t.Fatalf("expected exactly 1 RunChat call, got %d", len(fake.Calls))
	}
	gotPrompt := fake.Calls[0].Prompt
	if gotPrompt != selectionContext+"\n\nWat doet dit?" {
		t.Fatalf("prompt sent to claude = %q, want context prepended to the typed body", gotPrompt)
	}

	// A saveChatMessage for the reviewer's OWN turn (the workflow's job, not
	// runOneClaudeTurn's) must never receive Context either — asserted at the
	// workflow level below via chatMessageID reuse: the user row it wrote in
	// TestClaudeChatWorkflowRoundTrip already only carries Body, unchanged by
	// this field's existence (that test predates Context and still passes).

	// A turn with no Context (every turn after the first) is a pure
	// pass-through — unchanged prompt, exactly the old behaviour.
	fake.SetChatTurns("Nog een antwoord.")
	msg2, _ := runOneClaudeTurn(ctx, m, cm, fake, t.TempDir(), chatTurnInput{
		PR: pr, ConversationID: commentID, Body: "En dit?", TurnID: "msg-ctx-2",
	})
	if msg2.Body != "Nog een antwoord." {
		t.Fatalf("saved assistant body = %q", msg2.Body)
	}
	if got := fake.Calls[1].Prompt; got != "En dit?" {
		t.Fatalf("prompt without context = %q, want the plain body unchanged", got)
	}
}

// shrinkChatRetryDelays makes the automatic backoff ladder run in milliseconds
// for the duration of one test. Same number of rungs (so the attempt counter,
// the model escalation and the wording stay exactly what production sees) —
// only the durable timers are short.
func shrinkChatRetryDelays(t *testing.T) {
	t.Helper()
	orig := chatRetryDelays
	chatRetryDelays = []time.Duration{
		time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond,
	}
	t.Cleanup(func() { chatRetryDelays = orig })
}

// A transient Claude failure is retried automatically: the reviewer's turn
// ends up as ONE assistant reply (the failed attempt's bubble is REPLACED, not
// joined by a second row) and never needs a manual retry.
func TestClaudeChatRetriesTransientFailure(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970710, "comment-retry-transient"

	fake.SetChatTurns("Alsnog een antwoord.")
	fake.SetChatFailures(1, errors.New("claude: overloaded"))

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat doet dit?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == ""
	})

	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected the user turn + ONE assistant turn, got %d rows: %+v", len(list), list)
	}
	if list[1].Body != "Alsnog een antwoord." || list[1].Kind != "" {
		t.Fatalf("assistant turn = %+v, want the retried reply", list[1])
	}
	if list[1].Model != claude.ModelOpus {
		t.Fatalf("first retry should still run on Opus, got model %q", list[1].Model)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 RunChat calls (fail + retry), got %d", len(fake.Calls))
	}
}

// TestRunChatTurnWithRetriesResetsResultPerAttempt guards a bug in
// runChatTurnWithRetries's OWN loop (not runOneClaudeTurn): chat.Message.Kind
// is `json:"kind,omitempty"`, so a successful attempt's encoded Activity
// result OMITS "kind" — reusing one `result` variable across ladder
// iterations then leaves a PRIOR failed attempt's chat.KindRetrying sitting in
// Message.Kind even once a later attempt genuinely succeeded, which the loop
// then reads as "still retrying" and drives the ladder through every
// remaining rung for REAL, in the background, well after this turn already
// had its final answer. A short sleep after the reviewer's own answer arrives
// gives any such leaked retry a real chance to fire before asserting.
func TestRunChatTurnWithRetriesResetsResultPerAttempt(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970715, "comment-retry-reset"

	fake.SetChatTurns("Nu werkt het.")
	fake.SetChatFailures(1, errors.New("claude: overloaded"))

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
		return len(list) == 2 && list[1].Kind == ""
	})

	time.Sleep(50 * time.Millisecond)

	list, err := cm.List(ctx, commentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[1].Body != "Nu werkt het." || list[1].Kind != "" {
		t.Fatalf("assistant turn should stay the successful retry's own reply, got %+v", list)
	}
	if len(fake.Calls) != 2 {
		t.Fatalf("expected exactly 2 RunChat calls total (fail + succeed) — the ladder kept running after success, got %d", len(fake.Calls))
	}
}

// After two failed Opus attempts the ladder escalates to Sonnet, and the
// answer records WHICH model produced it (the reviewer sees that as a pill on
// the bubble).
func TestClaudeChatEscalatesToSonnet(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970711, "comment-retry-sonnet"

	fake.SetChatTurns("Sonnet springt bij.")
	fake.SetChatModelError(claude.ModelOpus, errors.New("claude: overloaded"))

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat doet dit?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == ""
	})

	list, _ := cm.List(ctx, commentID)
	if list[1].Body != "Sonnet springt bij." {
		t.Fatalf("assistant turn = %+v, want Sonnet's reply", list[1])
	}
	if list[1].Model != claude.ModelSonnet {
		t.Fatalf("assistant turn model = %q, want %q", list[1].Model, claude.ModelSonnet)
	}
	if len(fake.Calls) != 3 {
		t.Fatalf("expected 3 RunChat calls (Opus, Opus, Sonnet), got %d", len(fake.Calls))
	}
	for i, want := range []string{claude.ModelOpus, claude.ModelOpus, claude.ModelSonnet} {
		if fake.Calls[i].Model != want {
			t.Fatalf("call %d ran on %q, want %q", i+1, fake.Calls[i].Model, want)
		}
	}
}

// With every model down the ladder gives up: one KindError turn (not a trail
// of attempt bubbles), a bounded number of calls, and the workflow still
// alive.
func TestClaudeChatGivesUpAfterLadder(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970712, "comment-retry-exhausted"

	fake.SetChatError(errors.New("claude: overloaded"))

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat doet dit?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == chat.KindError
	})

	list, _ := cm.List(ctx, commentID)
	if len(list) != 2 {
		t.Fatalf("expected the user turn + ONE failure turn, got %d rows: %+v", len(list), list)
	}
	if list[1].Kind != chat.KindError {
		t.Fatalf("expected a KindError turn once the ladder is exhausted, got %+v", list[1])
	}
	if !strings.Contains(list[1].Body, "handmatig") {
		t.Fatalf("final failure body = %q, want it to point at the manual retry", list[1].Body)
	}
	if want := len(chatRetryDelays) + 1; len(fake.Calls) != want {
		t.Fatalf("expected exactly %d RunChat calls, got %d", want, len(fake.Calls))
	}
}

// The manual "Opnieuw proberen" Signal re-runs the SAME failed turn: no second
// user bubble, the failure row is replaced by the answer, and it starts at
// Opus again (the escalation is per turn, never sticky).
func TestClaudeChatManualRetryRerunsFailedTurn(t *testing.T) {
	stubUnreachableGh(t)
	shrinkChatRetryDelays(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970713, "comment-retry-manual"

	fake.SetChatError(errors.New("claude: overloaded"))

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Wat doet dit?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == chat.KindError
	})
	callsBefore := len(fake.Calls)

	// Claude is reachable again; the reviewer presses "Opnieuw proberen".
	fake.SetChatError(nil)
	fake.SetChatTurns("Nu lukt het wel.")
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Action: chatActionRetry,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == ""
	})

	list, _ := cm.List(ctx, commentID)
	if len(list) != 2 {
		t.Fatalf("a manual retry must not add a second user turn, got %d rows: %+v", len(list), list)
	}
	if list[0].Role != "user" || list[0].Body != "Wat doet dit?" {
		t.Fatalf("the reviewer's own turn changed: %+v", list[0])
	}
	if list[1].Body != "Nu lukt het wel." || list[1].Kind != "" {
		t.Fatalf("failed turn was not replaced by the answer: %+v", list[1])
	}
	if list[1].Model != claude.ModelOpus {
		t.Fatalf("a manual retry should start at Opus again, got %q", list[1].Model)
	}
	if got := fake.Calls[callsBefore].Model; got != claude.ModelOpus {
		t.Fatalf("first call of the manual retry ran on %q, want Opus", got)
	}
}

// TestClaudeChatAutoLandsPendingCheckoutWorkAfterATurn is tasks 1+2+4's own
// end-to-end regression: the reviewer never sends a "commit" action (that
// button is gone, see .claude/docs/workflows-comments.md) — a turn that
// escalates to write access and really edits the PR's assigned checkout must,
// by itself, commit that edit, land it on the PR's pending ref and refresh
// the review tree, with no further reviewer action needed. Unlike the old
// disposable shadow worktree, the checkout itself is never reclaimed/removed
// (chat_checkout.go): it is the reviewer's own, permanent local clone.
//
// The second half is the reviewer-reported bug this landing is gated on: a
// FOLLOW-UP question turn, which never touches the checkout at all, must NOT
// produce a second "Wijziging staat op ..." notice — see turnChangedCheckout
// (chat_checkout.go).
func TestClaudeChatAutoLandsPendingCheckoutWorkAfterATurn(t *testing.T) {
	const headRefName = "feature/autoland"
	bareDir, cloneDir := setupChatShadowRepo(t, headRefName, "v1\n")
	stubReachableGh(t, headRefName)

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
	dataDir := t.TempDir()
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, nil, dataDir, "test/repo")
	m.chat = cm
	ctx := context.Background()

	const pr, commentID = 970740, "comment-autoland"

	dir := cloneCheckoutDir(t, bareDir, headRefName)
	assignCheckoutForTest(t, "", pr, dir)

	// The turn escalates to write access and then really edits the checkout —
	// the fake's own hook stands in for Claude's Edit/Bash tool calls, since
	// only a turn that CHANGED the checkout itself may land anything (see
	// turnChangedCheckout, chat_checkout.go).
	fake.SetChatTurns(`{"type":"need_write"}`, "Oké, ik heb het aangepast.")
	fake.SetChatHook(func(req claude.RunRequest) {
		if req.WorkDir != dir {
			return // the cheap read-only attempt, which never edits anything
		}
		if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("edited by claude\n"), 0o644); err != nil {
			t.Errorf("simulated edit: %v", err)
		}
	})
	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-1", Author: "reviewer", Body: "Hoe staat het ermee?",
	}); err != nil {
		t.Fatal(err)
	}

	// The user turn + the assistant's own reply + the auto-land outcome (a
	// SEPARATE message id — chatAutoLandTurnSuffix — so it can never overwrite
	// the assistant's own reply, see chatMessageID).
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 3
	})

	list, _ := cm.List(ctx, commentID)
	landed := false
	for _, msg := range list {
		if msg.Kind == chat.KindError {
			t.Fatalf("no message should report an error: %+v", msg)
		}
		if strings.Contains(msg.Body, pendingLandedMsg(headRefName, dir)) {
			landed = true
		}
	}
	if !landed {
		t.Fatalf("expected one message to report the successful auto-land, got %+v", list)
	}

	// The pending ref now really holds the edit...
	ref := prPendingRef("", pr, headRefName)
	sha := pendingRefSHA(ctx, "", ref)
	if sha == "" {
		t.Fatal("pending ref does not exist after the auto-land")
	}
	out, err := exec.Command("git", "-C", cloneDir, "show", sha+":foo.txt").Output()
	if err != nil || string(out) != "edited by claude\n" {
		t.Fatalf("pending ref content = %q, err %v; want the edit", out, err)
	}
	// ...and the checkout itself is untouched/kept — it is the reviewer's own
	// permanent clone, never reclaimed (unlike the old disposable shadow
	// worktree).
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("expected the checkout to remain on disk after landing, got err=%v", err)
	}

	// The reported bug: a follow-up PURE QUESTION turn changes nothing in the
	// checkout, so it must add only its own two rows (the reviewer's message
	// and Claude's answer) — never a second auto-land notice, even though the
	// shared checkout holds work of its own: an unrelated, uncommitted file
	// the reviewer is working on themselves. The landing used to fire on that
	// PR-wide state alone, which both re-showed the notice and swept the
	// reviewer's own file into Claude's commit.
	if err := os.WriteFile(filepath.Join(dir, "reviewer-own-work.txt"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake.SetChatHook(nil)
	fake.SetChatTurns("Nee, dat bestond nog niet.")
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Body: "Bestond dit al ergens anders?",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		l, _ := cm.List(ctx, commentID)
		return len(l) == 5
	})
	// Give a wrongly-triggered landing every chance to add a 6th row.
	time.Sleep(300 * time.Millisecond)
	after, _ := cm.List(ctx, commentID)
	if len(after) != 5 {
		t.Fatalf("a question turn that changed nothing must add no landing notice, got %d rows: %+v", len(after), after)
	}
	for _, msg := range after[3:] {
		if strings.Contains(msg.Body, "Wijziging staat op") {
			t.Fatalf("a question turn that changed nothing must not report a landing: %+v", msg)
		}
	}
	// The reviewer's own file is still uncommitted, exactly as they left it.
	statusOut, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output()
	if err != nil || !strings.Contains(string(statusOut), "reviewer-own-work.txt") {
		t.Fatalf("the reviewer's own uncommitted file must be left alone, status = %q, err %v", statusOut, err)
	}
}

// TestChatFailureTurnSurfacesTheCLIsOwnDefinitiveReason: a bug fix (see
// claude.ChatCallError's own doc comment for the verified repro) — RunChat
// used to discard a claude CLI turn's own "is_error" explanation whenever the
// process exited non-zero, so every Claude call failure rendered the exact
// same generic "Er ging iets mis" wording no matter the real cause (a usage
// limit, a billing problem, an invalid model, …). chatFailureTurn is a pure
// function, so this is tested directly rather than through a full workflow
// round trip.
func TestChatFailureTurnSurfacesTheCLIsOwnDefinitiveReason(t *testing.T) {
	callErr := &claude.ChatCallError{
		Reason:     "Claude AI usage limit reached. Your limit will reset at 3pm.",
		Definitive: true,
	}
	kind, body := chatFailureTurn(0, claude.ModelOpus, callErr)
	if kind != chat.KindError {
		t.Fatalf("expected chat.KindError for a definitive CLI verdict (an automatic retry is pointless), got %q", kind)
	}
	if !strings.Contains(body, "usage limit reached") {
		t.Fatalf("expected the CLI's own reason verbatim in the message, got %q", body)
	}
	if strings.Contains(body, "nieuwe poging over") {
		t.Fatalf("must not promise a retry countdown for a definitive CLI verdict, got %q", body)
	}
	if strings.Contains(body, "Poging 1 van") {
		t.Fatalf("must not use the generic attempt-counting wording once a real reason is known, got %q", body)
	}
}

// TestChatFailureTurnKeepsTheLadderForANonDefinitiveReason: a ChatCallError
// with a Reason from stderr but not Definitive (a plain process/exec hiccup,
// not the CLI's own completed verdict) must not shortcut the existing
// backoff ladder — only a Definitive CLI verdict does that (see the doc
// comment on chatFailureTurn).
func TestChatFailureTurnKeepsTheLadderForANonDefinitiveReason(t *testing.T) {
	callErr := &claude.ChatCallError{Reason: "network is unreachable"}
	kind, body := chatFailureTurn(0, claude.ModelOpus, callErr)
	if kind != chat.KindRetrying {
		t.Fatalf("expected chat.KindRetrying to keep trying a non-definitive failure, got %q", kind)
	}
	if !strings.Contains(body, "nieuwe poging over") {
		t.Fatalf("expected the usual retry countdown to still be promised, got %q", body)
	}
}

// TestChatFailureTurnUnchangedForAPlainError: a bare error (no
// claude.ChatCallError at all — e.g. context.DeadlineExceeded, or what every
// pre-existing test in this file already programs via SetChatError) must
// produce EXACTLY the pre-existing generic wording, so this fix is additive
// only.
func TestChatFailureTurnUnchangedForAPlainError(t *testing.T) {
	kind, body := chatFailureTurn(0, claude.ModelOpus, errors.New("claude: overloaded"))
	if kind != chat.KindRetrying {
		t.Fatalf("expected chat.KindRetrying, got %q", kind)
	}
	if !strings.Contains(body, "Er ging iets mis bij het praten met Claude") {
		t.Fatalf("expected the unchanged generic wording, got %q", body)
	}
}

// TestCancelledTurnDoesNotAutoRetry is THE regression test for this feature:
// a reviewer-triggered cancel (POST /api/chat/cancel → cancelChatTurn,
// chat_cancel.go) must produce a terminal chat.KindCancelled turn and must
// NEVER fall into the automatic backoff ladder (runChatTurnWithRetries) —
// unlike an ordinary transient failure, which schedules a durable w.Sleep and
// silently tries again a few seconds later. If this regressed, a cancelled
// turn would restart itself behind the reviewer's back, exactly the "grootste
// val" flagged before building this.
//
// SetChatBlockUntilCancel (claude.Fake) makes the turn hang in RunChat until
// its own ctx is cancelled — the fixture SLASH_CLAUDE_CHAT_TURNS itself
// cannot express ("still running" has no script entry). Because
// Engine.SignalWorkflow drives the whole turn INLINE and blocks for as long
// as it runs (see chat_cancel.go's own doc comment), the Signal is sent on a
// separate goroutine so the test can call cancelChatTurn from the main one
// while that Signal call is still blocked.
func TestCancelledTurnDoesNotAutoRetry(t *testing.T) {
	stubUnreachableGh(t)
	m, engine, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr, commentID = 970714, "comment-cancel"

	fake.SetChatBlockUntilCancel(true)

	runID, err := m.StartClaudeChat(ClaudeChatInput{PR: pr, CommentID: commentID})
	if err != nil {
		t.Fatal(err)
	}

	signalDone := make(chan error, 1)
	go func() {
		signalDone <- engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
			ID: "msg-1", Author: "reviewer", Body: "Refactor dit hele bestand.",
		})
	}()

	// Poll-and-cancel in one step: cancelChatTurn is a no-op (returns false)
	// until runOneClaudeTurn has actually registered its CancelFunc, and
	// idempotent once it has, so retrying it is safe.
	waitFor(t, func() bool { return cancelChatTurn(commentID) })

	select {
	case err := <-signalDone:
		if err != nil {
			t.Fatalf("SignalWorkflow returned an error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelling the turn did not unblock the blocked Signal call")
	}

	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == chat.KindCancelled
	})

	// The critical assertion: give the workflow's own durable timer every
	// chance to fire a retry it should never schedule in the first place.
	// chatRetryDelays[0] is several seconds in production; shrinking it here
	// would only prove the SHORTENED ladder doesn't fire — the point is that
	// KindCancelled must skip runChatTurnWithRetries' ladder branch entirely
	// (chat.KindRetrying is never produced for a cancel), so there is no timer
	// to wait out at all. A plain, generous real-time wait confirms exactly
	// that: nothing changes on its own.
	time.Sleep(150 * time.Millisecond)
	list, _ := cm.List(ctx, commentID)
	if len(list) != 2 {
		t.Fatalf("a cancelled turn must not grow the transcript on its own, got %d rows: %+v", len(list), list)
	}
	if list[1].Kind != chat.KindCancelled {
		t.Fatalf("a cancelled turn auto-changed its own Kind (auto-retried?): %+v", list[1])
	}
	if list[1].Body == "" {
		t.Fatalf("expected a reviewer-facing cancelled message, got empty body")
	}

	// "Opnieuw proberen" (chatActionRetry) must still work afterwards — a
	// cancel is not a dead end, just not a SELF-triggered one.
	fake.SetChatBlockUntilCancel(false)
	fake.SetChatTurns("Nu wel, in één keer.")
	if err := engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: "msg-2", Author: "reviewer", Action: chatActionRetry,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		list, _ := cm.List(ctx, commentID)
		return len(list) == 2 && list[1].Kind == ""
	})
	list, _ = cm.List(ctx, commentID)
	if list[1].Body != "Nu wel, in één keer." {
		t.Fatalf("manual retry after a cancel did not replace the cancelled turn: %+v", list[1])
	}
}
