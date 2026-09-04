// failedTasks — the ONE global "er is werk mislukt" dialog, shown on every
// page, over whatever the reviewer was doing. Reviewer request: "als er ergens
// een mislukte taak is, geef een popup met de error melding lijst, over alle
// prs heen, overal tonen waar ik ook zou zijn. ik moet het voor 5 minuten
// kunnen negeren, ook alles retryen vanaf de laatste keer dat dezelfde taak
// goed is gegaan", refined to "ik wil bovenaan van 4 dagen zien … toon
// maximaal 3 items met een toon meer knop".
//
// Three deliberate choices:
//
//  1. IT IS A REAL MODAL. Backdrop, centered, and it owns the keyboard — the
//     same contract as the command palette and imageLightbox.mjs: every page's
//     own global keydown handler checks isFailedTasksOpen() FIRST, so none of
//     the app's navigation keys fire behind it. Escape dismisses, which is the
//     same thing as the 5-minute snooze (there is no "close and pretend it
//     never happened" — the work really did fail).
//  2. THE 4-DAY WINDOW IS THE SERVER'S, NOT OURS. GET /api/problems already
//     only reports the last problemWindow (run_errors.go), so "alles opnieuw
//     proberen" here and POST /api/workflows/retry-all there mean exactly the
//     same set of rows. No client-side date filtering that could drift from it.
//  3. THE ROWS ARE problems.mjs's OWN. problemRunRow already renders a failed
//     run for the /pr-overview drawer and the review tree's Taken block; this
//     is a third call site, not a third implementation.
//  4. ONLY REAL FAILED RUNS, not the `logErrors` half. A mirrored glue-log line
//     is deliberately labelled "overgeslagen", not "mislukt" — best-effort work
//     that was skipped and will be retried by its own poller — and in practice
//     those are mostly plain informational lines ("pr #100 merged — stop
//     polling"), dozens after every restart. A modal that blocks the whole
//     screen may only fire on something that really went wrong and really needs
//     a decision, and it is also the only half "alles opnieuw proberen" can
//     even act on: a log line is no run, so there is nothing to resume. The
//     /pr-overview drawer keeps showing both, unchanged.
//
// The snooze lives in localStorage (per browser, survives a refresh) — exactly
// like the theme preference, and for the same reason: it is a UI convenience,
// not durable state, so it is outside the workflow write boundary.
import { reactive, html } from './vendor/arrow.js'
import { fetchProblems, problemRunRow } from './problems.mjs'
import { t } from './i18n.mjs'

// SNOOZE_MS — "ik moet het voor 5 minuten kunnen negeren".
const SNOOZE_MS = 5 * 60 * 1000
// PREVIEW_COUNT — "toon maximaal 3 items met een toon meer knop".
const PREVIEW_COUNT = 3
const POLL_MS = 30000
const STORE_KEY = 'failedTasksSnoozeUntil'

const fs = reactive({
  loaded: false,
  // rows: the failed runs of GET /api/problems, newest-updated first (the
  // order the endpoint already delivers them in).
  rows: [],
  prTitles: {},
  // expanded: the "toon meer" button was pressed, so the whole list shows
  // instead of the first PREVIEW_COUNT rows.
  expanded: false,
  // snoozedUntil: epoch ms; while now() is below it the dialog stays closed.
  snoozedUntil: readSnooze(),
  busy: false,
  // note: the outcome of the last "alles opnieuw proberen" ("7 hervat, 1
  // overgeslagen") or "negeren", so the button says what it did instead of
  // just spinning.
  note: '',
  // confirmIgnoreAll: "Alles negeren" was pressed once and is waiting for the
  // second press. Ignoring is irreversible (the runs are deleted, see
  // WorkflowIgnoreRuns), and doing that to the WHOLE list on one stray click
  // would throw away failures the reviewer never read. A single row needs no
  // such step: that decision is about one failure the reviewer is looking at.
  confirmIgnoreAll: false,
})

function readSnooze() {
  try {
    const v = Number(localStorage.getItem(STORE_KEY))
    return Number.isFinite(v) ? v : 0
  } catch (err) {
    return 0
  }
}

function writeSnooze(until) {
  try {
    localStorage.setItem(STORE_KEY, String(until))
  } catch (err) {
    // A browser with storage blocked keeps the snooze in memory only; the
    // dialog then returns on the next page load, which is the safe direction.
  }
}

