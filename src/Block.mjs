// Block — the detail card for a single block, shown to the right of the list.
// A component: takes one block object (from state.blocks) plus display options
// and returns an arrow.js template. It mirrors the sidebar row but with the full
// header, file:line and the approve toggle. Code goes underneath later.

import { html } from './vendor/arrow.js'
import { categoryClass } from './BlockList.mjs'
import Prism from './vendor/prism.js'

// highlight turns raw PHP source into Prism-tokenised HTML (keywords, strings,
// variables, …). Prism.highlight escapes the text itself, so the result is safe
// to feed to .innerHTML. Blocks are usually bare function bodies without a
// `<?php` tag, which the php grammar still tokenises fine. If the grammar is
// somehow missing we fall back to an escaped plain string — never raw innerHTML.
export function highlight(code) {
  const grammar = Prism.languages.php
  if (!grammar) return escapeHtml(code)
  return Prism.highlight(code, grammar, 'php')
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// The word shown top-right of the header, per change status.
const STATUS_WORD = {
  added: 'text-emerald-600',
  modified: 'text-amber-600',
  removed: 'text-rose-600',
}

function statusColor(status) {
  return STATUS_WORD[status] || 'text-slate-500'
}

// singleSide returns which pane to show when a block is one-sided: an added block
// has no old source (show only 'right'/new), a removed block has no new source
// (show only 'left'/old). Modified blocks keep both panes (null). This lets the
// card drop the empty pane and render narrower. Driven by status so the width is
// stable even before b.code loads.
function singleSide(b) {
  if (b.status === 'added') return 'right'
  if (b.status === 'removed') return 'left'
  return null
}

/**
 * @param {object} b - one block from state.blocks (reactive).
 * @param {object} [opts] - { preview: boolean } dims the look-ahead card.
 * @returns arrow.js template — call with a mount target to render.
 */
export default function Block(b, opts = {}) {
  const preview = !!opts.preview
  // activeGroup is a function returning the currently-navigated change group
  // ({ start, end } row indices) for this block, or null. It's a function (not a
  // value) so the pane's .innerHTML binding re-runs when the navigation state it
  // reads changes — see home.mjs. Preview cards never highlight.
  const activeGroup = opts.activeGroup || (() => null)
  // hintsEnabled is a function returning whether the out-of-view change hints may
  // show for this card. They only make sense for the block the reviewer is
  // actually stepping through: the selected card, in diff mode. Preview cards and
  // list mode pass a falsey predicate, so their hints stay hidden. Reactive (a
  // function) so flipping mode re-evaluates without re-rendering the diff.
  const hintsEnabled = opts.hintsEnabled || (() => false)
  // diffActive is a function returning whether the reviewer is currently stepping
  // through this block's code diff (the selected card, in diff mode). When true the
  // card border turns light blue — the same indigo as a selected row in the comment
  // index — as an at-a-glance cue that the keyboard now drives the diff.
  const diffActive = opts.diffActive || (() => false)
  // approvedRows is a function returning the Set of approved row indices for this
  // block, so the panes re-tint (an emerald left bar) as the reviewer approves
  // units. A function (not a value) so the .innerHTML binding re-runs when
  // b.approvedRows changes. Defaults to nothing approved.
  const approvedFn = opts.approvedRows || (() => new Set())
  // commentedRows is a function returning the Set of rows that carry a comment,
  // so the panes mark them with a 💬 (presence only). A function so the binding
  // re-runs as comments load/change. Defaults to no comments.
  const commentedFn = opts.commentedRows || (() => new Set())
  // approvedCalls is a function returning the Set of approved call-segment keys
  // (finer than approvedRows — see callKey), so a row with more than one call
  // segment can show its per-segment progress before the whole row is signed
  // off. Defaults to nothing approved.
  const approvedCallsFn = opts.approvedCalls || (() => new Set())
  return html`
    <article
      class="${() =>
        'flex min-h-0 max-w-full flex-col overflow-hidden rounded-xl border bg-white transition ' +
        (singleSide(b) ? 'w-[38rem] 2xl:w-[46rem] ' : 'w-[70rem] 2xl:w-[82rem] ') +
        (preview
          ? 'max-h-72 border-slate-200 opacity-50'
          : diffActive()
          ? 'border-indigo-300 ring-1 ring-indigo-200'
          : 'border-slate-300 ring-1 ring-black/5')}"
    >
      <div class="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5">
        <span
          class="${() =>
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
            categoryClass(b.category)}"
          >${() => b.category}</span
        >
        <h2 class="flex-1 truncate font-mono text-sm font-semibold text-slate-800">
          ${() => b.label}
        </h2>
        <span class="${() => 'shrink-0 text-xs font-medium ' + statusColor(b.status)}"
          >${() => b.status}</span
        >
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <span class="font-mono text-xs text-slate-500"
          >${() => b.file + ':' + b.line}</span
        >
        <span class="flex-1"></span>
        ${() =>
          b.tests === false
            ? html`<span
                class="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-600"
                >⚑ geen tests</span
              >`
            : ''}
        ${() =>
          b.author
            ? html`<span
                class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600"
                >${b.author}</span
              >`
            : ''}
        <label class="flex cursor-pointer items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-slate-300"
            checked="${() => blockApproved(b)}"
            .indeterminate="${() => blockPartlyApproved(b)}"
            @change="${() => toggleBlockApproval(b)}"
          />
          ${() => approveSummary(b)}
        </label>
      </div>

      <p class="border-t border-slate-100 px-4 py-3 text-sm leading-relaxed">
        <span class="font-semibold text-slate-500">Goal:</span>
        <span class="${() => (b.description ? 'text-slate-600' : 'italic text-slate-400')}"
          >${() => b.description || 'nog geen omschrijving'}</span
        >
      </p>

      ${() => codeDiff(b, activeGroup, hintsEnabled, approvedFn, commentedFn, approvedCallsFn)}
    </article>
  `
}

// codeDiff renders the old/new source side by side under the block info. Old on
// the left, new on the right. The two sides are line-aligned by an LCS diff
// (alignRows, below) so unchanged lines sit on the same row, a removed line
// leaves a blank filler on the right, and an added line leaves a blank filler on
// the left. Changed lines are tinted red (old) / green (new). This is a pure
// text diff — no AI. `b.code` is filled lazily by home.mjs: undefined (not
// requested), null (loading), { old, new } or { error }.
function codeDiff(
  b,
  activeGroup,
  hintsEnabled = () => false,
  approvedFn = () => new Set(),
  commentedFn = () => new Set(),
  approvedCallsFn = () => new Set(),
) {
  const c = b.code
  if (c === undefined) return ''
  if (c === null) {
    return html`<div
      class="border-t border-slate-100 px-4 py-3 text-xs italic text-slate-400"
      data-testid="code-diff"
    >
      loading code…
    </div>`
  }
  if (c.error) {
    return html`<div
      class="border-t border-slate-100 px-4 py-3 text-xs text-rose-500"
      data-testid="code-diff"
    >
      ${c.error}
    </div>`
  }
  const rows = blockRows(b)
  const only = singleSide(b)
  // One-sided blocks (added / removed) show just their non-empty pane at full
  // width — no divider, no empty counterpart.
  if (only === 'right') {
    return html`
      <div
        class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100"
        data-testid="code-diff"
        data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
      >
        ${codePane('new', c.new, rows, 'right', 'border-emerald-100 bg-emerald-50 text-emerald-700', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn)}
        ${scrollHint('up')}
        ${scrollHint('down')}
      </div>
    `
  }
  if (only === 'left') {
    return html`
      <div
        class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100"
        data-testid="code-diff"
        data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
      >
        ${codePane('old', c.old, rows, 'left', 'border-rose-100 bg-rose-50 text-rose-600', activeGroup, 'w-full', approvedFn, commentedFn, approvedCallsFn)}
        ${scrollHint('up')}
        ${scrollHint('down')}
      </div>
    `
  }
  return html`
    <div
      class="relative flex min-h-0 flex-1 overflow-hidden border-t border-slate-100"
      data-testid="code-diff"
      data-hints="${() => (hintsEnabled() ? 'on' : 'off')}"
    >
      ${codePane('old', c.old, rows, 'left', 'border-rose-100 bg-rose-50 text-rose-600', activeGroup, 'w-1/2', approvedFn, commentedFn, approvedCallsFn)}
      <div class="w-px shrink-0 bg-slate-100"></div>
      ${codePane('new', c.new, rows, 'right', 'border-emerald-100 bg-emerald-50 text-emerald-700', activeGroup, 'w-1/2', approvedFn, commentedFn, approvedCallsFn)}
      ${scrollHint('up')}
      ${scrollHint('down')}
    </div>
  `
}

// scrollHint is the little floating bar at the top/bottom edge of the diff body
// that tells the reviewer there are still changed lines out of view in that
// direction (so scrolling reveals more). It starts hidden (opacity 0) and is
// switched on/off — and positioned right below the pane headers / above the
// bottom edge — imperatively by updateHints on every scroll and refresh. It's
// pointer-events-none so it never eats a scroll or click.
function scrollHint(dir) {
  const down = dir === 'down'
  // A chevron pointing the way you can scroll. Static SVG string, fed through the
  // .innerHTML binding (arrow.js sets the property instead of escaping) — the
  // markup is our own, so it's safe.
  const chevron = down
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M6 9l6 6 6-6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M18 15l-6-6-6 6"/></svg>'
  return html`
    <div
      data-hint="${dir}"
      style="opacity:0"
      class="${'pointer-events-none absolute inset-x-0 z-10 flex h-7 items-center justify-center transition-opacity duration-150 ' +
      (down
        ? 'bottom-0 bg-gradient-to-t'
        : 'top-0 bg-gradient-to-b') +
      ' from-white/95 via-white/70 to-transparent'}"
    >
      <span
        class="flex h-4 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-1 ring-black/5"
        .innerHTML="${() => chevron}"
      ></span>
    </div>
  `
}

// updateHints toggles and positions the up/down scroll hints of one diff. A row
// is "out of view" when its box sits fully above the visible top or below the
// visible bottom of the (equal to both panes) left scroll body; if any changed
// row is out of view in a direction, that hint shows. The hints are anchored to
// the scroll body's edges (top sits below the pane headers) so they float over
// the code, not over the OLD/NEW header row.
export function updateHints(container) {
  const pane = container.querySelector('[data-scrollsync]')
  const up = container.querySelector('[data-hint="up"]')
  const down = container.querySelector('[data-hint="down"]')
  if (!pane || !up || !down) return
  // Only the selected block in diff mode opts in (data-hints="on"); everything
  // else — preview cards, list mode — keeps both hints hidden.
  if (container.getAttribute('data-hints') !== 'on') {
    up.style.opacity = '0'
    down.style.opacity = '0'
    return
  }
  const vRect = pane.getBoundingClientRect()
  let above = false
  let below = false
  for (const el of pane.querySelectorAll('[data-changed]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom <= vRect.top + 0.5) above = true
    else if (r.top >= vRect.bottom - 0.5) below = true
    if (above && below) break
  }
  // This green in-block chevron only ever means "there are more changed lines
  // out of view in this direction — scroll to reveal them". Stepping to the
  // next / previous block is a separate, grey chevron rendered *outside* the
  // card by home.mjs (stepChevron), so it never lights up here.
  const cRect = container.getBoundingClientRect()
  up.style.top = vRect.top - cRect.top + 'px'
  down.style.bottom = cRect.bottom - vRect.bottom + 'px'
  up.style.opacity = above ? '1' : '0'
  down.style.opacity = below ? '1' : '0'
}

// syncScroll keeps the old (left) and new (right) panes in lockstep on both axes:
// scrolling one — sideways or up/down — scrolls the other to the same position.
// Each pane scrolls on its own (they can hold lines of different length), so
// without this they drift apart. The rows are line-aligned and equal-height, so
// scrollTop maps 1:1. The `!==` guards stop the mirrored write from bouncing
// back — once both panes share a value the loop is a no-op. This also carries
// home.mjs's scrollIntoView (which scrolls only the left pane) over to the right.
function syncScroll(e) {
  const src = e.target
  const container = src.closest('[data-testid="code-diff"]')
  if (!container) return
  for (const p of container.querySelectorAll('[data-scrollsync]')) {
    if (p === src) continue
    if (p.scrollLeft !== src.scrollLeft) p.scrollLeft = src.scrollLeft
    if (p.scrollTop !== src.scrollTop) p.scrollTop = src.scrollTop
  }
  // Scrolling may have moved changed lines in or out of view — re-evaluate the
  // up/down hints. Covers both manual scroll and home.mjs's programmatic
  // scrollTop (which fires a scroll event too).
  updateHints(container)
}

// codePane is one half of the diff: a fixed-width, horizontally scrolling column
// with a tinted header. `data` is a codeSide ({ start, end, text }) used only for
// the L-range in the header. The body is the shared aligned `rows`, projected to
// this side (`left` = old, `right` = new). Both panes render the same number of
// rows at the same line-height, so they line up vertically without any JS.
function codePane(
  side,
  data,
  rows,
  sideKey,
  headerCls,
  activeGroup,
  widthCls = 'w-1/2',
  approvedFn = () => new Set(),
  commentedFn = () => new Set(),
  approvedCallsFn = () => new Set(),
) {
  return html`
    <div class="${'flex min-w-0 min-h-0 flex-col ' + widthCls}" data-pane="${side}">
      <div class="no-scrollbar min-h-0 flex-1 overflow-auto" data-scrollsync @scroll="${syncScroll}">
        <code
          class="language-php m-0 block py-2 font-mono text-[11px] leading-relaxed text-slate-700"
          .innerHTML="${() =>
            paneHTML(rows, sideKey, activeGroup(), approvedFn(), commentedFn(), approvedCallsFn())}"
        ></code>
      </div>
    </div>
  `
}

// paneHTML builds the innerHTML string of one pane's <code>: one <div> per
// aligned row. Present lines are Prism-highlighted (which escapes the text);
// blank/filler lines get a non-breaking space so the row keeps its height. The
// only unescaped bits are our own static class strings, so the result is safe to
// hand to the .innerHTML binding.
function paneHTML(rows, sideKey, group, approved = new Set(), commented = new Set(), approvedCalls = new Set()) {
  const parts = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const text = sideKey === 'left' ? r.left : r.right
    const mark = sideKey === 'left' ? r.leftMark : r.rightMark
    const ws = wsOnly(r)
    // A row-level flag (a real change on either side) so a single pane's rows
    // carry the full set of changes — updateHints scans just the left pane. Del
    // rows are marked on the left, ins rows via their filler row, so both are
    // covered. Whitespace-only re-alignments don't count (see rowChanged/wsOnly).
    const changed = rowChanged(r)
    const active = changed && group && i >= group.start && i <= group.end
    // At call granularity the active unit is a single row plus the char indices
    // of the one call segment being navigated; underline those (per side) so the
    // exact segment within the line is marked. null at group/line granularity.
    const underline =
      active && group.char ? (sideKey === 'left' ? group.left : group.right) : null
    // A fully-approved changed row gets a small checkmark in the left gutter —
    // see approveHere below for which side draws it. The active (indigo)
    // highlight takes precedence visually while the cursor is on the row.
    const isApproved = changed && approved.has(i)
    // Backgrounds are ~20% lighter than the raw Tailwind rose/emerald shades
    // (mixed 20% toward white) so the tint reads as an accent, not a fill.
    let cls = 'relative block whitespace-pre px-3'
    if (active) {
      // Brighter tint + an inset left bar (box-shadow, so it adds no width and
      // the bars of adjacent active rows merge into one continuous accent).
      cls += ' shadow-[inset_3px_0_0_#6366f1]'
      if (mark === 'del') cls += ' bg-[#fed7dc]' // rose-200 +20% white
      else if (mark === 'ins') cls += ' bg-[#b9f5d9]' // emerald-200 +20% white
      else cls += ' bg-indigo-50'
    } else {
      if (ws) {
        // Whitespace-only re-alignment: no full-line tint (it isn't a real
        // change). Only the shifted whitespace itself is coloured, in the body.
      } else if (mark === 'del') cls += ' bg-[#ffe9eb]' // rose-100 +20% white
      else if (mark === 'ins') cls += ' bg-[#dafbea]' // emerald-100 +20% white
      else if (text === null) cls += ' bg-slate-50' // filler for the missing side
    }
    // A row modified on both sides (a del paired with an ins) gets an intra-line
    // char diff so the reviewer sees *what* changed — the inserted/removed
    // characters are marked, not just the whole line. One-sided rows (a pure
    // add or remove) have nothing to diff against, so they highlight plainly.
    const paired = r.left != null && r.right != null && !!r.leftMark && !!r.rightMark
    let body
    if (text === null) body = '&nbsp;'
    else if (paired) body = highlightChanges(r, sideKey, ws, underline)
    else if (underline && underline.size)
      // A one-sided change (pure add / remove): its whole line is the single
      // edit, so underline it end to end.
      body = markChars(highlight(text), (pi) => (underline.has(pi) ? UNDERLINE_CLS : ''))
    else body = highlight(text)
    // A 💬 marks a row that carries a comment — presence only (the count
    // doesn't matter). Shown once per row: on the new (right) pane for a normal
    // row, on the old (left) pane only for a pure deletion (no right side), so a
    // modified row doesn't get the marker twice. Appended after the code so it
    // trails the line and scrolls with it.
    const commentedHere =
      text !== null && commented.has(i) && (sideKey === 'right' || r.right == null)
    const marker = commentedHere
      ? ' <span class="select-none opacity-60" data-comment="1" title="Er zit een comment op deze regel">💬</span>'
      : ''
    // Anchor the first row of the active group so home.mjs can scroll it to
    // the vertical centre of the diff viewport.
    const anchor = active && i === group.start ? ' data-change-active="1"' : ''
    const flag = changed ? ' data-changed="1"' : ''
    // approveHere mirrors commentedHere: the approve mark for a row belongs on
    // the new (right) pane normally, and on the old (left) pane only for a pure
    // deletion (no right side) — so a modified row never gets it twice.
    const approveHere = sideKey === 'right' || r.right == null
    const check =
      isApproved && approveHere
        ? ' <span class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] font-bold leading-none text-emerald-600" title="Goedgekeurd">✓</span>'
        : ''
    parts.push(`<div class="${cls}"${anchor}${flag}>${check}${body}${marker}</div>`)

    // Partial call approval: once at least one — but not all — of this row's
    // call segments is approved, an open circle marks every segment still
    // waiting, positioned under it via a second monospace row. Both panes
    // evaluate the exact same (row, approval-state) inputs, so they insert this
    // extra row at the same index on both sides and stay line-for-line aligned:
    // only the side that actually shows the segments draws the dots, the other
    // gets a blank filler row of equal height.
    const partial = partialCallApproval(rows, i, approved, approvedCalls)
    if (partial) {
      parts.push(
        approveHere ? circleRowHTML(text, partial.segs, partial.approvedStarts) : BLANK_MARK_ROW,
      )
    }
  }
  return parts.join('')
}

// BLANK_MARK_ROW is the filler used on the pane that doesn't draw the
// call-approval circles, so both panes keep the same row count and stay
// vertically aligned (see paneHTML).
const BLANK_MARK_ROW = '<div class="block whitespace-pre px-3 leading-none">&nbsp;</div>'

// partialCallApproval decides whether row `i` should show the per-segment
// open-circle indicator: it has more than one call segment (rowCallSegments),
// isn't already fully approved (that gets the plain checkmark instead), and at
// least one — but not all — of its segments is approved. Returns null when
// nothing is approved yet (nothing to show) or everything is (checkmark
// covers it), matching the "niks → niks, deels → bolletjes, alles → vinkje"
// rule.
function partialCallApproval(rows, i, approved, approvedCalls) {
  if (!rowChanged(rows[i])) return null
  if (approved.has(i)) return null
  const segs = rowCallSegments(rows, i)
  if (segs.length <= 1) return null
  const prefix = i + ':'
  const approvedStarts = new Set(
    [...approvedCalls]
      .filter((k) => k.startsWith(prefix))
      .map((k) => Number(k.slice(prefix.length))),
  )
  const done = segs.filter((s) => approvedStarts.has(s.start)).length
  if (done === 0 || done >= segs.length) return null
  return { segs, approvedStarts }
}

// circleRowHTML renders the per-segment progress row: one dot under every call
// segment, positioned at its (whitespace-trimmed) start column via literal
// leading spaces — works without any JS measurement because the row shares the
// exact same monospace font/size as the code line above it, so columns line up
// 1:1. An already-approved segment gets a solid green dot, a still-waiting one
// a hollow (open) one — so the row reads at a glance as a progress strip.
function circleRowHTML(text, segs, approvedStarts) {
  let out = ''
  let col = 0
  for (const s of segs) {
    let start = s.start
    while (start < s.end && /\s/.test(text[start])) start++
    if (start < col) continue
    out += ' '.repeat(start - col)
    out += approvedStarts.has(s.start)
      ? '<span class="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" title="Goedgekeurd"></span>'
      : '<span class="inline-block h-1.5 w-1.5 rounded-full border border-emerald-500 align-middle" title="Nog niet goedgekeurd"></span>'
    col = start + 1
  }
  return `<div class="block whitespace-pre px-3 leading-none">${out || '&nbsp;'}</div>`
}

// wsOnly reports whether a row differs on both sides purely in whitespace
// (indentation / alignment): same tokens, just re-spaced. Re-indenting a whole
// block makes diffLines pair every line as del/ins even though nothing really
// changed — these rows are noise, so we skip them for navigation and don't tint
// the whole line, only the shifted whitespace.
function wsOnly(r) {
  return (
    r.leftMark === 'del' &&
    r.rightMark === 'ins' &&
    r.left != null &&
    r.right != null &&
    r.left.replace(/\s+/g, '') === r.right.replace(/\s+/g, '')
  )
}

// rowChanged reports whether a row counts as a change for navigation and hints:
// it carries a del/ins mark and isn't a whitespace-only re-alignment.
function rowChanged(r) {
  return !!(r.leftMark || r.rightMark) && !wsOnly(r)
}

// UNDERLINE_CLS is the thin underline that marks the *active* call segment when
// the reviewer has drilled navigation down to the finest level (gran === 'call').
// Its colour is the same indigo (#6366f1) as the inset left bar of an active row,
// so "the selected segment within the line" reads as the finest step of the same
// accent.
export const UNDERLINE_CLS = 'underline decoration-2 decoration-[#6366f1] underline-offset-2'

// highlightChanges renders one side of a modified row: Prism-highlighted like any
// line, but with the characters that differ from the other side wrapped in a
// coloured marker (rose on old, emerald on new) so the exact edit stands out —
// e.g. the inserted `_` in `firstname` → `first_name`. `ws` picks the marker
// weight: a whitespace-only re-alignment sits on an untinted row and gets the
// softer 200 shade; a real content change sits on a tinted row and needs the
// stronger 300 shade to read against it. `underline` is an optional Set of char
// indices (the active char-edit) that additionally get the indigo underline.
function highlightChanges(r, sideKey, ws, underline) {
  const text = sideKey === 'left' ? r.left : r.right
  const { leftMarked, rightMarked } = charDiffSides(r.left, r.right)
  const marked = sideKey === 'left' ? leftMarked : rightMarked
  const markCls = ws
    ? sideKey === 'left'
      ? 'bg-rose-200'
      : 'bg-emerald-200'
    : sideKey === 'left'
      ? 'bg-rose-300'
      : 'bg-emerald-300'
  return markChars(highlight(text), (pi) => {
    const parts = []
    if (marked.has(pi)) parts.push(markCls)
    if (underline && underline.has(pi)) parts.push(UNDERLINE_CLS)
    return parts.join(' ')
  })
}

// charDiffSides diffs the two sides at *token* granularity and returns, per side,
// the set of character indices belonging to a token present on only that side.
// A token is a whole `[A-Za-z0-9]` run (an identifier / number) or a single other
// character, so a word is matched as a unit — `address` → `billingAddress` marks
// the whole `address` / `billingAddress`, not just the differing letters. The
// per-token char ranges are unioned back so wrapChangedChars can still wrap by
// character offset.
function charDiffSides(left, right) {
  const a = tokenize(left || '')
  const b = tokenize(right || '')
  const ops = diffChars(
    a.map((t) => t.text),
    b.map((t) => t.text),
  )
  const leftMarked = new Set()
  const rightMarked = new Set()
  const markToken = (set, tok) => {
    for (let k = 0; k < tok.text.length; k++) set.add(tok.start + k)
  }
  let ai = 0
  let bi = 0
  for (const op of ops) {
    if (op === 'eq') {
      ai++
      bi++
    } else if (op === 'del') {
      markToken(leftMarked, a[ai++])
    } else {
      markToken(rightMarked, b[bi++])
    }
  }
  return { leftMarked, rightMarked }
}

// tokenize splits a line into { text, start } tokens: each maximal `[A-Za-z0-9]`
// run is one token (so identifiers/numbers match whole), and every other
// character (operators, punctuation, each whitespace char) is its own token.
function tokenize(s) {
  const toks = []
  const re = /[A-Za-z0-9]+|[^A-Za-z0-9]/g
  let m
  while ((m = re.exec(s)) !== null) {
    toks.push({ text: m[0], start: m.index })
  }
  return toks
}

// diffChars is diffLines over an arbitrary sequence (characters or tokens): a
// classic LCS returning 'eq'/'del'/'ins' ops turning `a` into `b`, comparing
// elements with `===`. Lines are short, so the O(n·m) table is cheap.
function diffChars(a, b) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('eq')
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push('del')
      i++
    } else {
      ops.push('ins')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('ins')
    j++
  }
  return ops
}

