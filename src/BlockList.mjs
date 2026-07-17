// BlockList — the fixed left sidebar listing every touched block of a PR.
// A component: takes reactive() state and returns an arrow.js template. The
// parent (home.mjs) mounts it and owns the keyboard navigation.

import { html } from './vendor/arrow.js'

// Tailwind classes per category tag, so the pills read like the screenshot.
const CATEGORY_STYLE = {
  ACTION: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300',
  CONTROLLER: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300',
  REQUEST: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  RESOURCE: 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-300',
  MODEL: 'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300',
  ENUM: 'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300',
  JOB: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300',
  EVENT: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  LISTENER: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  SERVICE: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300',
  REPOSITORY: 'bg-lime-100 dark:bg-lime-500/20 text-lime-700 dark:text-lime-300',
  BUILDER: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  MIGRATION: 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300',
  FACTORY: 'bg-pink-100 dark:bg-pink-500/20 text-pink-700 dark:text-pink-300',
  TEST: 'bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400',
  MODULE: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300',
  ROUTE: 'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300',
  CONFIG: 'bg-stone-200 dark:bg-stone-500/20 text-stone-600 dark:text-stone-400',
  OTHER: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400',
}

// Colour + glyph per change status: + new, - gone, -/+ changed.
const STATUS_STYLE = {
  added: { cls: 'text-emerald-600 dark:text-emerald-400', mark: '+' },
  modified: { cls: 'text-amber-600 dark:text-amber-400', mark: '-/+' },
  removed: { cls: 'text-rose-600 dark:text-rose-400', mark: '-' },
}

export function categoryClass(cat) {
  return CATEGORY_STYLE[cat] || CATEGORY_STYLE.OTHER
}

export function statusInfo(status) {
  return STATUS_STYLE[status] || { cls: 'text-slate-500 dark:text-zinc-500', mark: status }
}

export default function BlockList(state) {
  return html`
    <aside
      data-testid="pr-index"
      class="${() =>
        'fixed bottom-[100px] left-6 top-6 flex w-[26rem] flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900 transition-all duration-200 ease-out ' +
        // Light-blue border while the keyboard drives stop 2 (list-mode, not
        // showing the description) — mirrors diffActive on the block-diff card
        // and the stop-1 border above, so all three stops highlight the same way.
        (state.mode === 'list' && !state.showDescription
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-200 dark:border-zinc-800 ring-1 ring-black/5') +
        ' ' +
        (state.mode === 'diff'
          ? '-translate-x-[28rem] opacity-0 pointer-events-none'
          : // showDescription (stop 1, list-mode only) slides this pr-index one
            // column-width right so the PR-description panel can take its usual
            // left-6 spot instead of appearing after it — see PrInfoPanel/
            // detail-layout.md. 27.5rem = the description panel's own width
            // (26rem) plus the 1.5rem gap it leaves before the pr-index, so the
            // two sit flush next to each other exactly like pr-index/<main> do.
            state.showDescription
            ? 'translate-x-[27.5rem] opacity-100'
            : 'translate-x-0 opacity-100')}"
    >
      <header class="shrink-0 border-b border-slate-200 dark:border-zinc-800 px-4 py-3">
        <div class="flex items-center gap-2">
          <span
            class="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold tracking-wide text-white"
            >START</span
          >
          <h1 class="text-sm font-semibold text-slate-800 dark:text-zinc-200">
            Start — where do you want to begin?
          </h1>
        </div>
        <p class="mt-1 text-xs text-slate-500 dark:text-zinc-500">
          <span class="font-medium text-slate-700 dark:text-zinc-300"
            >${() => state.blocks.length}</span
          >
          starting points &nbsp;·&nbsp; ↑ ↓ to choose · → to step into the diff ·
          ← to search
        </p>
        ${() => approvalSummaryLine(state)}
        <input
          id="block-search"
          data-testid="block-search"
          type="text"
          placeholder="Search starting points…"
          autocomplete="off"
          spellcheck="false"
          class="${() =>
            'mt-2 w-full rounded-lg border bg-slate-50 dark:bg-zinc-800/60 px-3 py-1.5 text-sm text-slate-800 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none ' +
            (state.searchActive
              ? 'border-indigo-300 dark:border-indigo-500 bg-white dark:bg-zinc-900 ring-2 ring-indigo-200 dark:ring-indigo-500/30'
              : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700')}"
          @input="${(e) => state.onSearch && state.onSearch(e.target.value)}"
          @focus="${() => (state.searchActive = true)}"
          @blur="${() => (state.searchActive = false)}"
        />
      </header>

      <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto" id="block-scroll">
        ${() => renderList(state)}
      </div>
    </aside>
  `
}

// isFullyApproved reports whether a top-level block (and its whole subtree) is
// completely approved — the same green ✓ state the row pill shows. Driven by the
// server-backed combined-approval summary (state.approvalSummaries), so it's right
// even before a block's code has lazily loaded.
export function isFullyApproved(state, b) {
  const s = state.approvalSummaries && state.approvalSummaries[b.id]
  return !!s && s.total > 0 && s.done === s.total
}