// snooze hides the dialog for SNOOZE_MS and schedules its own return, so the
// reviewer does not have to reload to see a failure they postponed.
function snooze() {
  const until = Date.now() + SNOOZE_MS
  fs.snoozedUntil = until
  fs.expanded = false
  fs.note = ''
  fs.confirmIgnoreAll = false
  writeSnooze(until)
  setTimeout(() => {
    // Re-read rather than clearing blindly: a later snooze (another tab, or a
    // second press) must win.
    if (Date.now() >= fs.snoozedUntil) fs.snoozedUntil = 0
  }, SNOOZE_MS + 250)
}

// refreshFailedTasks pulls GET /api/problems (read-only) and keeps its failed
// runs. A transient failure leaves whatever was on screen untouched —
// fetchProblems resolves with ok:false and empty data rather than throwing.
export async function refreshFailedTasks() {
  const { ok, failedRuns, prTitles } = await fetchProblems()
  if (!ok) return
  fs.rows = failedRuns
  fs.prTitles = prTitles
  fs.loaded = true
  if (failedRuns.length === 0) fs.note = ''
}

// initFailedTasksPopup starts the poll. Idempotent, so a page may call it once
// from its own entry module without worrying about a double timer.
let initialized = false
export function initFailedTasksPopup() {
  if (initialized) return
  initialized = true
  refreshFailedTasks()
  setInterval(refreshFailedTasks, POLL_MS)
}

// isFailedTasksOpen/handleFailedTasksKeydown are the two hooks a page's global
// keydown handler must check FIRST — same contract as imageLightbox.mjs: while
// this dialog is up it owns the keyboard completely.
export function isFailedTasksOpen() {
  return fs.loaded && fs.rows.length > 0 && Date.now() >= fs.snoozedUntil
}

export function handleFailedTasksKeydown(e) {
  // A Cmd/Ctrl/Alt chord is a browser command (reload, copy, tab switch), not
  // app navigation — never swallow it. Owning the keyboard means owning the
  // app's OWN keys; every page's handler already reasons this way for a text
  // field (isNativeTextEditKey in home.mjs), but /pr-overview and /settings
  // check this dialog before any such guard of their own.
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    snooze()
    return true
  }
  // Everything else is swallowed: the page behind the backdrop must not
  // navigate while the reviewer is looking at a failure list.
  e.preventDefault()
  return true
}

// failureReason — WHY a POST from this dialog failed, in as few words as
// possible: the server's own {"error":…} text when it sent one, otherwise the
// bare HTTP status. A note that only says "is niet gelukt" is unactionable —
// the first real report of this was a plain 404 (a server binary started
// before the endpoint existed), which read exactly like a deletion that
// really went wrong. Not translated: it is a status code or a server message,
// not interface text.
function failureReason(res, body) {
  const msg = body && typeof body.error === 'string' ? body.error.trim() : ''
  if (msg) return msg
  return res ? 'HTTP ' + res.status : 'geen antwoord'
}

async function retryAll() {
  if (fs.busy) return
  fs.busy = true
  fs.note = t('Bezig met opnieuw proberen…')
  try {
    const res = await fetch('/api/workflows/retry-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || !body.ok) {
      fs.note = t('Opnieuw proberen is niet gelukt.') + ' (' + failureReason(res, body) + ')'
    } else {
      fs.note = t('{n} hervat, {s} overgeslagen.', { n: body.retried || 0, s: body.skipped || 0 })
    }
  } catch (err) {
    fs.note = t('Opnieuw proberen is niet gelukt.') + ' (' + failureReason(null, null) + ')'
  }
  fs.busy = false
  await refreshFailedTasks()
}

// ignoreRuns permanently deletes the named failed runs — reviewer request:
// "wil ik ook errors kunnen negeren". A retry is not always the answer: a
// failure on a PR that has meanwhile been merged, or one that will never
// succeed (a `gh` call the reviewer has no rights for), is simply not work any
// more, and while it sits in the list this modal reopens over everything on
// every page. The sanctioned write path, like retryAll: POST starts an
// ignore_runs Execution whose own Activity does every deletion (see
// .claude/rules/workflows-write-boundary.md).
async function ignoreRuns(runIds) {
  if (fs.busy || runIds.length === 0) return
  fs.busy = true
  fs.confirmIgnoreAll = false
  fs.note = t('Bezig met negeren…')
  try {
    const res = await fetch('/api/workflows/ignore-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || !body.ok) {
      fs.note = t('Negeren is niet gelukt.') + ' (' + failureReason(res, body) + ')'
    } else {
      fs.note = t('{n} genegeerd, {s} overgeslagen.', { n: body.ignored || 0, s: body.skipped || 0 })
    }
  } catch (err) {
    fs.note = t('Negeren is niet gelukt.') + ' (' + failureReason(null, null) + ')'
  }
  fs.busy = false
  await refreshFailedTasks()
}