// markChars wraps the characters of a Prism-highlighted HTML string in marker
// spans, where `classOf(plaintextIndex)` returns the class string for that source
// char (`''` for none). It walks the HTML tracking the plaintext offset — copying
// tags verbatim (they don't advance the offset) and counting each entity
// (`&amp;` etc.) as one source char — so the indices from charDiffSides (offsets
// into the raw line) line up with the escaped output. Consecutive chars that map
// to the *same* class string share one span, and a span is always closed before a
// tag, so a marker never straddles a Prism token boundary (it nests inside or sits
// between tokens) and the markup stays well-formed. Because a whole class string
// (e.g. background + underline) is compared as one unit, overlapping markers just
// produce a span carrying both classes.
export function markChars(html, classOf) {
  let out = ''
  let pi = 0 // plaintext index into the original line
  let i = 0
  let open = '' // the class string of the currently-open span ('' = none)
  const ensure = (cls) => {
    if (cls === open) return
    if (open) out += '</span>'
    open = ''
    if (cls) {
      out += `<span class="${cls}">`
      open = cls
    }
  }
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      // A tag — copy it whole, and never let a marker span straddle it.
      ensure('')
      const end = html.indexOf('>', i)
      const to = end === -1 ? html.length : end + 1
      out += html.slice(i, to)
      i = to
      continue
    }
    if (ch === '&') {
      // An HTML entity stands for a single source char.
      const end = html.indexOf(';', i)
      const to = end === -1 ? i + 1 : end + 1
      ensure(classOf(pi))
      out += html.slice(i, to)
      pi++
      i = to
      continue
    }
    ensure(classOf(pi))
    out += ch
    pi++
    i++
  }
  ensure('')
  return out
}

