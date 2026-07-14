// RelatedPanel — the column to the right of the selected block. Two stacked
// cards: on top the underlying code the block calls into — its child blocks
// from the relations read-model (GET /api/relations), passed down by home.mjs —
// below the live **comments** on lines of code (wired to the task_code_comment
// workflow).

import { html } from './vendor/arrow.js'
import { reactive } from './vendor/arrow.js'
import { highlight } from './Block.mjs'
import { bindUrlState, num } from './urlState.mjs'

// ── Real comments (task_code_comment workflow) ────────────────────────────────
// This section IS wired to the API. Placing a comment starts a Workflow
// Execution (POST /api/workflows/task_code_comment); a reaction sends a Signal
// (POST /api/workflows/{runId}/signals/reply). Everything else here is read-only
// (GET /api/comments?pr=N). Per the write-boundary rule, the UI only ever writes
// by starting or signalling a workflow — never straight to a store.
// focus/threadPos drive the keyboard navigation of this right-hand panel (see
// home.mjs → onKeydown). focus is which region owns the arrows: null (the diff/
// list has the keyboard), 'code' (the related-code block, light-blue border), 'new'
// (the "+ Comment op deze regel" button), 'comment' (a comment row in the index,
// cs.sel), or 'thread' (inside the selected comment's thread). threadPos indexes
// the thread bottom-up: 0 = the reply field (typing), 1..n = the n-th message
// from the bottom (1 = newest), so ↑ walks to older messages and ↓ back down.
// A thread's messages are the comment's own body (its opening message) followed
// by its reactions — see threadMessages.
// `scope` is the current selection context (from home.mjs, pushed via
// setCommentScope): { file, label, mode, gran, rowStart, rowEnd, seg } or null.
// It lives on cs — RelatedPanel's own reactive — on purpose: the index render
// reads cs and reliably re-renders on cs changes, whereas reading home.mjs'
// `state` across the module boundary from inside this list binding did not
// retrigger it. home.mjs bridges state→cs.scope with an arrow.js watch.
// codeSel indexes the selected underlying-code child while cs.focus === 'code':
// → walks it forward through the child list, ↓ leaves it for the comments column.
const cs = reactive({ pr: null, list: [], view: [], sel: 0, composing: false, busy: false, focus: null, threadPos: 0, scope: null, scopeSig: '', codeSel: 0 })

// The panel cursor survives a browser refresh: focus/codeSel/sel/threadPos live in
// the URL under their own `rel` namespace, alongside the main navigation (sel/mode/
// chg/gran) that home.mjs binds. The composer/busy/list/view/scope are transient or
// loaded data and stay out. focus === null (diff owns the keyboard) is the default,
// so the params only appear once you actually step into the panel.
bindUrlState(
  cs,
  [
    { key: 'focus', param: 'foc', default: null },
    { key: 'codeSel', param: 'code', parse: num(0), default: 0 },
    { key: 'sel', param: 'csel', parse: num(0), default: 0 },
    { key: 'threadPos', param: 'thr', parse: num(0), default: 0 },
  ],
  { ns: 'rel' },
)

// restorePending captures what the URL restored into cs *before* the async data
// pushes (setRelated / loadComments) can clobber it — those clamp codeSel/sel back
// to 0 and drop a dangling focus while the children/comments are still loading,
// which would immediately mirror the params out of the URL again. We re-apply this
// snapshot once the data settles (applyRelRestore), then clear it so it never
// hijacks later navigation. Null when the URL carried no rel.* param — nothing to
// restore, and the mirror-watch is then free to keep the URL canonical.
let restorePending =
  cs.focus !== null || cs.codeSel !== 0 || cs.sel !== 0 || cs.threadPos !== 0
    ? { focus: cs.focus, codeSel: cs.codeSel, sel: cs.sel, threadPos: cs.threadPos }
    : null

// ── Underlying code, pushed from home.mjs ─────────────────────────────────────
// The underlying-code card follows the cursor: which child blocks / resolved
// calls to show depends on the current navigation unit, which lives in home.mjs'
// `state`. Rather than read that reactive `state` (and the selected block's
// lazily-loaded `b.code`) from inside this panel's render binding — which races
// with home.mjs' own diff render over `b.code` and can leave the diff stuck on
// "loading" — home.mjs computes the list in a `watch` and pushes it here via
// setRelated (the same decoupling the comment index uses with setCommentScope).
// `rc` is this module's own reactive so the render reliably re-runs on a push.
const rc = reactive({ children: [], unresolved: [] })

// setRelated receives the freshly-scoped underlying-code children + the
// unresolved-call list from home.mjs (via a watch on the navigation state) and
// stores them on rc. Always reassigns (never mutates in place) so arrow.js
// re-renders the keyed card list.
export function setRelated(children, unresolved) {
  rc.children = Array.isArray(children) ? children : []
  rc.unresolved = Array.isArray(unresolved) ? unresolved : []
  // A block switch (or a shrinking list) must not leave the child cursor on a
  // stale index; snap it back to the first block.
  if (cs.codeSel >= rc.children.length) cs.codeSel = 0
  // Children just arrived — a pending refresh-restore that wanted the code card
  // (or a codeSel) can now land. One-shot; see applyRelRestore.
  applyRelRestore()
}

