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
	// eventPendingPushChanged says a PR's not-yet-pushed landed chat edits
	// changed: something landed, a push started, succeeded or failed (no Key —
	// PR-wide). No payload, same rule as the two above: the client refetches
	// GET /api/pending-push, which reads git itself, so a dropped event costs a
	// refetch and never correctness (see .claude/docs/server-events.md).
	eventPendingPushChanged = "pendingpush.changed"
	// eventCheckoutChanged says a PR's shared local checkout state changed:
	// a directory got assigned/freed, a decision needs answering (or got
	// answered), or a stash was restored (no Key — PR-wide, no payload).
	// Fired both by the checkout-menu Activities (checkoutRelist/
	// checkoutAnswer/checkoutOff/checkoutRestoreStash, workflows.go) AND by an
	// ordinary chat turn resolving/advancing the assignment on its own
	// (chat_workflow.go), so the chip/badge stay live either way. Same rule
	// as every other "…changed" event: the client refetches
	// GET /api/chat/checkout, so a dropped frame costs a refetch, never
	// correctness.
	eventCheckoutChanged = "checkout.changed"
	// eventBlocksChanged says a PR's blocks table was swapped: new commits were
	// pulled in by the ingest refresh, or a full (re-)ingest ran (no Key —
	// PR-wide, no payload). Without this, an already-open review tree keeps
	// showing whatever /api/blocks returned at page load: home.mjs calls
	// loadBlocks() exactly once and there is no poll, so a push by a COLLEAGUE
	// (the motivating case, PR 13255) stayed invisible until a manual reload
	// while the server had long since re-ingested it.
	//
	// Unlike the events above, the client does NOT refetch on its own: it shows
	// a notice the reviewer clicks, because reloading the tree mid-review would
	// swap blocks out from under an active cursor. See .claude/docs/server-events.md.
	eventBlocksChanged = "blocks.changed"
	// eventPRMetaChanged says a PR's prmeta read-model changed (no Key —
	// PR-wide, no payload): the pr_status tracker re-derived what changed since
	// the reviewer's OWN last review (stages 3+4, re-run on a RefreshSince
	// signal). Needed because pollPRMeta (src/home.mjs) stops polling as soon
	// as the statuses stage landed, while that block's Haiku explanation
	// arrives seconds later. Same rule as every "…changed" event: the client
	// refetches GET /api/pr, so a dropped frame costs a refetch, never
	// correctness.
	eventPRMetaChanged = "prmeta.changed"
	// eventCommentBatchProgress carries a volatile commentBatchProgress snapshot
	// of a running comment_batch run (no Key — the payload is PR-wide and carries
	// its own per-comment items). Unlike every "…changed" event above there is no
	// read model to refetch: a batch run's per-comment state exists ONLY in this
	// volatile snapshot (comment_batch_progress.go), which is why the payload
	// travels along and GET /api/comment-batch is its resync read.
	eventCommentBatchProgress = "commentbatch.progress"
	// eventTestRunProgress carries a volatile testRunProgress snapshot of a
	// running test_run run (no Key — PR-wide, carries its own per-test items),
	// the exact same shape/reasoning as eventCommentBatchProgress above: a test
	// run's per-test state exists ONLY in this volatile snapshot
	// (test_run_progress.go), and GET /api/test-run is its resync read.
	eventTestRunProgress = "testrun.progress"
	// eventResync is emitted by the connection itself after it had to drop an
	// event: "you may have missed something, refetch everything you track".
	eventResync = "resync"
)

// publishCallResolveChanged/publishTestCoversChanged are the two callresolve/
// testcovers publishers, mirroring publishChatChanged (chat_progress.go): a
// volatile "refetch me" nudge, never the new rows themselves.
func publishCallResolveChanged(repo string, pr int) {
	events.publish(eventCallResolveChanged, repo, pr, "", nil)
}
func publishTestCoversChanged(repo string, pr int) {
	events.publish(eventTestCoversChanged, repo, pr, "", nil)
}

// publishPendingPushChanged nudges every tab watching this PR to refetch
// GET /api/pending-push (the todo row at the bottom of the block index and the
// PR-overview's own "ongepusht" pill).
func publishPendingPushChanged(repo string, pr int) {
	events.publish(eventPendingPushChanged, repo, pr, "", nil)
}

// publishCheckoutChanged nudges every tab watching this PR to refetch
// GET /api/chat/checkout (the chip in prInfoCard and the PR-overview badge).
func publishCheckoutChanged(repo string, pr int) {
	events.publish(eventCheckoutChanged, repo, pr, "", nil)
}

// publishBlocksChanged nudges every tab watching this PR that its blocks were
// swapped (an ingest refresh pulled in new commits, or a full re-ingest ran).
// Same rule as every other event: it carries nothing and is never the truth —
// GET /api/blocks stays the read, so a dropped frame costs at most one notice.
func publishBlocksChanged(repo string, pr int) { events.publish(eventBlocksChanged, repo, pr, "", nil) }

// publishPRMetaChanged nudges every tab watching this PR to refetch
// GET /api/pr (the PR-info column, incl. the "Sinds jouw laatste review"
// block). Carries nothing — the read model stays the only truth.
func publishPRMetaChanged(repo string, pr int) { events.publish(eventPRMetaChanged, repo, pr, "", nil) }

// busEvent is one multiplexed message. Data is pre-marshalled at publish time
// so the hub never holds a live pointer into a caller's struct (which the
// caller would then keep mutating while several connections read it).
type busEvent struct {
	Type string `json:"type"`
	// Repo is the canonical repo string of the PR this event is about ("" = the
	// primary repo, omitted from the JSON — so a primary-repo frame is
	// byte-identical to what a single-repo build sent).
	Repo string          `json:"repo,omitempty"`
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
	// scope is the PR this connection watches, as a statusKey ("13000",
	// "owner/name#12"); "" = every PR (and every PR-less event).
	scope   string
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
func (h *eventHub) subscribe(scope string) (int, *eventSub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	sub := &eventSub{scope: scope, ch: make(chan busEvent, eventSubBuffer)}
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
func (h *eventHub) publish(typ string, repo string, pr int, key string, data any) {
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
	ev := busEvent{Type: typ, Repo: repo, PR: pr, Key: key, Seq: h.seq, Data: raw}
	scope := ""
	if pr != 0 {
		scope = statusKey(repo, pr)
	}
	for _, sub := range h.subs {
		if sub.scope != "" && scope != "" && sub.scope != scope {
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