// dedent4 strips one level of leading indent from the diff: only when every
// non-blank line of BOTH sides starts with 4 spaces does it drop those 4 spaces
// everywhere. Blocks are usually one method deep inside a class, so this removes
// the dead indent and lets the code sit flush in the panes. The all-or-nothing
// check keeps old/new stripped by the same amount, so alignRows still lines up.
// Blank lines are left as-is. Returns [old, new].
function dedent4(oldText, newText) {
  const lines = (oldText + '\n' + newText).split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0 || !lines.every((l) => l.startsWith('    '))) {
    return [oldText, newText]
  }
  const strip = (t) =>
    t
      .split('\n')
      .map((l) => (l.startsWith('    ') ? l.slice(4) : l))
      .join('\n')
  return [strip(oldText), strip(newText)]
}

// blockRows produces the aligned diff rows for a loaded block (b.code === {old,new}).
// Returns [] when the code isn't loaded or errored. Shared by codeDiff (rendering)
// and home.mjs (change navigation) so both agree on the exact same row list.
export function blockRows(b) {
  const c = b && b.code
  if (!c || c.error) return []
  const [oldText, newText] = dedent4(
    (c.old && c.old.text) || '',
    (c.new && c.new.text) || '',
  )
  return alignRows(oldText, newText)
}

