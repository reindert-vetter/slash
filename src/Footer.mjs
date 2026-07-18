// Footer — the fixed bottom bar under the sidebar and detail panel. It is only
// shown while a diff is open (any granularity — group, line or call); it holds
// the inline diff of the active line (- removed / + added, when the active
// unit is a single row). In list mode (no diff open) it is hidden entirely.
// The panels above reserve 90px for it.

import { html } from './vendor/arrow.js'
import { blockRows, unitsFor, highlight, markChars, UNDERLINE_CLS } from './Block.mjs'
import { themeToggleButton } from './theme.mjs'

// line builds the innerHTML for one footer diff line: a non-selectable +/- gutter
// followed by the Prism-highlighted PHP, so it reads exactly like a row in the
// block's code panes. `underline`, when given, is a Set of char indices (the active
// call segment) that get the indigo underline — so the footer mirrors the pane's
// `'call'`-granularity marker. `highlight` escapes the text, the gutter is our own
// static markup, so the string is safe for the .innerHTML binding.
function line(mark, text, underline) {
  const gutter = mark === 'del' ? 'text-rose-500 dark:text-rose-400' : 'text-emerald-500'
  const code = underline
    ? markChars(highlight(text), (pi) => (underline.has(pi) ? UNDERLINE_CLS : ''))
    : highlight(text)
  return `<span class="select-none ${gutter}">${mark === 'del' ? '-' : '+'} </span>${code}`
}

// activeUnit returns the single aligned row the reviewer has selected together
// with the active unit's underline sets (`ulLeft`/`ulRight` — the char indices of
// the active call segment, only present on a `'call'` unit), but only when the
// active unit spans exactly one row. For multi-line selections it returns null, so
// the footer shows no inline diff — we only preview one-liners. It follows the
// *current* granularity: list mode previews the first change group, diff mode
// follows state.change through the units of state.gran. Since a line- or
// call-granularity unit is always a single row, refining a selection with f down to
// one line (or one segment) always surfaces it here.
function activeUnit(state) {
  const b = state.blocks[state.selected]
  if (!b) return null
  const rows = blockRows(b)
  const gran = state.mode === 'diff' ? state.gran : 'group'
  const idx = state.mode === 'diff' ? state.change : 0
  const g = unitsFor(rows, gran)[idx]
  if (!g || g.start !== g.end) return null
  const row = rows[g.start]
  if (!row) return null
  return { row, ulLeft: g.left || null, ulRight: g.right || null }
}

// WIDE_AT is the char-count past which a diff line no longer comfortably fits in
// the centred max-w-5xl column (~1024px at the 11px mono font, minus the +/-
// gutter). Above it we drop the max-width so the footer uses the full width and
// you can read (or scroll) more of the line before it clips.
const WIDE_AT = 150

// wrapClass picks the inner column width: centred (max-w-5xl) for short lines so
// it stays aligned with the panels above, full width once the active line is long.
function wrapClass(state) {
  const u = activeUnit(state)
  const r = u && u.row
  const len = r ? Math.max((r.left || '').length, (r.right || '').length) : 0
  const width = len > WIDE_AT ? 'max-w-none' : 'max-w-5xl'
  return `flex w-full ${width} flex-col gap-1.5`
}

export default function Footer(state) {
  // Only reveal the footer while a diff is open — any granularity (group,
  // line or call) — since there is nothing to preview in list mode. The
  // inline diff *content* below (activeUnit) is unrelated and still only
  // appears once the active unit narrows to a single row; a multi-row group
  // just shows the (empty) bar, no diff. The whole class string is one
  // reactive function binding (arrow.js requires the full attribute value in
  // a single binding, see .claude/rules/conventions.md); the `hidden` toggle
  // just adds/removes `display:none` on the stable <footer> root, so no
  // keyed-node pitfall applies.
  return html`
    <footer
      class="${() =>
        `fixed bottom-0 left-0 right-0 z-20 ${state.mode === 'diff' ? 'flex' : 'hidden'} h-[90px] justify-center border-t border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-2.5`}"
      data-testid="footer"
    >
      <div class="absolute right-4 top-1/2 -translate-y-1/2">${themeToggleButton('h-8 w-8')}</div>
      <div class="${() => wrapClass(state)}">
        <div
          class="no-scrollbar min-h-0 flex-1 overflow-auto"
          data-testid="footer-diff"
        >
          <code
            class="language-php m-0 block font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
            data-testid="code-diff"
            .innerHTML="${() => {
              const u = activeUnit(state)
              if (!u) return ''
              const r = u.row
              let s = ''
              if (r.left !== null)
                s += `<div class="block whitespace-pre bg-rose-100 dark:bg-rose-500/20">${line('del', r.left, u.ulLeft)}</div>`
              if (r.right !== null)
                s += `<div class="block whitespace-pre bg-emerald-100 dark:bg-emerald-500/20">${line('ins', r.right, u.ulRight)}</div>`
              return s
            }}"
          ></code>
        </div>
      </div>
    </footer>
  `
}
