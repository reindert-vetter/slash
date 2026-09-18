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
	"sync/atomic"
	"time"
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

// writeTurnStaleTimeout — how long a checkout's write-turn slot may sit HELD
// with no sign of the holder ever coming back before a WAITING acquire gives
// up on it and force-frees the slot for itself instead of blocking forever.
//
// Reported symptom this exists for: "hij wacht op een andere chat, maar die
// kan ik niet stoppen" — chat_write_gate.go's slot is a plain in-memory
// channel with no owner identity and no timeout, so a holder that never
// calls its deferred release() (a crashed/permanently wedged goroutine —
// no subprocess left running, the process itself not restarted) used to wedge
// every later write turn for that checkout forever, recoverable only by
// restarting the whole server. The only visible "Stop" button
// (data-testid=claude-chat-cancel) is scoped to whichever conversation is
// currently open — cancelling it only makes THAT turn give up waiting, it
// never frees the slot it was never holding in the first place.
//
// The timeout itself is measured, not guessed: the longest single
// claude_chat write turn that ever completed SUCCESSFULLY in this
// deployment's own workflow history held its own checkout for ~2546s
// (~42.4 minutes — a real `Bash` test-suite run: "1095 passed ... 2821
// assertions, 1235s" in its own reply; run "chat-47284166cc7147a9794cf3ba",
// PR 13729), measured directly from data/workflows.db's `events` table (the
// gap between a conversation's SignalReceived("message") and its own
// ActivityCompleted("runClaudeTurn") — see .claude/docs/claude-chat-panel.md
// for the exact query and the full top-20 distribution; every other
// successful turn in that history was well under 800s). This constant is
// set to more than 2x that measured maximum, so a real, slow-but-alive turn
// (a long test run, a big refactor) is never mistaken for an abandoned one.
var writeTurnStaleTimeout = 90 * time.Minute

// writeTurnStaleCheckInterval is how often a WAITING acquire re-checks
// whether the current holder has gone stale, instead of only ever blocking
// on the channel send. Cheap (one map read under a mutex) and short enough
// that a genuinely freed slot is still picked up promptly.
var writeTurnStaleCheckInterval = 30 * time.Second

// writeTurnHolder describes whoever currently holds one checkout's write
// slot — purely for the checkout chip (buildCheckoutView, chat_checkout.go)
// to name it instead of a bare "Wachten…", and for the staleness check
// above. released is shared with the holder's own release closure: exactly
// one of {the real holder's eventual release(), a force-release} ever wins
// the CompareAndSwap on it, so a holder that was force-released and later
// turns out to not actually be dead after all can never double-drain a
// LATER, unrelated holder's own token (see forceReleaseStaleWriteTurnSlot's
// own doc comment for the race this closes).
type writeTurnHolder struct {
	Label      string
	AcquiredAt time.Time
	released   *atomic.Bool
}

var (
	writeTurnHoldersMu sync.Mutex
	writeTurnHolders   = map[string]writeTurnHolder{}
)

// currentWriteTurnHolder reports who (if anyone) currently holds key's write
// slot right now, and whether that holder has already crossed
// writeTurnStaleTimeout — a pure read, no side effect, used by
// buildCheckoutView (chat_checkout.go) to show the reviewer who's holding it
// and whether "Forceer vrijgeven" would currently do anything.
func currentWriteTurnHolder(key string) (label string, stale, ok bool) {
	writeTurnHoldersMu.Lock()
	defer writeTurnHoldersMu.Unlock()
	h, present := writeTurnHolders[key]
	if !present {
		return "", false, false
	}
	return h.Label, time.Since(h.AcquiredAt) >= writeTurnStaleTimeout, true
}

// forceReleaseStaleWriteTurnSlot drains key's slot when its current holder
// has been sitting on it for at least writeTurnStaleTimeout, so a genuinely
// abandoned holder can never wedge every future write turn for that checkout
// forever — the only recovery before this was a full server restart (which
// resets writeTurnSlots to empty anyway).
//
// Also used directly by the manual "Forceer vrijgeven" action
// (handleCheckoutForceRelease, tasks_api.go) — deliberately the SAME check,
// not a separate unconditional drain: a reviewer-triggered force-release
// must never be able to interrupt a turn that is merely slow, only one that
// has already crossed the same measured-safe staleness bar an automatic
// check would eventually have crossed anyway. Returns whether it actually
// freed anything (false: nothing was held, or the holder wasn't stale yet).
//
// Race this closes: staleness is checked and the holder's bookkeeping entry
// is removed atomically under one lock, and the actual channel drain is
// gated behind winning the CompareAndSwap on that holder's own `released`
// flag (shared with its real release closure below) — so if the "abandoned"
// holder is not actually dead and its own deferred release() fires around
// the same moment, only ONE of the two ever drains the channel. Without that
// guard, the real holder's later release() would instead drain whatever
// LATER, unrelated acquirer had since taken the freed slot, corrupting the
// capacity-1 semaphore into allowing two concurrent write turns.
func forceReleaseStaleWriteTurnSlot(key string) bool {
	writeTurnHoldersMu.Lock()
	holder, ok := writeTurnHolders[key]
	stale := ok && time.Since(holder.AcquiredAt) >= writeTurnStaleTimeout
	if stale {
		delete(writeTurnHolders, key)
	}
	writeTurnHoldersMu.Unlock()
	if !stale || !holder.released.CompareAndSwap(false, true) {
		return false
	}
	ch := writeTurnSlotChan(key)
	select {
	case <-ch:
		return true
	default:
		// The real holder's own release already drained it a moment earlier
		// (it won a concurrent CAS on a DIFFERENT acquisition's flag — cannot
		// happen for this same holder, since we just won its CAS above — or
		// this holder was never actually acquired via acquireWriteTurnSlot at
		// all, which is not a real code path). Nothing left to do either way.
		return false
	}
}

