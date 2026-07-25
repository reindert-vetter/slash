// inbox.mjs — the /inbox page (Fase 3 of the task-inbox design): a left
// index + right detail panel over the derived, scored task list from
// GET /api/tasks (the task_inbox workflow, see
// .claude/rules/tembed-workflows.md). Read-only except for two sanctioned
// write paths: snoozing a task (task_snooze workflow, signals/snooze) and
// replying/resolving a comment_unread task's thread (the *existing*
// task_code_comment reply Signal — a comment's task id IS its runId, see
// modules/comments' RunID==ID convention).
//
// Layout mirrors the /pr/<id> pattern: a fixed left index (like pr-index)
// + a right detail panel (like the block column), sorted by points
// descending (tie-break: most recently updated first).

import { reactive, html, watch } from './vendor/arrow.js'
import { initTheme, themeToggleButton } from './theme.mjs'
import { avatarHTML } from './avatar.mjs'
import { renderMarkdown } from './markdown.mjs'
import { highlight } from './Block.mjs'
import { composeTargetHint, commentBody } from './RelatedPanel.mjs'

initTheme()

const state = reactive({
  loading: true,
  error: '',
  taskInboxRunId: '',
  taskSnoozeRunId: '',
  tasks: [], // taskinbox.Task[] straight off GET /api/tasks
  snoozes: [], // tasksnooze.Snooze[] straight off GET /api/tasksnoozes
  selectedId: null, // task.id of the row shown in the detail panel
  snoozePopoverFor: null, // task.id whose snooze-duration popover is open
  showSnoozed: false, // the "snoozed tasks" drawer at the bottom of the index
  replyBusy: false,
})

// ── data shape helpers ──────────────────────────────────────────────────
// PointNotes/Detail are opaque JSON strings on the wire (taskinbox.Task) —
// parsed once per task here rather than re-parsed on every render.

function pointNotesOf(t) {
  try {
    return JSON.parse(t.pointNotes || '[]')
  } catch (e) {
    return []
  }
}

function detailOf(t) {
  try {
    return JSON.parse(t.detail || '{}')
  } catch (e) {
    return {}
  }
}

// ── snooze (until === 0 || until > now means still hidden) ─────────────────

function snoozeUntilFor(taskId) {
  const sn = state.snoozes.find((s) => s.taskId === taskId)
  return sn ? sn.until : null
}

function isSnoozed(taskId) {
  const until = snoozeUntilFor(taskId)
  if (until == null) return false
  return until === 0 || until > Date.now()
}

// snoozeUntil computes an absolute Unix-ms expiry for a duration choice, in
// browser-local time — mirrors the removed PR-ignore feature's own
// ignoreUntil (see git history / tembed-workflows.md's `ignore` section,
// now replaced task-scoped by task_snooze).
function snoozeUntil(kind) {
  const now = new Date()
  if (kind === 'forever') return 0
  if (kind === 'week') return Date.now() + 7 * 86400000
  if (kind === 'twoweeks') return Date.now() + 14 * 86400000
  if (kind === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(8, 0, 0, 0)
    return d.getTime()
  }
  if (kind === 'monday') {
    const d = new Date(now)
    const day = d.getDay() // 0=Sun … 1=Mon
    let add = (1 - day + 7) % 7
    if (add === 0) add = 7
    d.setDate(d.getDate() + add)
    d.setHours(8, 0, 0, 0)
    return d.getTime()
  }
  return 0
}