// unitsFor maps a granularity ('group' | 'line' | 'call') to its navigation-unit
// list for the given rows: whole change runs (changeGroups), individual changed
// lines (changeLines), or single call-chain segments within a line (changeCalls).
// Shared by home.mjs (diff navigation) and Footer.mjs (the one-line preview) so
// both agree on what the currently-selected unit is.
export function unitsFor(rows, gran) {
  if (gran === 'line') return changeLines(rows)
  if (gran === 'call') return changeCalls(rows)
  return changeGroups(rows)
}

// ── Approval ───────────────────────────────────────────────────────────────
// Approval is tracked per *changed row*: `b.approvedRows` is an array of row
// indices (into blockRows) the reviewer has signed off. Every granularity's
// approval reduces to these rows — approving a group marks all its rows, a line
// or call marks the one row it sits on — so "is the whole block approved?" is
// simply "are all changed rows approved?". The array is always reassigned (never
// mutated in place) so arrow.js re-renders the checkbox and the pane bars.

// changedRows returns the indices of every navigable (changed, non-ws-only) row —
// the full set a reviewer must approve for the block to count as approved.
export function changedRows(rows) {
  const out = []
  for (let i = 0; i < rows.length; i++) if (rowChanged(rows[i])) out.push(i)
  return out
}

