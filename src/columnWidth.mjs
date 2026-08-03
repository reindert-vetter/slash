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

const COOKIE_NAME = 'slash_colw'
const MAX_AGE_S = 60 * 60 * 24 * 30 // 30 days — the reviewer's explicit choice

function readCookieRaw() {
  const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : ''
}

function writeCookie(map) {
  document.cookie =
    COOKIE_NAME + '=' + encodeURIComponent(JSON.stringify(map)) + '; path=/; max-age=' + MAX_AGE_S + '; samesite=lax'
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

// parseAutoWidthPx extracts the ACTIVE `w-[<N>rem]` token from one of the
// existing width-class functions (widthCls/relatedColumnWidthCls/
// commentColumnWidthCls/claudeColumnWidthCls) — every one of them emits the
// same `w-[Nrem] narrow:w-[Nrem] 2xl:w-[Nrem]` shape (see diff-card.md's
// "Narrow viewport" section) — and converts it to a real pixel value against
// the page's CURRENT root font-size (not a hardcoded 16, so browser
// zoom/user font-size settings are respected). Only used to decide "close
// enough to auto, snap back" on mouseup — never to draw anything (drawing is
// the class itself, until an override exists).
//
// Picking the right one of the three tokens for the CURRENT viewport is
// load-bearing, not cosmetic: at a wide viewport (>=1536px, Tailwind's
// default 2xl breakpoint) the `2xl:` token wins over the bare one, and below
// 1400px (this app's custom `narrow` screen, index.html) the `narrow:` token
// wins instead — using the bare token unconditionally made a small drag at a
// wide viewport compare against the WRONG (narrower) auto width and commit
// an override instead of snapping back.
export function parseAutoWidthPx(clsString) {
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
// `window.addEventListener('resize', ...)` for state.viewportH, needed
// because the pointer routinely leaves the handle's own thin hit area mid-drag.
// `autoWidthPxFn` is supplied by the caller (each kind knows its own
// width-class function) and is only read once, on mouseup, to decide the
// snap-back.
export function startColumnResize(e, state, key, autoWidthPxFn) {
  if (!key) return
  e.preventDefault()
  e.stopPropagation()
  const root = e.currentTarget.closest('[data-col-resize-root]')
  if (!root) return
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
    if (current == null) return
    const autoPx = autoWidthPxFn()
    if (autoPx != null && Math.abs(current - autoPx) <= SNAP_BACK_PX) clearColumnWidth(state, key)
    else setColumnWidth(state, key, current)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// resizeHandle — the visual affordance shared by every resizable column: a
// thin strip on the right edge with a col-resize cursor (Rule 4 in
// mouse-navigation.md: hover carries no state here, only a CSS cursor
// change) plus a subtle hover tint so the strip is discoverable at all. The
// card/column root this is nested inside must carry `relative` +
// `data-col-resize-root` (the drag's `closest(...)` anchor).
export function resizeHandle(onDown, onReset) {
  // `right-0` (flush with the INNER right edge), not a negative offset: some
  // resizable roots (related-code, the block-diff `<article>`) carry
  // `overflow-hidden`, which clips a positioned child that sticks out past
  // the box's own edge — a negative offset made the handle unpaintable and
  // therefore un-hit-testable there, so mousedown silently never fired.
  return html`<div
    class="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize select-none hover:bg-indigo-300/40 dark:hover:bg-indigo-500/30"
    data-testid="col-resize-handle"
    @mousedown="${onDown}"
    @dblclick="${onReset}"
  ></div>`
}
