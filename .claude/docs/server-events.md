# Server-sent events: one push channel per browser tab

`GET /api/events?pr=N` is a **single, multiplexed SSE stream per browser tab**
(`eventbus.go` + `tasks_api.go`'s `handleEvents` on the server,
`src/events.mjs` on the client) over which every subject the server wants to
push travels. Native `EventSource` — no dependency, no build step, and the
browser reconnects by itself.

Two features are on it today: the embedded Claude chat (see
`.claude/docs/claude-chat-panel.md`) and callresolve/testcovers (see
"Migrating a poller onto this channel" below), plus two plain nudges
(`pendingpush.changed`, `blocks.changed`); the channel is generic from day one
so the remaining pollers can move over one at a time.

## The two rules that make this safe

Both sides state them, and neither is optional.

1. **An event is never the source of truth.** A frame says "something changed"
   — the handler then re-reads the ordinary read-only `GET`. The only payload
   carried inline is *deliberately volatile* state that has no read model to be
   authoritative about (a half-finished Claude turn). This is exactly why the
   whole channel sits **outside the write boundary**: it publishes nothing
   durable, touches no module/read-model/workflow history, and is empty again
   after a restart — the same carve-out as the heartbeat map and
   `ingest_progress.go`, see `.claude/rules/workflows-write-boundary.md`.
2. **Always resync on (re)connect.** Every consumer registers an
   `onEventsResync` handler that refetches what it tracks. It fires on the first
   open, on every browser reconnect, **and** when the server reports it had to
   drop frames for that connection. The server keeps **no backlog** by design,
   so without this a dropped connection silently freezes a view.

A consequence worth stating: a missed event costs at most one refetch, never a
wrong screen. That is what lets the server drop frames freely under pressure.

## Server side (`eventbus.go`)

- One process-wide `eventHub` (a package-level `var`, like
  `ingestProgressByPR` — operational plumbing reached from both HTTP handlers
  and Activity bodies, no durable state to own).
- `publish(type, pr, key, data)` marshals `data` **at publish time**, so the
  hub never holds a live pointer into a struct the caller keeps mutating.
- **A slow subscriber never blocks a publisher.** The send is non-blocking; a
  full buffer (`eventSubBuffer`, 64) drops the frame and flags the subscriber,
  and its connection then writes one `resync` frame instead. Publishers run
  inside Activities (a Claude turn streaming tokens) and must never be held up
  by a tab that stopped reading.
- `?pr=` narrows a connection to one PR (plus PR-less events). Finer filtering
  ("which conversation") is client-side on the event's `key`. `EventSource`
  cannot renegotiate after connecting, so a scope change is simply a reconnect
  — which keeps the handler free of any subscription protocol of its own.
- Keep-alive: a `: ping` comment every `sseKeepAlive` (20s), plus a
  `retry: 3000` hint on connect.

### `chat.progress`/`chat.message` are consumed for EVERY conversation of the PR

Both chat handlers (`ensureChatEvents`, `RelatedPanel.mjs`) used to drop any
frame whose `key` was not the conversation the panel happened to show. They no
longer do: a reviewer can have a turn running on code they navigated away from
(see "Parallel conversations" in `.claude/docs/claude-chat-panel.md`), and that
turn's progress is exactly what the index pill of its own code reports. The
"never trust a pushed body" rule is untouched — a `chat.message` still only ever
makes the conversation **in view** refetch `GET /api/chat`; for any other one it
just flags "an answer landed here".

Its resync read grew a second, PR-wide form for the same reason:
`GET /api/chat/progress?pr=N` returns every running turn of that PR, keyed by
conversation id (`runningChatProgressForPR`), so a tab that reconnects mid-turn
rebuilds its whole per-conversation picture instead of only the conversation it
has anchored. Both resync reads yield to a newer pushed event per conversation —
a reconnecting stream resyncs every few hundred ms, so without that they would
keep wiping the frames they are catching up on.

### `commentbatch.progress` — the one event whose payload has no read model at all

