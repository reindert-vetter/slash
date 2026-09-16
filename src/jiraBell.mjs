// jiraBell.mjs — the Jira-notifications header bell (`/pr-overview`'s
// `jiraBellButton`), reused as a small, self-contained icon on `/pr/<id>`
// (home.mjs) and `/plan/<KEY>` (plan.mjs) — reviewer request: "ik wil de
// notificatie belletje wat in pr overzicht zit, ook zien in pr tree en plan,
// maar alleen als er iets te klikken is". See .claude/docs/pr-overview.md
// ("Jira notifications live in the header bell") for the full mechanism this
// ports from; this file only documents what is DIFFERENT here.
//
// Deliberately a SEPARATE, independent module rather than an import from
// overview.mjs: overview.mjs's own jiraBellButton/jiraBellPanel/jiraRow are
// wired into that page's own `state`/`omenu`/CommandMenu machinery (the
// right-click "Markeer als ongelezen" menu, the row-popover keyboard model),
// which home.mjs/plan.mjs do not share and should not be made to share just
// for this. So this is a second, small implementation of the same read-only
// feed + the same two writes (mark read / mark all read), reusing the exact
// same backend (`GET /api/jira/notifications`, the `jira_inbox` tracker's
// `jira_notify` Signal) — not a refactor of overview.mjs, which stays
// untouched and is the more feature-complete of the two (it alone still has
// the right-click "mark as unread" menu; see below).
//
// The ONE new rule for this rollout, which overview.mjs's own bell does NOT
// have: the icon renders NOTHING at all while there are zero notifications —
// `jira.length > 0` gates it, regardless of read/unread — so a reviewer who
// has never had a Jira notification never sees a dead bell that only opens
// to "Geen notificaties." on these two pages. Confirmed with Reindert.
//
// Scoped deliberately OUT of this rollout (present only in overview.mjs):
// the right-click "Markeer als ongelezen" context menu. Marking read (click a
// row, the per-row tick, or "Alles gelezen maken") is fully available here;
// marking a row unread again is not, on these two pages, for now.

import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { avatarHTML } from './avatar.mjs'
import { relativeTime } from './relativeTime.mjs'

// bell — this module's own small reactive store, independent of whichever
// page's `state`/`ui` mounts it.
const bell = reactive({
  jira: [],
  jiraHidden: 0,
  jiraRunId: '',
  jiraUnreadOnly: true,
  open: false,
})

// JIRA_READ_RESPITE_MS / jiraReadRespite — the same 5-minute "just read, stay
// visible" grace period as overview.mjs's own bell (see that file's own doc
// comment on jiraReadRespite for the full reasoning). Plain, non-reactive
// module-level Map here too, for the same reason: a display fact, not domain
// state.
const JIRA_READ_RESPITE_MS = 5 * 60 * 1000
const jiraReadRespite = new Map()

function jiraRespiteActive(n) {
  const at = jiraReadRespite.get(n.id)
  if (typeof at !== 'number') return false
  if (Date.now() - at >= JIRA_READ_RESPITE_MS) {
    jiraReadRespite.delete(n.id)
    return false
  }
  return true
}

function visibleJiraNotifications() {
  if (!bell.jiraUnreadOnly) return bell.jira
  return bell.jira.filter((n) => n.unread || jiraRespiteActive(n))
}

function jiraUnreadCount() {
  return bell.jira.filter((n) => n.unread).length
}

async function loadJiraNotifications() {
  try {
    const res = await fetch('/api/jira/notifications')
    if (!res.ok) return
    const body = await res.json()
    if (!body || !body.ok) return
    bell.jiraRunId = body.runId || ''
    bell.jira = Array.isArray(body.items) ? body.items : []
    bell.jiraHidden = Number(body.hidden) || 0
    const liveIds = new Set(bell.jira.map((n) => n.id))
    for (const id of jiraReadRespite.keys()) {
      if (!liveIds.has(id)) jiraReadRespite.delete(id)
    }
  } catch (err) {
    // Keep whatever was already shown — a transient failure must never blank
    // the list.
  }
}

async function ensureJiraRunId() {
  let runId = bell.jiraRunId
  if (!runId) {
    const started = await fetch('/api/workflows/jira_inbox', { method: 'POST' })
    const body = await started.json()
    runId = (body && body.runId) || ''
    bell.jiraRunId = runId
  }
  return runId
}

async function markJiraRead(n) {
  if (!n || !n.unread) return
  jiraReadRespite.set(n.id, Date.now())
  bell.jira = bell.jira.map((it) => (it.id === n.id ? { ...it, unread: false } : it))
  try {
    const runId = await ensureJiraRunId()
    if (!runId) return
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/jira_notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', id: n.id }),
    })
  } catch (err) {
    console.error('mark jira notification read failed:', err)
  }
}