function formatSnoozeUntil(until) {
  if (!until) return 'voor altijd'
  try {
    return new Date(until).toLocaleString('nl-NL', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch (e) {
    return new Date(until).toISOString()
  }
}

const SNOOZE_CHOICES = [
  { kind: 'tomorrow', label: 'Morgen 08:00' },
  { kind: 'monday', label: 'Volgende maandag 08:00' },
  { kind: 'week', label: '7 dagen' },
  { kind: 'twoweeks', label: '14 dagen' },
  { kind: 'forever', label: 'Voor altijd' },
]

async function postJSON(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

async function snoozeTask(taskId, kind) {
  if (!state.taskSnoozeRunId) return
  const until = snoozeUntil(kind)
  // Optimistic local update so the row disappears immediately, reconciled on
  // the next loadSnoozes() poll — same pattern as overview.mjs's ignore flow.
  state.snoozes = [...state.snoozes.filter((s) => s.taskId !== taskId), { taskId, until }]
  state.snoozePopoverFor = null
  if (state.selectedId === taskId) selectNext()
  await postJSON('/api/workflows/' + encodeURIComponent(state.taskSnoozeRunId) + '/signals/snooze', {
    taskId,
    until,
  })
  loadSnoozes()
}

async function unsnoozeTask(taskId) {
  if (!state.taskSnoozeRunId) return
  state.snoozes = state.snoozes.filter((s) => s.taskId !== taskId)
  await postJSON('/api/workflows/' + encodeURIComponent(state.taskSnoozeRunId) + '/signals/snooze', {
    taskId,
    clear: true,
  })
  loadSnoozes()
}

// ── derived lists ────────────────────────────────────────────────────────

function visibleTasks() {
  return state.tasks
    .filter((t) => !isSnoozed(t.id))
    .slice()
    .sort((a, b) => b.points - a.points || b.updatedAt - a.updatedAt)
}

function snoozedTasks() {
  return state.tasks.filter((t) => isSnoozed(t.id))
}

function selectedTask() {
  return state.tasks.find((t) => t.id === state.selectedId) || null
}

// selectNext keeps the detail panel showing something sensible right after
// the currently selected task disappears (snoozed away, or resolved) —
// simply the new first row, mirroring "move on to whatever's next".
function selectNext() {
  const rows = visibleTasks().filter((t) => t.id !== state.selectedId)
  state.selectedId = rows.length ? rows[0].id : null
}

// ── load / poll (mirrors overview.mjs's reloadSnapshot + heartbeat cadence) ─

async function ensureTaskInbox() {
  const res = await postJSON('/api/workflows/task_inbox')
  if (res.ok) {
    const body = await res.json()
    state.taskInboxRunId = body.runId || state.taskInboxRunId
  }
}

async function ensureTaskSnooze() {
  const res = await postJSON('/api/workflows/task_snooze')
  if (res.ok) {
    const body = await res.json()
    state.taskSnoozeRunId = body.runId || state.taskSnoozeRunId
  }
}

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks')
    if (!res.ok) return
    const body = await res.json()
    if (body && body.ok) {
      state.tasks = Array.isArray(body.tasks) ? body.tasks : []
      if (state.selectedId == null) {
        const rows = visibleTasks()
        if (rows.length) state.selectedId = rows[0].id
      }
    }
  } catch (e) {
    // keep whatever we last had on a transient failure
  } finally {
    state.loading = false
  }
}

async function loadSnoozes() {
  try {
    const res = await fetch('/api/tasksnoozes')
    if (!res.ok) return
    const body = await res.json()
    if (body && body.ok) state.snoozes = Array.isArray(body.snoozes) ? body.snoozes : []
  } catch (e) {
    // keep the current list on a transient failure
  }
}

function activeTab() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

async function refreshTaskInbox() {
  if (!state.taskInboxRunId) return
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.taskInboxRunId) + '/signals/refresh', {
      method: 'POST',
    })
  } catch (e) {
    // best-effort — the workflow keeps its own cadence regardless
  }
}

function sendHeartbeat() {
  if (!activeTab() || !state.taskInboxRunId) return
  fetch('/api/workflows/' + encodeURIComponent(state.taskInboxRunId) + '/heartbeat', { method: 'POST' }).catch(
    () => {}
  )
}

const HEARTBEAT_MS = 60_000
const RELOAD_MS = 15_000

async function init() {
  await ensureTaskInbox()
  await ensureTaskSnooze()
  await refreshTaskInbox()
  await Promise.all([loadTasks(), loadSnoozes()])
  setInterval(sendHeartbeat, HEARTBEAT_MS)
  setInterval(() => {
    if (activeTab()) {
      loadTasks()
      loadSnoozes()
    }
  }, RELOAD_MS)
  document.addEventListener('visibilitychange', sendHeartbeat)
}

