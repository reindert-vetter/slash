// Footer — the fixed bottom bar under the sidebar and detail panel. It is only
// shown once there is actually something to preview: state.footerVisible
// (derived in home.mjs's updateFooter() as
// `!!(state.footerUnit || state.footerExplain)`) — the AI-generated Dutch
// description of the focused unit's if-statement, or the inline diff of the
// active line (- removed / + added, when the active unit is a single row).
// A multi-row group with neither (no if, not a single row) hides the bar
// entirely, rather than showing an empty balk for the whole diff-mode
// session as before. The panels above reserve 0/90/140px to match (0 when
// !footerVisible, 90 with just the inline diff, 140 while a description also
// shows — the reactive bottom-[…] bindings in home.mjs/RelatedPanel.mjs), so
// nothing is reserved when the footer itself is gone.
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
// gutter). Above it we drop the max-width so the footer uses the full width and
// you can read (or scroll) more of the line before it clips.
const WIDE_AT = 150

// wrapClass picks the inner column width: centred (max-w-5xl) for short lines so
// it stays aligned with the panels above, full width once the active line is long.
function wrapClass(state) {
  const r = state.footerUnit
  const len = r ? Math.max((r.left || '').length, (r.right || '').length) : 0
  const width = len > WIDE_AT ? 'max-w-none' : 'max-w-5xl'
  return `flex w-full ${width} flex-col gap-1.5`
}

// explainText renders the AI-description line: the Dutch explanation once it is
// done, a subdued "genereren…" while the explain_code workflow runs, and ''
// (the <p> is hidden via its class below) when the focused unit has no
// if-statement / the generation failed.
function explainText(state) {
  const e = state.footerExplain
  if (!e) return ''
  return e.status === 'done' ? e.text : 'AI-omschrijving genereren…'
}

export default function Footer(state) {
  // Only reveal the footer once state.footerVisible is true — there is
  // nothing to preview otherwise (list mode, or a multi-row group with no
  // if-statement). The footer grows to 140px while the description shows so
  // 1-2 full sentences fit above the inline diff. Every class string is one
  // reactive function binding (arrow.js requires the full attribute value in
  // a single binding, see .claude/rules/conventions.md); the `hidden` toggle
  // just adds/removes `display:none` on this stable <footer> root, so no
  // keyed-node pitfall applies.
  return html`
    <footer
      class="${() =>
        `fixed bottom-0 left-0 right-0 z-20 ${state.footerVisible ? 'flex' : 'hidden'} ${state.footerExplain ? 'h-[140px]' : 'h-[90px]'} justify-center border-t border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-2.5`}"
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
        <div
          class="no-scrollbar min-h-0 flex-1 overflow-auto"
          data-testid="footer-diff"
        >
          <code
            class="language-php m-0 block font-mono text-[11px] leading-relaxed text-slate-700 dark:text-zinc-300"
            data-testid="code-diff"
            .innerHTML="${() => {
              const r = state.footerUnit
              if (!r) return ''
              // Rebuild the underline Sets from the plain arrays the snapshot
              // carries (see footerUnitInfo in home.mjs).
              const ulLeft = r.ulLeft ? new Set(r.ulLeft) : null
              const ulRight = r.ulRight ? new Set(r.ulRight) : null
              let s = ''
              if (r.left !== null && r.left !== undefined)
                s += `<div class="block whitespace-pre bg-rose-100 dark:bg-rose-500/20">${line('del', r.left, ulLeft)}</div>`
              if (r.right !== null && r.right !== undefined)
                s += `<div class="block whitespace-pre bg-emerald-100 dark:bg-emerald-500/20">${line('ins', r.right, ulRight)}</div>`
              return s
            }}"
          ></code>
        </div>
      </div>
    </footer>
  `
}
