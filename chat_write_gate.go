// chat_write_gate.go — at most ONE code-generating claude_chat turn at a time.
//
// Reviewer decision: a turn that only ANSWERS something may run unlimited in
// parallel (chatting on another selection while an earlier answer is still
// being written is the whole point, see "Parallel conversations" in
// .claude/docs/claude-chat-panel.md), but a turn that GENERATES or CHANGES
// code runs one at a time, serially. A second such turn WAITS for the first —
// it is never refused.
//
// The two kinds are not guessed: runOneClaudeTurn (chat_workflow.go) already
// distinguishes them for a completely different reason. Every turn starts with
// the cheap read-only attempt, and only Claude's own {"type":"need_write"}
// directive escalates it to the shadow worktree with Edit/Bash (see "Two-step
// tool access" in .claude/docs/workflows-comments.md). That escalation IS the
// "this turn is going to change code" signal, so the gate sits exactly around
// the second attempt and nothing about the first one changes.
//
// Deliberately process-wide, not per PR: the point is to have one agentic
// edit run at a time on this machine (each one can run Bash), which is a
// machine-level resource, not a per-PR one.
//
// This global cap also happens to be exactly what makes the shared local
// checkout (chat_checkout.go — every conversation of a PR now edits the SAME
// real directory, no more per-conversation disposable worktree) safe against
// two turns mutating it at once, for free: since this gate already lets at
// most one code-generating turn run anywhere on the machine, two turns can
// never race each other's `git add`/commit/checkout/stash in the same (or any
// other) checkout. See todo/todo-local-checkout-chat-edits.md's "samenloop"
// chapter — a separate per-directory lock would only add complexity, since
// this gate already subsumes it.
//
// Not a workflow-determinism concern: this blocks inside an Activity, never in
// a workflow body, and it changes neither the number nor the order of
// ExecuteActivity calls (see .claude/rules/workflow-determinism.md).
package main

import "context"

// writeTurnSlots is the semaphore itself — capacity 1 is the whole policy.
var writeTurnSlots = make(chan struct{}, 1)

// acquireWriteTurnSlot takes the one code-turn slot and returns the release
// func the caller must defer. When the slot is already taken it calls
// onWaiting once (so the reviewer's status line can say it is waiting rather
// than showing a silent stall) and then blocks until the slot frees up.
//
// A cancelled context gives up waiting and returns a no-op release: the caller
// then runs into that same cancelled context on its next CLI call and fails
// the turn normally, which is what a shutdown should look like.
func acquireWriteTurnSlot(ctx context.Context, onWaiting func()) func() {
	select {
	case writeTurnSlots <- struct{}{}:
		return func() { <-writeTurnSlots }
	default:
	}
	if onWaiting != nil {
		onWaiting()
	}
	select {
	case writeTurnSlots <- struct{}{}:
		return func() { <-writeTurnSlots }
	case <-ctx.Done():
		return func() {}
	}
}