// ── Index scoping (filter by the selected navigation unit) ────────────────────
// The index shows only the comments *under* what's selected in the diff: a whole
// group's comments include its lines' and calls'; a line's include its calls'; a
// call's are only that call. It's always scoped to the selected block (a group/
// line/call is a block-internal notion), so in list mode the block's whole set
// shows.

// setCommentScope receives the live selection context from home.mjs (via a watch
// on the navigation state) and stores it on cs, so the index re-filters as the
// reviewer moves. Skips a redundant write (same signature) so an unrelated
// reactive tick doesn't needlessly re-render the list.
export function setCommentScope(scope) {
  const sig = scope
    ? [scope.file, scope.label, scope.mode, scope.gran, scope.rowStart, scope.rowEnd, scope.seg].join('|')
    : ''
  if (sig === cs.scopeSig) return
  cs.scopeSig = sig
  cs.scope = scope
  recomputeView()
}

// commentUnder reports whether comment c sits at or below the selected unit t in
// the same block: c's aligned-row range ⊆ t's range and — when t is a single
// 'call' segment — the same call (gran + seg). A comment with an unknown anchor
// (rowStart < 0: legacy/seeded) is always shown within its block.
function commentUnder(c, t) {
  if (c.rowStart == null || c.rowStart < 0) return true
  if (c.rowStart < t.rowStart || c.rowEnd > t.rowEnd) return false
  if (t.gran === 'call') return c.gran === 'call' && c.seg === t.seg
  return true
}

// recomputeView derives the visible list from cs.list + cs.scope and reassigns
// cs.view. Reassigning a reactive *array* property is the pattern that reliably
// re-renders arrow.js keyed lists (cs.list itself works that way) — computing the
// filter lazily inside the render binding did not re-run it when only cs.scope
// changed (e.g. navigating between blocks). Called whenever the list or the scope
// changes (loadComments / setCommentScope).
function recomputeView() {
  const s = cs.scope
  if (!s) {
    cs.view = cs.list
    return
  }
  const inBlock = cs.list.filter((c) => c.file === s.file && c.label === s.label)
  cs.view = s.mode !== 'diff' || s.rowStart < 0 ? inBlock : inBlock.filter((c) => commentUnder(c, s))
}

// visibleComments is the current filtered index — the scoped/​narrowed comments
// under the selection (see recomputeView). Bindings read cs.view (reactive), so
// they re-render whenever the list or scope changes.
function visibleComments() {
  void cs.list // subscribe the binding to cs.list — its reassignment is what
  // reliably patches the keyed list (see setCommentScope); cs.view holds the
  // actual filtered result.
  return cs.view
}

// selI clamps cs.sel onto the visible list (cs.sel indexes the *visible* list),
// so a shrinking filter never leaves the selection dangling past the end.
function selI() {
  const n = visibleComments().length
  return n ? Math.min(cs.sel, n - 1) : 0
}

// selComment is the currently-selected comment within the visible list.
function selComment() {
  return visibleComments()[selI()]
}

// commentRowSet returns the aligned-diff rows of block b that carry a comment, so
// Block can mark them with a 💬 (presence only — the count doesn't matter). Reads
// cs.list, so it re-runs as comments load. Comments with an unknown anchor
// (rowStart < 0) sit on no row, so they're skipped here (they still show in the
// index). Exported for home.mjs → Block(commentedRows).
export function commentRowSet(b) {
  const set = new Set()
  if (!b) return set
  for (const c of cs.list) {
    if (c.file !== b.file || c.label !== b.label) continue
    if (c.rowStart == null || c.rowStart < 0) continue
    for (let i = c.rowStart; i <= c.rowEnd; i++) set.add(i)
  }
  return set
}

// ── Keyboard focus in the right-hand panel ────────────────────────────────────
// home.mjs owns the single keydown listener and, once the reviewer steps into
// this panel (→ from the diff), routes the arrows here via handleRelatedKey. The
// focus state is navigation position, not durable state: it is mirrored to the URL
// (rel.foc, so a refresh restores where the cursor sat — see bindUrlState above),
// but never written to a store, so the write-boundary rule is unaffected.

// relatedActive reports whether this panel currently owns the keyboard.
export function relatedActive() {
  return cs.focus !== null
}

// isCodeFocused reports whether the keyboard is on the Onderliggende-code block
// (so home.mjs can wire Enter there to the LLM call-search).
export function isCodeFocused() {
  return cs.focus === 'code'
}

// focusedRelatedChild returns the underlying-code child the keyboard is
// currently on (cs.focus === 'code', indexed by cs.codeSel), or null. home.mjs
// reads this on Enter to know which child to drill into (see drillIntoChild).
export function focusedRelatedChild() {
  return cs.focus === 'code' ? rc.children[cs.codeSel] || null : null
}

// enterRelated hands the keyboard to the panel, starting on the first
// underlying-code child. Called by home.mjs on → from the diff.
export function enterRelated() {
  cs.composing = false
  cs.focus = 'code'
  cs.codeSel = 0
  scrollCodeIntoView()
}

