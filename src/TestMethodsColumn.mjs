// TestMethodsColumn — stop 2b of the left→right nav chain (see
// .claude/docs/keyboard-navigation.md), between the pr-index (stop 2) and
// the block-with-diff (stop 3): the list of test methods belonging to the
// currently selected test_class row (see testClassRowItem/recomputeLeftList
// in home.mjs). Rendered directly in <main>'s column flow, to the LEFT of
// the diff card of the active method — always visible as soon as a
// test_class row is selected, in both list and diff mode (decision: no
// separate reveal-on-→ step, unlike drilling — see detail-layout.md).
//
// A component: takes reactive() state + the selected row + whether stop 2b
// currently owns the keyboard, and returns an arrow.js template. Clicking a
// method row both selects it (state.classMethodSel) and gives the column
// keyboard focus (state.testColumnFocused) — home.mjs owns ↑/↓/→/Enter once
// it does.

import { html } from './vendor/arrow.js'
import { blockRows, changedRows, approvedRowSet } from './Block.mjs'
import { categoryClass, statusInfo, commentActivityPill } from './BlockList.mjs'

// methodApproveCount mirrors home.mjs's blockApproveCount for a single real
// PR block (own changed rows only, no nested subtree — a method row's pill
// is deliberately as narrow as the class row's own pill, see
// "Grouping test methods per class" in detail-layout.md). Duplicated instead
// of imported to avoid a leaf component reaching back into the page module —
// the same "small self-contained calculation" precedent as blockRows/
// changedRows/approvedRowSet themselves being reused everywhere.
function methodApproveCount(state, m) {
  const backendTotal =
    state.blockTotals && typeof state.blockTotals[m.id] === 'number' ? state.blockTotals[m.id] : null
  const all = changedRows(blockRows(m))
  const set = approvedRowSet(m)
  if (all.length) {
    const done = all.filter((i) => set.has(i)).length
    return { done, total: backendTotal !== null ? backendTotal : all.length }
  }
  if (backendTotal === null) return { done: 0, total: 0 }
  return { done: Math.min(set.size, backendTotal), total: backendTotal }
}

// methodLabel gives the class-header sentinel block (see classHeaderSentinel
// in phpscan.go — a synthetic block covering a class's header content, e.g.
// properties/traits/constants above the first method) a readable label
// instead of its raw `<class-header>` name — decision: "class-header" (kept
// in the same idiom as the rest of the app's mixed Dutch/English UI text).
// Every other method just shows its bare name (no `Class::` prefix — the
// class is already named in this column's own header).
function methodLabel(m) {
  return m.name === '<class-header>' ? 'Class-header' : m.name
}

function approvePillCls(done, total) {
  if (!total) return 'hidden'
  return (
    'shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums ' +
    (done === total
      ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
      : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500')
  )
}

// methodRow shows, besides its own approve pill, the same avatar+"+N"
// comment-activity indicator the sidebar rows show (BlockList.mjs's exported
// commentActivityPill, reused as-is — not a parallel implementation), fed by
// state.commentActivity[m.id]: home.mjs's decoupled commentActivity watch
// fills a per-method entry for every method of a test_class row, alongside
// its existing per-row entry, via commentScopeKeys(m) (which works unchanged
// for a single real PR block).
function methodRow(state, row, m, idx) {
  const active = idx === state.classMethodSel
  const c = methodApproveCount(state, m)
  const st = statusInfo(m.status)
  return html`
    <div
      data-testid="test-method-row"
      data-idx="${idx}"
      class="${() =>
        // Same full-border treatment (always 1px, colour-only toggle) as
        // BlockList.mjs's sidebar row — see its comment for why the
        // bg-indigo-50 + ring stays alongside the border.
        'flex cursor-default items-center gap-2 border px-3 py-1.5 text-sm ' +
        (active
          ? 'border-indigo-300 dark:border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.classMethodSel = idx
        state.testColumnFocused = true
      }}"
    >
      <span
        class="${() => (active ? 'text-indigo-500 dark:text-indigo-400' : 'text-transparent')}"
        >›</span
      >
      <span
        class="flex-1 truncate font-mono text-[12px] text-slate-800 dark:text-zinc-200"
        title="${methodLabel(m)}"
        >${methodLabel(m)}</span
      >
      ${() => commentActivityPill(state, m)}
      <span class="${() => approvePillCls(c.done, c.total)}"
        >${c.done === c.total && c.total ? '✓ ' : ''}${c.done}/${c.total}</span
      >
      <span class="${() => 'shrink-0 text-xs font-medium ' + st.cls}">${st.mark}</span>
    </div>
  `.key(m.id + ':' + (m.approvedRows ? m.approvedRows.length : 0) + ':' + (m.approvedCalls ? m.approvedCalls.length : 0))
}

export default function TestMethodsColumn(state, row, onApproveClass) {
  return html`
    <div
      class="${() =>
        'flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-xl border bg-white dark:bg-zinc-900 ' +
        // Same on/off indigo focus border as every other stop of the
        // left→right nav chain (see "Focus highlight per stop" in
        // keyboard-navigation.md) — a live read of state.testColumnFocused,
        // not a snapshotted boolean prop, so it stays correct even if
        // arrow.js reuses this component instance across an unrelated
        // re-render (the caller's own key only forces a fresh node on a
        // codeVersion/focusLevel/method-set change, not on every focus
        // toggle — see home.mjs's DetailPanel).
        (state.testColumnFocused
          ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'border-slate-300 dark:border-zinc-700 ring-1 ring-black/5')}"
      data-testid="test-methods-column"
    >
      <header class="shrink-0 border-b border-slate-200 dark:border-zinc-800 px-3 py-2">
        <div class="flex items-center gap-2">
          <span
            class="${'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' + categoryClass('TEST')}"
            >TEST</span
          >
          <span class="flex-1 truncate text-sm font-semibold text-slate-800 dark:text-zinc-200" title="${row.label}"
            >${row.label}</span
          >
        </div>
        ${() => {
          // Class-level checkbox — the same "top checkbox on a block card"
          // convention as Block.mjs's blockApproved/blockPartlyApproved/
          // toggleBlockApproval (checked/indeterminate off a done/total
          // fraction, click approves-or-clears everything), applied to every
          // method of this class in one action instead of one block's rows.
          // Reuses the same {done,total} the plain pill used to show
          // (state.approvalSummaries[row.id], the narrow "own rows only" sum
          // — see blockApproveCount's test_class branch), so appearance is
          // unchanged until the reviewer actually clicks. See "Approving the
          // whole class in one action" in test-class-grouping.md.
          const s = state.approvalSummaries && state.approvalSummaries[row.id]
          if (!s || !s.total) return ''
          const done = s.done === s.total
          return html`
            <label
              class="mt-1 flex cursor-pointer items-center gap-1.5 text-xs"
              data-testid="test-class-approve-checkbox"
            >
              <input
                type="checkbox"
                class="h-3.5 w-3.5 rounded border-slate-300 dark:border-zinc-700"
                checked="${() => done}"
                .indeterminate="${() => s.done > 0 && !done}"
                @change="${() => onApproveClass && onApproveClass(row)}"
              />
              <span
                class="${'rounded px-1.5 py-0.5 font-semibold tabular-nums ' +
                (done
                  ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                  : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400')}"
                data-testid="test-class-approval"
                >${done ? '✓ ' : ''}${s.done}/${s.total} methodes</span
              >
            </label>
          `
        }}
      </header>
      <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        ${() => row.methods.map((m, idx) => methodRow(state, row, m, idx))}
      </div>
    </div>
  `
}
