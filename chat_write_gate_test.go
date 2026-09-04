package main

import (
	"context"
	"testing"
	"time"
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