// exitRelated releases the keyboard back to the diff and drops any input focus /
// half-typed new comment. Exported as leaveRelated for home.mjs: drillIntoChild
// calls it to hand a freshly-drilled column's keyboard to its own diff instead
// of landing on its Onderliggende-code panel (see the "Drillen" flow).
function exitRelated() {
  cs.focus = null
  cs.composing = false
  const el = document.activeElement
  if (el && el.blur) el.blur()
}
export { exitRelated as leaveRelated }

// focusEl focuses a right-pane input a frame later (once the reactive re-render
// has swapped in the matching view: the new-comment composer or the reply field).
function focusEl(sel) {
  requestAnimationFrame(() => {
    const el = document.querySelector(sel)
    if (el) el.focus()
  })
}

// toCode / toNew / toComment land on a left-column item. Landing already opens the
// right pane and drops the caret in it — the reviewer types straight away, no →
// needed: 'new' shows an empty new-comment composer; a comment shows its history
// with the reply field focused. 'code' has no input, so it just blurs.
function toCode() {
  cs.composing = false
  cs.focus = 'code'
  const el = document.activeElement
  if (el && el.blur) el.blur()
}

function toNew() {
  cs.composing = true
  cs.focus = 'new'
  focusEl('[data-testid=comment-compose]')
}

function toComment() {
  cs.composing = false
  cs.focus = 'comment'
  scrollCommentIntoView()
  focusEl('[data-testid=reaction-compose]')
}

// threadMessages builds the rendered thread of a comment: its own body as the
// first message (the reviewer's opening, shown as their own bubble) followed by
// every reaction. So the comment that titles the thread also reads back as its
// first chat message. The synthetic opening carries source 'ui' so it renders on
// the reviewer's side, like the composer that placed it.
function threadMessages(c) {
  if (!c) return []
  const origin = { id: 'origin:' + c.id, source: 'ui', author: c.author, body: c.body }
  return [origin, ...(c.reactions || [])]
}

// reactionCount is the number of bubbles the thread renders (opening + reactions)
// — the upper bound the keyboard walks to when stepping up through the history.
function reactionCount() {
  return threadMessages(selComment()).length
}

// scrollCommentIntoView / scrollReactionIntoView keep the active row / bubble in
// view while walking with the arrows (deferred a frame so the DOM has the new
// highlight class first), mirroring scrollSelectedIntoView in home.mjs.
function scrollCommentIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelectorAll('[data-testid=comment-item]')[selI()]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// scrollCodeIntoView keeps the selected underlying-code child in view while
// walking the card with the arrows (deferred a frame so the DOM has the active
// highlight first), mirroring scrollCommentIntoView.
function scrollCodeIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=related-item][data-active=true]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

function scrollReactionIntoView() {
  requestAnimationFrame(() => {
    // threadPos counts from the bottom (1 = newest), so the array index is
    // reactions.length - threadPos.
    const j = reactionCount() - cs.threadPos
    const el = document.querySelectorAll('[data-testid=reaction-bubble]')[j]
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// focusThread puts the caret in the reply field at the bottom of the thread
// (threadPos 0, ready to type) or, once the reviewer walks up into the history,
// blurs it and scrolls the selected older message into view.
function focusThread() {
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-testid=reaction-compose]')
    if (cs.threadPos === 0) {
      if (input) input.focus()
    } else {
      if (input && document.activeElement === input) input.blur()
      scrollReactionIntoView()
    }
  })
}

// enterThread steps into the selected comment's thread, landing on the reply
// field so the reviewer can type straight away (→ from a comment row).
function enterThread() {
  cs.composing = false
  cs.focus = 'thread'
  cs.threadPos = 0
  focusThread()
}

// applyRelRestore re-applies the URL-restored panel cursor (restorePending, set at
// module load) once the data it points at has actually loaded — children arrive via
// setRelated, comments via loadComments, and either can win the race. It gates on
// the data the *wanted* focus needs and only clears restorePending once it applies,
// so a comment focus isn't dropped because setRelated happened to fire first with
// children but no comments yet (and vice-versa). It runs at most once, so it never
// hijacks navigation the reviewer does afterwards. Indices are clamped to what
// loaded and a focus is restored via the same land helpers the arrows use — so the
// caret/scroll land exactly where a manual step would — but only when the target
// exists; otherwise the diff keeps the keyboard.
function applyRelRestore() {
  const want = restorePending
  if (!want) return
  const children = rc.children.length
  const comments = visibleComments().length
  // Wait for the data the wanted focus points at; 'new'/null need none.
  if (want.focus === 'code' && children === 0) return
  if ((want.focus === 'comment' || want.focus === 'thread') && comments === 0) return
  restorePending = null
  cs.codeSel = children ? Math.min(want.codeSel, children - 1) : 0
  cs.sel = comments ? Math.min(want.sel, comments - 1) : 0
  if (want.focus === 'code') {
    cs.focus = 'code'
    scrollCodeIntoView()
  } else if (want.focus === 'new') {
    toNew()
  } else if (want.focus === 'thread') {
    cs.focus = 'thread'
    cs.threadPos = Math.min(want.threadPos, reactionCount())
    focusThread()
  } else if (want.focus === 'comment') {
    toComment()
  }
  // else (focus null): leave the diff with the keyboard, indices restored silently.
}

