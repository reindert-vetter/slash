// runningTasks — the "N actief" pill and the popup behind it: what is running
// RIGHT NOW. Shared by /pr-overview (its header), /pr/<id> (the PR-info card's
// button row) and /plan/<KEY>.
//
// Reviewer request: click the pill to see what is actually running, "gebruik
// een popup zoals errors heeft, maar zelfde tekst als onder de pr description
// (Taken-blok)". So:
//  - The popup is a modal in the mould of failedTasks.mjs: backdrop, owns the
//    keyboard (Escape / click outside closes, everything else is swallowed).
//  - The ROWS are the Taken block's own taskRow/buildTaskRows (RelatedPanel.mjs),
//    imported lazily on first open so /pr-overview does not load the whole
//    review-tree module just to paint a header.
//  - Only workflow runs in StatusRunning, repo-wide, from the `runs` list of
//    the read-only GET /api/running-count, each with a PR label. Active Claude
//    chat turns are in the pill's NUMBER but not in this list (hence the note).
// Pure read; no state is written, so it is outside the workflow write boundary.
import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

const POLL_MS = 10_000
const OPEN_POLL_MS = 3_000

export const running = reactive({ count: 0, runs: [], open: false, mod: null })

// setRunningSnapshot — fed by whoever already fetched /api/running-count
// (overview.mjs), so the page does not poll the same endpoint twice.
export function setRunningSnapshot(body) {
  if (!body) return
  running.count = typeof body.running === 'number' ? body.running : 0
  running.runs = Array.isArray(body.runs) ? body.runs : []
}

async function fetchRunning() {
  try {
    const res = await fetch('/api/running-count')
    if (!res.ok) return
    const body = await res.json()
    if (body && body.ok) setRunningSnapshot(body)
  } catch (e) {
    // keep what we showed; a transient failure must not blank the pill.
  }
}

let initialized = false
// initRunningTasks — own poll for pages that do not already fetch the count.
export function initRunningTasks() {
  if (initialized) return
  initialized = true
  fetchRunning()
  setInterval(() => !document.hidden && fetchRunning(), POLL_MS)
}

let openTimer = 0
export async function openRunningTasks() {
  if (!running.mod) running.mod = await import('./RelatedPanel.mjs')
  running.open = true
  fetchRunning()
  clearInterval(openTimer)
  openTimer = setInterval(fetchRunning, OPEN_POLL_MS)
}

export function closeRunningTasks() {
  running.open = false
  clearInterval(openTimer)
}

export function isRunningTasksOpen() {
  return running.open
}

export function handleRunningTasksKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    closeRunningTasks()
    return true
  }
  e.preventDefault()
  return true
}

// runningRows — the Taken block's own rows for the running runs, with the PR
// each belongs to prefixed onto the label (the Taken block is per PR, this
// list is repo-wide).
function runningRows() {
  const mod = running.mod
  if (!mod) return []
  const prOf = new Map(running.runs.map((r) => [r.runId, r.pr]))
  const rows = mod.buildTaskRows(
    { workflows: running.runs, pageProblems: { failedRuns: [], logErrors: [] } },
    { chat: false },
  )
  return rows.map((row) => {
    const pr = prOf.get(row.runId)
    return pr > 0 ? { ...row, label: 'PR #' + pr + ' · ' + row.label } : row
  })
}

// runningBadgeButton — the pill, now a button. Hidden at 0 (a keyed array so
// 0 ↔ n never hits the single↔array slot pitfall). The "›" glyph hints that it
// is clickable; the word carries the meaning, the pulsing dot is decoration.
export function runningBadgeButton() {
  const n = running.count
  if (!n) return []
  return [
    html`<button
      type="button"
      data-testid="running-count"
      title="${t('Toon wat er draait')}"
      aria-label="${t('Toon wat er draait')}"
      class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2.5 py-1 text-xs text-slate-500 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-700"
      @click="${(e) => {
        if (e) e.stopPropagation()
        openRunningTasks()
      }}"
    >
      <span
        class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"
        data-testid="running-count-dot"
      ></span>
      <span>${t('{n} actief', { n })}</span>
      <span aria-hidden="true">›</span>
    </button>`.key('running:' + n),
  ]
}

function dialog() {
  return html`
    <div
      data-testid="running-tasks-backdrop"
      class="fixed inset-0 z-[55] flex items-start justify-center bg-slate-900/40 p-4 pt-[8vh] backdrop-blur-sm dark:bg-black/60"
      @click="${(e) => {
        if (e && e.target === e.currentTarget) closeRunningTasks()
      }}"
    >
      <div
        data-testid="running-tasks-dialog"
        role="dialog"
        aria-modal="true"
        class="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        @click="${(e) => e && e.stopPropagation()}"
      >
        <div class="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <div class="min-w-0 flex-1">
            <p data-testid="running-tasks-title" class="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">
              ${() => t('Wat draait er nu') + ' · ' + running.runs.length}
            </p>
            <p class="text-[12px] text-slate-500 dark:text-zinc-500">${t('Taken die nu echt bezig zijn, over alle PRs heen.')}</p>
          </div>
          <button
            type="button"
            data-testid="running-tasks-close"
            class="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
            @click="${(e) => {
              if (e) e.stopPropagation()
              closeRunningTasks()
            }}"
          >
            ${t('Sluiten')} · Esc
          </button>
        </div>
        <div data-testid="running-tasks-list" class="min-h-0 flex-1 overflow-y-auto">
          ${() => {
            const rows = runningRows()
            return rows.length
              ? rows.map((r) => running.mod.taskRow(r, {}).key(r.key))
              : [html`<p class="px-4 py-3 text-[12px] text-slate-500 dark:text-zinc-500" data-testid="running-tasks-empty">${t('Geen lopende taken.')}</p>`.key('empty')]
          }}
        </div>
        <div class="contents">
          ${() =>
            running.count > running.runs.length
              ? html`<p
                  data-testid="running-tasks-chat-note"
                  class="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500 dark:border-zinc-800 dark:text-zinc-500"
                >
                  ${t('Actieve Claude-chatbeurten tellen mee in het getal, maar staan niet in deze lijst.')}
                </p>`
              : ''}
        </div>
      </div>
    </div>
  `
}

// RunningTasksHost — top-level mount, sibling of FailedTasksHost. Stable <div>
// root with one nested toggling binding (arrowjs-pitfalls.md).
export default function RunningTasksHost() {
  return html`<div>${() => (running.open ? dialog().key('running-tasks') : '')}</div>`
}