// ── reply / resolve (comment_unread — the SAME task_code_comment reply
// Signal RelatedPanel.mjs uses; a comment's task id is "comment:" + its
// runId, and Comment.ID === Comment.RunID, see tembed-workflows.md) ────────

function commentRunId(t) {
  return t.id.startsWith('comment:') ? t.id.slice('comment:'.length) : ''
}

async function sendReply(t, body, done) {
  const runId = commentRunId(t)
  if (!runId || !body) return
  state.replyBusy = true
  try {
    await postJSON('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      author: 'reviewer',
      body,
      done,
    })
    const el = document.querySelector('[data-testid=task-reply-input]')
    if (el) el.value = ''
    await refreshTaskInbox()
    await loadTasks()
  } finally {
    state.replyBusy = false
  }
}

function resolveComment(t) {
  const el = document.querySelector('[data-testid=task-reply-input]')
  const body = (el && el.value.trim()) || '/resolve'
  return sendReply(t, body, true)
}

function replyComment(t) {
  const el = document.querySelector('[data-testid=task-reply-input]')
  const body = el ? el.value.trim() : ''
  if (!body) return
  return sendReply(t, body, false)
}

// ── icons ────────────────────────────────────────────────────────────────

const ICON_PATHS = {
  pr_review:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  comment_unread: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  jira: '<path d="M12 2 3 8.5 6.5 20h11L21 8.5Z"/><circle cx="12" cy="12" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
}