// The left column is one flat vertical list the arrows walk: the related-code
// card (row 0), the "+ Comment op deze regel" button (row 1), then one row per
// comment (row 2 + i). Modelling it as a single cursor — instead of per-region
// special cases — is what keeps ↑/↓ deterministic: the same key always moves one
// row, whatever path you took to get there.
function rowCount() {
  return 2 + visibleComments().length
}

// currentRow maps the live focus/selection back to that flat index.
function currentRow() {
  if (cs.focus === 'code') return 0
  if (cs.focus === 'new') return 1
  return 2 + selI()
}

// gotoRow lands on row `n` (clamped into range) via the matching landing action,
// so the right pane and input focus follow the cursor. Rows ≥ 2 are comments.
function gotoRow(n) {
  n = Math.max(0, Math.min(n, rowCount() - 1))
  if (n === 0) toCode()
  else if (n === 1) toNew()
  else {
    cs.sel = n - 2
    toComment()
  }
}

// handleRelatedKey drives the panel for one arrow/Escape press and returns 'exit'
// when focus leaves the panel back to the diff (else true). The left column is a
// flat row walk (gotoRow); the thread is the one region where ↑/↓ mean something
// else — they walk the message history — and ← steps back out to the comment row.
export function handleRelatedKey(key) {
  if (key === 'Escape') {
    exitRelated()
    return 'exit'
  }
  if (cs.focus === 'thread') {
    if (key === 'ArrowUp') {
      cs.threadPos = Math.min(cs.threadPos + 1, reactionCount())
      focusThread()
    } else if (key === 'ArrowDown') {
      cs.threadPos = Math.max(cs.threadPos - 1, 0)
      focusThread()
    } else if (key === 'ArrowLeft') {
      toComment()
    }
    return true
  }
  if (cs.focus === 'code') {
    // The code card is a flat vertical list of underlying-code children. ↓/↑ walk
    // it (↑ from the first child exits to the diff); → jumps to the comments
    // column; ← always returns to the diff.
    const n = rc.children.length
    if (key === 'ArrowDown') {
      if (cs.codeSel < n - 1) {
        cs.codeSel += 1
        scrollCodeIntoView()
      }
    } else if (key === 'ArrowUp') {
      if (cs.codeSel === 0) {
        exitRelated()
        return 'exit'
      }
      cs.codeSel -= 1
      scrollCodeIntoView()
    } else if (key === 'ArrowRight') {
      gotoRow(1)
    } else if (key === 'ArrowLeft') {
      exitRelated()
      return 'exit'
    }
    return true
  }
  if (key === 'ArrowDown') gotoRow(currentRow() + 1)
  else if (key === 'ArrowUp') gotoRow(currentRow() - 1)
  else if (key === 'ArrowLeft') {
    exitRelated()
    return 'exit'
  } else if (key === 'ArrowRight' && cs.focus === 'comment' && selComment()) {
    // → steps into the thread so ↑ walks the old messages instead of the index.
    enterThread()
  }
  return true
}

// startComment opens the "new comment on this line" composer — the command menu
// (home.mjs) calls it so the reviewer can start a comment task from `/`. It only
// flips the local composing flag; placing the comment still goes through the
// workflow (placeComment), so the write-boundary is unchanged.
export function startComment() {
  cs.composing = true
}

// isComposeOpen reports whether the new-comment composer is currently open, so
// home.mjs's keydown handler can catch Enter on a filled composer and open the
// comment-kind menu (Claude / Git / private / Jira) instead of placing directly.
export function isComposeOpen() {
  return cs.composing
}

// composeHasText reports whether the composer textarea holds non-whitespace text
// — the gate for opening the comment-kind menu (an empty composer + Enter does
// nothing). Reads the DOM (home.mjs has no access to the textarea otherwise).
export function composeHasText() {
  const el = document.querySelector('[data-testid=comment-compose]')
  return !!el && el.value.trim() !== ''
}

// isCommentFocused reports whether a placed comment's row currently owns the
// keyboard (landed on via ↑/↓ or a click, reply field focused but not yet
// stepped into the thread). home.mjs uses this to decide whether Enter should
// open the delete menu instead of falling through to the reply field.
export function isCommentFocused() {
  return cs.focus === 'comment' && selComment() != null
}

// commentReplyEmpty reports whether the focused comment's reply field is
// empty. Landing on a comment row already focuses that field (see toComment),
// so Enter must only open the delete menu when there's nothing typed to send
// — otherwise it would hijack the "type a quick reply, hit Enter" flow.
export function commentReplyEmpty() {
  const el = document.querySelector('[data-testid=reaction-compose]')
  return !el || el.value.trim() === ''
}

// commentSelIndex is the index of the focused comment row, for anchoring the
// delete menu under the right element (home.mjs has no access to cs directly).
export function commentSelIndex() {
  return selI()
}

