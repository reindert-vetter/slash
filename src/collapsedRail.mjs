// collapsedRail.mjs — the shared "collapse to a narrow rail" idiom this app
// uses whenever a column loses the keyboard focus to a sibling and gives up
// its width so the focused one can reclaim it: a slim, full-height, bordered
// button with a chevron and a vertically-written label, click brings the
// focus back. Extracted out of home.mjs's own `collapsedColumnHTML` (the
// drilled/top-level block column's own rail, see .claude/docs/drilling.md)
// so a second caller — the comment↔Claude pair in RelatedPanel.mjs, see
// .claude/docs/comments-panel.md's "Vertical inklappen" section — reuses the
// exact same visual idiom instead of an approximate second copy that would
// drift out of sync over time. `collapsedColumnHTML` itself is unchanged in
// behavior: it just forwards to this now, verbatim markup/classes.
import { html } from './vendor/arrow.js'

// `dataDrillIdx` mirrors collapsedColumnHTML's own optional `drillIdx` param
// (null for a rail that isn't one of state.drill's own entries) — always
// rendered as `data-drill-idx` (empty string when null/omitted), matching
// the pre-extraction markup exactly so no existing selector/test changes.
export function railButtonHTML({ label, title, testid, onClick, dataDrillIdx = null }) {
  return html`
    <button
      type="button"
      class="flex h-full w-14 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5 text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60 hover:text-indigo-500 dark:hover:text-indigo-400"
      data-testid="${testid}"
      data-drill-idx="${dataDrillIdx === null ? '' : dataDrillIdx}"
      title="${title || ''}"
      @click="${() => onClick()}"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-4 w-4 shrink-0"
      ><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
      <span class="max-h-40 overflow-hidden text-ellipsis text-[10px] font-medium [writing-mode:vertical-rl]"
        >${label}</span
      >
    </button>
  `
}
