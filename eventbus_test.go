package main

import (
	"encoding/json"
	"testing"
)

// A published event reaches a subscriber of the same PR, a PR-less subscriber,
// and nobody else — the whole filtering contract of the hub.
func TestEventHubScopesByPR(t *testing.T) {
	h := newEventHub()
	_, all := h.subscribe(0)
	_, mine := h.subscribe(7)
	_, other := h.subscribe(8)

	h.publish(eventChatMessage, 7, "conv-1", nil)

	for name, sub := range map[string]*eventSub{"all": all, "mine": mine} {
		select {
		case ev := <-sub.ch:
			if ev.Type != eventChatMessage || ev.PR != 7 || ev.Key != "conv-1" {
				t.Fatalf("%s: unexpected event %+v", name, ev)
			}
		default:
			t.Fatalf("%s: expected an event", name)
		}
	}
	select {
	case ev := <-other.ch:
		t.Fatalf("subscriber of another PR got %+v", ev)
	default:
	}
}

// The payload is marshalled at publish time, so a later mutation of the
// caller's struct can never change what a subscriber reads.
func TestEventHubSnapshotsPayload(t *testing.T) {
	h := newEventHub()
	_, sub := h.subscribe(0)
	p := chatProgress{Running: true, Phase: chatPhaseWriting, Partial: "hal"}
	h.publish(eventChatProgress, 1, "conv", p)
	p.Partial = "changed after publish"

	ev := <-sub.ch
	var got chatProgress
	if err := json.Unmarshal(ev.Data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Partial != "hal" {
		t.Fatalf("payload was not snapshotted: %q", got.Partial)
	}
}

// A subscriber that never reads must not block the publisher, and must be
// flagged so its connection can send a resync instead of silently skipping.
func TestEventHubDropsInsteadOfBlocking(t *testing.T) {
	h := newEventHub()
	_, sub := h.subscribe(0)
	for i := 0; i < eventSubBuffer+10; i++ {
		h.publish(eventChatMessage, 1, "conv", nil) // would deadlock if it blocked
	}
	if !sub.dropped.Load() {
		t.Fatal("expected the slow subscriber to be flagged as dropped")
	}
	if got := len(sub.ch); got != eventSubBuffer {
		t.Fatalf("buffer = %d, want %d", got, eventSubBuffer)
	}
}

// Unsubscribing really unregisters (no goroutine/connection leak) and closes
// the channel, which is what ends the SSE writer loop.
func TestEventHubUnsubscribe(t *testing.T) {
	h := newEventHub()
	id, sub := h.subscribe(0)
	if h.subscriberCount() != 1 {
		t.Fatalf("subscriberCount = %d, want 1", h.subscriberCount())
	}
	h.unsubscribe(id)
	if h.subscriberCount() != 0 {
		t.Fatalf("subscriberCount = %d, want 0", h.subscriberCount())
	}
	if _, open := <-sub.ch; open {
		t.Fatal("expected the channel to be closed")
	}
	h.unsubscribe(id) // idempotent
}
