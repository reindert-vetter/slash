// eventbus.go — the process-wide, in-memory push channel behind
// GET /api/events (the browser's native EventSource; see
// .claude/docs/server-events.md). One tab holds one SSE connection, over
// which EVERY subject is multiplexed; a subscriber tells the subjects apart by
// the event's own Type field.
//
// Two rules make this safe, and both are load-bearing:
//
//  1. AN EVENT IS NEVER THE SOURCE OF TRUTH. It only says "something changed"
//     or carries a deliberately volatile snapshot (a half-finished Claude
//     turn). Every consumer re-reads the ordinary read-only GET when it
//     (re)connects, so a dropped/missed event costs at most a refetch and can
//     never desynchronise the UI from the read model. That is exactly what
//     keeps this outside the write boundary: it publishes nothing durable, it
//     touches no module/read-model/workflow history, and it is empty again
//     after a restart — the same carve-out as the heartbeat map and
//     ingest_progress.go (see .claude/rules/workflows-write-boundary.md).
//
//  2. A SLOW SUBSCRIBER NEVER BLOCKS A PUBLISHER. publish does a non-blocking
//     send; a full buffer drops the event and flags the subscriber, and the
//     connection's own writer then sends one eventResync frame instead, which
//     tells that tab to refetch. Publishers run inside Activities (a Claude
//     turn streaming tokens), and an Activity must never be held up by a tab
//     that stopped reading.
package main

import (
	"encoding/json"
	"sync"
	"sync/atomic"
)

// Event types. The type travels in the PAYLOAD rather than in the SSE
// `event:` field on purpose: a named SSE event only reaches a listener
// registered with addEventListener for that exact name, so a handler
// registered after the stream opened would silently miss everything. With one
// unnamed stream every frame lands on EventSource.onmessage and src/events.mjs
// fans out on this field — which is also what makes adding a new subject a
// pure server-side change.
const (
	// eventChatProgress carries a volatile chatProgress snapshot of a running
	// Claude turn (Key = the conversation/comment id).
	eventChatProgress = "chat.progress"
	// eventChatMessage says the transcript of a conversation changed (Key = the
	// conversation/comment id). Deliberately carries NO message payload — the
	// client refetches GET /api/chat, so the read model stays the only truth.
	eventChatMessage = "chat.message"
	// eventCallResolveChanged/eventTestCoversChanged say the callresolve/
	// testcovers read-model changed for this PR (no Key — PR-wide, there is no
	// finer per-connection scope than the pr the SSE connection already carries).
	// Deliberately no payload either: the client refetches GET /api/callresolve/
	// GET /api/testcovers, same as eventChatMessage. These exist because
	// resolve_call's/resolve_test_covers' LLM search runs fire-and-forget AFTER
	// POST /api/ingest already returned (see autoStartResolveCall,
	// .claude/docs/workflows-analysis.md) — without a push, a reviewer who
	// stayed on the page never sees a child that resolves a few seconds later,
	// while a fresh tab opened afterwards fetches the already-resolved read
	// model and sees more. See .claude/docs/server-events.md.
	eventCallResolveChanged = "callresolve.changed"
	eventTestCoversChanged  = "testcovers.changed"
	// eventResync is emitted by the connection itself after it had to drop an
	// event: "you may have missed something, refetch everything you track".
	eventResync = "resync"
)

// publishCallResolveChanged/publishTestCoversChanged are the two callresolve/
// testcovers publishers, mirroring publishChatChanged (chat_progress.go): a
// volatile "refetch me" nudge, never the new rows themselves.
func publishCallResolveChanged(pr int) { events.publish(eventCallResolveChanged, pr, "", nil) }
func publishTestCoversChanged(pr int)  { events.publish(eventTestCoversChanged, pr, "", nil) }

// busEvent is one multiplexed message. Data is pre-marshalled at publish time
// so the hub never holds a live pointer into a caller's struct (which the
// caller would then keep mutating while several connections read it).
type busEvent struct {
	Type string          `json:"type"`
	PR   int             `json:"pr,omitempty"`
	Key  string          `json:"key,omitempty"`
	Seq  uint64          `json:"seq"`
	Data json.RawMessage `json:"data,omitempty"`
}

// eventSubBuffer is how many events may queue up for one connection before it
// is told to resync instead. Generous enough for a burst of token deltas,
// small enough that a dead tab can't hold much memory.
const eventSubBuffer = 64

type eventSub struct {
	pr      int // 0 = every PR (and every PR-less event)
	ch      chan busEvent
	dropped atomic.Bool
}

type eventHub struct {
	mu   sync.Mutex
	seq  uint64
	next int
	subs map[int]*eventSub
}

func newEventHub() *eventHub { return &eventHub{subs: map[int]*eventSub{}} }

// events is the one hub of this process. A package-level var rather than a
// TaskManager field, mirroring ingest_progress.go: it is operational plumbing
// with no durable state, and both HTTP handlers and Activity bodies reach it.
var events = newEventHub()

// subscribe registers a connection interested in pr (0 = everything) and
// returns its id (for unsubscribe) plus its receive channel.
func (h *eventHub) subscribe(pr int) (int, *eventSub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	sub := &eventSub{pr: pr, ch: make(chan busEvent, eventSubBuffer)}
	h.subs[h.next] = sub
	return h.next, sub
}

// unsubscribe drops a connection. Closing the channel here (rather than from
// the publisher) is safe because publish only ever sends while holding the
// same lock this takes.
func (h *eventHub) unsubscribe(id int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if sub, ok := h.subs[id]; ok {
		delete(h.subs, id)
		close(sub.ch)
	}
}

// publish fans one event out to every matching subscriber. Never blocks: a
// subscriber whose buffer is full is flagged instead (see the file header).
// A marshalling failure drops the event silently — this is cosmetic plumbing,
// never a reason to fail the work that produced it.
func (h *eventHub) publish(typ string, pr int, key string, data any) {
	var raw json.RawMessage
	if data != nil {
		b, err := json.Marshal(data)
		if err != nil {
			return
		}
		raw = b
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	ev := busEvent{Type: typ, PR: pr, Key: key, Seq: h.seq, Data: raw}
	for _, sub := range h.subs {
		if sub.pr != 0 && pr != 0 && sub.pr != pr {
			continue
		}
		select {
		case sub.ch <- ev:
		default:
			sub.dropped.Store(true)
		}
	}
}

// subscriberCount is used by tests (and nothing else) to assert that a closed
// connection really unregistered itself.
func (h *eventHub) subscriberCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
