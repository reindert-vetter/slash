// Footer — the fixed bottom bar under the sidebar and detail panel. It is only
// shown once there is actually something to preview: state.footerVisible
// (derived in home.mjs's updateFooter() as
// `!!(state.footerUnit || state.footerExplain)`) — the AI-generated Dutch
// description of the focused unit (Opus, every line/group unit with code, not
// just an if-statement), or the inline diff of the active unit's rows
// (- removed / + added per changed line: one row for a line/call unit, one
// row per changed line for a multi-row group — so selecting a whole
// change-group/"block" shows a per-line breakdown of what changed, not just
// a one-liner). A unit with neither (blank/whitespace-only, and — in practice
// never, every navigable unit has at least one row) hides the bar entirely,
// rather than showing an empty balk for the whole diff-mode session as
// before.
//
// The bar's own height is NOT a fixed 90/140px tier anymore — footerBoxPx(state)
// (exported below) sizes it to what its actual content needs (a small chrome
// allowance + one line per rendered '-'/'+' row +, while an AI description
// shows, room for up to its line-clamp-2 cap), clamped between FOOTER_MIN_PX
// and FOOTER_MAX_PX. This is a deliberate character/line-COUNT estimate, not a
// DOM measurement (no ResizeObserver/scrollHeight read that could race with
// this same render) — the same technique Block.mjs's widthCls/fitWidthCls and
// RelatedPanel.mjs's relatedColumnWidthCls already use for WIDTH, just applied
// to height: a fixed per-line px constant times a known row/line count. Two
// deliberately accepted approximations: (1) the description's actual line
// count (1 vs. 2) isn't known without measuring text-wrap, so a visible
// description ALWAYS reserves room for its full line-clamp-2 cap (2 lines),
// even when the text only needs 1 — a residual, minor over-reservation, still
// far closer to reality than the previous flat +50px (90→140) jump regardless
// of how many diff rows were shown alongside it. (2) FOOTER_MAX_PX (140) keeps
// the same ceiling the old, bigger tier already had — a very long multi-row
// group still scrolls inside the existing no-scrollbar/overflow-auto code area
// (data-testid=footer-diff) rather than growing the bar past it.
//
// footerBoxPx(state) is THE single source of truth for this height — home.mjs's
// <main> bottom-reservation reads the exact same function (imported from here),
// so the footer's own box and the space the panels above it reserve can never
// drift apart (see "Footer" in keyboard-navigation.md and the look-ahead
// preview-collapse mechanism in detail-layout.md, which also reads this value
// to know how much room is actually left for the active card).
//
// A separate, always-visible PR-wide progress bar (ProgressBar.mjs) sits BELOW
// this footer, at the true bottom-0 of the screen (this footer's own root is
// therefore bottom-[PROGRESS_BAR_PX]px, not bottom-0) — see "A separate,
// always-visible progress bar" in footer.md for why it's not folded into this
// component's own footerVisible gate.
//
// The theme toggle (system/light/dark) used to live in this footer's top-right
// corner, then in its own always-visible fixed corner element — it now lives
// in prInfoCard (home.mjs), in a slim row just above the PR summary, since the
// footer here is no longer reliably present to anchor a corner slot to (see
// the "Thema" section in conventions.md).
//
// The footer reads ONLY the plain snapshots state.footerUnit/state.footerExplain
// that home.mjs' footer watch pushes (the setRelated/setCommentScope decoupling
// pattern): it never touches blockRows/b.code itself — that would make it a
// co-subscriber on the focused block's code (the diff "stuck on loading" race,
// see conventions.md) — and the snapshots already follow the focused column
// (a drilled column's own cursor included), which a plain
// state.selected/gran/change read here could not.

import { html } from './vendor/arrow.js'
import { highlight, markChars, UNDERLINE_CLS } from './Block.mjs'
import { PROGRESS_BAR_PX } from './ProgressBar.mjs'

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

// WIDE_AT is the char-count past which a diff line no longer comfortably fits in
// the centred max-w-5xl column (~1024px at the 11px mono font, minus the +/-
// gutter). Above it we drop the max-width so the footer uses the full width,
// AND — for whichever of the old/left (del) or new/right (ins) line is long —
// switch that line from whitespace-pre to a wrap so the entire line is
// visible without an invisible (no-scrollbar) horizontal scroll. One shared
// threshold for both, so they can't drift apart.
const WIDE_AT = 110

// footerBoxPx constants — a per-line px estimate, not a measurement (see the
// module doc comment above). FOOTER_PADDING_PX is the bar's own py-2.5 top+
// bottom padding; FOOTER_GAP_PX is the gap-1.5 between the description line
// and the diff block, only counted while BOTH are present; FOOTER_DIFF_LINE_PX
// is one code row at the pane's own text-[11px] leading-relaxed (≈11×1.625);
// FOOTER_EXPLAIN_LINES_PX reserves for the description's line-clamp-2 ceiling
// (2 lines at text-xs leading-relaxed, ≈12×1.625 each) — always the full 2,
// see the accepted-imprecision note above. FOOTER_MIN_PX/FOOTER_MAX_PX floor
// and cap the result — MAX is unchanged from the previous larger (140px) tier.
const FOOTER_PADDING_PX = 20
const FOOTER_GAP_PX = 6
const FOOTER_DIFF_LINE_PX = 18
const FOOTER_EXPLAIN_LINES_PX = 40
const FOOTER_MIN_PX = 56
const FOOTER_MAX_PX = 140