// renderList builds the starting-points list. Fully-approved blocks are hidden by
// default (state.showApproved === false) and revealed by a toggle row at the
// bottom. It ALWAYS returns a keyed array (never a bare element), so arrow.js
// never freezes on a single↔array slot-shape switch (see conventions.md): the
// empty state is wrapped as an array of one keyed element.
function renderList(state) {
  if (state.blocks.length === 0) return [emptyState(state).key('empty')]
  const approvedCount = state.blocks.filter((b) => isFullyApproved(state, b)).length
  const items = []
  state.blocks.forEach((b, i) => {
    if (!state.showApproved && isFullyApproved(state, b)) return
    items.push(row(state, b, i))
  })
  if (approvedCount > 0) items.push(toggleRow(state, approvedCount))
  return items
}

// toggleRow is the bottom button that hides/shows the fully-approved blocks.
function toggleRow(state, count) {
  return html`
    <button
      data-testid="toggle-approved"
      class="w-full border-t border-slate-100 dark:border-zinc-800/60 px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-zinc-500 hover:bg-slate-50 dark:hover:bg-zinc-800/60"
      @click="${() => (state.showApproved = !state.showApproved)}"
    >
      ${() =>
        state.showApproved
          ? `Verberg ${count} goedgekeurde ${count === 1 ? 'block' : 'blocks'}`
          : `Toon ${count} goedgekeurde ${count === 1 ? 'block' : 'blocks'}`}
    </button>
  `.key('toggle-approved')
}

// approvalSummaryLine is the PR-wide combined-approval counter in the header,
// fed by the server-backed total (state.approvalTotal). Hidden until there's
// anything to approve.
function approvalSummaryLine(state) {
  const t = state.approvalTotal
  if (!t || t.total === 0) return ''
  const done = t.done === t.total
  const remaining = t.total - t.done
  return html`
    <p class="mt-1 text-xs" data-testid="approval-summary">
      <span
        class="${'rounded px-1.5 py-0.5 font-semibold tabular-nums ' +
        (done ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400')}"
        >${done ? '✓ ' : ''}${t.done}/${t.total} goedgekeurd</span
      >
      ${() =>
        done
          ? ''
          : html`<span class="ml-1 text-slate-500 dark:text-zinc-500"
              >· ${remaining} nog te reviewen</span
            >`}
    </p>
  `
}

function row(state, b, i) {
  const st = statusInfo(b.status)
  return html`
    <div
      data-idx="${i}"
      data-testid="block-row"
      class="${() =>
        'flex cursor-default items-center gap-2 border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2 text-sm ' +
        (i === state.selected
          ? 'bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-300 dark:ring-indigo-500/40'
          : 'hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => (state.selected = i)}"
    >
      <span
        class="${() =>
          i === state.selected ? 'text-indigo-500 dark:text-indigo-400' : 'text-transparent'}"
        >›</span
      >
      <span
        class="${() =>
          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
          categoryClass(b.category)}"
        >${b.category}</span
      >
      <span
        class="flex-1 truncate font-mono text-[13px] text-slate-800 dark:text-zinc-200"
        title="${b.label}"
        >${b.label}</span
      >
      ${() => approvalPill(state, b)}
      <span class="${() => 'shrink-0 text-xs font-medium ' + st.cls}"
        >${st.mark}</span
      >
    </div>
  `.key(b.file + ':' + b.label + ':' + b.side)
}

// approvalPill shows the combined approval progress of a block *and every block
// nested under it* (the count home.mjs rolls up into state.approvalSummaries):
// "done/total", green with a ✓ once everything is approved, neutral while
// partial. Hidden only when there's nothing to approve yet (total 0 — e.g. code
// still loading); the done state is always shown, never hidden.
function approvalPill(state, b) {
  const s = state.approvalSummaries && state.approvalSummaries[b.id]
  if (!s || s.total === 0) return ''
  const done = s.done === s.total
  return html`
    <span
      class="${'shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums ' +
      (done ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500')}"
      data-testid="block-approval"
      title="Goedgekeurde regels (dit block + onderliggende code)"
      >${done ? '✓ ' : ''}${s.done}/${s.total}</span
    >
  `
}

function emptyState(state) {
  return html`
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="text-sm text-slate-500 dark:text-zinc-500">No blocks ingested yet.</p>
      <button
        data-testid="ingest-btn"
        class="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        @click="${() => state.onIngest && state.onIngest()}"
        ?disabled="${() => state.ingesting}"
      >
        ${() => (state.ingesting ? 'Ingesting…' : 'Ingest #' + state.pr)}
      </button>
      ${() =>
        state.error
          ? html`<p class="max-w-xs text-xs text-rose-600 dark:text-rose-400">${state.error}</p>`
          : ''}
    </div>
  `
}
