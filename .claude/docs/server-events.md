# Server-sent events: one push channel per browser tab

`GET /api/events?pr=N` is a **single, multiplexed SSE stream per browser tab**
(`eventbus.go` + `tasks_api.go`'s `handleEvents` on the server,
`src/events.mjs` on the client) over which every subject the server wants to
push travels. Native `EventSource` — no dependency, no build step, and the
browser reconnects by itself.

Two features are on it today: the embedded Claude chat (see
`.claude/docs/claude-chat-panel.md`) and callresolve/testcovers (see
"Migrating a poller onto this channel" below); the channel is generic from day
one so the remaining pollers can move over one at a time.

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
