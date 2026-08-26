// chat_steer.go — "geef dit bericht door aan de turn die NU draait".
//
// A reviewer who types while a claude_chat turn is still running used to have
// exactly one option: the client-side queue (see "Doorpraten tijdens een
// lopende turn" in .claude/docs/claude-chat-panel.md), which turns the message
// into the NEXT turn. The claude CLI can do better: with
// --input-format stream-json its stdin stays open for the whole turn, and a
// user message written to it is picked up by the model at the running turn's
// next step boundary (right after a tool call) — so the reviewer really can
// steer mid-flight, exactly like the CLI's own interactive mode.
//
// The delivery itself is in-memory (chatSteerByConv below): an Activity that
// has already started is a black box, and the ONLY channel into a running
// subprocess is a live one. What is NOT in-memory is the reviewer's action —
// that is a real Signal on a real Execution, so it is durable and replayable
// before anything is delivered. It cannot be a Signal on the conversation's
// OWN claude_chat run: Engine.SignalWorkflow takes that run's lock and drives
// the turn inline, so such a Signal would block for exactly as long as the
// turn it means to steer (the same reason chat_cancel.go is not a Signal).
//
// So this file adds a SECOND Execution per conversation — a chat_steer run,
// whose own lock is free — in the shape chat_merge.go already established for
// the same problem (a per-PR queue Execution doing what a busy conversation
// run cannot). The write boundary therefore holds unchanged: the UI only
// starts/signals a workflow, and only Activities write (see
// .claude/rules/workflows-write-boundary.md). No carve-out.
//
// Accepted, documented limitation: that a running turn was steered is not
// visible in the claude_chat run's OWN history — only its Activity's final
// result is recorded there. The reviewer's message and the decision that led
// to it are fully recorded, in the chat_steer run. This is the same class as
// the CLI's --resume session state, which an Activity's result already depends
// on without the history describing it.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/chat"
)

// WorkflowChatSteer is the Workflow Type name (registered in workflows.go).
const WorkflowChatSteer = "chat_steer"

// SignalChatSteer carries one reviewer message aimed at the turn that is
// running right now.
const SignalChatSteer = "steer"

// ChatSteerInput starts (or, idempotently, re-ensures) a conversation's
// chat_steer Execution.
type ChatSteerInput struct {
	// Repo is the canonical repo string this PR belongs to: "" (absent) for the
	// primary repo, "owner/name" for any other configured repo. See repos.go.
	Repo           string `json:"repo,omitempty"`
	PR             int    `json:"pr"`
	ConversationID string `json:"conversationId"`
}

// ChatSteerRequest is the payload of a "steer" Signal. ID is minted by the
// HTTP handler (like ChatMessageSignal.ID), never inside the workflow body, so
// the message row's own id stays deterministic under replay.
type ChatSteerRequest struct {
	ID   string `json:"id"`
	Body string `json:"body"`
}

// chatSteerActivityInput is what both Activities below receive — the Signal's
// payload plus the conversation it belongs to.
type chatSteerActivityInput struct {
	Repo           string `json:"repo,omitempty"`
	PR             int    `json:"pr"`
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
	Body           string `json:"body"`
}

// chatSteerResult is deliverChatSteer's recorded result. The workflow body
// branches purely on it, so the branch is a pure function of the history —
// the same shape claudeChatWorkflow's own result.NeedsLand branch has.
type chatSteerResult struct {
	Delivered bool `json:"delivered"`
}

// chatSteerRunID derives the chat_steer Execution's Run ID from the
// conversation id — deterministic, like chatMergeQueueRunID, so
// StartWorkflowID makes ensuring it idempotent with no extra bookkeeping.
func chatSteerRunID(repo, conversationID string) string {
	return fmt.Sprintf("chatsteer-%s%s", repoRunPrefix(repo), conversationID)
}

