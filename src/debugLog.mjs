// debugLog.mjs — "Debug mode": record what the reviewer navigated and clicked,
// so Claude can later READ that recording and reproduce a reported bug step by
// step instead of guessing. Off by default; the switch lives on the settings
// page (settings-row-debug, src/settings.mjs). Full mechanism, event schema and
// the reproduction workflow: .claude/docs/debug-mode.md.
//
// A recording always STARTS with a page load: initDebugLog() logs a `session`
// event carrying the complete location.href, so replaying a bug begins with
// "open this URL" — opening the review tree (or the overview/settings page) is
// the first line of every session, exactly as the reviewer asked for.
//
// Two deliberate design choices:
//
//   1. The PREFERENCE is localStorage, like theme.mjs and unlike autowarn.mjs.
//      The server never needs to read it — it only ever receives the events
//      this module chooses to send — so there is nothing for a workflow Signal
//      to be the source of truth about.
//   2. The RECORDING is durable (<dataDir>/debug-log.jsonl, so it survives a
//      server restart), which means the write MUST go through a workflow:
//      POST /api/workflows/debug_log per flushed batch (see debug_log.go and
//      .claude/rules/workflows-write-boundary.md). Reading is the plain
//      read-only GET /api/debug/log.
//
// This module registers its OWN capture-phase keydown/click listeners rather
// than being called from each page's nav code. That keeps the instrumentation
// out of home.mjs's onKeydown entirely (one import + one init() call per page)
// and means it can never influence the nav chain: it never calls
// preventDefault/stopPropagation, and it never touches the DOM — so the
// "zero attribute mutations per navigation step" contract of
// tests/navigate.spec.mjs is unaffected.
import { reactive, html } from './vendor/arrow.js'

const STORAGE_KEY = 'debugMode'

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

// debugMode.enabled is the reactive source of truth the toggle button reads.
export const debugMode = reactive({ enabled: readStored() })

// toggleDebugMode flips the switch and persists it immediately — the same
// shape as theme.mjs's cycleTheme. Turning it ON starts a fresh session line
// right away (so the reviewer doesn't have to reload first); turning it OFF
// flushes whatever is still buffered, then goes quiet.
export function toggleDebugMode() {
  const next = !debugMode.enabled
  debugMode.enabled = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* private mode — the switch then only lasts this page */
  }
  if (next) {
    installListeners()
    logSession('toggled-on')
  } else {
    flush()
  }
}

// ── the recording ─────────────────────────────────────────────────────────

const FLUSH_AT = 25 // events
const FLUSH_MS = 1500

// A session id per page load: every line of one page's recording carries it,
// so a multi-page reproduction (overview → tree → settings) stays readable.
const sessionId = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
  }
})()

let buffer = []
let flushTimer = null
let installed = false
let lastUrl = ''

function pageName() {
  return location.pathname
}

function record(ev) {
  if (!debugMode.enabled) return
  buffer.push({ t: Date.now(), ...ev })
  if (buffer.length >= FLUSH_AT) {
    flush()
    return
  }
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
}

// flush ships whatever is buffered as ONE debug_log Execution.
// Fire-and-forget: a failed log write must never be felt in the UI.
//
// On the way OUT of a page (pagehide/hidden) it goes through
// navigator.sendBeacon instead of fetch, because the tail of a session is
// exactly the part a reproduction needs and a plain fetch — even with
// `keepalive` — is routinely aborted by the navigation that triggered it
// (measured: ERR_ABORTED on every gear-icon/back navigation). sendBeacon is
// the API built for this and is handed a JSON Blob so the server sees the
// right content type. The short FLUSH_MS above keeps this path rare anyway.
function flush(unloading) {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!buffer.length) return
  const events = buffer
  buffer = []
  const body = JSON.stringify({ kind: 'append', session: sessionId, page: pageName(), events })
  try {
    if (unloading && navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/workflows/debug_log', new Blob([body], { type: 'application/json' }))
      if (ok) return
    }
    fetch('/api/workflows/debug_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body,
    }).catch(() => {})
  } catch {
    /* ignore — debug logging is never allowed to break the page */
  }
}

// clearDebugLog empties the whole recording (the settings page's "Log wissen"),
// through the same one-shot workflow — never a direct write.
export async function clearDebugLog() {
  buffer = []
  const res = await fetch('/api/workflows/debug_log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'clear' }),
  })
  return res.ok
}

