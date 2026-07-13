// BlockList — the fixed left sidebar listing every touched block of a PR.
// A component: takes reactive() state and returns an arrow.js template. The
// parent (home.mjs) mounts it and owns the keyboard navigation.

import { html } from './vendor/arrow.js'

// Tailwind classes per category tag, so the pills read like the screenshot.
const CATEGORY_STYLE = {
  ACTION: 'bg-indigo-100 text-indigo-700',
  CONTROLLER: 'bg-sky-100 text-sky-700',
  REQUEST: 'bg-cyan-100 text-cyan-700',
  RESOURCE: 'bg-teal-100 text-teal-700',
  MODEL: 'bg-violet-100 text-violet-700',
  ENUM: 'bg-fuchsia-100 text-fuchsia-700',
  JOB: 'bg-orange-100 text-orange-700',
  EVENT: 'bg-amber-100 text-amber-700',
  LISTENER: 'bg-amber-100 text-amber-700',
  SERVICE: 'bg-blue-100 text-blue-700',
  REPOSITORY: 'bg-lime-100 text-lime-700',
  BUILDER: 'bg-emerald-100 text-emerald-700',
  MIGRATION: 'bg-rose-100 text-rose-700',
  FACTORY: 'bg-pink-100 text-pink-700',
  TEST: 'bg-slate-200 text-slate-600',
  MODULE: 'bg-purple-100 text-purple-700',
  ROUTE: 'bg-green-100 text-green-700',
  CONFIG: 'bg-stone-200 text-stone-600',
  OTHER: 'bg-slate-100 text-slate-600',
}

// Colour + glyph per change status: + new, - gone, -/+ changed.
const STATUS_STYLE = {
  added: { cls: 'text-emerald-600', mark: '+' },
  modified: { cls: 'text-amber-600', mark: '-/+' },
  removed: { cls: 'text-rose-600', mark: '-' },
}

export function categoryClass(cat) {
  return CATEGORY_STYLE[cat] || CATEGORY_STYLE.OTHER
}

export function statusInfo(status) {
  return STATUS_STYLE[status] || { cls: 'text-slate-500', mark: status }
}

export default function BlockList(state) {
  return html`
    <aside
      class="${() =>
        'fixed bottom-[100px] left-6 top-6 flex w-[26rem] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white ring-1 ring-black/5 transition-all duration-200 ease-out ' +
        (state.mode === 'diff'
          ? '-translate-x-[28rem] opacity-0 pointer-events-none'
          : 'translate-x-0 opacity-100')}"
    >
      <header class="shrink-0 border-b border-slate-200 px-4 py-3">
        <div class="flex items-center gap-2">
          <span
            class="rounded bg-emerald-600 px-2 py-0.5 text-xs font-bold tracking-wide text-white"
            >START</span
          >
          <h1 class="text-sm font-semibold text-slate-800">
            Start — where do you want to begin?
          </h1>
        </div>
        <p class="mt-1 text-xs text-slate-500">
          <span class="font-medium text-slate-700"
            >${() => state.blocks.length}</span
          >
          starting points &nbsp;·&nbsp; ↑ ↓ to choose · → to step into the diff ·
          ← to step back
        </p>
      </header>

      <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto" id="block-scroll">
        ${() =>
          state.blocks.length === 0
            ? emptyState(state)
            : state.blocks.map((b, i) => row(state, b, i))}
      </div>
    </aside>
  `
}

function row(state, b, i) {
  const st = statusInfo(b.status)
  return html`
    <div
      data-idx="${i}"
      data-testid="block-row"
      class="${() =>
        'flex cursor-default items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm ' +
        (i === state.selected
          ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-300'
          : 'hover:bg-slate-50')}"
      @click="${() => (state.selected = i)}"
    >
      <span
        class="${() =>
          i === state.selected ? 'text-indigo-500' : 'text-transparent'}"
        >›</span
      >
      <span
        class="${() =>
          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
          categoryClass(b.category)}"
        >${b.category}</span
      >
      <span
        class="flex-1 truncate font-mono text-[13px] text-slate-800"
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
      (done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}"
      data-testid="block-approval"
      title="Goedgekeurde regels (dit block + onderliggende code)"
      >${done ? '✓ ' : ''}${s.done}/${s.total}</span
    >
  `
}

function emptyState(state) {
  return html`
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p class="text-sm text-slate-500">No blocks ingested yet.</p>
      <button
        data-testid="ingest-btn"
        class="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        @click="${() => state.onIngest && state.onIngest()}"
        ?disabled="${() => state.ingesting}"
      >
        ${() => (state.ingesting ? 'Ingesting…' : 'Ingest #' + state.pr)}
      </button>
      ${() =>
        state.error
          ? html`<p class="max-w-xs text-xs text-rose-600">${state.error}</p>`
          : ''}
    </div>
  `
}