async function markAllJiraRead() {
  if (!jiraUnreadCount()) return
  bell.jira = bell.jira.map((it) => (it.unread ? { ...it, unread: false } : it))
  try {
    const runId = await ensureJiraRunId()
    if (!runId) return
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/jira_notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read_all' }),
    })
  } catch (err) {
    console.error('mark all jira notifications read failed:', err)
  }
}

function closeJiraBell() {
  bell.open = false
}

function toggleJiraBell() {
  bell.open = !bell.open
}

// ── rendering — a trimmed port of overview.mjs's jiraRow/jiraBellPanel/etc,
// same testids so a future shared test could target either.

function jiraBellDot() {
  if (!jiraUnreadCount()) return html`<span class="hidden"></span>`
  return html`<span
    data-testid="jira-bell-dot"
    title="${() => jiraUnreadCount() + ' ' + t('ongelezen')}"
    class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-2 ring-white dark:bg-indigo-400 dark:ring-zinc-950"
  ></span>`
}

function jiraUnreadMark(n) {
  if (!n.unread) return html`<span class="inline-block h-2 w-2 shrink-0"></span>`
  return html`<span
    data-testid="jira-unread-dot"
    title="${t('Ongelezen')}"
    class="inline-block h-2 w-2 shrink-0 rounded-full bg-indigo-500 dark:bg-indigo-400"
  ></span>`
}

function jiraMarkReadButton(n) {
  return html`<button
    type="button"
    data-testid="jira-mark-read"
    title="${t('Markeer als gelezen')}"
    class="rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
    @click="${(e) => {
      e.preventDefault()
      e.stopPropagation()
      markJiraRead(n)
    }}"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5"></path>
    </svg>
  </button>`
}

function jiraAvatarMark(n) {
  return html`<span class="flex w-8 shrink-0 items-center justify-center"
    >${() => avatarHTML(n.actor || n.issueKey || '?', n.avatarUrl, 'h-6 w-6')}</span
  >`
}

function jiraRow(n) {
  const icon = n.issueIconUrl ? html`<img src="${n.issueIconUrl}" alt="" class="mt-0.5 h-3.5 w-3.5 shrink-0" />`.key('icon') : ''
  const groupNote =
    n.groupSize > 1 && n.otherActor
      ? html`<p class="mt-1 truncate text-xs font-medium text-indigo-600 dark:text-indigo-400">+${n.groupSize - 1} updates from ${n.otherActor}</p>`.key(
          'group',
        )
      : ''
  const preview = n.commentPreview
    ? html`<p
        class="mt-1.5 line-clamp-3 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300"
      >
        ${n.commentPreview}
      </p>`.key('preview')
    : ''
  return html`
    <a
      href="${n.url}"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="jira-row"
      data-jira-id="${n.id}"
      class="group flex items-start gap-3 border-b border-slate-100 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-100 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40"
      @click="${() => markJiraRead(n)}"
    >
      ${() => jiraAvatarMark(n)}
      <div class="min-w-0 flex-1">
        <h3
          class="${'line-clamp-2 text-[13.5px] text-slate-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white ' +
          (n.unread ? 'font-semibold' : 'font-normal')}"
        >
          ${n.title || n.issueKey || n.url}
          <span class="font-normal text-slate-400 dark:text-zinc-600">· ${relativeTime(n.at)}</span>
          ${() =>
            !n.unread && jiraRespiteActive(n)
              ? html`<span data-testid="jira-respite-mark" class="font-normal text-indigo-500 dark:text-indigo-400">· ${t('net gelezen')}</span>`.key(
                  'respite',
                )
              : ''}
        </h3>
        ${() =>
          n.issueTitle
            ? html`<p class="mt-0.5 flex items-start gap-1 text-xs text-slate-600 dark:text-zinc-400">${icon}<span class="line-clamp-2">${n.issueTitle}</span></p>`.key(
                'issue-title',
              )
            : ''}
        <p class="mt-0.5 truncate text-xs text-slate-500 dark:text-zinc-500">${(n.issueKey ? n.issueKey + ' • ' : '') + (n.issueStatus || n.actor)}</p>
        <div class="contents">${() => groupNote}</div>
        <div class="contents">${() => preview}</div>
      </div>
      <div class="flex shrink-0 items-center gap-2 self-start pt-0.5">
        <div class="contents">${() => (n.unread ? jiraMarkReadButton(n) : '')}</div>
        ${() => jiraUnreadMark(n)}
      </div>
    </a>
  `.key('jira:' + n.id)
}