// EnsureChatSteer ensures a conversation's chat_steer Execution exists
// (idempotent via StartWorkflowID) and returns its Run ID.
func (m *TaskManager) EnsureChatSteer(repo string, pr int, conversationID string) (string, error) {
	return m.engine.StartWorkflowID(chatSteerRunID(repo, conversationID), WorkflowChatSteer,
		ChatSteerInput{Repo: repo, PR: pr, ConversationID: conversationID})
}

// chatSteerWorkflow is the durable definition. Never completes — a long-lived
// per-conversation tracker, mould of chatMergeQueueWorkflow. Deterministic:
// every branch comes from either the Signal's own recorded payload or the
// recorded result of the Activity before it.
func chatSteerWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ChatSteerInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}
	for {
		var req ChatSteerRequest
		w.WaitSignal(SignalChatSteer, &req)
		arg := chatSteerActivityInput{
			Repo: in.Repo, PR: in.PR, ConversationID: in.ConversationID,
			MessageID: req.ID, Body: req.Body,
		}
		var res chatSteerResult
		if err := w.ExecuteActivity("deliverChatSteer", arg, &res); err != nil {
			return nil, fmt.Errorf("deliver chat steer: %w", err)
		}
		if res.Delivered {
			continue
		}
		// Nothing was running after all (the turn ended in the split second
		// between the reviewer's steerable-check and this Activity, or it sits
		// in a phase with no live CLI: work-directory prep, the write-turn
		// slot, a retry backoff). The message must not be lost, so it becomes
		// an ordinary next turn — exactly what the client-side queue would
		// have done, but from the workflow history instead of from a browser
		// tab.
		//
		// ASYNC on purpose: forwarding signals the conversation's own
		// claude_chat run, whose lock a still-running turn holds, so a
		// synchronous Activity would block this run's advance — and with it the
		// HTTP request that delivered this very Signal. ExecuteActivityAsync
		// runs it on its own goroutine and records the result when it lands;
		// Get then yields this run until then, which also keeps two steer
		// messages in FIFO order.
		f := w.ExecuteActivityAsync("forwardChatSteerAsMessage", arg)
		if err := f.Get(nil); err != nil {
			return nil, fmt.Errorf("forward chat steer: %w", err)
		}
	}
}

// chatSteerByConv is the in-memory hand-off to a RUNNING turn: per
// conversation, the send func RunChat's stdin writer sits behind. Registered
// by runOneClaudeTurn for the lifetime of ONE claude CLI call and unregistered
// straight after, so a steer can never reach a later, unrelated turn. No
// module, no read-model, no workflow-history write, and empty again after a
// restart — the same shape as chatCancelByConv (chat_cancel.go). It is
// deliberately NOT reachable from an HTTP handler: the only caller is the
// deliverChatSteer Activity above, which is what keeps this inside the write
// boundary rather than next to it.
var (
	chatSteerMu     sync.Mutex
	chatSteerByConv = map[string]func(string) bool{}
)

// registerChatSteer makes send reachable for this conversation for the
// duration of one CLI call. The caller must call the returned unregister func
// (typically via defer).
func registerChatSteer(conversationID string, send func(string) bool) (unregister func()) {
	chatSteerMu.Lock()
	chatSteerByConv[conversationID] = send
	chatSteerMu.Unlock()
	return func() {
		chatSteerMu.Lock()
		defer chatSteerMu.Unlock()
		// Safe to delete unconditionally: only one turn per conversation is ever
		// active at a time (Engine.SignalWorkflow serializes every Signal for a
		// given run through the run lock), and within a turn the two CLI calls
		// (read-only attempt, shell attempt) run strictly one after the other.
		delete(chatSteerByConv, conversationID)
	}
}

// steerChatTurn hands text to the CLI call running for conversationID, if any.
// Returns false when nothing is running for it, or when the send lost its race
// with the turn's own ending — the caller then falls back to an ordinary next
// turn.
func steerChatTurn(conversationID, text string) bool {
	chatSteerMu.Lock()
	send, ok := chatSteerByConv[conversationID]
	chatSteerMu.Unlock()
	if !ok {
		return false
	}
	return send(text)
}