// footerBoxPx — the footer's own visible box height in px, derived purely from
// already-known counts (state.footerUnit's row shape, state.footerExplain's
// presence): never a DOM measurement, so it can't race this same render (see
// the module doc comment). Exported so home.mjs's <main> bottom-reservation
// (and the look-ahead preview-collapse decision, see detail-layout.md) read
// the EXACT same number — the single source of truth that keeps the footer's
// own height and the space reserved for it from ever drifting apart. Returns
// 0 while the footer itself is hidden (state.footerVisible false), so a
// caller can use it directly as a reservation/availability figure too.
export function footerBoxPx(state) {
  if (!state.footerVisible) return 0
  let diffLines = 0
  const rows = state.footerUnit
  if (rows)
    for (const r of rows) {
      if (r.left !== null && r.left !== undefined) diffLines++
      if (r.right !== null && r.right !== undefined) diffLines++
    }
  const hasExplain = !!state.footerExplain
  let px = FOOTER_PADDING_PX
  if (diffLines > 0 && hasExplain) px += FOOTER_GAP_PX
  px += diffLines * FOOTER_DIFF_LINE_PX
  if (hasExplain) px += FOOTER_EXPLAIN_LINES_PX
  return Math.max(FOOTER_MIN_PX, Math.min(FOOTER_MAX_PX, px))
}

// wrapClass picks the inner column width: centred (max-w-5xl) for short lines so
// it stays aligned with the panels above, full width once any row of the active
// unit is long (a multi-row group takes the longest line across all its rows).
function wrapClass(state) {
  const rows = state.footerUnit
  let len = 0
  if (rows) for (const r of rows) len = Math.max(len, (r.left || '').length, (r.right || '').length)
  const width = len > WIDE_AT ? 'max-w-none' : 'max-w-5xl'
  return `flex w-full ${width} flex-col gap-1.5`
}

// explainText renders the AI-description line: the Dutch explanation once it is
// done, a subdued "genereren…" while the explain_code workflow runs, and ''
// (the <p> is hidden via its class below) when the focused unit has no
// code / the generation failed.
function explainText(state) {
  const e = state.footerExplain
  if (!e) return ''
  return e.status === 'done' ? e.text : 'AI-omschrijving genereren…'
}

export default function Footer(state) {
  // Only reveal the footer once state.footerVisible is true — there is
  // nothing to preview otherwise (list mode, or a unit with no code). The
  // footer's own height is footerBoxPx(state) — content-driven (see the
  // module doc comment above), not a fixed 90/140px tier — so it only takes
  // as much room as its actual content needs, clamped at FOOTER_MAX_PX. Every
  // class string is one reactive function binding (arrow.js requires the full
  // attribute value in a single binding, see .claude/rules/conventions.md);
  // the `hidden` toggle just adds/removes `display:none` on this stable
  // <footer> root, so no keyed-node pitfall applies.
  return html`
    <footer
      class="${() =>
        `fixed bottom-[${PROGRESS_BAR_PX}px] left-0 right-0 z-20 ${state.footerVisible ? 'flex' : 'hidden'} h-[${footerBoxPx(state)}px] justify-center border-t border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-2.5`}"
      data-testid="footer"
    >
      <div class="${() => wrapClass(state)}">
        <p
          class="${() =>
            `shrink-0 text-xs leading-relaxed line-clamp-2 ${state.footerExplain ? '' : 'hidden'} ${
              state.footerExplain && state.footerExplain.status !== 'done'
                ? 'italic text-slate-400 dark:text-zinc-500 animate-pulse'
                : 'text-slate-600 dark:text-zinc-300'
            }`}"
          data-testid="footer-description"
        >
          ${() => explainText(state)}
        </p>
        <div class="relative min-h-0 flex-1">
          <div
            class="no-scrollbar min-h-0 h-full overflow-auto"
            data-testid="footer-diff"
          >
            <code
              class="language-php m-0 block font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
              data-testid="code-diff"
              .innerHTML="${() => {
                const rows = state.footerUnit
                if (!rows) return ''
                // One row for a line/call unit (always single-row), one row per
                // changed line for a multi-row group — same per-row del/ins markup
                // as before, just looped over every row the active unit spans.
                let s = ''
                for (const r of rows) {
                  // Rebuild the underline Sets from the plain arrays the snapshot
                  // carries (see footerUnitInfo in home.mjs).
                  const ulLeft = r.ulLeft ? new Set(r.ulLeft) : null
                  const ulRight = r.ulRight ? new Set(r.ulRight) : null
                  // A long old/left or new/right line wraps in full (rather than
                  // requiring an invisible no-scrollbar horizontal scroll) so the
                  // reviewer sees the entire line — see the WIDE_AT comment above.
                  if (r.left !== null && r.left !== undefined) {
                    const leftWrap = r.left.length > WIDE_AT ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
                    s += `<div class="block ${leftWrap} bg-rose-100 dark:bg-rose-500/20">${line('del', r.left, ulLeft)}</div>`
                  }
                  if (r.right !== null && r.right !== undefined) {
                    const rightWrap = r.right.length > WIDE_AT ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
                    s += `<div class="block ${rightWrap} bg-emerald-100 dark:bg-emerald-500/20">${line('ins', r.right, ulRight)}</div>`
                  }
                }
                return s
              }}"
            ></code>
          </div>
        </div>
      </div>
    </footer>
  `
}
