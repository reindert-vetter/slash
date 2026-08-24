// chat_cancel.go — "stop this running claude_chat turn right now". A cancel
// can never be a Signal: tembed's Engine.SignalWorkflow takes the run's own
// lock and drives the whole turn inline (see engine.go's advance/advanceMode),
// so a Signal aimed at the SAME run would simply queue up behind the turn it
// is trying to interrupt and block for exactly as long as that turn runs.
//
// Instead this is a purely in-memory, per-conversation registry of the
// context.CancelFunc that cancels ONLY the outbound work of one running turn
// (the claude CLI subprocess, the write-turn-slot wait, the git/gh checkout
// prep) — never the Activity's own ability to persist a message, which keeps
// using the ORIGINAL, uncancelled context (see runOneClaudeTurn,
// chat_workflow.go). No module, no read-model, no workflow-history write, and
// empty again after a restart — the same operational carve-out as
// chatProgressByConv (chat_progress.go); see the matching example in
// .claude/rules/workflows-write-boundary.md. Safe because it is not the
// source of truth about anything: the durable outcome of a cancel is the
// chat.KindCancelled message the Activity itself saves once its context
// actually cancels, exactly like any other terminal turn result.
package main

import "sync"

var (
	chatCancelMu     sync.Mutex
	chatCancelByConv = map[string]func(){}
)

// registerChatCancel makes cancel reachable for this conversation for the
// duration of the turn. The caller must call the returned unregister func
// (typically via defer) once the turn is done, so a stale entry can never
// cancel a LATER, unrelated turn on the same conversation.
func registerChatCancel(conversationID string, cancel func()) (unregister func()) {
	chatCancelMu.Lock()
	chatCancelByConv[conversationID] = cancel
	chatCancelMu.Unlock()
	return func() {
		chatCancelMu.Lock()
		defer chatCancelMu.Unlock()
		// Safe to unconditionally delete: only one turn per conversation is ever
		// active at a time (Engine.SignalWorkflow serializes every Signal for a
		// given run through the run lock — see the file's own doc comment), so
		// this unregister can never race a later turn's own registration.
		delete(chatCancelByConv, conversationID)
	}
}

// cancelChatTurn cancels the running turn's context for conversationID, if
// any. Returns false when nothing is running for it (already finished, or
// never started) — not an error, mirroring chatProgressFor's own "no running
// turn" non-error shape.
func cancelChatTurn(conversationID string) bool {
	chatCancelMu.Lock()
	cancel, ok := chatCancelByConv[conversationID]
	chatCancelMu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}