// approvedRowSet reads a block's approved-row indices as a Set (empty when none).
export function approvedRowSet(b) {
  return new Set(Array.isArray(b && b.approvedRows) ? b.approvedRows : [])
}

// approvedCallSet reads a block's approved call-segment keys as a Set (empty
// when none). A key is `${row}:${segStart}` (see callKey/rowCallSegments) —
// finer than approvedRows, used only while a row's segments aren't *all*
// approved yet (once they are, the row graduates into approvedRows instead —
// see toggleCallApprove in home.mjs — so the two sets never overlap for a row).
export function approvedCallSet(b) {
  return new Set(Array.isArray(b && b.approvedCalls) ? b.approvedCalls : [])
}

// callKey builds the approvedCalls key for one call segment: its row plus the
// segment's untrimmed start char offset, stable because rowCallSegments always
// splits the same source text the same way.
export function callKey(row, segStart) {
  return row + ':' + segStart
}

// callUnitApproved reports whether one call-granularity unit (as produced by
// changeCalls) currently counts as approved: its whole row is approved (a
// coarser group/line approval, or a call approval that graduated once every
// segment of the row was approved), or its own segment key is in approvedCalls.
export function callUnitApproved(b, unit) {
  if (!unit) return false
  if (approvedRowSet(b).has(unit.start)) return true
  return approvedCallSet(b).has(callKey(unit.start, unit.segStart))
}

