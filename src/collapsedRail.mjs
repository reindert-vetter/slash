// collapsedRail.mjs — the shared "collapse to a narrow rail" idiom this app
// uses whenever a column loses the keyboard focus to a sibling and gives up
// its width so the focused one can reclaim it: a slim, full-height, bordered
// button with a chevron and a vertically-written label, click brings the
// focus back. Extracted out of home.mjs's own `collapsedColumnHTML` (the
// drilled/top-level block column's own rail, see .claude/docs/drilling.md)
// so a second caller — the comment↔Claude pair in RelatedPanel.mjs, see
// .claude/docs/comments-panel.md's "Vertical inklappen" section — reuses the
// exact same visual idiom instead of an approximate second copy that would
// drift out of sync over time. `railButtonHTML` (still exported below)
// stays exactly as it was for that RelatedPanel.mjs caller;
// `railGroupHTML`/`railRowHTML` below are the newer, home.mjs-only addition
// that merges several drill/block-column rails into one shared strip — see
// their own doc comments and "Unfocused columns collapse into a single
// shared rail" in .claude/docs/drilling.md.
import { html } from './vendor/arrow.js'

// railGroupHTML combines every currently-collapsed drill/block-column rail
// into ONE bordered strip (`data-testid="collapsed-rail"`) instead of one
// separate w-14 box per level — reviewer report: with 2+ open ancestor
// columns, home.mjs used to render one loose rail button per level, side by
// side, eating one w-14 slot each (see "Unfocused columns collapse into a
// single shared rail" in .claude/docs/drilling.md). `entries` is the plain,
// already-ordered (top-level first, deepest ancestor last, i.e. closest to
// the focused column) array of `railButtonHTML` prop objects (each also
// carrying its own `key`) home.mjs's `collapsedRailEntry` builds.
//
// The inner list is wrapped in its own `${() => ...}` binding — not baked in
// statically — for the same reason `CommentClaudeFooter`'s task list needed
// it (see "A keyed list embedded as a STATIC slot..." in
// .claude/rules/arrowjs-pitfalls.md): `railGroupHTML` is called fresh on
// every re-run of home.mjs's collapsed-rail slot, but the OUTER element this
// returns keeps the same stable `.key('collapsed-rail')` across renders, so
// arrow.js patches the existing chunk instead of remounting it — a plain,
// non-function array value baked into that patched template would never be
// re-diffed again after the very first mount.
export function railGroupHTML(entries) {
  return html`
    <div
      class="flex h-full w-14 shrink-0 flex-col gap-1 divide-y divide-slate-200 dark:divide-zinc-700 overflow-y-auto rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 ring-1 ring-black/5"
      data-testid="collapsed-rail"
    >
      ${() => entries.map((e) => railRowHTML(e).key(e.key))}
    </div>
  `
}

// railRowHTML — one row inside railGroupHTML's shared strip: same icon +
// vertically-written label + click contract as railButtonHTML, but without
// its own border/rounded/bg/ring (the group above already carries those,
// plus a divide-y between rows) so several stacked rows read as ONE rail,
// not several.
function railRowHTML({ label, title, testid, onClick, dataDrillIdx = null }) {
  return html`
    <button
      type="button"
      class="flex min-h-14 w-full flex-1 flex-col items-center justify-center gap-2 py-2 text-slate-500 dark:text-zinc-400 hover:bg-slate-50 dark:hover:bg-zinc-800/60 hover:text-indigo-500 dark:hover:text-indigo-400"
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
