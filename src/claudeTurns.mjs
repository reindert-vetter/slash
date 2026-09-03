// claudeTurns.mjs — one shared, reactive picture of EVERY Claude chat turn this
// tab knows about, keyed by conversation id (which IS the comment id, see
// chat_workflow.go's chatConversationRunID).
//
// Why it exists: a reviewer may send a message, navigate to other code, and
// start a second conversation there while the first is still being answered
// (reviewer request, see "Parallel conversations" in
// .claude/docs/claude-chat-panel.md). The chat panel itself only ever shows
// ONE conversation — the one belonging to the selected code — so anything that
// is "in flight" cannot live in that panel's single-slot state: a second send
// would queue behind the first one's turn, and the first one's progress/answer
// would be dropped on the floor the moment the panel re-anchored.
//
// So the per-turn bookkeeping lives here instead, and two very different
// render spots read the same snapshot without knowing about each other:
//
//   - the chat panel (RelatedPanel.mjs/ClaudeChat.mjs) for the conversation it
//     currently shows: is it busy, what is Claude doing, what is queued,
//   - the left index row of the code the conversation hangs on (BlockList.mjs'
//     claudeChatPill) for EVERY conversation: "Claude bezig" while a turn runs
//     elsewhere, "Claude antwoordde" once an answer landed on code the
//     reviewer is not looking at.
//
// A shared pure-ish utility module like commentBatch.mjs/theme.mjs: it owns one
// reactive object plus its own read-only fetch, and imports no component (which
// is also what keeps BlockList.mjs from having to import RelatedPanel.mjs back).
//
// Deliberately NOT a read model: a running turn's progress is volatile by
// construction (chat_progress.go keeps it in memory only), and "the reviewer
// has not seen this answer yet" is a property of this tab, not of the server.
// The durable truth is the saved transcript, refetched over GET /api/chat.
import { reactive } from './vendor/arrow.js'
import { repoParam } from './prContext.mjs'

// byId holds one entry per conversation this tab has seen anything happen on:
//   progress  — the volatile snapshot pushed over SSE (chat.progress), or null
//   busy      — a Signal POST for this conversation is in flight right now
//   answered  — a turn finished on a conversation that was NOT in view, so the
//               reviewer still has to go look at it (cleared when they do)
//   sendError — the reviewer-facing sentence for that conversation's LAST
//               rejected/failed Signal POST, '' whenever the last send was
//               accepted. Per-conversation for the same reason as `busy`: a
//               reviewer sends on conversation A, walks to B before the
//               rejection arrives — that sentence belongs to A and must still
//               be there when they walk back, not get attached to whichever
//               conversation happens to be on screen when the response lands.
//               See "Parallel conversations" in .claude/docs/claude-chat-panel.md.
// scopes maps a conversation id onto the `file|label` of the code its comment
// hangs on, so the index pill can find "the conversations of this block"
// without importing the comment list itself.
//
// Both are plain objects that are only ever REASSIGNED, never mutated — that
// is what re-runs the bindings reading them (see .claude/rules/arrowjs-pitfalls.md).
//
// A THIRD, non-reactive Map (finishedAt, below — mirrors progressAt's own
// shape) tracks when a conversation's turn most recently stopped
// running/being busy, purely so isTurnRecentlyFinished can mark a just-
// finished chat "Klaar" for 2 minutes instead of letting it read as still
// running the instant it's done. Deliberately a per-tab heuristic, not a
// read model: the server keeps no history of when a turn finished (only
// "is one running right now", chat_progress.go), so a conversation that
// finished while this tab was closed/refreshed never gets a "recently
// finished" window after the fact — only one this tab actually observed
// finishing live.
const turns = reactive({ byId: {}, scopes: {} })

const EMPTY = { progress: null, busy: false, answered: false, sendError: '' }

function entryOf(id) {
  return (id != null && turns.byId[id]) || EMPTY
}

// finishedAt — a non-reactive Map (next to progressAt below), stamped the
// moment a conversation goes from "running/busy" to "not any more". Powers
// isTurnRecentlyFinished' 2-minute window (see its own doc comment):
// reviewer request — a finished task should be clearly marked as done for
// long enough to actually notice, rather than reading as still "bezig".
// Plain
// (not reactive) like progressAt: nothing reads it directly for rendering,
// only through isTurnRecentlyFinished, which compares it against Date.now()
// at read time.
const finishedAt = new Map()
const FINISHED_LINGER_MS = 2 * 60 * 1000

// markFinishedIfJustStopped stamps finishedAt(id) the moment `wasActive`
// (the running/busy state just before this write) flips to `!isActiveNow` —
// called from both setTurnProgress and setTurnBusy, the two writers of
// "is this conversation doing something right now". Clears any stale stamp
// the instant the conversation becomes active again (a fresh turn on the
// same conversation must not inherit an old "klaar" mark).
function markFinishedIfJustStopped(id, wasActive, isActiveNow) {
  if (isActiveNow) finishedAt.delete(id)
  else if (wasActive) finishedAt.set(id, Date.now())
}