// acquireWriteTurnSlot takes key's one code-turn slot and returns the release
// func the caller must defer. When the slot is already taken it calls
// onWaiting once (so the reviewer's status line can say it is waiting rather
// than showing a silent stall) and then waits until the slot frees up —
// either because the real holder releases it, or because
// forceReleaseStaleWriteTurnSlot decides the holder has gone stale (see its
// own doc comment). label is a short, human description of the caller
// (logged nowhere yet, but stored so the checkout chip can eventually name
// the current holder — see buildCheckoutView).
//
// A cancelled context gives up waiting and returns a no-op release: the caller
// then runs into that same cancelled context on its next CLI call and fails
// the turn normally, which is what a shutdown should look like.
func acquireWriteTurnSlot(ctx context.Context, key, label string, onWaiting func()) func() {
	ch := writeTurnSlotChan(key)
	acquire := func() func() {
		released := &atomic.Bool{}
		writeTurnHoldersMu.Lock()
		writeTurnHolders[key] = writeTurnHolder{Label: label, AcquiredAt: time.Now(), released: released}
		writeTurnHoldersMu.Unlock()
		return func() {
			if !released.CompareAndSwap(false, true) {
				return // already force-released; the token is already drained
			}
			writeTurnHoldersMu.Lock()
			delete(writeTurnHolders, key)
			writeTurnHoldersMu.Unlock()
			<-ch
		}
	}
	select {
	case ch <- struct{}{}:
		return acquire()
	default:
	}
	if onWaiting != nil {
		onWaiting()
	}
	ticker := time.NewTicker(writeTurnStaleCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case ch <- struct{}{}:
			return acquire()
		case <-ctx.Done():
			return func() {}
		case <-ticker.C:
			forceReleaseStaleWriteTurnSlot(key)
		}
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
func acquireCheckoutWriteSlot(ctx context.Context, dataDir, repo string, pr int, label string, onWaiting func()) func() {
	key := checkoutWriteSlotKey(dataDir, repo, pr)
	release := acquireWriteTurnSlot(ctx, key, label, func() {
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

// forceReleaseCheckoutWriteSlot is the manual counterpart of the automatic
// staleness check above, driven by the reviewer's own "Forceer vrijgeven"
// command (checkoutChipCommandsFor, src/home.mjs) via
// POST /api/checkout/force-release (handleCheckoutForceRelease, tasks_api.go).
// A stateless operational carve-out, not a workflow write — see
// .claude/rules/workflows-write-boundary.md: it touches no module, no
// read-model and no workflow history, only the same in-memory bookkeeping
// forceReleaseStaleWriteTurnSlot already mutates on its own poll cadence,
// and it is empty again after a restart exactly like chatCancelByConv. It
// applies the SAME staleness bar as the automatic check (see that function's
// own doc comment) — this is deliberately not an unconditional "just kill
// it" button.
func forceReleaseCheckoutWriteSlot(dataDir, repo string, pr int) bool {
	key := checkoutWriteSlotKey(dataDir, repo, pr)
	return forceReleaseStaleWriteTurnSlot(key)
}

// checkoutWaiters registers which claude_chat conversation Run IDs are
// currently waiting (runChatTurnWithRetries' w.WaitSignal, chat_workflow.go)
// for a given checkout (keyed the same way as writeTurnSlots above,
// checkoutWriteSlotKey) to free up — the fast half of the SignalCheckoutFreed
// hook: chat_merge.go's broadcastCheckoutFreed reads this to know who to wake
// once a landing that was in the way finishes.
//
// Best-effort/in-memory only, same carve-out as writeTurnSlots: losing an
// entry across a restart is safe, because checkoutWaitFallbackWorkflow's own
// durable w.Sleep timer wakes that same run regardless — the slow, always-
// correct safety-net half of the same hook.
var (
	checkoutWaitersMu sync.Mutex
	checkoutWaiters   = map[string][]string{}
)

// registerCheckoutWaiter adds runID to key's waiter list, deduplicated so a
// replayed/recovered attempt (which re-executes this Activity only when it
// wasn't already recorded — see registerCheckoutWaiter's Activity
// registration in workflows.go) never adds itself twice.
func registerCheckoutWaiter(key, runID string) {
	checkoutWaitersMu.Lock()
	defer checkoutWaitersMu.Unlock()
	for _, id := range checkoutWaiters[key] {
		if id == runID {
			return
		}
	}
	checkoutWaiters[key] = append(checkoutWaiters[key], runID)
}

// takeCheckoutWaiters removes and returns every run ID currently registered
// for key, so broadcastCheckoutFreed (chat_merge.go) can signal each of them
// exactly once and nobody is left registered against a checkout that already
// froze.
func takeCheckoutWaiters(key string) []string {
	checkoutWaitersMu.Lock()
	defer checkoutWaitersMu.Unlock()
	ids := checkoutWaiters[key]
	delete(checkoutWaiters, key)
	return ids
}
