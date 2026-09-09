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
	release := acquireWriteTurnSlot(context.Background(), "pr:1", func() {
		t.Fatal("the first code turn must not have to wait")
	})

	waited := make(chan struct{}, 4)
	got := make(chan struct{})
	go func() {
		r2 := acquireWriteTurnSlot(context.Background(), "pr:1", func() { waited <- struct{}{} })
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
	release := acquireWriteTurnSlot(context.Background(), "pr:2", nil)
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan func())
	go func() { done <- acquireWriteTurnSlot(ctx, "pr:2", func() {}) }()
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
	release := acquireWriteTurnSlot(context.Background(), "pr:10", func() {
		t.Fatal("the first PR's own turn must not have to wait for itself")
	})
	defer release()

	done := make(chan struct{})
	go func() {
		r2 := acquireWriteTurnSlot(context.Background(), "pr:20", func() {
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