function patch(id, fields) {
  if (id == null) return
  const next = { ...turns.byId }
  const merged = { ...entryOf(id), ...fields }
  // Forget an entry that has nothing left to say, so this map stays the size
  // of "what is happening now" instead of growing per conversation visited.
  // finishedAt is intentionally NOT part of this condition — deleting the
  // byId entry must not also drop the 2-minute "recently finished" memory,
  // see isTurnRecentlyFinished below.
  if (!merged.progress && !merged.busy && !merged.answered && !merged.sendError) delete next[id]
  else next[id] = merged
  turns.byId = next
}

// setTurnBusy marks the Signal round-trip of ONE conversation. The panel's own
// composer gate reads this per conversation, so a message typed on another
// selection is sent straight away instead of queueing behind this turn.
export function setTurnBusy(id, on) {
  if (id != null) {
    const wasActive = !!(entryOf(id).busy || (entryOf(id).progress && entryOf(id).progress.running))
    markFinishedIfJustStopped(id, wasActive, !!on)
  }
  patch(id, { busy: !!on })
}

export function isTurnBusy(id) {
  return !!entryOf(id).busy
}

// setTurnSendError/turnSendError hold ONE conversation's own "last send
// failed" sentence — see the `sendError` field doc above. Set right before a
// Signal POST (cleared) and again once the response is known (a sentence, or
// '' on success), always keyed by the conversation the send was actually FOR
// (sendClaudeMessage's own `commentId`, not whatever `cc.commentId` happens to
// be by the time the response arrives).
export function setTurnSendError(id, text) {
  patch(id, { sendError: text || '' })
}

export function turnSendError(id) {
  return entryOf(id).sendError
}

// progressAt records WHEN we last learned something about each conversation's
// live turn — a plain, non-reactive Map next to the reactive store, so a resync
// read can tell whether a pushed event overtook it (see loadRunningTurns and
// loadChatProgress in RelatedPanel.mjs). setTurnProgress is the single writer
// of both, which is what keeps those two in step.
const progressAt = new Map()

// setTurnProgress stores the volatile snapshot of one conversation's running
// turn (null clears it). Accepts a snapshot for ANY conversation, not just the
// one on screen — that is the whole point.
export function setTurnProgress(id, p) {
  if (id == null) return
  progressAt.set(id, Date.now())
  const wasActive = !!(entryOf(id).busy || (entryOf(id).progress && entryOf(id).progress.running))
  const isActiveNow = !!(entryOf(id).busy || (p && p.running))
  markFinishedIfJustStopped(id, wasActive, isActiveNow)
  patch(id, { progress: p || null })
}

export function lastTurnProgressAt(id) {
  return progressAt.get(id) || 0
}

export function turnProgress(id) {
  return entryOf(id).progress
}

// anyTurnRunning powers the 1s "Claude denkt… 12s" heartbeat: it must keep
// ticking while a turn runs, including one the panel is not showing.
export function anyTurnRunning() {
  for (const id in turns.byId) {
    const p = turns.byId[id].progress
    if (p && p.running) return true
  }
  return false
}

// markTurnAnswered/clearTurnAnswered — "a turn finished on code you are not
// looking at". Set by the SSE handler for a conversation that is not the one
// in view, cleared the moment it becomes the one in view.
export function markTurnAnswered(id) {
  patch(id, { answered: true })
}

export function clearTurnAnswered(id) {
  patch(id, { answered: false })
}

// setTurnScopes refreshes the id → `file|label` map from the comment list
// (RelatedPanel.mjs owns that list; this module only needs the anchor). One
// reassignment per comment load, same cadence as the comment poll.
export function setTurnScopes(pairs) {
  const next = {}
  for (const [id, scope] of pairs) next[id] = scope
  turns.scopes = next
}

// claudeTurnFor answers "does this index row have a Claude turn to report" for
// a block row: an ordinary code row matches through the `file|label` of the
// comments hanging on it, a comment-index row matches its own comment id
// directly. Returns 'busy' (a turn is running right now), 'answered' (a turn
// finished while the reviewer was elsewhere) or '' — busy wins, since it is
// the newer fact of the two.
export function claudeTurnFor(b) {
  if (!b) return ''
  const ownId = b.kind === 'comment' && b.comment ? b.comment.id : null
  const scope = b.file != null && b.label != null ? b.file + '|' + b.label : null
  let answered = false
  for (const id in turns.byId) {
    if (ownId != null ? id !== ownId : turns.scopes[id] !== scope) continue
    const e = turns.byId[id]
    if (e.busy || (e.progress && e.progress.running)) return 'busy'
    if (e.answered) answered = true
  }
  return answered ? 'answered' : ''
}

