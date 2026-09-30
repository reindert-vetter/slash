// selfUpdate.mjs — the "Nieuwe versie van slash" row at the top of the header
// bell, shared by BOTH bells (overview.mjs's own and jiraBell.mjs on
// /pr/<id> and /plan/<KEY>), plus the reload-after-restart logic every page
// runs. Backend: self_update.go (the `self_update` workflow, GET
// /api/update/status, POST /api/workflows/self_update {action}). Full
// mechanism: "Self-update (`self_update`)" in
// .claude/docs/workflows-trackers.md.
//
// Reviewer request: "als slash een update heeft, dat het auto update … met een
// knop in meldingen onder belletje", later sharpened to: check GitHub every 6
// hours, rebase local commits, wait until everything is done, show the notice
// with a button to keep the old version. So the update proceeds ON ITS OWN
// (≥2 min after the notice, once nothing is busy) unless "Doorgaan met de
// oude versie" is pressed; "Nu bijwerken" skips the grace period.
//
// Reload: the first status read pins the running commit this tab was loaded
// against; as soon as a later read reports a different `running`, the tab
// reloads — every open tab, not just the one that clicked. It does NOT reload
// while the reviewer is typing in a focused, non-empty field (the plan-page
// and general chat composers are not persisted to localStorage the way
// RelatedPanel's drafts are, see draftStorage.mjs) — it waits and shows a
// "herlaad" row instead.

import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { relativeTime } from './relativeTime.mjs'

const su = reactive({
  status: null,
  bootRev: null,
  down: false,
  reloadPending: false,
  sending: '',
  error: '',
  now: Date.now(),
})

const ACTIVE_PHASES = ['checking', 'building', 'waiting', 'restarting']

function phase() {
  return (su.status && su.status.enabled && su.status.phase) || 'idle'
}

// selfUpdateNeedsAttention — drives the bell's dot: a version is ready, being
// applied, or the tab has to reload.
export function selfUpdateNeedsAttention() {
  const p = phase()
  return su.reloadPending || p === 'notice' || p === 'waiting' || p === 'restarting'
}

// selfUpdateHasSomething — the small bells on /pr and /plan only render when
// there is something to click; this widens that gate with the update row.
export function selfUpdateHasSomething() {
  return selfUpdateNeedsAttention() || phase() === 'failed'
}

function isTyping() {
  const el = document.activeElement
  if (!el) return false
  if (el.isContentEditable) return (el.textContent || '').trim() !== ''
  const tag = (el.tagName || '').toLowerCase()
  if (tag === 'textarea') return (el.value || '').trim() !== ''
  if (tag === 'input') {
    const type = (el.type || 'text').toLowerCase()
    return ['text', 'search', ''].includes(type) && (el.value || '').trim() !== ''
  }
  return false
}

function tryReload() {
  if (isTyping()) {
    su.reloadPending = true
    return
  }
  location.reload()
}

