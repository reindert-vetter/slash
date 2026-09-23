// columnWidth.mjs — per-column manual width override.
//
// Every column in <main>'s column flow (the block-diff card/drilled column in
// Block.mjs, and Underlying-code/Claude-chat/inline-comments in
// RelatedPanel.mjs) computes its own width as a pure, content-driven Tailwind
// class (widthCls/relatedColumnWidthCls/commentColumnWidthCls/
// claudeColumnWidthCls — see .claude/docs/diff-card.md). This module adds an
// OPTIONAL override on top: a reviewer can drag a column's right edge to a
// custom pixel width, remembered per block. An inline `style="width:...px"`
// always wins over the card's own `w-[...]` class (inline style beats any
// class selector regardless of specificity), so none of those existing
// width-class functions needed to change — this is a purely additive layer.
// See .claude/docs/column-resize.md for the full write-up.
//
// A pure, state-agnostic utility module — same tier as urlState.mjs/
// theme.mjs/avatar.mjs — reused by both Block.mjs (via opts, Block.mjs never
// imports `state` directly) and RelatedPanel.mjs (which already receives
// `state`).

import { html } from './vendor/arrow.js'
import { suspendCallArrows, resumeCallArrows } from './callArrows.mjs'

const COOKIE_NAME = 'slash_colw'
const MAX_AGE_S = 60 * 30 // 30 minutes — the reviewer's explicit choice: a
// width preference is a "how I like to look at this session's code" thing,
// not a multi-day setting — see column-resize.md.

function readCookieRaw() {
  const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : ''
}

// MAX_COOKIE_BYTES — a safety margin under the ~4093-byte limit browsers
// place on a single cookie's name+value. Reproduced directly (see
// column-resize.md, "Cookie-size cap"): a ~12.7KB encoded value is REJECTED
// ENTIRELY by document.cookie's write — not truncated, the whole assignment
// silently becomes a no-op, and document.cookie reads back with the cookie
// simply absent. Without a cap, a reviewer who resizes enough distinct
// columns over time (every kind/block combination is its own key) eventually
// crosses that limit, and every FUTURE resize — not just the one that tipped
// it over — quietly stops persisting, since every write re-serializes the
// whole map.
const MAX_COOKIE_BYTES = 3800

// boundedMap — drop the OLDEST entries (in the object's own insertion order)
// one at a time until the encoded map fits under MAX_COOKIE_BYTES.
// setColumnWidth (below) re-inserts an already-existing key on every write
// (delete then set), so "oldest" here really means "least recently set", a
// cheap LRU-ish approximation with no extra bookkeeping. Never mutates the
// input map — callers keep whatever they had in memory; only the PERSISTED
// cookie is bounded.
function boundedMap(map) {
  let keys = Object.keys(map)
  while (keys.length) {
    const candidate = {}
    for (const k of keys) candidate[k] = map[k]
    if (encodeURIComponent(JSON.stringify(candidate)).length <= MAX_COOKIE_BYTES) return candidate
    keys = keys.slice(1) // drop the oldest key, try again
  }
  return {}
}

function writeCookie(map) {
  document.cookie =
    COOKIE_NAME +
    '=' +
    encodeURIComponent(JSON.stringify(boundedMap(map))) +
    '; path=/; max-age=' +
    MAX_AGE_S +
    '; samesite=lax'
}

// loadColumnWidths — read once at page load. Cookies are available
// synchronously (unlike GET /api/me / GET /api/names in avatar.mjs), so no
// async hydration dance is needed: home.mjs calls this once, right after
// constructing `state`, to seed `state.colWidths`.
export function loadColumnWidths() {
  const raw = readCookieRaw()
  if (!raw) return {}
  try {
    const map = JSON.parse(raw)
    return map && typeof map === 'object' ? map : {}
  } catch {
    return {}
  }
}

// MIN_COL_PX — a hard floor so a drag can never collapse a column to an
// unusably thin (or zero/negative) sliver. Deliberately NOT content-aware:
// the reviewer's own resize is an explicit action and may clip code, even in
// the `fit` stand whose whole point is normally to avoid that (accepted,
// see column-resize.md) — this floor is only about the column staying a
// column at all.
export const MIN_COL_PX = 200

// MIN_SPLIT_PANE_PX — the floor for the split stand's own OLD/LEFT pane when
// dragging the middle divider (startSplitResize below). Smaller than
// MIN_COL_PX (a whole COLUMN's floor): this only bounds one half of a
// two-pane split, not a standalone column.
export const MIN_SPLIT_PANE_PX = 120

// SNAP_BACK_PX — how close (in px) a drag has to land to the auto width
// before it resets to "auto" instead of committing an override (the second
// of the two reset paths, next to the handle's own dblclick).
const SNAP_BACK_PX = 10