function jiraUnreadToggle() {
  return html`<button
    data-testid="jira-unread-toggle"
    class="${'shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ' +
    (bell.jiraUnreadOnly
      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-300'
      : 'border-slate-200 bg-white text-slate-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400')}"
    @click="${() => (bell.jiraUnreadOnly = !bell.jiraUnreadOnly)}"
  >
    ${() => t('Alleen ongelezen') + ': ' + (bell.jiraUnreadOnly ? t('aan') : t('uit'))}
  </button>`
}

function jiraMarkAllReadButton() {
  return html`<button
    type="button"
    data-testid="jira-mark-all-read"
    class="ml-auto shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
    disabled="${() => jiraUnreadCount() === 0}"
    @click="${() => markAllJiraRead()}"
  >
    ${t('Alles gelezen maken')}
  </button>`
}

function jiraHiddenNote() {
  return html`<div
    data-testid="jira-hidden-note"
    class="${() =>
      'border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500 dark:border-zinc-800 dark:text-zinc-500 ' + (bell.jiraHidden ? 'block' : 'hidden')}"
  >
    ${() => (bell.jiraHidden ? t('{n} verborgen door je filter', { n: bell.jiraHidden }) : '')}
  </div>`
}

function jiraBellPanel() {
  const rows = visibleJiraNotifications()
  return html`
    <div
      data-testid="jira-bell-panel"
      class="absolute right-0 top-full z-20 mt-2 w-[45rem] max-w-[calc(100vw-6rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-zinc-800">
        <h2 class="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">Jira</h2>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400"
          >${() => jiraUnreadCount() + ' ' + t('ongelezen')}</span
        >
        ${jiraUnreadToggle()} ${jiraMarkAllReadButton()}
      </div>
      ${jiraHiddenNote()}
      <div class="max-h-96 overflow-y-auto">
        ${() =>
          rows.length
            ? html`<div>${() => visibleJiraNotifications().map((n) => jiraRow(n))}</div>`.key('jira-bell:list')
            : html`<p class="px-4 py-6 text-center text-sm text-slate-500 dark:text-zinc-500">
                ${() => (bell.jira.length ? t('Alles gelezen.') : t('Geen notificaties.'))}
              </p>`.key('jira-bell:empty')}
      </div>
    </div>
  `.key('jira-bell:' + (bell.jiraUnreadOnly ? 'unread' : 'all') + ':' + rows.map((n) => n.id + (n.unread ? '!' : '')).join(','))
}

// jiraBellButton — the header icon. Renders NOTHING (an empty, keyless
// wrapper) while `bell.jira` is empty — see this file's own header comment
// for why: "alleen als er iets te klikken is", confirmed as "at least one
// notification exists, read or unread" rather than "at least one unread".
export function jiraBellButton(cls = 'h-7 w-7') {
  return html`<div class="contents">
    ${() =>
      bell.jira.length
        ? html`<div class="relative" data-testid="jira-bell-wrapper">
            <button
              type="button"
              data-testid="jira-bell-button"
              title="${t('Jira notificaties')}"
              class="${'relative inline-flex items-center justify-center rounded-full bg-slate-50 text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200 ' +
              cls}"
              @click="${toggleJiraBell}"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path>
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>
              </svg>
              ${() => jiraBellDot()}
            </button>
            <div class="contents">${() => (bell.open ? jiraBellPanel() : '')}</div>
          </div>`.key('jira-bell:present')
        : html`<span class="hidden" data-testid="jira-bell-absent"></span>`.key('jira-bell:absent')}
  </div>`
}

// ── host-page wiring ─────────────────────────────────────────────────────
// Same shape as imageLightbox.mjs's isLightboxOpen/handleLightboxKeydown: the
// host page's own onKeydown checks isJiraBellOpen() and, if so, hands the key
// over and returns — this dropdown owns the keyboard (Escape only) while
// open, exactly like overview.mjs's own bell.

export function isJiraBellOpen() {
  return bell.open
}

export function handleJiraBellKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeJiraBell()
  }
}

// handleJiraBellOutsideClick — the host page registers this on
// `document`'s `mousedown`; mirrors overview.mjs's own closeJiraBellOnOutsideClick.
export function handleJiraBellOutsideClick(e) {
  if (!bell.open) return
  const wrap = e.target.closest && e.target.closest('[data-testid="jira-bell-wrapper"]')
  if (!wrap) closeJiraBell()
}

// initJiraBell — call once at module load from each host page. Loads once
// immediately, then polls every 60s (same cadence as overview.mjs's own
// 60s poll), and wires the outside-click closer.
let jiraBellPollTimer = null
export function initJiraBell() {
  if (jiraBellPollTimer) return // already initialized (guards a hot-reload/double-import)
  loadJiraNotifications()
  jiraBellPollTimer = setInterval(loadJiraNotifications, 60_000)
  document.addEventListener('mousedown', handleJiraBellOutsideClick)
}