async function loadStatus() {
  try {
    const res = await fetch('/api/update/status', { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const body = await res.json()
    su.down = false
    su.status = body
    if (body && body.running) {
      if (su.bootRev === null) su.bootRev = body.running
      else if (body.running !== su.bootRev) tryReload()
    }
  } catch (err) {
    // The server is restarting (or briefly gone): poll fast until it's back.
    su.down = true
  }
  schedule()
}

let pollTimer = null
function schedule() {
  clearTimeout(pollTimer)
  const fast = su.down || su.reloadPending || ACTIVE_PHASES.includes(phase())
  pollTimer = setTimeout(loadStatus, fast ? 3000 : 60_000)
}

async function send(action) {
  su.sending = action
  su.error = ''
  try {
    const res = await fetch('/api/workflows/self_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) su.error = body.error || 'HTTP ' + res.status
  } catch (err) {
    su.error = String(err)
  } finally {
    su.sending = ''
  }
  loadStatus()
}

let inited = false
// initSelfUpdate — call once per page at module load.
export function initSelfUpdate() {
  if (inited) return
  inited = true
  loadStatus()
  // A 1s clock for the countdown in the notice row, and for re-trying a
  // deferred reload once the reviewer stops typing.
  setInterval(() => {
    su.now = Date.now()
    if (su.reloadPending && !isTyping()) location.reload()
  }, 1000)
}

// ── rendering ────────────────────────────────────────────────────────────

const ROW_CLS = 'border-b border-slate-100 px-4 py-3 text-[13px] dark:border-zinc-800'
const BTN_CLS =
  'shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
const PRIMARY_CLS =
  'shrink-0 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40'

function button(label, action, cls, testid) {
  return html`<button
    type="button"
    data-testid="${testid}"
    class="${cls}"
    disabled="${() => su.sending !== ''}"
    @click="${(e) => {
      e.stopPropagation()
      send(action)
    }}"
  >
    ${label}
  </button>`
}

function short(sha) {
  return (sha || '').slice(0, 7)
}

function countdownText() {
  const s = su.status || {}
  const left = Math.max(0, Math.ceil((new Date(s.autoAt).getTime() - su.now) / 1000))
  if (left > 0) {
    const m = Math.floor(left / 60)
    const sec = String(left % 60).padStart(2, '0')
    return t('Wordt automatisch bijgewerkt over {t}, zodra niets meer bezig is.', { t: m + ':' + sec })
  }
  if (s.busy > 0) return t('Wacht tot {n} lopende taak/taken klaar is/zijn…', { n: s.busy })
  return t('Wordt nu bijgewerkt…')
}

function title(text) {
  return html`<p class="font-semibold text-slate-900 dark:text-zinc-100">${text}</p>`
}

function noticeRow() {
  const s = su.status
  const commits = (s.commits || []).slice(0, 5)
  const more = (s.commits || []).length - commits.length
  return html`<div data-testid="self-update-row" data-phase="notice" class="${ROW_CLS}">
    ${title(t('Nieuwe versie van slash klaar') + ' (' + short(s.target) + ')')}
    <ul class="mt-1 list-disc pl-5 text-xs text-slate-600 dark:text-zinc-400">
      ${commits.map((c, i) => html`<li class="truncate">${c}</li>`.key('c' + i))}
      ${more > 0 ? html`<li>${t('… en nog {n}', { n: more })}</li>`.key('more') : html`<li class="hidden"></li>`.key('more')}
    </ul>
    <p class="${'mt-1 text-xs text-slate-500 dark:text-zinc-500 ' + (s.rebase ? '' : 'hidden')}">
      ${t('Je lokale commits worden op origin/main gerebased.')}
    </p>
    <p data-testid="self-update-countdown" class="mt-1 text-xs text-slate-600 dark:text-zinc-400">${() => countdownText()}</p>
    <div class="mt-2 flex flex-wrap gap-2">
      ${button(t('Nu bijwerken'), 'now', PRIMARY_CLS, 'self-update-now')}
      ${button(t('Doorgaan met de oude versie'), 'skip', BTN_CLS, 'self-update-skip')}
    </div>
  </div>`
}

function simpleRow(p, text, extra) {
  return html`<div data-testid="self-update-row" data-phase="${p}" class="${ROW_CLS}">
    <div class="flex items-center gap-2">
      <p class="min-w-0 flex-1 text-slate-700 dark:text-zinc-300">${text}</p>
      <div class="contents">${() => extra || ''}</div>
    </div>
  </div>`
}

function failedRow() {
  const s = su.status
  return html`<div data-testid="self-update-row" data-phase="failed" class="${ROW_CLS}">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        ${title(t('Bijwerken van slash mislukt'))}
        <p class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-600 dark:text-zinc-400">
          ${(s.error || '').replace(/^tembed: workflow failed: /, '')}
        </p>
      </div>
      ${button(t('Opnieuw controleren'), 'check', BTN_CLS, 'self-update-check')}
    </div>
  </div>`
}

function row() {
  if (su.reloadPending) {
    return simpleRow(
      'reload',
      t('slash is bijgewerkt — deze pagina herlaadt zodra je klaar bent met typen.'),
      html`<button type="button" data-testid="self-update-reload" class="${BTN_CLS}" @click="${() => location.reload()}">
        ${t('Herlaad nu')}
      </button>`,
    ).key('su:reload')
  }
  const s = su.status
  if (!s || !s.enabled) return html`<span class="hidden"></span>`.key('su:none')
  const p = phase()
  switch (p) {
    case 'notice':
      return noticeRow().key('su:notice:' + s.target)
    case 'checking':
      return simpleRow(p, t('Controleren op een nieuwe versie van slash…')).key('su:checking')
    case 'building':
      return simpleRow(p, t('Nieuwe versie van slash wordt gebouwd…')).key('su:building')
    case 'waiting':
      return simpleRow(
        p,
        s.busy > 0
          ? t('slash wordt bijgewerkt zodra alles klaar is — nog {n} bezig.', { n: s.busy })
          : t('slash wordt bijgewerkt…'),
      ).key('su:waiting:' + s.busy)
    case 'restarting':
      return simpleRow(p, t('slash herstart met de nieuwe versie…')).key('su:restarting')
    case 'failed':
      return failedRow().key('su:failed:' + (s.error || '').length)
    default:
      return simpleRow(
        'idle',
        t('slash is up-to-date') + ' (' + short(s.running) + ')' + (s.checkedAt ? ' · ' + t('gecontroleerd') + ' ' + relativeTime(s.checkedAt) : ''),
        button(t('Nu controleren'), 'check', BTN_CLS, 'self-update-check'),
      ).key('su:idle:' + (s.checkedAt || ''))
  }
}

// selfUpdateSection — mount at the top of a bell panel. Stable element root,
// the phase switch inside it (see the "bare toggling expression" rule in
// .claude/rules/arrowjs-pitfalls.md).
export function selfUpdateSection() {
  return html`<div class="contents">
    ${() => row()}
    <p class="${() => 'px-4 pb-2 text-[11px] text-rose-600 dark:text-rose-400 ' + (su.error ? '' : 'hidden')}">${() => su.error}</p>
  </div>`
}