function icon(name, cls = 'h-3.5 w-3.5') {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="${'inline-block shrink-0 ' + cls}"
    aria-hidden="true"
    .innerHTML="${ICON_PATHS[name] || ''}"
  ></svg>`
}

const KIND_ICON_CLS = {
  pr_review: 'text-indigo-500 dark:text-indigo-400',
  comment_unread: 'text-amber-500 dark:text-amber-400',
  jira: 'text-sky-500 dark:text-sky-400',
}

const KIND_LABEL = {
  pr_review: 'PR-review',
  comment_unread: 'Onbeantwoorde reactie',
  jira: 'Jira',
}

function relTime(ms) {
  if (!ms) return ''
  const diffSec = Math.round((Date.now() - ms) / 1000)
  if (diffSec < 60) return 'zojuist'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return diffMin + ' min geleden'
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return diffHour + ' uur geleden'
  const diffDay = Math.round(diffHour / 24)
  return diffDay + ' dag' + (diffDay === 1 ? '' : 'en') + ' geleden'
}

// ── index row ────────────────────────────────────────────────────────────

function snoozePopover(t) {
  if (state.snoozePopoverFor !== t.id) return ''
  return html`
    <div
      data-testid="task-snooze-popover"
      class="absolute right-0 top-full z-10 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
      @click="${(e) => e.stopPropagation()}"
    >
      ${SNOOZE_CHOICES.map(
        (c) => html`<button
          data-testid="${'task-snooze-' + c.kind}"
          class="block w-full rounded px-2 py-1.5 text-left text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
          @click="${() => snoozeTask(t.id, c.kind)}"
        >
          ${c.label}
        </button>`.key(c.kind)
      )}
    </div>
  `
}

function taskRow(t) {
  const isSel = () => state.selectedId === t.id
  return html`
    <div
      data-testid="task-row"
      data-task-id="${t.id}"
      class="${() =>
        'relative flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer ' +
        (isSel()
          ? 'border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 dark:border-indigo-500/40 dark:bg-indigo-500/10'
          : 'border-transparent hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      @click="${() => {
        state.selectedId = t.id
        state.snoozePopoverFor = null
      }}"
    >
      <span data-testid="task-kind-icon" class="${'mt-0.5 ' + (KIND_ICON_CLS[t.kind] || 'text-slate-400')}"
        >${icon(t.kind)}</span
      >
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-slate-900 dark:text-zinc-100">${t.title}</div>
        <div class="truncate text-xs text-slate-500 dark:text-zinc-400">${t.subtitle}</div>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1">
        <span
          data-testid="task-points"
          class="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
          >${t.points}</span
        >
        <button
          data-testid="task-snooze-btn"
          title="Snooze"
          class="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
          @click="${(e) => {
            e.stopPropagation()
            state.snoozePopoverFor = state.snoozePopoverFor === t.id ? null : t.id
          }}"
        >
          ${icon('clock', 'h-3.5 w-3.5')}
        </button>
      </div>
      ${() => snoozePopover(t)}
    </div>
  `
}

function snoozedRow(t) {
  const until = snoozeUntilFor(t.id)
  return html`
    <div
      data-testid="task-snoozed-row"
      class="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2.5 py-2 text-xs dark:border-zinc-800"
    >
      <div class="min-w-0">
        <div class="truncate font-medium text-slate-700 dark:text-zinc-300">${t.title}</div>
        <div class="text-slate-400 dark:text-zinc-500">gesnoozed tot ${formatSnoozeUntil(until)}</div>
      </div>
      <button
        data-testid="task-snoozed-unsnooze"
        class="shrink-0 rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        @click="${() => unsnoozeTask(t.id)}"
      >
        Stop met snoozen
      </button>
    </div>
  `
}

function snoozedDrawer() {
  const list = snoozedTasks()
  return html`
    <div class="mt-3 border-t border-slate-100 pt-2 dark:border-zinc-800">
      <button
        data-testid="task-snoozed-toggle"
        class="flex w-full items-center justify-between rounded px-1 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        @click="${() => (state.showSnoozed = !state.showSnoozed)}"
      >
        <span>${() => (state.showSnoozed ? 'Verberg' : 'Toon') + ' gesnoozede taken (' + list.length + ')'}</span>
      </button>
      ${() =>
        state.showSnoozed
          ? html`<div data-testid="task-snoozed-list" class="mt-2 flex flex-col gap-1.5">
              ${() =>
                list.length
                  ? list.map((t) => snoozedRow(t).key(t.id))
                  : [html`<p class="px-1 text-xs text-slate-400 dark:text-zinc-500">Geen gesnoozede taken.</p>`.key(
                      'none'
                    )]}
            </div>`
          : ''}
    </div>
  `
}

function taskIndex() {
  return html`
    <aside
      data-testid="task-index"
      class="fixed left-6 top-6 bottom-6 w-[26rem] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="mb-2 flex items-center justify-between px-1">
        <h1 class="text-sm font-semibold text-slate-900 dark:text-zinc-100">Taken</h1>
        ${themeToggleButton('shrink-0')}
      </div>
      ${() =>
        state.loading
          ? html`<p class="px-1 text-xs text-slate-400 dark:text-zinc-500">Laden…</p>`
          : ''}
      ${() => {
        const rows = visibleTasks()
        if (!rows.length && !state.loading) {
          return [
            html`<p data-testid="task-empty" class="px-1 text-xs text-slate-400 dark:text-zinc-500">
              Niets te doen — alles is bijgewerkt.
            </p>`.key('empty'),
          ]
        }
        return rows.map((t) => taskRow(t).key(t.id))
      }}
      ${() => snoozedDrawer()}
    </aside>
  `
}

// ── detail: pr_review ───────────────────────────────────────────────────

const CHECKS_STYLE = {
  SUCCESS: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  FAILURE: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  ERROR: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  PENDING: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
}

function prReviewDetail(t) {
  const d = detailOf(t)
  return html`
    <div data-testid="task-detail-pr" class="flex flex-col gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900 dark:text-zinc-100">${d.title || t.title}</h2>
        <p class="mt-0.5 text-sm text-slate-500 dark:text-zinc-400">
          PR #${t.pr} · ${d.author || ''} ·
          <span class="text-emerald-600 dark:text-emerald-400">+${d.additions || 0}</span>
          <span class="text-rose-600 dark:text-rose-400">−${d.deletions || 0}</span>
        </p>
      </div>
      <div class="flex flex-wrap gap-1.5 text-xs">
        ${() =>
          d.reviewDecision
            ? html`<span
                class="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300"
                >${d.reviewDecision}</span
              >`
            : ''}
        ${() =>
          d.checksState
            ? html`<span
                class="${'rounded-full px-2 py-0.5 ' + (CHECKS_STYLE[d.checksState] || 'bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300')}"
                >CI: ${d.checksState}${d.checksTotal ? ' (' + d.checksTotal + ')' : ''}</span
              >`
            : ''}
      </div>
      <div class="mt-2 flex gap-2">
        ${() =>
          d.hasGraph
            ? html`<a
                href="${'/pr/' + t.pr}"
                data-testid="task-open-tree"
                class="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >Open review tree</a
              >`
            : ''}
        ${() =>
          t.url
            ? html`<a
                href="${t.url}"
                target="_blank"
                rel="noreferrer"
                data-testid="task-open-github"
                class="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >Open op GitHub</a
              >`
            : ''}
      </div>
    </div>
  `
}

// ── detail: comment_unread ───────────────────────────────────────────────

function commentThreadMessage(m, i) {
  return html`
    <div data-testid="task-comment-message" class="flex items-start gap-2">
      ${avatarHTML(m.author, '', 'h-5 w-5')}
      <div class="min-w-0 flex-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-sm dark:bg-zinc-800">
        <div class="mb-0.5 flex items-baseline gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
          <span class="font-medium text-slate-700 dark:text-zinc-200">${m.author}</span>
          <span>${relTime(new Date(m.createdAt).getTime())}</span>
        </div>
        <div class="[overflow-wrap:anywhere] text-slate-800 dark:text-zinc-100" .innerHTML="${commentBody(m)}"></div>
      </div>
    </div>
  `
}

function commentUnreadDetail(t) {
  const d = detailOf(t)
  const messages = Array.isArray(d.messages) ? d.messages : []
  const codeTarget = d.file ? { file: d.file, label: d.label, gran: d.gran, code: d.code } : null
  return html`
    <div data-testid="task-detail-comment" class="flex flex-col gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900 dark:text-zinc-100">${t.title}</h2>
        <p class="mt-0.5 text-sm text-slate-500 dark:text-zinc-400">
          PR #${t.pr} · ${d.file || ''}${d.label ? ' · ' + d.label : ''}
        </p>
      </div>
      ${() => (codeTarget && codeTarget.code ? composeTargetHint(codeTarget) : '')}
      <div data-testid="task-comment-thread" class="flex flex-col gap-2">
        ${() =>
          messages.length
            ? messages.map((m, i) => commentThreadMessage(m, i).key('msg:' + i))
            : [html`<p class="text-xs text-slate-400 dark:text-zinc-500">Geen berichten.</p>`.key('none')]}
      </div>
      <div class="mt-2 flex flex-col gap-2">
        <textarea
          data-testid="task-reply-input"
          rows="2"
          placeholder="Reageer…"
          class="w-full resize-none rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        ></textarea>
        <div class="flex gap-2">
          <button
            data-testid="task-reply-send"
            class="${() =>
              'rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 ' +
              (state.replyBusy ? 'opacity-60' : '')}"
            @click="${() => replyComment(t)}"
          >
            Verstuur
          </button>
          <button
            data-testid="task-reply-resolve"
            class="${() =>
              'rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 ' +
              (state.replyBusy ? 'opacity-60' : '')}"
            @click="${() => resolveComment(t)}"
          >
            Oplossen
          </button>
          ${() =>
            t.url
              ? html`<a
                  href="${t.url}"
                  target="_blank"
                  rel="noreferrer"
                  class="ml-auto self-center text-xs text-slate-500 hover:underline dark:text-zinc-400"
                  >Open op GitHub</a
                >`
              : ''}
        </div>
      </div>
    </div>
  `
}

// ── detail: jira ─────────────────────────────────────────────────────────

function jiraDetail(t) {
  const d = detailOf(t)
  return html`
    <div data-testid="task-detail-jira" class="flex flex-col gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900 dark:text-zinc-100">${t.title}</h2>
        <p class="mt-0.5 text-sm text-slate-500 dark:text-zinc-400">${d.key || ''} · ${d.status || ''}</p>
      </div>
      <div
        class="markdown-body text-sm text-slate-800 dark:text-zinc-100"
        .innerHTML="${() => renderMarkdown(d.description || '')}"
      ></div>
      <div class="mt-2">
        ${() =>
          d.url || t.url
            ? html`<a
                href="${d.url || t.url}"
                target="_blank"
                rel="noreferrer"
                data-testid="task-open-jira"
                class="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >Open in Jira</a
              >`
            : ''}
      </div>
    </div>
  `
}

// ── points breakdown (shared across all three kinds) ────────────────────

function pointsBreakdown(t) {
  const notes = pointNotesOf(t)
  return html`
    <div
      data-testid="task-points-breakdown"
      class="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <div class="mb-1.5 font-medium text-slate-500 dark:text-zinc-400">
        Score: <span class="text-slate-800 dark:text-zinc-100">${t.points}</span>
      </div>
      <ul class="flex flex-col gap-0.5">
        ${() =>
          notes.length
            ? notes.map(
                (n, i) => html`<li
                  data-testid="task-point-note"
                  class="flex items-center justify-between text-slate-600 dark:text-zinc-300"
                >
                  <span>${n.label}</span>
                  <span class="font-mono">${n.points >= 0 ? '+' : ''}${n.points}</span>
                </li>`.key('note:' + i)
              )
            : [html`<li class="text-slate-400 dark:text-zinc-500">geen opbouw</li>`.key('none')]}
      </ul>
    </div>
  `
}

// detailBodyFor picks the kind-specific detail template. Kept as its own
// function (rather than inlined) so the taskDetail() wrapper below can hang
// it off a `${() => …}` function binding.
function detailBodyFor(t) {
  if (t.kind === 'pr_review') return prReviewDetail(t)
  if (t.kind === 'comment_unread') return commentUnreadDetail(t)
  if (t.kind === 'jira') return jiraDetail(t)
  return html`<p class="text-sm text-slate-500">Onbekend taaktype.</p>`
}

function taskDetail() {
  const t = selectedTask()
  if (!t) {
    return html`<div class="flex h-full items-center justify-center text-sm text-slate-400 dark:text-zinc-500">
      Selecteer een taak
    </div>`
  }
  // The outer wrapper below is always the SAME template call site (the
  // `<div class="flex flex-col">…</div>` shape never changes), so arrow.js
  // caches/reuses that chunk across a task-switch and statically patches its
  // slots — a plain, non-function `${…}` interpolation there only knows how
  // to patch an attribute/text node, not swap in a differently-shaped nested
  // template (prReviewDetail's shape vs. jiraDetail's shape). That silently
  // left the PREVIOUS kind's detail on screen while only the plain-text
  // label above it updated. Routing both through `${() => …}` function
  // bindings sends them through arrow's reactive node-reconciler instead,
  // which does handle a template↔template shape swap correctly — the same
  // fix as the documented "static template↔string slot" pitfall in
  // .claude/rules/conventions.md, generalized to template↔template.
  return html`
    <div class="flex flex-col">
      <div class="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500">
        ${() => KIND_LABEL[t.kind] || t.kind}
      </div>
      ${() => detailBodyFor(t)}
      ${() => pointsBreakdown(t)}
    </div>
  `
}

function taskDetailPanel() {
  return html`
    <main
      data-testid="task-detail"
      class="fixed left-[32.5rem] right-6 top-6 bottom-6 overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      ${() => taskDetail()}
    </main>
  `
}

function App() {
  return html`<div>${taskIndex()}${taskDetailPanel()}</div>`
}

// ── keyboard: ↑/↓ through the visible list, 's' opens the snooze popover for
// the selected row, Escape closes it. Kept deliberately simple — no
// hover-vs-keyboard gate (that fixes a *separate* hover-highlight state
// which this page doesn't have; here the arrow keys ARE the selection). ──

function moveSelection(delta) {
  const rows = visibleTasks()
  if (!rows.length) return
  const idx = rows.findIndex((t) => t.id === state.selectedId)
  const next = idx === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + delta))
  state.selectedId = rows[next].id
  state.snoozePopoverFor = null
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-task-id="' + CSS.escape(state.selectedId) + '"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

window.addEventListener('keydown', (e) => {
  const active = document.activeElement
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    if (e.key === 'Escape') active.blur()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 's' && state.selectedId) {
    state.snoozePopoverFor = state.snoozePopoverFor === state.selectedId ? null : state.selectedId
  } else if (e.key === 'Escape') {
    state.snoozePopoverFor = null
  }
})

App()(document.getElementById('app'))
init()