// deleteFocusedComment sends the "delete" signal for the focused comment's
// Workflow Execution. This is the only write path: the workflow first flips
// the comment's status to "deleting", then removes it from GitHub and from
// the read-model — the UI just asks and reloads once it's done.
export async function deleteFocusedComment() {
  const c = selComment()
  if (!c || !c.runId) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer' }),
    })
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

async function loadComments(pr) {
  if (pr == null) return
  try {
    const res = await fetch('/api/comments?pr=' + encodeURIComponent(pr))
    if (res.ok) {
      cs.list = await res.json()
      recomputeView()
      // A delete (or a shrinking list generally) can leave cs.sel pointing past
      // the end, or the focused/threaded row can vanish entirely — clamp back
      // onto the list and drop out of a now-dangling focus/thread.
      if (cs.sel >= cs.list.length) cs.sel = Math.max(0, cs.list.length - 1)
      if ((cs.focus === 'comment' || cs.focus === 'thread') && cs.list.length === 0) {
        cs.focus = 'new'
        cs.threadPos = 0
      }
      // Comments just arrived — a pending refresh-restore that wanted a comment/
      // thread (or a sel) can now land. One-shot; see applyRelRestore.
      applyRelRestore()
    }
  } catch (_) {
    // keep the last good list on a transient error
  }
}

// Activity tracking: a tab being *visible* is not the same as the reviewer being
// *active* — a tab left open in the foreground while the reviewer walked away
// would otherwise keep heartbeating forever. We only beat on genuine engagement:
// visible + focused + input within ACTIVITY_WINDOW. No input for that long ⇒ we
// stop beating, and the server backs off to its slow cadence.
const ACTIVITY_WINDOW = 120000 // 2 min without input ⇒ treat the reviewer as away
let lastActivity = 0
if (typeof window !== 'undefined') {
  const mark = () => {
    lastActivity = Date.now()
  }
  ;['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'focus'].forEach((ev) =>
    window.addEventListener(ev, mark, { passive: true })
  )
}

function tabActive() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false
  return Date.now() - lastActivity < ACTIVITY_WINDOW
}

// beat tells the server the reviewer is actively viewing the selected open
// thread, so its GitHub poller keeps its fast cadence (server backs off to a
// 10-min cadence without a heartbeat within the last 10 min). It only fires while
// the tab is genuinely active (see tabActive) and writes no state.
function beat() {
  if (!tabActive()) return
  const c = selComment()
  if (!c || !c.runId || c.status !== 'open') return
  fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/heartbeat', { method: 'POST' }).catch(() => {})
}

// syncComments refetches when the PR changes and starts a slow refresh so
// GitHub-polled reactions (server-side) surface in the UI, plus a heartbeat so
// the server keeps fast-polling the thread you are looking at.
let refreshTimer = null
let heartbeatTimer = null
function syncComments(pr) {
  if (cs.pr !== pr) {
    cs.pr = pr
    cs.sel = 0
    loadComments(pr)
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => cs.pr != null && loadComments(cs.pr), 5000)
  }
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(beat, 60000)
  }
}

// createComment starts a comment task (Workflow Execution) on the given line with
// `body`. Shared by the composer (placeComment) and the command menu's fallback
// ("Maak hiermee een comment", which uses the typed text as the comment). It writes
// only by starting the workflow (POST), so the write-boundary holds. On success it
// reloads the read-model and selects the fresh comment.
export async function createComment({ pr, file, line, body, code, gran, label, rowStart, rowEnd, seg, local }) {
  if (pr == null || !file || !body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/task_code_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr,
        file,
        line,
        author: 'reviewer',
        body,
        code,
        gran,
        label,
        rowStart: rowStart == null ? -1 : rowStart,
        rowEnd: rowEnd == null ? -1 : rowEnd,
        seg: seg || '',
        // A private note ("alleen voor mijzelf"): stored but never posted to
        // GitHub (the workflow skips postGithubComment). Default false, so the
        // existing composer/fallback paths are unchanged.
        local: !!local,
      }),
    })
    await loadComments(pr)
    // The fresh comment sits on the unit we just placed it on, so it's the last
    // entry of the (order-preserving) visible list — land the selection there.
    cs.sel = Math.max(0, visibleComments().length - 1)
  } finally {
    cs.busy = false
  }
}

// placeComment submits the composer's text as a comment on the current unit.
// Exported so the comment-kind menu (home.mjs COMPOSE_COMMANDS) can place a
// private note via opts.local; the composer button routes through the menu too.
export async function placeComment(state, commentTarget, opts = {}) {
  const b = state && state.blocks && state.blocks[state.selected]
  const el = document.querySelector('[data-testid=comment-compose]')
  const body = el && el.value.trim()
  if (!b || !body) return
  // Capture the exact unit the composer is previewing so the placed comment's
  // thread can show the same code (see composeTargetHint / the thread hint).
  const t = (commentTarget && commentTarget()) || null
  await createComment({
    pr: state.pr,
    file: b.file,
    line: b.line,
    body,
    code: t ? t.code : '',
    gran: t ? t.gran : '',
    label: t ? t.label : '',
    rowStart: t ? t.rowStart : -1,
    rowEnd: t ? t.rowEnd : -1,
    seg: t ? t.seg : '',
    local: !!opts.local,
  })
  el.value = ''
  cs.composing = false
}