// blockApproved — the derived top-level state: a block is approved once it has at
// least one change and *every* changed row is approved.
export function blockApproved(b) {
  const all = changedRows(blockRows(b))
  if (!all.length) return false
  const set = approvedRowSet(b)
  return all.every((i) => set.has(i))
}

// blockPartlyApproved — some but not all changed rows approved (the checkbox's
// indeterminate state).
export function blockPartlyApproved(b) {
  const all = changedRows(blockRows(b))
  const set = approvedRowSet(b)
  const done = all.filter((i) => set.has(i)).length
  return done > 0 && done < all.length
}

// toggleBlockApproval flips the whole block from the top checkbox: approve every
// changed row, or (if already fully approved) clear them all.
function toggleBlockApproval(b) {
  b.approvedRows = blockApproved(b) ? [] : changedRows(blockRows(b))
}

// approveSummary is the checkbox label: plain "approve" for a block with no
// navigable changes, else "approve <done>/<total>" so approval progress is legible.
function approveSummary(b) {
  const all = changedRows(blockRows(b))
  if (!all.length) return 'approve'
  const set = approvedRowSet(b)
  const done = all.filter((i) => set.has(i)).length
  return `approve ${done}/${all.length}`
}

// changeGroups collapses runs of consecutive changed rows (del/ins) into
// navigation targets: one group per run, but a run longer than MAX_GROUP rows is
// split into successive groups of that size. Each group is { start, end }
// (inclusive row indices into `rows`). Unchanged rows break a run.
//
// The MAX_GROUP split only happens on a row that carries an actual letter (A-z):
// a changed row whose text is just braces/punctuation (e.g. `}` or `{`) is
// pulled into the current group instead of starting a fresh one, so a group
// never ends right before — or begins on — a bare bracket line.
const MAX_GROUP = 5
export function changeGroups(rows) {
  const groups = []
  let run = null
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const changed = rowChanged(r)
    if (!changed) {
      run = null
      continue
    }
    if (!run || (run.end - run.start + 1 >= MAX_GROUP && hasLetter(r))) {
      run = { start: i, end: i }
      groups.push(run)
    } else {
      run.end = i
    }
  }
  return groups
}