// getColumnWidth — the reactive read every card's style binding uses.
// IMPORTANT: reading a brand-new key on a plain object is not reliably
// reactive on its own in this codebase's arrow.js build (the same caveat
// documented on state.langSiblings in home.mjs) — hence the explicit
// `state.colWidthVersion` bump on every write, and every reader voiding it
// first, mirroring state.codeVersion/state.langSiblings.
export function getColumnWidth(state, key) {
  void state.colWidthVersion
  return (key && state.colWidths[key]) || null
}

// colWidthStyle — the whole-value inline style string (or '' for auto,
// meaning the class-driven width wins) — the "attribute value must be the
// whole value" rule in .claude/rules/arrowjs-pitfalls.md.
export function colWidthStyle(state, key) {
  const px = getColumnWidth(state, key)
  return px ? 'width:' + px + 'px;max-width:' + px + 'px' : ''
}

function setColumnWidth(state, key, px) {
  // Delete before re-setting, even for an already-existing key: a plain
  // object's key order is insertion order and is otherwise never touched on
  // update, so a re-resized column would stay stuck at its ORIGINAL
  // insertion position and be evicted first by boundedMap despite being the
  // most recently touched. This makes "oldest key" in boundedMap genuinely
  // mean "least recently set".
  delete state.colWidths[key]
  state.colWidths[key] = Math.round(px)
  state.colWidthVersion++
  writeCookie(state.colWidths)
}

export function clearColumnWidth(state, key) {
  if (!key || !(key in state.colWidths)) return
  delete state.colWidths[key]
  state.colWidthVersion++
  writeCookie(state.colWidths)
}

// resetColumnWidth — the handle's own dblclick reset path.
export function resetColumnWidth(state, key) {
  clearColumnWidth(state, key)
}

// parseAutoWidthPx extracts the ACTIVE width token from one of the existing
// width-class functions (widthCls/relatedColumnWidthCls/
// commentColumnWidthCls/claudeColumnWidthCls) and converts it to a real pixel
// value. Only used to decide "close enough to auto, snap back" on mouseup —
// never to draw anything (drawing is the class itself, until an override
// exists).
//
// Two shapes are understood:
//
// 1. `w-[Nrem] narrow:w-[Nrem] 2xl:w-[Nrem]` (relatedColumnWidthCls/
//    commentColumnWidthCls/claudeColumnWidthCls, and Block.mjs's
//    boundedWrapWidthCls for a non-PHP file) — converted against the page's
//    CURRENT root font-size (not a hardcoded 16, so browser zoom/user
//    font-size settings are respected). Picking the right one of the three
//    tokens for the CURRENT viewport is load-bearing, not cosmetic: at a wide
//    viewport (>=1536px, Tailwind's default 2xl breakpoint) the `2xl:` token
//    wins over the bare one, and below 1400px (this app's custom `narrow`
//    screen, index.html) the `narrow:` token wins instead — using the bare
//    token unconditionally made a small drag at a wide viewport compare
//    against the WRONG (narrower) auto width and commit an override instead
//    of snapping back.
// 2. `w-[Npx]` (Block.mjs's contentWidthCls/NARROW_FIXED_WIDTH_CLS, a PHP
//    file, every stand) — already an absolute pixel value, so it needs no
//    conversion and no element at all. This used to be a
//    `w-[calc(Nch_+_Mrem)]` shape whose `ch` had to be resolved against the
//    card <article>'s OWN font through a throwaway off-screen probe
//    element; Block.mjs now converts its chars-count to px itself (against
//    the CODE font's real advance width, see CODE_CHAR_PX there), so both
//    that probe and the `el` parameter are gone. `el` was the only reason
//    this function ever touched the DOM.
export function parseAutoWidthPx(clsString) {
  const px = /(?:^|\s)w-\[([\d.]+)px\]/.exec(clsString)
  if (px) return parseFloat(px[1])
  const bare = /(?:^|\s)w-\[([\d.]+)rem\]/.exec(clsString)
  if (!bare) return null
  const narrow = /narrow:w-\[([\d.]+)rem\]/.exec(clsString)
  const xl2 = /2xl:w-\[([\d.]+)rem\]/.exec(clsString)
  const vw = window.innerWidth
  let remNum = bare[1]
  if (xl2 && vw >= 1536) remNum = xl2[1]
  else if (narrow && vw <= 1399) remNum = narrow[1]
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return parseFloat(remNum) * remPx
}

