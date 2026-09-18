package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
)

// One code turn at a time PER KEY: the second acquire on the SAME key WAITS
// (and says so, once) instead of being refused, and gets the slot as soon as
// the first releases.
func TestWriteTurnSlotSerializesAndWaits(t *testing.T) {
	release := acquireWriteTurnSlot(context.Background(), "pr:1", "first", func() {
		t.Fatal("the first code turn must not have to wait")
	})

	waited := make(chan struct{}, 4)
	got := make(chan struct{})
	go func() {
		r2 := acquireWriteTurnSlot(context.Background(), "pr:1", "first", func() { waited <- struct{}{} })
		close(got)
		r2()
	}()

	select {
	case <-waited:
	case <-time.After(2 * time.Second):
		t.Fatal("the second code turn was never reported as waiting")
	}
	select {
	case <-got:
		t.Fatal("the second code turn ran while the first still held the slot")
	case <-time.After(20 * time.Millisecond):
	}

	release()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("the second code turn never got the slot after the first released it")
	}
	if len(waited) != 0 {
		t.Fatalf("onWaiting must be reported exactly once, got %d more", len(waited))
	}
}

// A cancelled context gives up waiting rather than blocking forever; the
// returned release is then a no-op that must not free someone else's slot.
func TestWriteTurnSlotGivesUpOnCancelledContext(t *testing.T) {
	release := acquireWriteTurnSlot(context.Background(), "pr:2", "first", nil)
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan func())
	go func() { done <- acquireWriteTurnSlot(ctx, "pr:2", "second", func() {}) }()
	select {
	case r := <-done:
		r() // no-op: must not release the slot the first turn still holds
	case <-time.After(2 * time.Second):
		t.Fatal("a cancelled context should not keep waiting for the slot")
	}
	ch := writeTurnSlotChan("pr:2")
	select {
	case ch <- struct{}{}:
		<-ch
		t.Fatal("the no-op release freed the slot the first turn still holds")
	default:
	}
}

// Two DIFFERENT keys (two different PRs/checkouts) never wait on each other —
// the core reviewer requirement behind making this gate per-checkout rather
// than process-wide: an action on PR X must never be held up by a write turn
// on unrelated PR Y.
func TestWriteTurnSlotDoesNotSerializeAcrossDifferentKeys(t *testing.T) {
	release := acquireWriteTurnSlot(context.Background(), "pr:10", "first", func() {
		t.Fatal("the first PR's own turn must not have to wait for itself")
	})
	defer release()

	done := make(chan struct{})
	go func() {
		r2 := acquireWriteTurnSlot(context.Background(), "pr:20", "second", func() {
			t.Error("a different key must never report waiting on an unrelated key's slot")
		})
		r2()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a different key's acquire was blocked by an unrelated key's held slot")
	}
}

// TestCheckoutWaitersDedupesAndDrains: the SignalCheckoutFreed hook's registry
// (chat_workflow.go/chat_merge.go) must (1) never register the same waiting
// run twice for one key — a replayed/recovered attempt re-registering itself
// must not wake it twice — and (2) takeCheckoutWaiters must both return and
// FORGET every waiter for a key in one call, so a later, unrelated freeing of
// the same key never re-wakes a run that already moved on.
func TestCheckoutWaitersDedupesAndDrains(t *testing.T) {
	const key = "dir:/tmp/does-not-matter"
	t.Cleanup(func() { takeCheckoutWaiters(key) }) // leave no residue for other tests

	registerCheckoutWaiter(key, "chat-a")
	registerCheckoutWaiter(key, "chat-b")
	registerCheckoutWaiter(key, "chat-a") // duplicate, must not double-add

	got := takeCheckoutWaiters(key)
	want := []string{"chat-a", "chat-b"}
	if len(got) != len(want) {
		t.Fatalf("takeCheckoutWaiters(%q) = %v, want %v (no duplicate)", key, got, want)
	}
	for i, id := range want {
		if got[i] != id {
			t.Fatalf("takeCheckoutWaiters(%q) = %v, want %v", key, got, want)
		}
	}

	// The take above must have DRAINED the registry: nobody is registered any
	// more, so a second take (as broadcastCheckoutFreed would do on a LATER,
	// unrelated landing of the same checkout) finds nothing left to signal.
	if again := takeCheckoutWaiters(key); len(again) != 0 {
		t.Fatalf("takeCheckoutWaiters(%q) a second time = %v, want empty (registry must drain)", key, again)
	}
}