// changeLines is the line-granularity navigation list: one unit per changed row
// that carries *new* code, each a single-row range { start: i, end: i }. Same
// shape as a changeGroups entry so the two are interchangeable for range
// highlighting. Only the new side (the right pane) is navigable — a pure
// deletion (a removed line with no replacement, rightMark !== 'ins') has no new
// code to select, so it's skipped. Added and modified rows both keep their
// right side, so they stay.
export function changeLines(rows) {
  const units = []
  for (let i = 0; i < rows.length; i++) {
    if (rowChanged(rows[i]) && rows[i].rightMark === 'ins') units.push({ start: i, end: i })
  }
  return units
}

// changeCalls is the call-granularity navigation list: one unit per call-chain
// segment of a changed row. Unlike the coarser levels this cuts a line by its
// *structure* (the calls it makes), not by what the diff changed — so later each
// segment can be tied to the function it calls (an edge in the call-graph). A
// line is split on `->`, `;`, the binary separators `??`/`&&`/`||`/comparisons,
// and a call's `(`/argument `,` boundaries (segmentCalls), and — unlike changeLines —
// the WHOLE new line is walked: every non-empty segment is landable, changed or
// not. Each unit is a single-row range { start: i, end: i } tagged `char: true`
// with `left`/`right` Sets of the char indices to underline on each side.
//
// Only new code (the right pane) is segmented: a row that adds new text
// (rightMark === 'ins') is split into its call segments. A removed line with no
// replacement still gets one unit — an empty new segment (nothing right) with the
// whole old line underlined — so you can land on it as a blank row marking what's
// gone.
export function changeCalls(rows) {
  const units = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!rowChanged(r)) continue
    if (r.rightMark === 'ins' && r.right != null) {
      for (const s of rowCallSegments(rows, i))
        units.push({
          start: i,
          end: i,
          char: true,
          left: new Set(),
          right: rangeSet(r.right, s.start, s.end),
          segStart: s.start,
        })
    } else {
      // A removed line with no replacement: land on it as an empty new segment,
      // underlining the whole removed line on the old side so you see what's gone.
      units.push({
        start: i,
        end: i,
        char: true,
        left: fullSet(r.left || ''),
        right: new Set(),
        segStart: 0,
      })
    }
  }
  return units
}

// rowCallSegments lists the call-chain segments of one row's *display* text —
// the new (right) text for a normal/added row, the old (left) text for a pure
// deletion with no replacement — mirroring changeCalls' own split. A segment's
// (untrimmed) start offset is used as its stable per-row approval key (see
// callKey). A row with nothing to split (a blank added line, or no real call
// structure) still yields exactly one segment spanning the whole text, so a
// row always has at least one segment — the fully-approved/none-approved cases
// stay binary and only rows with 2+ segments can be partly approved.
export function rowCallSegments(rows, i) {
  const r = rows[i]
  if (r.rightMark === 'ins' && r.right != null) {
    const segs = segmentCalls(r.right).filter(
      (s) => r.right.slice(s.start, s.end).trim() !== '',
    )
    return segs.length ? segs : [{ start: 0, end: r.right.length }]
  }
  return [{ start: 0, end: (r.left || '').length }]
}

// CALL_SEPARATORS are binary operators that join two *independent* operands —
// each side is its own call chain — so they break a segment and lead the next one
// (like `->`). `$a->x ?? $b->y` must split at `??` so `$a->x` and `$b->y` are
// separate segments (each later tied to its own call-graph edge), otherwise `??`
// gets swallowed into one caller's segment. Besides `??` (null-coalesce) this
// covers the logical `&&`/`||` and the comparisons — all glue two callers.
// Matched longest-first so `===` beats `==` and `!==` beats `!=`.
//
// Deliberately NOT separators (would over-split real chains): `=>` (array
// key=>value stays one segment — see the toArray test), `.` (PHP string
// concatenation, not a call boundary), `::` (static call, part of a chain), the
// ternary `?`/`:` (collide with the `?->` nullsafe operator and `::`), a bare
// `<`/`>` (collide with `->` and `=>`), and arithmetic (rarely a caller boundary,
// and `-`/`/` collide with `->`/`//`).
const CALL_SEPARATORS = ['===', '!==', '??', '&&', '||', '==', '!=', '<=', '>=']