// startColumnResize wires up one drag gesture: mousedown on the handle starts
// it, document-level mousemove/mouseup track the rest — the same
// module-level-listener shape as home.mjs's own
// `window.addEventListener('resize', ...)` (re-checking applyDiffColumnFit),
// needed because the pointer routinely leaves the handle's own thin hit area
// mid-drag.
// `autoWidthPxFn` is supplied by the caller (each kind knows its own
// width-class function) and is only read once, on mouseup, to decide the
// snap-back.
//
// The call/comment-arrow overlay (callArrows.mjs) points at fixed anchors —
// the pane's right edge, an Onderliggende-code card's own edge — that this
// drag moves continuously. Nothing else in this gesture touches
// setRelated/scroll/resize, so left alone the line would just sit drawn at
// its pre-drag position throughout: suspendCallArrows hides it as soon as
// the drag starts, resumeCallArrows brings it back (tracking the settled
// new width) once the drag ends, whichever way it ends.
export function startColumnResize(e, state, key, autoWidthPxFn) {
  if (!key) return
  e.preventDefault()
  e.stopPropagation()
  const root = e.currentTarget.closest('[data-col-resize-root]')
  if (!root) return
  suspendCallArrows()
  const startWidth = root.getBoundingClientRect().width
  const startX = e.clientX
  const onMove = (ev) => {
    const next = Math.max(MIN_COL_PX, startWidth + (ev.clientX - startX))
    state.colWidths[key] = next
    state.colWidthVersion++
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    const current = state.colWidths[key]
    if (current == null) return resumeCallArrows()
    const autoPx = autoWidthPxFn(root)
    if (autoPx != null && Math.abs(current - autoPx) <= SNAP_BACK_PX) clearColumnWidth(state, key)
    else setColumnWidth(state, key, current)
    resumeCallArrows()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// startSplitResize — drag the middle divider of a 'split' stand's two panes
// (Block.mjs's codeDiff). Reviewer request: "ik wil het middelste scheiding
// ook kunnen slepen met mijn muis, dan moet [de kaart] recht meeschuiven naar
// rechts" — confirmed as: the RIGHT/new pane never shrinks below its own
// current width, the CARD grows to make room instead. So only the LEFT pane's
// width (`splitKey`, e.g. 'splitLeft:'+b.id) and the CARD's own whole-width
// override (`cardKey`, the SAME 'diff:'+b.id key startColumnResize/the
// right-edge handle already writes) move — both by the identical delta — so
// the right pane's own share (cardWidth - leftWidth - the 1px/8px divider)
// stays numerically constant throughout the drag, in either direction. This
// deliberately reuses the whole-card override key: dragging the divider is
// equivalent to "grow the card AND hand every extra pixel to the left pane",
// so a card already manually resized (drag handle or c/v) is picked up from
// its real current width, exactly like startKeyResize continues from
// whatever currently renders.
export function startSplitResize(e, state, splitKey, cardKey) {
  if (!splitKey || !cardKey) return
  e.preventDefault()
  e.stopPropagation()
  const card = e.currentTarget.closest('[data-col-resize-root]')
  const container = e.currentTarget.closest('[data-split-root]')
  if (!card || !container) return
  const leftPane = container.querySelector('[data-pane="old"]')
  if (!leftPane) return
  suspendCallArrows()
  const startLeftWidth = leftPane.getBoundingClientRect().width
  const startCardWidth = card.getBoundingClientRect().width
  const startX = e.clientX
  const onMove = (ev) => {
    const nextLeft = Math.max(MIN_SPLIT_PANE_PX, startLeftWidth + (ev.clientX - startX))
    const applied = nextLeft - startLeftWidth // clamped by the floor above, so
    // the card only grows/shrinks by however much the left pane actually did
    state.colWidths[splitKey] = nextLeft
    state.colWidths[cardKey] = startCardWidth + applied
    state.colWidthVersion++
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    if (state.colWidths[splitKey] != null) setColumnWidth(state, splitKey, state.colWidths[splitKey])
    if (state.colWidths[cardKey] != null) setColumnWidth(state, cardKey, state.colWidths[cardKey])
    resumeCallArrows()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// KEY_RESIZE_PX_PER_SEC — how fast a held c/v keeps shrinking/growing the
// focused column (see startKeyResize below). Frame-rate independent (driven
// off the animation frame's own timestamp delta), so it feels the same on a
// 60Hz and a 120Hz display.
const KEY_RESIZE_PX_PER_SEC = 420

// startKeyResize — the keyboard counterpart of startColumnResize: holding `c`
// (dir -1) or `v` (dir 1) continuously shrinks/grows the given column instead
// of a single mousedown→mousemove drag. `root` is the column's own DOM node
// (found by the caller via its `data-diff-col-key` — see the doc comment on
// that attribute in Block.mjs), read once for the CURRENT rendered width
// exactly like startColumnResize's own `root.getBoundingClientRect().width` —
// so a hold that starts from an existing override continues from there, and a
// hold starting from the auto (class-driven) width continues from whatever
// that auto width currently renders as.
//
// Returns a handle with two terminal actions instead of a single onUp, because
// the caller (home.mjs) needs to tell a genuine "held it, then let go" apart
// from "this was the first half of a quick double-tap, about to be reset" —
// see the doc comment on home.mjs's own key-resize tracking:
//   - cancel() stops the animation WITHOUT persisting — used when the release
//     turns out to be the second half of a double-tap (the tiny width change
//     the brief tap already made is simply discarded, mirroring the resize
//     handle's own dblclick reset, which also ignores any drag distance).
//   - commit() stops the animation and persists the current width, exactly
//     like startColumnResize's mouseup path (but with no snap-back-to-auto:
//     that check needs the auto-width class function, which only Block.mjs
//     has — see MIN_COL_PX's neighbour parseAutoWidthPx and the doc-comment
//     in column-resize.md on why the keyboard path skips it).
export function startKeyResize(state, key, root, dir) {
  suspendCallArrows() // see the doc comment on startColumnResize above
  const startWidth = getColumnWidth(state, key) || root.getBoundingClientRect().width
  state.colWidths[key] = startWidth
  state.colWidthVersion++
  let raf = null
  let last = null
  const step = (t) => {
    if (last == null) last = t
    const dt = (t - last) / 1000
    last = t
    const next = Math.max(MIN_COL_PX, (state.colWidths[key] || startWidth) + dir * KEY_RESIZE_PX_PER_SEC * dt)
    state.colWidths[key] = next
    state.colWidthVersion++
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return {
    cancel() {
      if (raf != null) cancelAnimationFrame(raf)
      resumeCallArrows()
    },
    commit() {
      if (raf != null) cancelAnimationFrame(raf)
      const current = state.colWidths[key]
      if (current != null) setColumnWidth(state, key, current)
      resumeCallArrows()
    },
  }
}

// resizeHandle — the visual affordance shared by every resizable column: a
// thin strip on the right edge with a col-resize cursor (Rule 4 in
// mouse-navigation.md: hover carries no state here, only a CSS cursor
// change) plus a subtle hover tint so the strip is discoverable at all. The
// card/column root this is nested inside must carry `relative` +
// `data-col-resize-root` (the drag's `closest(...)` anchor).
//
// Wrapped in a stable `<div class="contents">` root, and `onDown` guards
// against a missing event (onReset/`@dblclick` needs no event at all, so it
// stays unguarded) — every call site (Block.mjs, RelatedPanel.mjs ×3) toggles
// this bare (`cond ? resizeHandle(...) : ''`), and this template's only
// expressions are its two event listeners, no other reactive binding. Same
// shape/reasoning as blockCloseColumnButton/blockMenuButton in Block.mjs: see
// "A narrow event-listener-only child toggled bare" in
// .claude/rules/arrowjs-pitfalls.md for what is and isn't established about
// why a slot like this can misfire.
// resetSplitDivider — the dblclick reset for the divider handle below: clears
// BOTH overrides startSplitResize writes (the left pane's own width and the
// card's whole-width override it grew/shrank in lockstep with), so a
// double-click genuinely goes back to fully auto, not just "auto split at
// whatever size the card happens to be".
export function resetSplitDivider(state, splitKey, cardKey) {
  clearColumnWidth(state, splitKey)
  clearColumnWidth(state, cardKey)
}

// splitDividerHandle — the middle divider between the split stand's old/left
// and new/right panes, dragging it via startSplitResize above. Same visual
// language as resizeHandle (thin, cursor-col-resize, subtle hover tint,
// dblclick reset) but IN-FLOW rather than absolutely positioned — it IS the
// divider between the two panes, not an overlay glued to one column's edge —
// so it keeps the thin `w-px` line as a centered child and only the (wider,
// more easily hit) wrapper carries the interaction.
export function splitDividerHandle(onDown, onReset) {
  return html`<div class="contents">
    <div
      class="relative w-2 shrink-0 cursor-col-resize select-none group"
      data-testid="split-divider-handle"
      @mousedown="${(e) => e && onDown(e)}"
      @dblclick="${onReset}"
    >
      <div
        class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-100 dark:bg-zinc-800 group-hover:bg-indigo-300/60 dark:group-hover:bg-indigo-500/50"
      ></div>
    </div>
  </div>`
}

export function resizeHandle(onDown, onReset) {
  // `right-0` (flush with the INNER right edge), not a negative offset: some
  // resizable roots (related-code, the block-diff `<article>`) carry
  // `overflow-hidden`, which clips a positioned child that sticks out past
  // the box's own edge — a negative offset made the handle unpaintable and
  // therefore un-hit-testable there, so mousedown silently never fired.
  return html`<div class="contents">
    <div
      class="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize select-none hover:bg-indigo-300/40 dark:hover:bg-indigo-500/30"
      data-testid="col-resize-handle"
      @mousedown="${(e) => e && onDown(e)}"
      @dblclick="${onReset}"
    ></div>
  </div>`
}