// GRAN_LABEL — how each navigation granularity is described in the composer's
// "linked to" hint (see composeTargetHint), coarsest to finest.
const GRAN_LABEL = {
  group: 'een groep wijzigingen',
  line: 'deze regel',
  call: 'deze aanroep',
}

// composeTargetHint renders what the in-progress comment is linked to: the
// granularity (group/line/call) plus the block's class::method and a code
// example of the exact unit — so the reviewer sees the link *while* typing,
// before the comment is placed. `target` is the `commentTarget()` result passed
// down from home.mjs (null until a block is selected).
function composeTargetHint(target) {
  if (!target) return ''
  return html`
    <div
      class="rounded-lg border border-indigo-100 bg-indigo-50/60 px-2.5 py-2 text-[11px]"
      data-testid="comment-target"
    >
      <div class="flex items-center gap-1.5 text-indigo-600">
        <span class="font-medium">${() => GRAN_LABEL[target.gran] || target.gran}</span>
        <span class="text-indigo-300">·</span>
        <span class="truncate font-mono font-semibold">${() => target.label}</span>
      </div>
      ${() =>
        target.code
          ? html`<code
              class="language-php mt-1 block max-h-16 overflow-auto whitespace-pre rounded bg-white/70 px-2 py-1 font-mono text-[11px] leading-relaxed text-slate-700"
              .innerHTML="${() => highlight(target.code)}"
            ></code>`
          : ''}
    </div>
  `
}

async function sendReaction(done) {
  const c = selComment()
  if (!c) return
  const el = document.querySelector('[data-testid=reaction-compose]')
  const body = (el && el.value.trim()) || (done ? '/resolve' : '')
  if (!body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, done }),
    })
    if (el) el.value = ''
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

const CSTATUS_DOT = { open: 'bg-amber-400', resolved: 'bg-emerald-500' }

// commentRow — one placed comment (a Workflow Execution) in the left list.
function commentRow(c, i) {
  return html`
    <button
      class="${() =>
        'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition ' +
        (selI() === i && cs.focus === 'comment'
          ? 'bg-indigo-50 ring-1 ring-indigo-200'
          : selI() === i && (cs.focus === 'thread' || cs.focus === 'comment')
          ? // still the comment whose thread is open in the chat on the right,
            // just not the row the keyboard is on right now: a lighter border
            // keeps it marked without competing with an actively-focused row.
            'bg-indigo-50/40 ring-1 ring-indigo-100'
          : 'hover:bg-slate-50')}"
      data-testid="comment-item"
      @click="${() => {
        cs.sel = i
        toComment()
        beat()
      }}"
    >
      <span class="${() => 'mt-1 h-2 w-2 shrink-0 rounded-full ' + (CSTATUS_DOT[c.status] || 'bg-slate-300')}"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-xs font-medium text-slate-800">${() => c.body}</span>
        <span class="truncate text-[11px] leading-snug text-slate-500" data-testid="comment-meta"
          >${() => c.file + ':' + c.line + ' · ' + c.reactionCount + ' reacties · ' + c.status}</span
        >
      </span>
    </button>
  `
}

// reactionBubble — one message in the thread. `i`/`total` let it light up when it
// is the one the reviewer walked up to (cs.threadPos counts from the bottom).
function reactionBubble(r, i, total) {
  const mine = r.source === 'ui'
  return html`
    <div class="${() => 'flex ' + (mine ? 'justify-end' : 'justify-start')}">
      <div
        class="${() => {
          const sel = cs.focus === 'thread' && cs.threadPos === total - i
          return (
            'max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed ' +
            (mine ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-700') +
            (sel ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="reaction-bubble"
      >
        ${() => r.body}
      </div>
    </div>
  `
}

