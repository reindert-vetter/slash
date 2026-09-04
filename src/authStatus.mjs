// authStatus — the ONE global "je bent ergens niet meer ingelogd" dialog, plus
// the shared state the settings page's own auth row renders. Reviewer request:
// "ik wil een popup als er iets groots fout gaat (waar ik een knop in kan
// drukken om te re-checken), betreft acli jira auth status, maar ook andere
// auth dingen".
//
// Why a SECOND modal next to failedTasks.mjs instead of a row in it: a failed
// workflow run is one piece of work you can resume; an expired credential is
// the ROOT CAUSE that silently skips work which never becomes a failed run at
// all (`pr_status: fetch jira INTEG-620 skipped: …` is only ever a log line).
// The two need different verbs — "opnieuw proberen" versus "opnieuw
// controleren"/"opnieuw inloggen" — so they stay separate dialogs. They can
// never fight over the screen: while auth is broken this one wins and
// failedTasks stays closed (its own isFailedTasksOpen checks isAuthProblemOpen
// first), because those failures are usually caused by exactly this.
//
// Everything else mirrors failedTasks.mjs on purpose: a real modal owning the
// keyboard (isAuthProblemOpen must be checked FIRST in each page's global
// keydown handler, the same contract as imageLightbox.mjs), a localStorage
// snooze, and one top-level host mounted next to MenuHost.
//
// Colourblind rule: every state carries a WORD plus a glyph; the colour is
// decoration only (.claude/rules/conventions.md).
import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

// SNOOZE_MS — long enough to fix it in a terminal, short enough that a
// forgotten login comes back.
const SNOOZE_MS = 5 * 60 * 1000
const POLL_MS = 120000
const STORE_KEY = 'authProblemSnoozeUntil'

// as — shared between the popup and the settings row, so both always show the
// same verdict and one "opnieuw controleren" updates both.
export const as = reactive({
  loaded: false,
  checks: [],
  jira: { email: '', site: '', tokenSet: false, tokenMasked: '' },
  checking: false,
  saving: false,
  note: '',
  snoozedUntil: readSnooze(),
})

// suppressPopup: set by the settings page, which shows the same information
// inline — a modal over the very form you are filling in would be absurd.
let suppressPopup = false

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
    // Storage blocked: the snooze then lives in memory only and the dialog
    // returns on the next page load — the safe direction.
  }
}

function snooze() {
  const until = Date.now() + SNOOZE_MS
  as.snoozedUntil = until
  as.note = ''
  writeSnooze(until)
  setTimeout(() => {
    if (Date.now() >= as.snoozedUntil) as.snoozedUntil = 0
  }, SNOOZE_MS + 250)
}

// refreshAuthStatus reads GET /api/auth/status (read-only). force=true adds
// ?refresh=1, which bypasses the server's own 60s cache — that is what the
// "Opnieuw controleren" button is for. A transient failure leaves whatever was
// on screen untouched rather than claiming everything broke.
export async function refreshAuthStatus(force = false) {
  if (as.checking) return
  as.checking = true
  try {
    const res = await fetch('/api/auth/status' + (force ? '?refresh=1' : ''))
    if (res.ok) {
      const data = await res.json()
      as.checks = Array.isArray(data.checks) ? data.checks : []
      as.jira = data.jira || { email: '', site: '', tokenSet: false, tokenMasked: '' }
      as.loaded = true
      if (force) as.note = brokenChecks().length === 0 ? t('Alles werkt weer.') : ''
    }
  } catch (err) {
    // Offline / server restarting — keep the last known answer.
  }
  as.checking = false
}

let initialized = false
// initAuthStatusPopup starts the poll. Idempotent, so a page may call it from
// its own entry module without worrying about a double timer.
export function initAuthStatusPopup(opts) {
  if (opts && opts.suppressPopup) suppressPopup = true
  if (initialized) return
  initialized = true
  refreshAuthStatus()
  setInterval(() => refreshAuthStatus(), POLL_MS)
}