// chatTurnSteerable reports whether a steer would reach a running CLI call
// right now — a purely in-memory read (no module, no history), the same class
// as chatProgressFor. Backs GET /api/chat/steerable, which the frontend uses
// to choose between steering and its own queue.
func chatTurnSteerable(conversationID string) bool {
	chatSteerMu.Lock()
	defer chatSteerMu.Unlock()
	_, ok := chatSteerByConv[conversationID]
	return ok
}

// openSteerSlot makes ONE claude CLI call steerable: it returns the channel to
// hand to claude.RunRequest.Steer plus the unregister func the caller must
// defer. The send is synchronous (RunChat's writer goroutine is reading for the
// whole call) but never waits forever: a cancelled turn, or a turn that ended
// in the split second before its unregister ran, gives up and reports false so
// the message falls back to an ordinary next turn instead of vanishing.
func openSteerSlot(ctx context.Context, conversationID string) (<-chan string, func()) {
	ch := make(chan string)
	unregister := registerChatSteer(conversationID, func(text string) bool {
		select {
		case ch <- text:
			return true
		case <-ctx.Done():
			return false
		case <-time.After(steerHandoffTimeout):
			return false
		}
	})
	return ch, unregister
}

// steerHandoffTimeout bounds that hand-off — see openSteerSlot. Short: the
// reader either is there right now or is gone.
const steerHandoffTimeout = 3 * time.Second

// chatSteerMessageID derives the steered message's row id from the Signal's
// own id, so a replay of this Activity can never produce a second copy of the
// same message (SaveMessage is INSERT OR REPLACE).
func chatSteerMessageID(messageID string) string { return "steer-" + messageID }

// deliverChatSteer is the deliverChatSteer Activity's body: hand the message
// to the running turn and, only if that succeeded, record it as the reviewer's
// own message in the transcript. When nothing is running it records nothing —
// the forward below then goes through claudeChatWorkflow's ordinary
// saveChatMessage, so the message is never stored twice.
func deliverChatSteer(ctx context.Context, tm *TaskManager, cm *chat.Module, arg chatSteerActivityInput) chatSteerResult {
	if !steerChatTurn(arg.ConversationID, arg.Body) {
		return chatSteerResult{}
	}
	msg := chat.Message{
		ID: chatSteerMessageID(arg.MessageID), ConversationID: arg.ConversationID,
		Repo: arg.Repo, PR: arg.PR, Role: "user", Body: arg.Body,
	}
	if err := cm.SaveMessage(ctx, msg); err != nil && tm != nil {
		tm.logf("chat_steer: save steered message for conversation %s: %v", arg.ConversationID, err)
	}
	publishChatChanged(arg.Repo, arg.PR, arg.ConversationID)
	return chatSteerResult{Delivered: true}
}

// forwardChatSteerAsMessage is the fallback Activity: deliver the reviewer's
// message as an ordinary next turn on the conversation's own claude_chat run.
// A cross-workflow Ensure+Signal from inside an Activity, the same shape
// enqueueChatMerge already uses. Blocking is expected here — SignalWorkflow
// waits for the conversation's run lock, i.e. for the turn that was running to
// finish — which is exactly why the workflow calls this one asynchronously.
func forwardChatSteerAsMessage(tm *TaskManager, arg chatSteerActivityInput) {
	// The conversation's Execution is guaranteed to exist — a steer can only be
	// typed into an already-open chat — so its Run ID is simply derived, never
	// re-ensured (which would race StartClaudeChat's parent/child decision).
	runID := chatConversationRunID(arg.ConversationID)
	if err := tm.engine.SignalWorkflow(runID, SignalMessage, ChatMessageSignal{
		ID: arg.MessageID, Author: "reviewer", Body: arg.Body,
	}); err != nil {
		tm.logf("chat_steer: forward message for conversation %s: %v", arg.ConversationID, err)
	}
}