// commentsSection — the wired panel: placed comments on the left, the selected
// comment's reactions + a working composer on the right, and a "+ Comment op deze
// regel" button that starts a new Execution on the current block.
function commentsSection(state, commentTarget, openCompose) {
  syncComments(state ? state.pr : null)
  const target = () => {
    const b = state && state.blocks && state.blocks[state.selected]
    return b ? b.file + ':' + b.line : 'geen regel geselecteerd'
  }
  return html`
    <section
      class="flex w-[36rem] shrink-0 max-h-[28rem] min-h-[16rem] flex-row overflow-hidden rounded-xl border border-slate-300 bg-white ring-1 ring-black/5"
      data-testid="comments-panel"
    >
      <div class="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-100">
        <div class="border-b border-slate-100 px-3 py-2.5">
          <h2 class="text-sm font-semibold text-slate-800">Comments</h2>
          <p class="text-[11px] text-slate-400">op regels code · live</p>
        </div>
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
          <button
            class="${() =>
              'flex w-full items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-left transition ' +
              (cs.focus === 'new'
                ? 'border-indigo-400 text-indigo-600 ring-1 ring-indigo-300'
                : 'border-slate-200 text-slate-400 hover:border-indigo-200 hover:text-indigo-500')}"
            data-testid="new-comment"
            @click="${() => (cs.composing = !cs.composing)}"
          >
            <span
              class="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-current text-[11px] leading-none"
              >+</span
            >
            <span class="text-xs font-medium">Comment op deze regel</span>
          </button>
          ${() => visibleComments().map((c, i) => commentRow(c, i).key('comment:' + c.id))}
          ${() =>
            visibleComments().length === 0
              ? html`<p class="px-2.5 py-3 text-[11px] text-slate-400">Nog geen comments.</p>`
              : null}
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="comment-thread">
        <div class="border-b border-slate-100 px-4 py-2.5">
          <h2 class="truncate text-sm font-semibold text-slate-800">
            ${() => (cs.composing ? 'Nieuwe comment · ' + target() : selComment() ? selComment().body : 'Comments')}
          </h2>
          <p class="text-[11px] text-slate-400">
            ${() => (cs.composing ? 'start een task op deze regel' : 'reacties hooken hier op de comment in')}
          </p>
        </div>

        ${() =>
          cs.composing
            ? html`
                <div class="flex min-h-0 flex-1 flex-col gap-2 p-3">
                  ${() => composeTargetHint(commentTarget ? commentTarget() : null)}
                  <textarea
                    class="min-h-24 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none"
                    placeholder="Je comment op deze regel…"
                    data-testid="comment-compose"
                  ></textarea>
                  <div class="flex items-center justify-end gap-2">
                    <button
                      class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
                      @click="${() => (cs.composing = false)}"
                    >
                      Annuleer
                    </button>
                    <button
                      class="${() =>
                        'rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
                        (cs.busy ? 'opacity-50' : 'hover:bg-indigo-600')}"
                      data-testid="comment-send"
                      @click="${() => (openCompose ? openCompose() : placeComment(state, commentTarget))}"
                    >
                      Plaats…
                    </button>
                  </div>
                </div>
              `
            : html`
                <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                  ${() => {
                    const c = selComment()
                    return c && c.code
                      ? composeTargetHint({ gran: c.gran, label: c.label, code: c.code })
                      : ''
                  }}
                  ${() =>
                    threadMessages(selComment()).map((r, i, arr) =>
                      reactionBubble(r, i, arr.length).key('msg:' + r.id)
                    )}
                </div>
                <div class="flex items-center gap-2 border-t border-slate-100 p-2.5">
                  <input
                    class="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300"
                    placeholder="Reageer op deze comment…"
                    data-testid="reaction-compose"
                    @keydown="${(e) => e.key === 'Enter' && sendReaction(false)}"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
                    data-testid="reaction-send"
                    @click="${() => sendReaction(false)}"
                  >
                    Stuur
                  </button>
                  <button
                    class="shrink-0 rounded-lg border border-emerald-300 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-50"
                    data-testid="reaction-resolve"
                    @click="${() => sendReaction(true)}"
                  >
                    ✓
                  </button>
                </div>
              `}
      </div>
    </section>
  `
}

// ── Underlying code (real, from the relations read-model) ─────────────────────
// The children of the selected block: the blocks it is coupled to (e.g. the
// Listener::handle for an event it dispatches). They are pulled out of the left
// list and shown here, top-right of the block. Fed by home.mjs' relatedChildren
// (GET /api/relations), which lazily loads each child's code.

// KIND_LABEL names the relation on a child card. A method_call carries no label:
// it shows a +added/-removed diff-stat (diffStatBadge) instead.
const KIND_LABEL = { event_listener: 'listener' }

// diffStatBadge shows, for a called method, how many lines its definition adds /
// removes ("+A −R", green/red) instead of the old "aanroep" label. A call into an
// unchanged file has no diff (r.diff == null) → a grey "Ongewijzigd" badge.
function diffStatBadge(r) {
  if (r.kind !== 'method_call') return ''
  if (!r.diff) {
    return html`
      <span
        class="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400"
        data-testid="related-diffstat"
        title="Aangeroepen definitie is niet gewijzigd in deze PR"
        >Ongewijzigd</span
      >
    `
  }
  return html`
    <span
      class="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
      data-testid="related-diffstat"
      title="Toegevoegde / verwijderde regels in de aangeroepen definitie"
    >
      <span class="text-emerald-600">+${() => r.diff.add}</span>
      <span class="text-rose-500">&#8722;${() => r.diff.del}</span>
    </span>
  `
}

// approvalBadge shows a child block's approval progress ("done/total", green +
// ✓ once fully approved). `a` is { done, total } or null (a call into an
// unchanged file — nothing to approve). Hidden only when there's nothing to
// approve yet (total 0); the done state is always shown.
function approvalBadge(a) {
  if (!a || !a.total) return ''
  const done = a.done === a.total
  return html`
    <span
      class="${'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums ' +
      (done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}"
      data-testid="related-approval"
      title="Goedgekeurde regels"
      >${done ? '✓ ' : ''}${a.done}/${a.total}</span
    >
  `
}