// runningTurnIds — every conversation id with a turn RUNNING right now
// (a Signal POST in flight, or a live `progress.running` snapshot),
// excluding `excludeId` (the conversation already shown by name elsewhere,
// e.g. the panel's own "Selected: …" line) — one of the sources of the
// "andere chats in deze PR" nested nav stop (see claude-chat-panel.md).
// Deliberately
// NOT `answered`: that is "finished while you were elsewhere", reported via
// the index pill instead, not "busy right now" — see claudeTurnFor above.
// Sorted by id so the list (and thus the keyboard cursor walking it) has a
// stable order across renders, independent of object-key insertion order.
export function runningTurnIds(excludeId) {
  const ex = excludeId == null ? null : String(excludeId)
  return Object.keys(turns.byId)
    .filter((id) => id !== ex && (turns.byId[id].busy || (turns.byId[id].progress && turns.byId[id].progress.running)))
    .sort((a, b) => Number(a) - Number(b))
}

// anyRecentlyFinishedTurn — true while at least one conversation is still
// inside its 2-minute "just finished" window. Lets syncChatTicker (
// RelatedPanel.mjs) keep its 1s heartbeat running long enough for a lingering
// "Andere chats in deze PR" row to actually expire on screen, not just on the next
// unrelated re-render.
export function anyRecentlyFinishedTurn() {
  const now = Date.now()
  for (const at of finishedAt.values()) {
    if (now - at < FINISHED_LINGER_MS) return true
  }
  return false
}

// isTurnRecentlyFinished — id finished (see markFinishedIfJustStopped) less
// than FINISHED_LINGER_MS ago and isn't busy/running again since. Read by
// chatStateOf/claudeTaskRow (RelatedPanel.mjs) for the per-row "Klaar" word,
// and by anyRecentlyFinishedTurn for the 1s ticker.
export function isTurnRecentlyFinished(id) {
  const at = finishedAt.get(id)
  if (!at) return false
  if (runningTurnIds(null).includes(String(id))) return false
  if (Date.now() - at >= FINISHED_LINGER_MS) {
    // Garbage-collect the stamp as we walk past it, so an expired one never
    // lingers in memory forever once nothing reads it any more. This used to
    // happen inside recentlyFinishedTurnIds, which was the list's inclusion
    // rule until the list became "every chat of this PR" (see
    // otherClaudeChats in RelatedPanel.mjs) and disappeared with it.
    finishedAt.delete(id)
    return false
  }
  return true
}

// recentlyFinishedTurnIds — every OTHER conversation whose turn finished
// inside the FINISHED_LINGER_MS window (isTurnRecentlyFinished, which also
// garbage-collects an expired stamp as it walks past it). This is NOT the
// inclusion rule of the "Andere chats in deze PR" list any more (that list is
// every conversation of the PR, see otherClaudeChats in RelatedPanel.mjs) —
// it exists because that list resolves its ids through cc.conversations,
// which is only refreshed on the comment poll's own cadence: a chat that just
// finished would otherwise pop into the list up to a poll later, long after
// the reviewer's eyes (and the ↓/↑ cursor) already went looking for it.
export function recentlyFinishedTurnIds(excludeId) {
  const ex = excludeId == null ? null : String(excludeId)
  return Object.keys(turns.byId)
    .concat([...finishedAt.keys()].map(String))
    .filter((id, i, all) => all.indexOf(id) === i && id !== ex && isTurnRecentlyFinished(id))
    .sort((a, b) => String(a).localeCompare(String(b)))
}

// loadRunningTurns is the PR-wide RESYNC read (GET /api/chat/progress?pr=N):
// every turn the server has running right now, for every conversation of this
// PR. The per-conversation read only covers the conversation in view, so
// without this a refresh (or an SSE reconnect) mid-turn would silently drop
// the index pill of a turn running on other code. Read-only, in-memory
// server-side, so it is never a source of truth — see server-events.md.
export async function loadRunningTurns(pr) {
  if (pr == null) return
  const startedAt = Date.now()
  try {
    const res = await fetch('/api/chat/progress?pr=' + encodeURIComponent(pr) + repoParam())
    if (!res.ok) return
    const json = await res.json()
    // A `running: false` (the per-conversation shape, or a mocked/absent map)
    // is simply "nothing to report".
    const running = (json.running && typeof json.running === 'object' && json.running) || {}
    // A pushed event that landed WHILE this request was in flight is newer than
    // what the response describes, so it must win — a resync runs right next to
    // the events it is catching up on, and without this it would wipe a fresher
    // snapshot (and, with a reconnecting stream, keep wiping it).
    const stale = (id) => lastTurnProgressAt(id) > startedAt
    // Drop a snapshot the server no longer reports as running: that turn ended
    // while we were disconnected.
    for (const id in turns.byId) {
      if (turns.byId[id].progress && !running[id] && !stale(id)) setTurnProgress(id, null)
    }
    for (const id in running) {
      if (!stale(id)) setTurnProgress(id, running[id])
    }
  } catch (_) {
    // keep whatever we had — a dropped read costs one stale pill at most
  }
}