Like `chat.progress` it carries a volatile snapshot rather than a "go refetch"
nudge (`comment_batch_progress.go`, `GET /api/comment-batch?pr=N` is its resync
read). It goes one step further than the others, though, and that is deliberate:
a `comment_batch` run leaves **no** durable per-comment trace — it only edits
code, never replies to or resolves a thread — so this snapshot is the only place
"Claude is working on this comment / has handled it" ever exists. Which is why
the server keeps it after the run finished and a restart simply loses it (the
comments are then plain open comments again). Consumers: `src/commentBatch.mjs`
(one shared reactive snapshot for the index pill and the comment's log line).

### The type travels in the payload, not in the SSE `event:` field

Load-bearing, not a style choice: a **named** SSE event only reaches a listener
registered with `addEventListener` for that exact name, so any consumer
subscribing *after* the stream opened would silently miss everything. One
unnamed stream (`data: {json}`) plus client-side fan-out on `type` makes
subscription order irrelevant — and adding a new subject a pure server-side
change. `tests/events_api_test.go` asserts no `event:` line is ever written.

## Client side (`src/events.mjs`)

A shared pure utility like `urlState.mjs`/`theme.mjs` (no `reactive()` state, no
component imports): `ensureEvents(pr)` opens the tab's one connection
(idempotent; a different `pr` replaces it), `onEvent(type, fn)` subscribes,
`onEventsResync(fn)` registers the rule-2 refetch. There is deliberately **no
`onerror` handling** — `EventSource` retries on its own and every consumer
resyncs on the next open, so a transient failure is invisible.

**One connection per tab is also a budget decision**: over HTTP/1.1 a browser
allows ~6 concurrent connections per origin, and a stream holds one of them for
as long as the page lives. One shared, multiplexed stream leaves five for
ordinary fetches; a stream per feature would not.

**Consequence for the test suite:** an always-open stream is, to a browser
automation tool, a request that never finishes — so Playwright's
`networkidle` can never fire on a page that holds one, and `/pr/<id>` holds one
for its whole life. That is why no spec may wait on `networkidle`; they use
`appReady(page)` instead. See "Spec-writing rules" in
`.claude/docs/testing-playwright.md`, and expect the same to apply to
`/pr-overview`/`/inbox` as soon as their pollers migrate here.

"Per tab" is literal here because `/pr/<id>`, `/pr-overview` and `/inbox` are
separate documents (no SPA routing), so one loaded page = one connection.

## Migrating a poller onto this channel (not done in one sweep)

Chat and callresolve/testcovers moved so far, on purpose. The pattern for the
rest (`ingest_progress`, the workflow poll, the comment poll, the inbox poll)
is always the same two steps, and each can be done independently:

1. Server: call `events.publish(...)` at the place that already changes the
   thing (the Activity that writes the read model, the in-memory stage setter).
2. Client: replace the `setInterval` with `onEvent(...)` → refetch, plus an
   `onEventsResync(...)` doing the same refetch, and keep the existing `GET` as
   the resync read.

Do **not** push the changed data itself in the frame while migrating — that
would break rule 1 and turn a cheap channel into a second, competing read
model.

### callresolve/testcovers (`callresolve.changed`/`testcovers.changed`)

Unlike chat, this wasn't replacing an existing poller — before this, the
callresolve/testcovers read-models were fetched **once** at `loadBlocks()` and
otherwise only refreshed lazily, per selected block (`startCallSearch`/its
test-covers counterpart, `src/home.mjs`), gated behind the reviewer actually
navigating onto the caller/test whose search was still running. That is a
problem specifically right after "Genereer review-boom" redirects into
`/pr/<id>` (`src/overview.mjs`'s `generatePage`): `resolve_call`'s/
`resolve_test_covers`' LLM search starts **fire-and-forget** (its own
goroutine, `autoStartResolveCall`, see `.claude/docs/workflows-analysis.md`)
well after `POST /api/ingest` already returned, so a reviewer who stays on the
page can hit what looks like "the end of the tree" within a couple of
keystrokes, while a fresh tab opened a bit later fetches the by-then-resolved
read model and gets further — the tree simply hadn't finished growing yet, and
nothing told the tab that was already open.

- **Server** (`eventbus.go`'s `publishCallResolveChanged`/
  `publishTestCoversChanged`, called from `workflows.go`): after
  `buildRelations`'s own `UpsertGo`/`Prune` for calls/covers (covers the first
  ingest AND a later `rebuild`/delta refresh), and after `saveResolutions`/
  `saveTestCoverResolutions` (the LLM search's own result — the exact moment
  described above). PR-wide, no `key` — there is no finer per-connection scope
  than the `pr` the SSE connection already carries.
- **Client** (`src/home.mjs`, next to the initial `loadBlocks()` kick-off):
  `ensureEvents(state.pr)` once per page load (this file has no SPA routing,
  so — unlike `RelatedPanel.mjs`'s `ensureChatEvents`, callable again per
  opened comment thread — no "already bound" dedupe guard is needed), then
  `onEvent('callresolve.changed', …)`/`onEvent('testcovers.changed', …)` each
  just call the existing `loadCallResolve()`/`loadTestCovers()` (which already
  call `recomputeLeftList()` themselves, so no extra plumbing), plus the same
  pair in `onEventsResync(...)`.

### pending push (`pendingpush.changed`)