// TestCheckoutWaitFallbackWorkflowWakesTheWaitingRun is the durable-safety-net
// half of the SignalCheckoutFreed hook, tested end to end against a real
// tembed engine (a fresh, isolated one — not the full app's, so this can
// register a throwaway target workflow without colliding with any real
// registered name): checkoutWaitFallbackWorkflow (chat_workflow.go) must
// actually deliver SignalCheckoutFreed to its ParentRunID once its own
// w.Sleep elapses, exactly as chat_merge.go's broadcastCheckoutFreed does on
// the real-landing path — this is the mechanism that guarantees
// runChatTurnWithRetries' checkout wait can never block forever even if the
// real broadcast is missed.
func TestCheckoutWaitFallbackWorkflowWakesTheWaitingRun(t *testing.T) {
	engine := tembed.New(tembed.NewMemoryStore())
	engine.RegisterWorkflow(WorkflowCheckoutWaitFallback, checkoutWaitFallbackWorkflow)
	engine.RegisterActivity("signalCheckoutFreed", func(ctx context.Context, in []byte) ([]byte, error) {
		var runID string
		if err := json.Unmarshal(in, &runID); err != nil {
			return nil, err
		}
		return nil, engine.SignalWorkflow(runID, SignalCheckoutFreed, CheckoutFreedSignal{})
	})

	woke := make(chan struct{}, 1)
	engine.RegisterWorkflow("__test_checkout_wait_target", func(w *tembed.Workflow, input []byte) ([]byte, error) {
		var freed CheckoutFreedSignal
		w.WaitSignal(SignalCheckoutFreed, &freed)
		select {
		case woke <- struct{}{}:
		default:
		}
		return nil, nil
	})

	parentRunID, err := engine.StartWorkflow("__test_checkout_wait_target", nil)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := engine.StartWorkflow(WorkflowCheckoutWaitFallback, checkoutWaitFallbackInput{
		ParentRunID: parentRunID, Delay: 10 * time.Millisecond,
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case <-woke:
	case <-time.After(2 * time.Second):
		t.Fatal("checkoutWaitFallbackWorkflow never woke the waiting run after its own delay elapsed")
	}
}

// TestWriteTurnSlotForceReleasesStaleHolder: a holder that never calls its
// own release() (a crashed/permanently wedged goroutine — exactly the
// reported "hij wacht op een andere chat, maar die kan ik niet stoppen"
// symptom) must not wedge a WAITING acquire forever once the holder has
// crossed writeTurnStaleTimeout — the whole point of forceReleaseStaleWriteTurnSlot.
func TestWriteTurnSlotForceReleasesStaleHolder(t *testing.T) {
	origTimeout, origInterval := writeTurnStaleTimeout, writeTurnStaleCheckInterval
	writeTurnStaleTimeout = 30 * time.Millisecond
	writeTurnStaleCheckInterval = 5 * time.Millisecond
	t.Cleanup(func() { writeTurnStaleTimeout, writeTurnStaleCheckInterval = origTimeout, origInterval })

	const key = "pr:stale-1"
	// The "abandoned" holder: acquired, then simply never releases.
	_ = acquireWriteTurnSlot(context.Background(), key, "abandoned", nil)

	done := make(chan func())
	go func() { done <- acquireWriteTurnSlot(context.Background(), key, "waiter", func() {}) }()

	select {
	case r := <-done:
		r()
	case <-time.After(2 * time.Second):
		t.Fatal("a stale holder should have been force-released, but the waiter never got the slot")
	}
}

// TestWriteTurnSlotDoesNotForceReleaseFreshHolder: the mirror image — a
// holder that is well within writeTurnStaleTimeout must NOT be force-released
// just because something is waiting; the waiter keeps waiting until either
// the real release or the timeout, whichever comes first.
func TestWriteTurnSlotDoesNotForceReleaseFreshHolder(t *testing.T) {
	origTimeout, origInterval := writeTurnStaleTimeout, writeTurnStaleCheckInterval
	writeTurnStaleTimeout = 2 * time.Second
	writeTurnStaleCheckInterval = 5 * time.Millisecond
	t.Cleanup(func() { writeTurnStaleTimeout, writeTurnStaleCheckInterval = origTimeout, origInterval })

	const key = "pr:stale-2"
	release := acquireWriteTurnSlot(context.Background(), key, "fresh holder", nil)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	got := acquireWriteTurnSlot(ctx, key, "waiter", func() {})
	got() // no-op: the context timed out well before writeTurnStaleTimeout

	// The original holder must still hold the ONE token: a non-blocking send
	// must fail.
	ch := writeTurnSlotChan(key)
	select {
	case ch <- struct{}{}:
		<-ch
		t.Fatal("a fresh holder's slot was force-released early")
	default:
	}
	release()
}

// TestWriteTurnSlotForceReleaseIsIdempotentAgainstTheRealHolder: the race
// forceReleaseStaleWriteTurnSlot's CompareAndSwap guards against — a holder
// that gets force-released for having gone stale, but was not actually dead
// and eventually calls its own deferred release() anyway, must never drain a
// LATER, unrelated holder's token. Without the CAS guard this would let two
// acquires succeed concurrently for the same key.
func TestWriteTurnSlotForceReleaseIsIdempotentAgainstTheRealHolder(t *testing.T) {
	origTimeout := writeTurnStaleTimeout
	writeTurnStaleTimeout = 10 * time.Millisecond
	t.Cleanup(func() { writeTurnStaleTimeout = origTimeout })

	const key = "pr:stale-3"
	release1 := acquireWriteTurnSlot(context.Background(), key, "holder-1", nil)

	time.Sleep(20 * time.Millisecond) // cross writeTurnStaleTimeout
	if !forceReleaseStaleWriteTurnSlot(key) {
		t.Fatal("expected forceReleaseStaleWriteTurnSlot to free the stale holder's slot")
	}

	// A brand new holder takes the freed slot.
	release2 := acquireWriteTurnSlot(context.Background(), key, "holder-2", nil)

	// holder-1's own (late, but real) release fires now — must be a no-op.
	release1()

	// holder-2's slot must still be held: a non-blocking send must fail.
	ch := writeTurnSlotChan(key)
	select {
	case ch <- struct{}{}:
		<-ch
		t.Fatal("holder-1's late release incorrectly drained holder-2's token")
	default:
	}
	release2()
}

// TestForceReleaseCheckoutWriteSlotRespectsStaleness: the manual "Forceer
// vrijgeven" endpoint (handleCheckoutForceRelease -> forceReleaseCheckoutWriteSlot)
// must be a no-op against a holder that hasn't gone stale yet, and must
// actually free it once it has -- the same staleness bar as the automatic
// check, never an unconditional kill switch.
func TestForceReleaseCheckoutWriteSlotRespectsStaleness(t *testing.T) {
	origTimeout := writeTurnStaleTimeout
	writeTurnStaleTimeout = 20 * time.Millisecond
	t.Cleanup(func() { writeTurnStaleTimeout = origTimeout })

	dataDir := t.TempDir()
	const repo = ""
	const pr = 999001
	release := acquireCheckoutWriteSlot(context.Background(), dataDir, repo, pr, "holder", nil)

	if forceReleaseCheckoutWriteSlot(dataDir, repo, pr) {
		t.Fatal("expected no-op: the holder has not gone stale yet")
	}

	time.Sleep(30 * time.Millisecond)
	if !forceReleaseCheckoutWriteSlot(dataDir, repo, pr) {
		t.Fatal("expected the stale holder's slot to be freed")
	}
	release() // now a no-op (already force-released) -- must not panic or block
}

// TestWriteTurnSlotHeartbeatKeepsALongLiveTurnFromGoingStale is the exact
// scenario behind the "Bash test suite ran 42 minutes but was still alive"
// case (see writeTurnStaleTimeout's own doc comment): a holder that never
// releases but keeps calling touchWriteTurnHolder faster than
// writeTurnStaleTimeout must NEVER be force-released, however long it has
// been held in total.
func TestWriteTurnSlotHeartbeatKeepsALongLiveTurnFromGoingStale(t *testing.T) {
	origTimeout, origInterval := writeTurnStaleTimeout, writeTurnStaleCheckInterval
	writeTurnStaleTimeout = 40 * time.Millisecond
	writeTurnStaleCheckInterval = 5 * time.Millisecond
	t.Cleanup(func() { writeTurnStaleTimeout, writeTurnStaleCheckInterval = origTimeout, origInterval })

	const key = "pr:stale-heartbeat"
	release := acquireWriteTurnSlot(context.Background(), key, "long but alive", nil)

	stopHeartbeat := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Millisecond) // well under writeTurnStaleTimeout
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-ticker.C:
				touchWriteTurnHolder(key)
			}
		}
	}()

	// Outlive writeTurnStaleTimeout several times over while heartbeats keep
	// arriving; a second acquire attempt must NOT get in.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	got := acquireWriteTurnSlot(ctx, key, "waiter", nil)
	got() // no-op if it never actually acquired (the expected outcome)

	close(stopHeartbeat)
	<-done

	ch := writeTurnSlotChan(key)
	select {
	case ch <- struct{}{}:
		<-ch
		t.Fatal("a holder that kept heartbeating was force-released")
	default:
	}
	release()
}