// relatedCard renders one child block: a header (label + file:line + relation
// kind) and a short, non-interactive code excerpt highlighted like the panes.
function relatedCard(r, i, drill) {
  const selected = () => cs.focus === 'code' && i === cs.codeSel
  // An unchanged call target (a method_call into a file this PR doesn't touch) has
  // no diff to review, so its selection highlight is grey rather than indigo.
  const unchanged = r.kind === 'method_call' && !r.diff
  return html`
    <div
      class="${() =>
        'cursor-pointer rounded-lg border bg-slate-50/60 hover:border-indigo-200 ' +
        (selected()
          ? unchanged
            ? 'border-slate-300 ring-1 ring-slate-200'
            : 'border-indigo-300 ring-1 ring-indigo-200'
          : 'border-slate-200')}"
      data-testid="related-item"
      data-active="${() => (selected() ? 'true' : 'false')}"
      @click="${() => drill && drill(r)}"
    >
      <div class="border-b border-slate-100 px-3 py-1.5">
        <div class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-700">${r.label}</span>
          ${() =>
            KIND_LABEL[r.kind]
              ? html`<span
                  class="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-indigo-500"
                  >${KIND_LABEL[r.kind]}</span
                >`
              : ''}
          ${() =>
            r.source
              ? html`<span
                  class="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600"
                  title="Gevonden door een LLM"
                  >bron: ${r.source}</span
                >`
              : ''}
          ${() => diffStatBadge(r)}
          ${() => approvalBadge(r.approve)}
        </div>
        <span class="block truncate font-mono text-[10px] text-slate-400" title="${() => r.file + ':' + r.line}"
          >${r.file}:${r.line}</span
        >
      </div>
      ${() =>
        r.code
          ? html`<code
              class="language-php m-0 block whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700"
              .innerHTML="${() => highlight(r.code)}"
            ></code>`
          : html`<p class="px-3 py-2 text-[11px] text-slate-400">code laden…</p>`}
    </div>
  `
}

// RelatedPanel — the fixed-width right column: the selected block's underlying
// (child) code on top, live comments below. `commentTarget` (from home.mjs)
// reports what an in-progress comment would attach to at the current navigation
// granularity; passed through to the composer. The underlying-code children +
// the unresolved-call list are read from `rc`, which home.mjs keeps up to date
// via setRelated (see the note on rc above). `search.startCallSearch` launches
// the LLM search for the currently-shown unresolved calls.
export default function RelatedPanel(state, commentTarget, search, openCompose) {
  const kids = () => rc.children
  // Calls the Go resolver could not pin (status unresolved) + any in flight
  // (searching). Drives the "Zoek" button and the "zoeken…" spinner.
  const unresolved = () => rc.unresolved
  // codeApproval rolls up the approval counts of the shown children (those that
  // are PR blocks with changed rows) into one { done, total } for the header.
  const codeApproval = () => {
    let done = 0
    let total = 0
    for (const r of rc.children) {
      if (r.approve) {
        done += r.approve.done
        total += r.approve.total
      }
    }
    return { done, total }
  }
  const pending = () => unresolved().filter((r) => r.status === 'unresolved').length
  const searching = () => unresolved().some((r) => r.status === 'searching')
  const runSearch = () => search && search.startCallSearch && search.startCallSearch()
  // Clicking a child drills into it as its own diff column — the same path Enter
  // takes on a focused child (drillIntoChild in home.mjs), just mouse-driven.
  const drill = (r) => search && search.drill && search.drill(r)
  return html`
    <aside class="flex min-h-0 shrink-0 flex-row items-start gap-3" data-testid="related-panel">
      <section
        class="${() =>
          'flex w-[30rem] shrink-0 max-h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-white ring-1 ' +
          (cs.focus === 'code'
            ? 'border-indigo-300 ring-indigo-200'
            : 'border-slate-300 ring-black/5')}"
        data-testid="related-code"
      >
        <div class="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-slate-800">Onderliggende code</h2>
            <p class="text-[11px] text-slate-400" data-testid="related-approval-total">
              Code die dit blok aanroept${() => {
                const a = codeApproval()
                return a.total ? ` · ${a.done}/${a.total} goedgekeurd` : ''
              }}
            </p>
          </div>
          ${() =>
            searching()
              ? html`<span
                  class="ml-auto shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-400"
                  data-testid="related-searching"
                  >zoeken…</span
                >`
              : pending() > 0
                ? html`<button
                    type="button"
                    class="ml-auto shrink-0 rounded-md border border-dashed border-indigo-300 px-2 py-1 text-[11px] font-medium text-indigo-500 hover:bg-indigo-50"
                    data-testid="related-search"
                    @click="${runSearch}"
                    title="Zoek de niet-gevonden aanroepen met AI (Haiku, dan Sonnet)"
                  >
                    Zoek (${pending()})
                  </button>`
                : ''}
        </div>
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
          ${() => {
            // All children render as one flat vertical list, full width, in order.
            const ks = kids()
            return ks.length === 0
              ? html`<p class="px-1 py-2 text-[11px] text-slate-400">Geen onderliggende code.</p>`
              : ks.map((r, i) => relatedCard(r, i, drill).key('related:' + r.id))
          }}
        </div>
      </section>

      ${commentsSection(state, commentTarget, openCompose)}
    </aside>
  `
}