- **Server** (`eventbus.go`'s `publishPendingPushChanged`): after a chat edit
  lands on the PR's pending ref (`processChatMergeAt`) and on every transition
  of a push attempt (`pushPendingPR`: started, succeeded, failed). PR-wide, no
  `key`, no payload.
- **Client** (`src/home.mjs`): `onEvent('pendingpush.changed', …)` and the same
  call in `onEventsResync(...)` both just refetch `GET /api/pending-push`, which
  reads git itself — so a dropped frame costs a refetch and never correctness.
  It feeds the todo row at the bottom of the index and the per-block "ongepusht"
  marking at once. See `.claude/docs/pending-push.md`.

### PR metadata (`prmeta.changed`)

- **Server** (`eventbus.go`'s `publishPRMetaChanged`, called from
  `workflows.go`'s `generateSinceReviewSummary`): after that Activity re-derived
  the "Sinds jouw laatste review" block — a fresh facts+summary pair, or a clear
  that had something to clear. PR-wide, no `key`, no payload.
- **Client** (`src/home.mjs`): `onEvent('prmeta.changed', …)` calls
  `fetchPRMetaOnce()`, one refetch of `GET /api/pr`.
- **Why it exists:** `pollPRMeta` stops as soon as the review/checks stage
  landed, while the block's Haiku explanation arrives seconds later — and the
  refresh itself is triggered per page load by `refreshSinceReview` (see
  "Stages 3+4 also re-run on demand" in `.claude/docs/workflows-trackers.md`),
  i.e. well after that poll gave up. Ordinary "refetch me" contract, so a
  dropped frame costs one stale column until the next reload.

### new commits in the tree (`blocks.changed`) — the one event that does NOT refetch

- **Server** (`eventbus.go`'s `publishBlocksChanged`, called from
  `workflows.go`): after the `scanAndStoreBlocks` Activity (a full ingest or
  re-ingest) and after a **non-`Skipped`** `refreshIngestDelta`. A `Skipped`
  refresh wrote nothing, so publishing there would put a "new commits" notice on
  screen with nothing behind it. PR-wide, no `key`, no payload.
- **Client** (`src/home.mjs`): the handler sets **`state.blocksStale = true`**
  and nothing else. `BlockList.mjs`'s `staleTreeRow` then renders a notice at the
  very top of the index (`data-testid=blocks-stale`, "Nieuwe commits in deze PR —
  herlaad de boom"), and **clicking it reloads the page**.

**Why this one breaks the "refetch on the event" pattern**, deliberately:

- `loadBlocks()` runs **exactly once**, at page load, and there is no poll. That
  is the whole bug this closes: on PR 13255 a colleague's commit was re-ingested
  by `pr_status` within 41 seconds and the open tab kept showing the tree from
  before it, with nothing on screen saying so.
- But an **automatic** refetch would swap blocks under an active cursor: the
  selection moves, the loaded diff of the block being read is dropped, and a
  half-finished approve pass resets. So the reviewer picks the moment. Explicit
  product decision, pinned by `tests/blocks-stale-notice.spec.mjs`'s second
  test — an auto-refreshing variant fails it.
- **A reload, not an in-place refetch.** That is the neat option here precisely
  *because* of the URL-state mechanism (see "URL state" in `CLAUDE.md`):
  `?sel=`/`?drill=`/`?gran=` already encode the navigation position, so a reload
  returns to the same block against a guaranteed-consistent tree — instead of
  threading a second "load the data but don't navigate" mode through
  `loadBlocks`'s first-open treatment (`showDescription`,
  `applyDefaultUnapprovedSelection`, the `?drill=` restore).
- **Deliberately NOT in `onEventsResync`**, unlike every other subject here. A
  resync means "you may have missed a frame", which is not evidence that
  anything changed — flagging the tree stale there would raise the notice after
  any ordinary reconnect (a laptop waking up, a server restart). A genuinely
  missed `blocks.changed` costs at most one stale tree until the next refresh,
  which is exactly the risk that existed before this event.
- `state.blocksStale` is never cleared: the reload is the only way back to a
  fresh tree, and a reloaded tab is by definition no longer stale.

Per the colour-blind rule the ↻ glyph and the words carry the meaning; the amber
tint is decoration.

Test: `tests/callresolve-live-update.spec.mjs` — mocks `/api/callresolve` to
hide a real, permanently-seeded row (PR 91) and holds the one `/api/events`
connection open until the test itself lets go, so the frame can only arrive
after a "still nothing yet" assertion has already settled.

## Tests

`eventbus_test.go` (scoping, payload snapshotting, drop-instead-of-block,
unsubscribe), `events_api_test.go` (headers, frame shape, PR scoping, cleanup
after the client goes away, the resync-after-drop frame). Frontend behaviour is
covered where it is used — `tests/claude-chat-progress.spec.mjs` fulfils
`/api/events` with hand-written frames, `tests/callresolve-live-update.spec.mjs`
the same for `callresolve.changed`.