// debugLogCount reads how many lines the recording currently holds — the
// counter on the settings row, so the reviewer can see the log is really
// filling up.
export async function debugLogCount() {
  try {
    const res = await fetch('/api/debug/log?limit=1')
    if (!res.ok) return 0
    const data = await res.json()
    return data.total || 0
  } catch {
    return 0
  }
}

// logAction records a NAMED action that no raw key/click can be read back
// from — today only the command palette's own runCommand (home.mjs), where the
// key that ran it says "Enter" and nothing about which command that was.
export function logAction(name, detail) {
  record({ type: 'action', key: name, detail: detail ? String(detail) : '', url: location.href })
}

function logSession(note) {
  record({ type: 'session', url: location.href, detail: note || document.referrer || '' })
  lastUrl = location.href
  flush() // the first line of a reproduction should never sit in a buffer
}

function modsOf(e) {
  const m = []
  if (e.metaKey) m.push('cmd')
  if (e.ctrlKey) m.push('ctrl')
  if (e.altKey) m.push('alt')
  if (e.shiftKey) m.push('shift')
  return m.join('+')
}

// targetOf describes the clicked/focused element the way a reproduction needs
// it: its own or nearest ancestor's data-testid (the same handle the Playwright
// specs use), falling back to the tag name.
function targetOf(el) {
  if (!el || !el.closest) return ''
  const withId = el.closest('[data-testid]')
  if (withId) return withId.getAttribute('data-testid') || ''
  return (el.tagName || '').toLowerCase()
}

function shortText(el) {
  const t = (el && el.textContent) || ''
  return t.trim().replace(/\s+/g, ' ').slice(0, 80)
}

// noteUrlChange logs the RESULTING url after a key/click, once, on the next
// macrotask. The whole navigation position lives in the query string
// (bindUrlState, see CLAUDE.md), so such a line is a directly reusable
// reproduction point: open that URL and you are where the reviewer was.
function noteUrlChange() {
  setTimeout(() => {
    if (!debugMode.enabled) return
    if (location.href === lastUrl) return
    lastUrl = location.href
    record({ type: 'nav', url: location.href })
  }, 0)
}

function onKey(e) {
  if (!debugMode.enabled) return
  const active = document.activeElement
  record({
    type: 'key',
    key: e.key,
    mods: modsOf(e),
    target: targetOf(active),
    detail: active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? 'in-text-field' : '',
  })
  noteUrlChange()
}

function onClick(e) {
  if (!debugMode.enabled) return
  const el = e.target
  record({ type: 'click', target: targetOf(el), detail: shortText(el), url: location.href })
  noteUrlChange()
}

function installListeners() {
  if (installed) return
  installed = true
  // Capture phase so an event a page handler stops still gets recorded; this
  // module never stops or prevents anything itself.
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('click', onClick, true)
  window.addEventListener('pagehide', () => flush(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
}

// initDebugLog is called once per page module (home.mjs, overview.mjs,
// settings.mjs). With debug mode off it does nothing at all — no listeners, no
// requests — so the normal review flow pays nothing for this feature.
export function initDebugLog() {
  if (!debugMode.enabled) return
  installListeners()
  logSession('')
}

// ── the toggle button ─────────────────────────────────────────────────────
// Same shape as autoWarnToggleButton: the WORD carries the state, with a
// filled/open dot beside it — never colour alone (the reviewer is colorblind).
export function debugModeToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="debug-mode-toggle"
      title="${() =>
        'Debug mode: ' +
        (debugMode.enabled ? 'aan' : 'uit') +
        ' — legt navigatie en acties vast in data/debug-log.jsonl (klik om te wisselen)'}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (debugMode.enabled
          ? 'text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30 hover:bg-amber-50 dark:hover:bg-amber-500/10'
          : 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800') +
        ' ' +
        cls}"
      @click="${toggleDebugMode}"
    >
      <span
        data-testid="debug-mode-toggle-dot"
        class="${() =>
          'inline-block h-2 w-2 shrink-0 rounded-full ' +
          (debugMode.enabled ? 'bg-amber-500' : 'border border-slate-400 dark:border-zinc-500')}"
      ></span>
      <span>${() => (debugMode.enabled ? 'Debug mode aan' : 'Debug mode uit')}</span>
    </button>
  `
}
