package main

import (
	"encoding/json"
	"testing"
)

// A published event reaches a subscriber of the same PR, a PR-less subscriber,
// and nobody else — the whole filtering contract of the hub.
func TestEventHubScopesByPR(t *testing.T) {
	h := newEventHub()
	_, all := h.subscribe("")
	_, mine := h.subscribe(statusKey("", 7))
	_, other := h.subscribe(statusKey("", 8))

	h.publish(eventChatMessage, "", 7, "conv-1", nil)

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
	_, sub := h.subscribe("")
	p := chatProgress{Running: true, Phase: chatPhaseWriting, Partial: "hal"}
	h.publish(eventChatProgress, "", 1, "conv", p)
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
	_, sub := h.subscribe("")
	for i := 0; i < eventSubBuffer+10; i++ {
		h.publish(eventChatMessage, "", 1, "conv", nil) // would deadlock if it blocked
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
	id, sub := h.subscribe("")
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

// publishBlocksChanged emits a PR-scoped, payload-less "refetch me" frame on
// the process-wide hub — the nudge an already-open review tree needs after an
// ingest refresh swapped its blocks (see .claude/docs/server-events.md).
func TestPublishBlocksChangedIsPRScopedAndEmpty(t *testing.T) {
	id1, sub := events.subscribe("13255")
	defer events.unsubscribe(id1)
	id2, other := events.subscribe("13263")
	defer events.unsubscribe(id2)

	publishBlocksChanged("", 13255)

	select {
	case ev := <-sub.ch:
		if ev.Type != eventBlocksChanged {
			t.Fatalf("expected type %q, got %q", eventBlocksChanged, ev.Type)
		}
		if ev.PR != 13255 {
			t.Fatalf("expected pr 13255, got %d", ev.PR)
		}
		if ev.Key != "" {
			t.Fatalf("expected no key (PR-wide), got %q", ev.Key)
		}
		if len(ev.Data) != 0 {
			t.Fatalf("expected no payload — the event is never the truth — got %s", ev.Data)
		}
	default:
		t.Fatal("expected a blocks.changed event")
	}
	select {
	case ev := <-other.ch:
		t.Fatalf("a tab on another PR got %+v", ev)
	default:
	}
}