// segmentCalls splits a line into call-chain segments so each caller — and each
// of its arguments — is separately landable. A new segment begins at each `->`
// or a CALL_SEPARATORS operator (the operator starts the call it introduces);
// `;` closes the current one (a statement boundary, kept at the end of its call).
// Two more boundaries separate a call from its arguments: at the *outermost*
// call's opening `(` (when it has real arguments) the caller name ends and the
// first argument starts fresh, and each top-level `,` inside that `(` ends one
// argument. So `$order->customer()->name();` (empty `()`, no args) stays
// `$order` / `->customer()` / `->name();`, while
// `$couple->orWhere('contracts.type', $mapping[$type]);` becomes
// `$couple` / `->orWhere(` / `'contracts.type',` / `$mapping[$type]);`.
// Strings are opaque — no boundary (`->`/`,`/`??`, and PHP's `.` concatenation)
// is ever detected inside a quoted literal, so `'contracts.type'` stays whole.
// Argument splitting is *outermost only*: a nested call or array argument keeps
// its own commas (`foo(bar($a, $b), $c)` → `foo(` / `bar($a, $b),` / `$c)`).
// The segments tile the whole line with no gaps. Returns [{ start, end }]
// half-open char ranges.
function segmentCalls(text) {
  const segs = []
  let start = 0
  const push = (end) => {
    if (end > start) segs.push({ start, end })
    start = end
  }
  // skipString returns the index just past the closing quote of the string that
  // starts at i (text[i] is `'` or `"`), honouring backslash escapes.
  const skipString = (i) => {
    const q = text[i]
    i += 1
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === q) return i + 1
      i += 1
    }
    return i
  }
  const stack = [] // open brackets we're inside: '(', '[' or '{'
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'") {
      i = skipString(i) // strings are opaque — no boundary lives inside one
    } else if (c === '-' && text[i + 1] === '>') {
      push(i) // end current here; `->` starts the next segment
      i += 2
    } else if (c === '(' || c === '[' || c === '{') {
      // Separate the caller name from its arguments only at the outermost call
      // (nothing open yet) that actually has arguments: peek past whitespace, an
      // empty `()` stays with the caller so `->customer()` is one segment.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const outermost = stack.length === 0
      stack.push(c)
      i += 1
      if (c === '(' && outermost && text[j] !== ')') push(i)
    } else if (c === ')' || c === ']' || c === '}') {
      if (stack.length) stack.pop()
      i += 1 // a closer rides along with the segment it ends
    } else if (c === ',' && stack.length === 1 && stack[0] === '(') {
      i += 1
      push(i) // an outermost-call argument boundary; the `,` trails its argument
    } else if (c === ';') {
      i += 1
      push(i) // include `;` in the current segment, then start fresh after it
    } else {
      const op = CALL_SEPARATORS.find((o) => text.startsWith(o, i))
      if (op) {
        push(i) // end current before the operator; it leads the next segment
        i += op.length
      } else {
        i += 1
      }
    }
  }
  push(text.length)
  return segs
}

// rangeSet returns the set of char indices in the half-open range [start, end),
// with leading and trailing whitespace trimmed off so the underline hugs the
// segment's text and never runs across the empty indent before it (or a trailing
// gap). `text` is the full line the range indexes into. Interior whitespace stays
// underlined so a segment reads as one continuous mark.
function rangeSet(text, start, end) {
  let s = start
  let e = end
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  const set = new Set()
  for (let k = s; k < e; k++) set.add(k)
  return set
}

// fullSet returns the set of every non-outer-whitespace char index of a string
// (leading/trailing whitespace trimmed, like rangeSet over the whole line).
function fullSet(s) {
  return rangeSet(s, 0, s.length)
}

// hasLetter reports whether either side of a row contains an ASCII letter (A-z).
// Bracket/punctuation-only rows return false, so they never act as a split
// boundary in changeGroups.
function hasLetter(r) {
  return /[a-z]/i.test(r.left || '') || /[a-z]/i.test(r.right || '')
}

// alignRows turns the old and new source into a list of aligned rows. Each row is
// { left, right, leftMark, rightMark }: `left`/`right` are the line text (or null
// when that side has no line on this row), and the marks ('del'/'ins'/null) drive
// the tint. Unchanged lines pair up; a run of removals is paired line-by-line
// with the following run of additions (so a modified line lines up with its
// replacement), and any overflow becomes one-sided rows.
function alignRows(oldText, newText) {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  const ops = diffLines(a, b)

  const rows = []
  let dels = []
  let inss = []
  const flush = () => {
    const n = Math.max(dels.length, inss.length)
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? dels[i] : null
      const right = i < inss.length ? inss[i] : null
      rows.push({
        left,
        right,
        leftMark: left !== null ? 'del' : null,
        rightMark: right !== null ? 'ins' : null,
      })
    }
    dels = []
    inss = []
  }
  for (const op of ops) {
    if (op.op === 'eq') {
      flush()
      if (op.left === op.right) {
        rows.push({ left: op.left, right: op.right, leftMark: null, rightMark: null })
      } else {
        // Equal but for whitespace: a pure re-indent. Emit it as a paired del/ins
        // row so wsOnly catches it downstream — only the shifted whitespace gets
        // the soft tint, the (unchanged) words are never marked. flush() ran first,
        // so this stays 1:1 aligned and never drifts into the positional pairing.
        rows.push({ left: op.left, right: op.right, leftMark: 'del', rightMark: 'ins' })
      }
    } else if (op.op === 'del') {
      dels.push(op.left)
    } else {
      inss.push(op.right)
    }
  }
  flush()
  return rows
}

// diffLines is a classic LCS line diff: it returns a sequence of ops that turn
// `a` into `b` — { op: 'eq', left, right } for a shared line, { op: 'del', left }
// for a line only in `a`, { op: 'ins', right } for a line only in `b`. Blocks are
// function-sized, so the O(n·m) table is cheap. Lines are matched
// whitespace-insensitively (via `key`, à la `git diff -w`): a line that only got
// re-indented still pairs with its counterpart and comes back as an `eq` op whose
// `left`/`right` differ only in whitespace, so alignRows can show it as a soft
// re-alignment instead of drifting into the positional del/ins pairing.
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  const key = (s) => s.replace(/\s+/g, '')
  const ka = a.map(key)
  const kb = b.map(key)
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      ops.push({ op: 'eq', left: a[i], right: b[j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', left: a[i] })
      i++
    } else {
      ops.push({ op: 'ins', right: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ op: 'del', left: a[i++] })
  while (j < m) ops.push({ op: 'ins', right: b[j++] })
  return ops
}
