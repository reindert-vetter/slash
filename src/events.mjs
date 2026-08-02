// events.mjs — ONE server-sent-events connection per browser tab, over which
// every subject the server pushes is multiplexed (see eventbus.go and
// .claude/docs/server-events.md). A shared pure utility like urlState.mjs /
// theme.mjs: no reactive() state of its own, no component imports, so any
// module can subscribe without dragging in another's machinery.
//
// Native `EventSource` — no dependency, no build step, and the browser handles
// reconnecting by itself, which is exactly why this beat both a polling loop
// and a hand-rolled streaming reader.
//
// TWO RULES, both load-bearing (the server side states the same pair):
//
//  1. AN EVENT IS NEVER THE SOURCE OF TRUTH. A handler treats an event as
//     "something changed, go read the read model", never as the new state
//     itself — except for a deliberately volatile payload (a half-finished
//     Claude turn) that has no read model to be authoritative about anyway.
//  2. ALWAYS RESYNC ON (RE)CONNECT. Register an onEventsResync handler that
//     refetches whatever you track; it fires on the first open, on every
//     browser reconnect, and when the server tells us it had to drop events
//     for this connection. Without it, a dropped connection silently freezes
//     your view.
//
// Dispatch is on the event's own `type` FIELD, not the SSE `event:` name: a
// named SSE event only reaches listeners registered with addEventListener for
// that exact name, so anything subscribing after the stream opened would miss
// it. One unnamed stream + client-side fan-out keeps subscription order
// irrelevant.

let source = null
let currentPr = null
const handlers = new Map() // type -> Set(handler)
const resyncHandlers = new Set()

// ensureEvents opens the tab's single connection (idempotent). Called with the
// PR currently in view; EventSource cannot renegotiate its query after
// connecting, so a different PR simply replaces the connection.
export function ensureEvents(pr) {
  if (typeof EventSource === 'undefined') return
  if (source && currentPr === pr) return
  if (source) {
    source.close()
    source = null
  }
  currentPr = pr
  const url = '/api/events' + (pr ? '?pr=' + encodeURIComponent(pr) : '')
  source = new EventSource(url)
  source.onmessage = (e) => {
    let ev = null
    try {
      ev = JSON.parse(e.data)
    } catch (_) {
      return
    }
    if (!ev || !ev.type) return
    if (ev.type === 'resync') {
      runResync()
      return
    }
    const set = handlers.get(ev.type)
    if (set) for (const fn of set) fn(ev)
  }
  // Fires on the first open AND on every automatic reconnect — the one moment
  // a consumer must refetch, since anything published while we were away is
  // gone for good (the server keeps no backlog, by design).
  source.onopen = () => runResync()
  // No onerror handling on purpose: EventSource retries by itself (the server
  // sends its own `retry:` hint), and a transient failure is invisible to the
  // reviewer because every consumer resyncs on the next open.
}

function runResync() {
  for (const fn of resyncHandlers) fn()
}

// onEvent subscribes to one event type. Returns an unsubscribe function; most
// call sites subscribe once for the page's lifetime and ignore it.
export function onEvent(type, fn) {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(fn)
  return () => set.delete(fn)
}

// onEventsResync registers a "refetch everything you track" handler — see rule
// 2 above.
export function onEventsResync(fn) {
  resyncHandlers.add(fn)
  return () => resyncHandlers.delete(fn)
}
