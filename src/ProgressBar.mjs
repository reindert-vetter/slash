// ProgressBar — a very thin, full-width strip fixed at the true bottom of the
// screen showing the PR-wide review progress (lines approved vs. the total
// approvable changed lines), reusing state.approvalTotal ({done, total}) —
// the exact same combined-approval rollup that already feeds BlockList.mjs's
// "X/Y approved · N left to review" heading (see "Combined approval per tree"
// in .claude/docs/approval.md). No new computation, just a different view on
// an existing number.
//
// Deliberately SEPARATE from Footer.mjs and its state.footerVisible gate: the
// footer only shows once there's a navigation unit to preview (list mode/no
// selection hides it), whereas this bar is a PR-wide indicator that must stay
// visible everywhere, including list mode. See "The footer is not the right
// place for a PR-wide indicator" in .claude/docs/footer.md.
//
// No text label (explicitly decided against "X / Y (38%)" — the reviewer only
// asked for the bar). Colourblind-safe without one: the ratio is carried by
// the FILL LENGTH itself (position, not colour), and the track vs. fill use a
// clearly different lightness (not just a different hue) so a low, low
// fraction still visibly reads as "something is filled" without relying on
// colour discrimination — see PROGRESS_BAR_PX's sibling constants below.
//
// PROGRESS_BAR_PX is exported so Footer.mjs (bumps its own fixed root up by
// this much, so the two bars never overlap) and home.mjs's <main> bottom
// reservation (adds it on top of footerBoxPx(state) whenever the footer is
// visible) read the exact same figure — the same "single source of truth"
// pattern footerBoxPx itself already uses.
import { html } from './vendor/arrow.js'

export const PROGRESS_BAR_PX = 3

export default function ProgressBar(state) {
  return html`
    <div
      class="${() => {
        const t = state.approvalTotal || { done: 0, total: 0 }
        return `fixed inset-x-0 bottom-0 z-30 ${t.total > 0 ? 'block' : 'hidden'} h-[${PROGRESS_BAR_PX}px] bg-slate-200 dark:bg-zinc-800`
      }}"
      data-testid="review-progress-bar"
    >
      <div
        class="${() => {
          const t = state.approvalTotal || { done: 0, total: 0 }
          const pct = t.total > 0 ? Math.min(100, Math.max(0, (t.done / t.total) * 100)) : 0
          const complete = t.total > 0 && t.done >= t.total
          const colorCls = complete ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-indigo-600 dark:bg-indigo-400'
          return `h-full ${colorCls} w-[${pct.toFixed(2)}%]`
        }}"
        data-testid="review-progress-fill"
      ></div>
    </div>
  `
}
