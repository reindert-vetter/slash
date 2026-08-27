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
// ingest refresh swapped its blocks (see .claude/docs/server-events.md) — when
// nothing was passed for landedFiles (a colleague's push, or a full re-ingest).
func TestPublishBlocksChangedIsPRScopedAndEmpty(t *testing.T) {
	id1, sub := events.subscribe("13255")
	defer events.unsubscribe(id1)
	id2, other := events.subscribe("13263")
	defer events.unsubscribe(id2)

	publishBlocksChanged("", 13255, nil)

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

// A landedFiles list travels in the event's own payload (blocksChangedPayload)
// — the race-free "was this refresh MY OWN just-landed edit" signal home.mjs's
// blocks.changed handler reads directly, instead of correlating against a
// separately-fetched, race-prone read model. Still just a routing hint: the
// event carries no other block data, so a consumer must still refetch
// GET /api/blocks for real (see .claude/docs/pending-push.md, "Wordt
// bijgewerkt").
func TestPublishBlocksChangedCarriesLandedFiles(t *testing.T) {
	id, sub := events.subscribe("13270")
	defer events.unsubscribe(id)

	publishBlocksChanged("", 13270, []string{"app/Actions/FooAction.php"})

	select {
	case ev := <-sub.ch:
		var payload blocksChangedPayload
		if err := json.Unmarshal(ev.Data, &payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if len(payload.LandedFiles) != 1 || payload.LandedFiles[0] != "app/Actions/FooAction.php" {
			t.Fatalf("landedFiles = %v, want the one landed file", payload.LandedFiles)
		}
	default:
		t.Fatal("expected a blocks.changed event")
	}
}

// A dropped event does more than flag the subscriber: it WAKES the connection
// (so its writer can send the resync frame without waiting for the next real
// event or the 20s keepalive tick) and it is counted, so a drop is never
// silent. See eventbus.go's file header.
func TestEventHubWakesAndCountsOnDrop(t *testing.T) {
	h := newEventHub()
	_, sub := h.subscribe("")
	for i := 0; i < eventSubBuffer; i++ {
		h.publish(eventChatMessage, "", 1, "conv", nil)
	}
	if h.dropCount() != 0 {
		t.Fatalf("dropCount = %d before the buffer was full, want 0", h.dropCount())
	}
	select {
	case <-sub.wake:
		t.Fatal("woken without a drop")
	default:
	}

	h.publish(eventChatMessage, "", 1, "conv", nil) // one too many
	if !sub.dropped.Load() {
		t.Fatal("expected the subscriber to be flagged as dropped")
	}
	if got := h.dropCount(); got != 1 {
		t.Fatalf("dropCount = %d, want 1", got)
	}
	select {
	case <-sub.wake:
	default:
		t.Fatal("expected the connection to be woken so it can resync now")
	}

	// A second drop while the first tap is still pending must not block the
	// publisher (an Activity is never held up by a tab that stopped reading).
	h.publish(eventChatMessage, "", 1, "conv", nil)
	h.publish(eventChatMessage, "", 1, "conv", nil)
	if got := h.dropCount(); got != 3 {
		t.Fatalf("dropCount = %d, want 3", got)
	}
}