// brokenChecks — the checks a modal over the whole screen is justified for:
// ONLY a credential that was configured and has since been REJECTED. Three
// states deliberately do not qualify:
//
//   - "missing" (never set up — the optional Jira notification feed): nothing
//     broke, the reviewer simply never wanted that feature. It is shown on the
//     settings page, which is where you go to turn it on; a modal on every
//     page for a feature you never asked for is nagging, not a warning.
//   - "skipped" (SLASH_GITHUB=off / SLASH_JIRA=off): an offline or test run.
//   - "ok".
export function brokenChecks() {
  return (as.checks || []).filter((c) => c.state === 'error')
}

// isAuthProblemOpen/handleAuthProblemKeydown — the two hooks a page's global
// keydown handler must check FIRST, before its own navigation keys and before
// the failed-tasks dialog.
export function isAuthProblemOpen() {
  if (suppressPopup || !as.loaded) return false
  return brokenChecks().length > 0 && Date.now() >= as.snoozedUntil
}

export function handleAuthProblemKeydown(e) {
  // A Cmd/Ctrl/Alt chord is a browser command, never app navigation — same
  // reasoning as handleFailedTasksKeydown.
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    snooze()
    return true
  }
  e.preventDefault()
  return true
}

// STATE_WORD — the word IS the state. Never rely on the colour beside it.
const STATE_WORD = {
  ok: 'Werkt',
  error: 'Niet ingelogd',
  missing: 'Niet ingesteld',
  skipped: 'Uitgeschakeld',
}
const STATE_GLYPH = { ok: '✓', error: '✕', missing: '○', skipped: '–' }
const STATE_CLS = {
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  error: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  missing: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  skipped: 'bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400',
}

// authStateBadge — the shared status pill, used by the dialog below AND by the
// settings page's auth row, so the two can never word a state differently.
export function authStateBadge(check) {
  const state = (check && check.state) || 'missing'
  // "Niet ingelogd" is the right word for a CLI session, but wrong for a token
  // the server pasted into a request and got rejected — that one was never a
  // login. The check that the settings page can repair in-place (editable) is
  // exactly that token, so it carries its own word.
  const errorWord = check && check.editable ? 'Afgekeurd' : 'Niet ingelogd'
  const cls =
    'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ' +
    (STATE_CLS[state] || STATE_CLS.missing)
  const word = state === 'error' ? errorWord : STATE_WORD[state] || 'Onbekend'
  const text = (STATE_GLYPH[state] || '?') + ' ' + t(word)
  return html`<span class="${cls}" data-testid="auth-state">${text}</span>`
}

// authCheckRow — one credential, its state, and how to repair it. A fix that
// is a terminal command is shown as copyable code; a fix that is a website is
// a real link (the Atlassian API-token page).
export function authCheckRow(check) {
  return html`
    <div
      data-testid="auth-check-row"
      data-check="${check.id}"
      class="flex items-start gap-2 border-b border-slate-100 px-4 py-2.5 last:border-b-0 dark:border-zinc-800"
    >
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-2 text-[13px] font-semibold text-slate-800 dark:text-zinc-100">
          <span class="truncate">${check.label}</span>${authStateBadge(check)}
        </p>
        <p class="mt-0.5 break-words text-[12px] text-slate-500 dark:text-zinc-400">${() => check.detail || ''}</p>
        <div class="contents">
          ${() =>
            check.fixCommand
              ? html`<p class="mt-1 text-[12px] text-slate-500 dark:text-zinc-400">
                  ${t('Los op met')}
                  <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-800 dark:bg-zinc-800 dark:text-zinc-200"
                    >${check.fixCommand}</code
                  >
                </p>`.key('fixcmd')
              : ''}
        </div>
        <div class="contents">
          ${() =>
            check.fixUrl
              ? html`<p class="mt-1 text-[12px]">
                  <a
                    href="${check.fixUrl}"
                    target="_blank"
                    rel="noopener"
                    class="font-semibold text-indigo-600 underline dark:text-indigo-300"
                    >${t('Waar haal ik dit vandaan?')}</a
                  >
                </p>`.key('fixurl')
              : ''}
        </div>
      </div>
    </div>
  `
}