// hiddenCount — how many rows the "toon meer" button would reveal.
function hiddenCount() {
  return Math.max(0, fs.rows.length - PREVIEW_COUNT)
}

function visibleRows() {
  return fs.expanded ? fs.rows : fs.rows.slice(0, PREVIEW_COUNT)
}

function dialog() {
  return html`
    <div
      data-testid="failed-tasks-backdrop"
      class="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/40 p-4 pt-[8vh] backdrop-blur-sm dark:bg-black/60"
      @click="${(e) => {
        // Only a click on the backdrop itself dismisses; a click inside the
        // panel must not (the panel stops propagation of its own clicks).
        if (e && e.target === e.currentTarget) snooze()
      }}"
    >
      <div
        data-testid="failed-tasks-dialog"
        role="dialog"
        aria-modal="true"
        class="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        @click="${(e) => e && e.stopPropagation()}"
      >
        <div class="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <span aria-hidden="true" class="text-rose-600 dark:text-rose-300">⚠</span>
          <div class="min-w-0 flex-1">
            <p data-testid="failed-tasks-title" class="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">
              ${() => t('Mislukte taken van de laatste 4 dagen') + ' · ' + fs.rows.length}
            </p>
            <p class="text-[12px] text-slate-500 dark:text-zinc-500">
              ${t('Opnieuw proberen gaat verder vanaf de laatste stap die wél lukte.')}
            </p>
          </div>
        </div>

        <div data-testid="failed-tasks-list" class="min-h-0 flex-1 overflow-y-auto">
          ${() => visibleRows().map((run) => problemRunRow(run, fs.prTitles, { onIgnore: (r) => ignoreRuns([r.runId]) }))}
        </div>

        <div class="contents">
          ${() =>
            !fs.expanded && hiddenCount() > 0
              ? html`<button
                  type="button"
                  data-testid="failed-tasks-more"
                  class="border-t border-slate-100 px-4 py-2 text-left text-[12px] font-semibold text-slate-600 hover:bg-slate-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                  @click="${(e) => {
                    if (e) e.stopPropagation()
                    fs.expanded = true
                  }}"
                >
                  ${() => t('Toon meer') + ' (' + hiddenCount() + ')'}
                </button>`.key('failed-tasks-more')
              : ''}
        </div>

        <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            data-testid="failed-tasks-retry-all"
            disabled="${() => fs.busy}"
            class="${() =>
              'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ' +
              (fs.busy ? 'bg-slate-400 dark:bg-zinc-700' : 'bg-rose-600 hover:bg-rose-500')}"
            @click="${(e) => {
              if (e) e.stopPropagation()
              retryAll()
            }}"
          >
            ${t('Alles opnieuw proberen')}
          </button>
          <button
            type="button"
            data-testid="failed-tasks-ignore-all"
            disabled="${() => fs.busy}"
            title="${t('Verwijder alle mislukte taken uit de lijst zonder ze opnieuw te proberen')}"
            class="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
            @click="${(e) => {
              if (e) e.stopPropagation()
              // Two presses, see fs.confirmIgnoreAll. The LABEL says which
              // press you are on — never a colour-only cue.
              if (!fs.confirmIgnoreAll) {
                fs.confirmIgnoreAll = true
                return
              }
              ignoreRuns(fs.rows.map((r) => r.runId))
            }}"
          >
            ${() => (fs.confirmIgnoreAll ? t('Zeker? Alles negeren') : t('Alles negeren'))}
          </button>
          <button
            type="button"
            data-testid="failed-tasks-snooze"
            class="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
            @click="${(e) => {
              if (e) e.stopPropagation()
              snooze()
            }}"
          >
            ${t('Negeer 5 minuten')}
          </button>
          <span
            data-testid="failed-tasks-note"
            class="min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-zinc-500"
            title="${() => fs.note}"
            >${() => fs.note}</span
          >
        </div>
      </div>
    </div>
  `
}

// FailedTasksHost — the top-level mount, sibling of MenuHost/ImageLightboxHost
// (home.mjs). Mounted once with a stable <div> root and one nested
// `${() => ...}` binding, per the "bare toggling expression" pitfall in
// .claude/rules/arrowjs-pitfalls.md.
export default function FailedTasksHost() {
  return html`<div>${() => (isFailedTasksOpen() ? dialog().key('failed-tasks') : '')}</div>`
}
