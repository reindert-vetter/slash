// chat_write_gate.go — at most ONE code-generating claude_chat turn at a time
// PER CHECKOUT.
//
// Reviewer decision: a turn that only ANSWERS something may run unlimited in
// parallel (chatting on another selection while an earlier answer is still
// being written is the whole point, see "Parallel conversations" in
// .claude/docs/claude-chat-panel.md), but a turn that GENERATES or CHANGES
// code runs one at a time, serially, for the checkout it would touch. A
// second such turn for the SAME checkout WAITS for the first — it is never
// refused; a turn for a DIFFERENT PR's checkout is never held up by it.
//
// The two kinds (answer vs. write) are not guessed: runOneClaudeTurn
// (chat_workflow.go) already distinguishes them for a completely different
// reason. Every turn starts with the cheap read-only attempt, and only
// Claude's own {"type":"need_write"} directive escalates it to the shared
// checkout with Edit/Bash (see "Two-step tool access" in
// .claude/docs/workflows-comments.md). That escalation IS the "this turn is
// going to change code" signal, so the gate sits exactly around the second
// attempt and nothing about the first one changes.
//
// Keyed by checkoutWriteSlotKey (chat_checkout.go) — the resolved checkout
// DIRECTORY once this PR has one assigned, or a per-PR fallback before that.
// Deliberately NOT process-wide any more (reviewer decision: "per pr moet het
// niet wachten op een andere pr"): a machine can
// easily have several PRs each with their own checkout, and there is no
// reason for an overlay answer or a write turn on PR X to queue behind a
// long-running edit on unrelated PR Y. Keying on the DIRECTORY rather than
// blindly on the PR number is what still protects the one case where two PRs
// really do share one physical checkout (a directory another PR already
// claims can still be picked via the "andere werkmap kiezen" last-resort
// choice, chat_checkout.go's checkoutLastResortDecision) — see
// checkoutWriteSlotKey's own doc comment.
//
// This per-checkout gate is also what makes every OTHER checkout-mutating
// operation — the landing/commit itself (processChatMerge) and the
// werkmap-overlay's own answer/relist/restore-stash Activities (workflows.go)
// — safe against a concurrently RUNNING write turn for that same PR: they now
// take the SAME slot before touching git, closing the exact race that used to
// let one conversation's still-uncommitted edit be misread by another
// conversation (or the overlay) as "unrelated dirty changes" (see
// dirtyIsOnlyPendingEdits, chat_checkout.go, for the other half of that fix).
//
// Not a workflow-determinism concern: this blocks inside an Activity, never in
// a workflow body, and it changes neither the number nor the order of
// ExecuteActivity calls (see .claude/rules/workflow-determinism.md).
package main

import (
	"context"
	"sync"
)

// writeTurnSlotsMu guards lazy creation of writeTurnSlots' per-key channels —
// never held while waiting on one (that would defeat the whole point of
// having separate keys).
var (
	writeTurnSlotsMu sync.Mutex
	writeTurnSlots   = map[string]chan struct{}{}
)

// writeTurnSlotChan returns key's own capacity-1 semaphore, creating it on
// first use. The map itself only ever grows (one entry per PR/checkout the
// process has ever seen a write turn or checkout-menu action for) — the same
// accepted, unbounded-but-tiny-in-practice shape as chatCheckoutByPR and
// chatProgressByConv.
func writeTurnSlotChan(key string) chan struct{} {
	writeTurnSlotsMu.Lock()
	defer writeTurnSlotsMu.Unlock()
	ch := writeTurnSlots[key]
	if ch == nil {
		ch = make(chan struct{}, 1)
		writeTurnSlots[key] = ch
	}
	return ch
}

// acquireWriteTurnSlot takes key's one code-turn slot and returns the release
// func the caller must defer. When the slot is already taken it calls
// onWaiting once (so the reviewer's status line can say it is waiting rather
// than showing a silent stall) and then blocks until the slot frees up.
//
// A cancelled context gives up waiting and returns a no-op release: the caller
// then runs into that same cancelled context on its next CLI call and fails
// the turn normally, which is what a shutdown should look like.
func acquireWriteTurnSlot(ctx context.Context, key string, onWaiting func()) func() {
	ch := writeTurnSlotChan(key)
	select {
	case ch <- struct{}{}:
		return func() { <-ch }
	default:
	}
	if onWaiting != nil {
		onWaiting()
	}
	select {
	case ch <- struct{}{}:
		return func() { <-ch }
	case <-ctx.Done():
		return func() {}
	}
}

// acquireCheckoutWriteSlot is acquireWriteTurnSlot's PR-aware wrapper: it
// resolves the checkoutWriteSlotKey (chat_checkout.go) for (dataDir, repo,
// pr) and, in addition to onWaiting, marks/clears this PR's own PR-wide
// "waiting" flag (setCheckoutWaiting, checkout_progress.go) — the one flag
// the checkout chip (src/home.mjs) always shows, regardless of which of the
// several call sites (an escalated chat turn, a test run, the werkmap
// overlay's own answer/relist/restore-stash, or the automatic post-turn
// landing) is doing the waiting. Every one of those should go through this
// wrapper rather than calling acquireWriteTurnSlot directly, so a wait is
// NEVER silent regardless of which UI surface the reviewer happens to have
// open (reviewer requirement: "als iets geblokkeerd raakt, moet dat
// zichtbaar zijn ... nooit stil wachten").
func acquireCheckoutWriteSlot(ctx context.Context, dataDir, repo string, pr int, onWaiting func()) func() {
	key := checkoutWriteSlotKey(dataDir, repo, pr)
	release := acquireWriteTurnSlot(ctx, key, func() {
		setCheckoutWaiting(repo, pr, true)
		if onWaiting != nil {
			onWaiting()
		}
	})
	return func() {
		setCheckoutWaiting(repo, pr, false)
		release()
	}
}