// saveJiraCredentials sends the settings page's form through the sanctioned
// write path: the single, global app_settings tracker (Kind "jiraCreds"), whose
// own Activity writes .env — see .claude/rules/workflows-write-boundary.md. An
// EMPTY token means "keep the stored one": the page never receives the token
// back, only a masked tail, so it cannot send it back either.
export async function saveJiraCredentials({ email, site, token }) {
  as.saving = true
  as.note = t('Bezig met opslaan…')
  try {
    const start = await fetch('/api/workflows/app_settings', { method: 'POST' })
    const startBody = await start.json().catch(() => null)
    const runId = startBody && startBody.runId
    if (!runId) throw new Error('no run')
    const res = await fetch('/api/workflows/' + runId + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'jiraCreds', jiraCreds: { email, site, token } }),
    })
    if (!res.ok) {
      const msg = await res.text().catch(() => '')
      as.note = t('Opslaan is niet gelukt.') + (msg ? ' (' + msg.trim() + ')' : '')
      as.saving = false
      return false
    }
  } catch (err) {
    as.note = t('Opslaan is niet gelukt.')
    as.saving = false
    return false
  }
  as.saving = false
  as.note = t('Opgeslagen — opnieuw aan het controleren…')
  await refreshAuthStatus(true)
  if (!as.note) as.note = t('Opgeslagen.')
  return true
}

// goToSettings opens the settings page with a way back, the same `?from=`
// round trip settingsLink.mjs builds (not imported: this module is mounted on
// the settings page itself, where that import would be circular).
function goToSettings() {
  location.href = '/settings?from=' + encodeURIComponent(location.pathname + location.search)
}

function dialog() {
  return html`
    <div
      data-testid="auth-problem-backdrop"
      class="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/40 p-4 pt-[8vh] backdrop-blur-sm dark:bg-black/60"
      @click="${(e) => {
        if (e && e.target === e.currentTarget) snooze()
      }}"
    >
      <div
        data-testid="auth-problem-dialog"
        role="dialog"
        aria-modal="true"
        class="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        @click="${(e) => e && e.stopPropagation()}"
      >
        <div class="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-zinc-800">
          <span aria-hidden="true" class="text-rose-600 dark:text-rose-300">⚠</span>
          <div class="min-w-0 flex-1">
            <p data-testid="auth-problem-title" class="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">
              ${() => t('Inloggegevens werken niet meer') + ' · ' + brokenChecks().length}
            </p>
            <p class="text-[12px] text-slate-500 dark:text-zinc-500">
              ${t('Zolang dit zo blijft slaat slash het werk dat hierop leunt stilzwijgend over.')}
            </p>
          </div>
        </div>

        <div data-testid="auth-problem-list" class="min-h-0 flex-1 overflow-y-auto">
          ${() => brokenChecks().map((c) => authCheckRow(c).key('auth:' + c.id))}
        </div>

        <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            data-testid="auth-problem-recheck"
            disabled="${() => as.checking}"
            class="${() =>
              'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ' +
              (as.checking ? 'bg-slate-400 dark:bg-zinc-700' : 'bg-indigo-600 hover:bg-indigo-500')}"
            @click="${(e) => {
              if (e) e.stopPropagation()
              refreshAuthStatus(true)
            }}"
          >
            ${() => (as.checking ? t('Bezig met controleren…') : t('Opnieuw controleren'))}
          </button>
          <button
            type="button"
            data-testid="auth-problem-settings"
            class="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
            @click="${(e) => {
              if (e) e.stopPropagation()
              goToSettings()
            }}"
          >
            ${t('Naar instellingen')}
          </button>
          <button
            type="button"
            data-testid="auth-problem-snooze"
            class="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
            @click="${(e) => {
              if (e) e.stopPropagation()
              snooze()
            }}"
          >
            ${t('Negeer 5 minuten')}
          </button>
          <span
            data-testid="auth-problem-note"
            class="min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-zinc-500"
            title="${() => as.note}"
            >${() => as.note}</span
          >
        </div>
      </div>
    </div>
  `
}

// AuthStatusHost — the top-level mount, sibling of MenuHost/FailedTasksHost. A
// stable <div> root with one nested `${() => ...}` binding, per the "bare
// toggling expression" pitfall in .claude/rules/arrowjs-pitfalls.md.
export default function AuthStatusHost() {
  return html`<div>${() => (isAuthProblemOpen() ? dialog().key('auth-problem') : '')}</div>`
}
