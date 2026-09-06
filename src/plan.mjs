// plan.mjs — the /plan/<JIRA-KEY> planning page: the stage BEFORE a pull
// request exists. Reached from the "Planning"/"Todo" rows on /pr-overview.
//
// Same column shape as the review tree, deliberately its OWN code: nothing is
// imported from home.mjs/Block.mjs/RelatedPanel.mjs (those carry the whole
// review-tree state), only the shared page-level utilities every page uses
// (theme, i18n, markdown, url-state, workflow labels) plus the vendored Prism.
//
// The columns, left to right:
//   1. the ticket (title + description) with the ticket's own running workflow
//      tasks stacked below it,
//   2. the questions Claude still has to perfect the plan — multiple choice,
//      every choice with its own free-text field — and BELOW them the list of
//      everything that has to be done, each with its explanation,
//   3. the example-code blocks of whatever the cursor is on, and
//   4+. one more column per level of NESTED blocks, opened with → (a block with
//      children drills into its own column, like the review tree's
//      Underlying-code drilling).
//
// See .claude/docs/plan-page.md.

import { html, reactive } from './vendor/arrow.js'
import Prism from './vendor/prism.js'
import { t } from './i18n.mjs'
import { renderMarkdown } from './markdown.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { settingsButton } from './settingsLink.mjs'
import { labelForWorkflow } from './workflowLabels.mjs'
import { bindUrlState, num } from './urlState.mjs'

initTheme()

// The issue key lives in the PATH (/plan/PAYM-813), like the PR id does on
// /pr/<id>. A bare numeric form is accepted too — the overview's rows always
// carry a real Jira key, but a hand-typed id must not 404 the shell.
const KEY_FROM_PATH = /^\/plan\/([A-Za-z0-9]+-\d+|\d+)$/
const planKey = (() => {
  const m = KEY_FROM_PATH.exec(location.pathname)
  return m ? m[1].toUpperCase() : ''
})()

// POLL_MS re-reads the document + the ticket's runs, so a freshly generated
// plan appears on its own while the reviewer is still reading the ticket.
const POLL_MS = 3000

const EMPTY_DOC = { key: planKey, title: '', description: '', url: '', questions: [], tasks: [], answers: [], error: '' }

const state = reactive({
  key: planKey,
  loading: true,
  error: '',
  doc: EMPTY_DOC,
  runs: [],
  generating: false,
  runId: '',
  // Which column owns the keyboard: 0 = the ticket, 1 = questions/tasks,
  // 2 + n = the n-th block column (2 is the first one).
  col: 1,
  // The cursor in column 2, as the stable id of an OPTION ("q1o2") or a TASK
  // ("t3") — never a raw index, so a regenerated task list can't silently move
  // the cursor onto something else (.claude/rules/conventions.md).
  cur: '',
  // One cursor index per open block column; its length IS the number of block
  // columns, so this doubles as the drill path.
  path: [0],
  descExpanded: false,
  // The id of the option whose answer is being sent right now (a word, not a
  // spinner colour — see the colourblind rule).
  saving: '',
  // The answers picked in this tab that the stored document has not caught up
  // with yet, keyed by question id (see answerFor).
  pending: {},
  // The newest plan_execute run of this ticket (GET /api/plan's `exec`), or
  // null when the plan was never executed — see the execute card below.
  exec: null,
  // Executing the plan pushes a branch and opens a PR, so it takes a SECOND
  // Enter/click to confirm. Reset as soon as the cursor moves away.
  confirmExec: false,
  // The start request is in flight (a word, never a spinner colour).
  startingExec: false,
  // The scope question ("hoofdtaak of subtaak?") was just answered with "the
  // main task", but the signal — which runs the first generation inline — has
  // not come back yet. Local, so the question disappears the moment it is
  // answered instead of on the next poll (the stored document still says
  // needsScope until that generation lands).
  scopePending: false,
})

bindUrlState(state, [
  { key: 'cur', param: 'cur', default: '' },
  { key: 'col', param: 'col', parse: num(1), default: 1 },
  {
    key: 'path',
    param: 'path',
    parse: (raw) => raw.split('.').map((v) => Number(v) || 0),
    format: (v) => (Array.isArray(v) && v.length > 1 ? v.join('.') : null),
    default: null,
  },
])

// ---------------------------------------------------------------- data reads

// loadPlan reads the whole document in one read-only GET. The response is
// compared as text first: the poll runs every few seconds and a reassignment
// would rebuild the option rows (and thereby wipe a half-typed answer field).
let lastPayload = ''
async function loadPlan() {
  try {
    const res = await fetch('/api/plan?key=' + encodeURIComponent(state.key))
    if (!res.ok) {
      state.error = t('Kon dit ticket niet laden.')
      state.loading = false
      return
    }
    const body = await res.json()
    if (!body || !body.ok) return
    const payload = JSON.stringify(body)
    if (payload === lastPayload) {
      state.loading = false
      return
    }
    lastPayload = payload
    state.doc = body.doc || EMPTY_DOC
    state.runs = Array.isArray(body.runs) ? body.runs : []
    state.generating = !!body.generating
    state.exec = body.exec || null
    state.error = ''
    state.loading = false
    if (!state.doc.needsScope) state.scopePending = false
    dropSettledPending()
    clampCursor()
  } catch (err) {
    state.error = t('Kon dit ticket niet laden.')
    state.loading = false
  }
}

// dropSettledPending forgets a local pick as soon as the stored document
// carries exactly the same one, so the document is back to being the only
// source of truth the moment it can be.
function dropSettledPending() {
  const stored = state.doc.answers || []
  const keep = {}
  let changed = false
  for (const [qid, a] of Object.entries(state.pending)) {
    const on = stored.find((s) => s.questionId === qid)
    if (on && on.optionId === a.optionId && (on.text || '') === (a.text || '')) changed = true
    else keep[qid] = a
  }
  if (changed) state.pending = keep
}

// ensureTracker starts (or idempotently reuses) the ticket's own `plan`
// tracker and keeps its Run ID, which is where the answers are signalled to.
// Starting an Execution is the sanctioned UI write path.
async function ensureTracker() {
  try {
    const res = await fetch('/api/workflows/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key }),
    })
    if (!res.ok) return
    const body = await res.json()
    if (body && body.runId) state.runId = body.runId
  } catch (err) {
    // The page stays readable without it; only answering needs the Run ID.
  }
}

// sendAnswer signals ONE answer (option + typed text) to the tracker. The
// document is updated locally too, so the choice is visible immediately
// instead of only after the next poll (an event/read is never the source of
// truth, the tracker's own document is).
async function sendAnswer(question, option, text) {
  state.pending = { ...state.pending, [question.id]: { questionId: question.id, optionId: option.id, text: text || '' } }
  lastPayload = ''
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = option.id
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: question.id, optionId: option.id, text: text || '' }),
    })
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really stored.
  }
  state.saving = ''
}

// needsScope is true while the tracker is parked on ITS first question: this
// ticket has subtasks, so what is being planned — the main task, or one of the
// subtasks? Nothing else of the index is shown until that is answered.
function needsScope() {
  return !state.scopePending && !!state.doc.needsScope && (state.doc.subtasks || []).length > 0
}

// busyGenerating covers both "the tracker says it is generating" and the gap
// right after the scope answer, where the generation runs inline in that very
// request and the stored document still reads as unanswered.
function busyGenerating() {
  return state.generating || state.scopePending
}

// chooseScope answers the scope question. A SUBTASK is not signalled at all —
// it simply has its own /plan page with its own tracker, and this one stays
// parked (see .claude/docs/plan-page.md). Only "the main task" is signalled,
// which releases this tracker into its first generation.
async function chooseScope(row) {
  if (row.target === 'subtask') {
    location.href = '/plan/' + encodeURIComponent(row.subtask.key)
    return
  }
  if (state.saving) return
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = row.id
  state.scopePending = true
  lastPayload = ''
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_scope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 'parent' }),
    })
    await loadPlan()
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really recorded.
  }
  state.saving = ''
}

// triggerExecute is the index's LAST action: implement the plan on a fresh
// branch and open a DRAFT pull request (plan_execute.go). It pushes and opens
// a PR, so the first press only ARMS it — the second one really starts it. The
// armed state is shown in words, never by a colour alone.
async function triggerExecute() {
  if (state.startingExec || execRunning()) return
  if (!state.confirmExec) {
    state.confirmExec = true
    return
  }
  state.confirmExec = false
  state.startingExec = true
  try {
    const res = await fetch('/api/workflows/plan_execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key }),
    })
    if (res.ok) {
      lastPayload = ''
      await loadPlan()
    }
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really recorded.
  }
  state.startingExec = false
}

function execRunning() {
  return !!state.exec && state.exec.status === 'running'
}

// ------------------------------------------------------------------ cursors

// navRows is the flat, ordered list column 2 navigates: every option of every
// question, then every task. One list, so ↓ walks from the last option
// straight into the task list, exactly as the column reads on screen.
// EXEC_ROW_ID is the stable id of that last action row — the same id space as
// an option ("q1o2") or a task ("t3"), so ?cur= restores it like any other.
const EXEC_ROW_ID = 'exec'

// SCOPE_PARENT_ID is the stable id of the "plan the main task itself" row —
// the same id space as an option ("q1o2") or a task ("t3"), so ?cur= restores
// it like any other row.
const SCOPE_PARENT_ID = 'scope:parent'

function navRows() {
  const out = []
  // The scope question REPLACES the whole index while it stands: the reviewer
  // is asked what is being planned before anything else is shown.
  if (needsScope()) {
    out.push({ id: SCOPE_PARENT_ID, kind: 'scope', target: 'parent' })
    ;(state.doc.subtasks || []).forEach((st) => out.push({ id: 'scope:' + st.key, kind: 'scope', target: 'subtask', subtask: st }))
    return out
  }
  ;(state.doc.questions || []).forEach((q, qi) => {
    ;(q.options || []).forEach((o, oi) => out.push({ id: o.id, kind: 'option', q, o, qi, oi }))
  })
  ;(state.doc.tasks || []).forEach((task, ti) => out.push({ id: task.id, kind: 'task', task, ti }))
  // The LAST action of the index: run the plan and open a draft PR. Only once
  // there is a task list to run — the workflow itself refuses an empty plan,
  // and without this guard a still-loading page would park the cursor on the
  // execute row instead of on the first question.
  if ((state.doc.tasks || []).length) out.push({ id: EXEC_ROW_ID, kind: 'action' })
  return out
}

function curRow() {
  const rows = navRows()
  if (!rows.length) return null
  return rows.find((r) => r.id === state.cur) || rows[0]
}

// clampCursor keeps the cursor and the drill path pointing at something that
// still exists after a regenerated document.
function clampCursor() {
  const rows = navRows()
  if (!rows.length) {
    if (state.cur !== '') state.cur = ''
    if (state.path.length !== 1 || state.path[0] !== 0) state.path = [0]
    return
  }
  if (!rows.some((r) => r.id === state.cur)) state.cur = rows[0].id
  const levels = blockLevels()
  if (state.path.length > levels.length && levels.length) state.path = state.path.slice(0, levels.length)
  if (state.col > 1 + levels.length) state.col = 1 + Math.max(1, levels.length)
}

// curBlocks are the blocks of whatever the cursor is on — an option's example
// code, or a task's. The last row of the index is an ACTION (see EXEC_ROW_ID)
// and carries neither, so it yields nothing and → simply doesn't open a block
// column.
function curBlocks() {
  const row = curRow()
  if (!row) return []
  let list = null
  if (row.kind === 'option') list = row.o.blocks
  else if (row.kind === 'task') list = row.task.blocks
  return Array.isArray(list) ? list : []
}

// blockLevels turns the drill path into the columns to render: level 0 is the
// cursor's own blocks, every next level the CHILDREN of the block the previous
// level's cursor sits on. A level with no blocks ends the chain, so there is
// never an empty column.
function blockLevels() {
  const out = []
  let list = curBlocks()
  let depth = 0
  while (list && list.length) {
    out.push(list)
    const at = state.path[depth]
    const block = list[Math.min(Math.max(at || 0, 0), list.length - 1)]
    if (depth + 1 >= state.path.length) break
    list = block && Array.isArray(block.children) ? block.children : []
    depth++
  }
  return out
}

function cursorAt(level, list) {
  const at = state.path[level]
  return Math.min(Math.max(at || 0, 0), Math.max(list.length - 1, 0))
}

function blockAt(level) {
  const levels = blockLevels()
  const list = levels[level]
  if (!list || !list.length) return null
  return list[cursorAt(level, list)]
}

// ------------------------------------------------------------------ keyboard

function isEditableFocused() {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function moveRow(delta) {
  const rows = navRows()
  if (!rows.length) return
  const at = Math.max(
    0,
    rows.findIndex((r) => r.id === state.cur),
  )
  const next = Math.min(Math.max(at + delta, 0), rows.length - 1)
  if (rows[next].id === state.cur) return
  state.cur = rows[next].id
  state.path = [0]
  state.confirmExec = false
  scrollCurIntoView()
}

function moveBlock(level, delta) {
  const levels = blockLevels()
  const list = levels[level]
  if (!list || !list.length) return
  const next = Math.min(Math.max(cursorAt(level, list) + delta, 0), list.length - 1)
  const path = state.path.slice(0, level + 1)
  path[level] = next
  state.path = path
  scrollCurIntoView()
}

// stepRight walks the same chain a click walks: ticket → questions → the
// cursor's blocks → one column per nesting level, as long as the block the
// cursor sits on really has children.
function stepRight() {
  if (state.col === 0) {
    state.col = 1
    return
  }
  if (state.col === 1) {
    if (!curBlocks().length) return
    state.col = 2
    return
  }
  const level = state.col - 2
  const block = blockAt(level)
  if (!block || !Array.isArray(block.children) || !block.children.length) return
  if (state.path.length === level + 1) state.path = state.path.concat([0])
  state.col = state.col + 1
  scrollFocusIntoView()
}

function stepLeft() {
  if (state.col === 0) {
    location.assign('/pr-overview')
    return
  }
  if (state.col === 1) {
    state.col = 0
    return
  }
  const level = state.col - 2
  state.col = state.col - 1
  if (level > 0) state.path = state.path.slice(0, level)
  scrollFocusIntoView()
}

function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (isEditableFocused()) {
    if (e.key === 'Escape') document.activeElement.blur()
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      if (state.col === 1) moveRow(1)
      else if (state.col > 1) moveBlock(state.col - 2, 1)
      return
    case 'ArrowUp':
      e.preventDefault()
      if (state.col === 1) moveRow(-1)
      else if (state.col > 1) moveBlock(state.col - 2, -1)
      return
    case 'ArrowRight':
      e.preventDefault()
      stepRight()
      return
    case 'ArrowLeft':
      e.preventDefault()
      stepLeft()
      return
    case 'Enter':
    case ' ': {
      const row = curRow()
      if (state.col === 1 && row && row.kind === 'option') {
        e.preventDefault()
        sendAnswer(row.q, row.o, answerTextFor(row.q.id))
      } else if (state.col === 1 && row && row.kind === 'scope') {
        e.preventDefault()
        chooseScope(row)
      } else if (state.col === 1 && row && row.kind === 'action') {
        e.preventDefault()
        triggerExecute()
      } else if (state.col > 1) {
        e.preventDefault()
        stepRight()
      }
      return
    }
    case 'Escape':
      state.descExpanded = false
      return
    default:
      return
  }
}

// scrollCurIntoView keeps the cursor row in view WITHOUT touching the
// horizontal axis — the column flow scrolls horizontally, so a plain
// scrollIntoView would drag the whole page sideways (the same rule as
// scrollIntoViewVertical in the review tree).
function scrollCurIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-cursor="true"]')
    if (!el) return
    let box = el.parentElement
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement
    if (!box) return
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    const bottom = top + el.offsetHeight
    if (top < box.scrollTop) box.scrollTop = top - 12
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 12
  })
}

// scrollFocusIntoView aligns the newly focused column's left edge — the one
// place a horizontal scroll IS wanted.
function scrollFocusIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-column-focused="true"]')
    if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  })
}

// ------------------------------------------------------------------ helpers

// answerFor merges the reviewer's just-made choice over the stored document.
// The tracker stores an answer within a second, but the regeneration behind it
// takes a Claude call, and the poll in between must not make the choice
// disappear again — an event/read is never the source of truth, so the local
// pick simply wins until the document reports the same one (see
// .claude/docs/plan-page.md).
function answerFor(questionId) {
  const pending = state.pending[questionId]
  if (pending) return pending
  return (state.doc.answers || []).find((a) => a.questionId === questionId) || null
}

function answerTextFor(questionId) {
  const a = answerFor(questionId)
  return a ? a.text || '' : ''
}

function isChosen(question, option) {
  const a = answerFor(question.id)
  return !!a && a.optionId === option.id
}

// PRISM_ALIASES maps the model's own language word onto a vendored grammar.
// Deliberately its own small table rather than an import from the review
// tree's diff renderer — this page shares no code with it.
const PRISM_ALIASES = { js: 'javascript', ts: 'typescript', html: 'markup', xml: 'markup', sh: 'bash', shell: 'bash' }

// prismName resolves the model's language word to the grammar name, which is
// also the `language-…` CSS class the Prism token colours are scoped to (see
// .claude/rules/conventions.md).
function prismName(lang) {
  const word = (lang || 'php').toLowerCase()
  return PRISM_ALIASES[word] || word
}

function highlight(code, lang) {
  const name = prismName(lang)
  const grammar = Prism.languages[name]
  if (!grammar) return escapeHtml(code || '')
  try {
    return Prism.highlight(code || '', grammar, name)
  } catch (err) {
    return escapeHtml(code || '')
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CARD = 'rounded-2xl border bg-white p-5 shadow-sm dark:bg-zinc-900 '
const CARD_IDLE = 'border-slate-300 ring-1 ring-black/5 dark:border-zinc-700 '
const CARD_FOCUS = 'border-indigo-300 ring-1 ring-indigo-200 dark:border-indigo-500 dark:ring-indigo-500/30 '
const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500'

// columnHeader names a column and says IN WORDS whether it owns the keyboard —
// never a colour on its own (.claude/rules/conventions.md, the colourblind
// rule).
function columnHeader(title, focused, extra) {
  return html`
    <div class="mb-2 flex shrink-0 items-center gap-2">
      <span class="${LABEL}">${title}</span>
      <div class="contents">
        ${() =>
          focused()
            ? html`<span
                class="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30"
                data-testid="column-active"
                >◆ ${t('actief')}</span
              >`
            : ''}
      </div>
      <div class="contents">${() => (extra ? extra() : '')}</div>
    </div>
  `
}

// ------------------------------------------------------- column 1: the ticket

function ticketCard() {
  return html`
    <div
      class="${() => 'flex min-h-0 flex-1 flex-col ' + CARD + (state.col === 0 ? CARD_FOCUS : CARD_IDLE)}"
      data-testid="plan-ticket-card"
      @click="${() => (state.col = 0)}"
    >
      <div class="flex items-start gap-2">
        <h1 class="min-w-0 flex-1 text-lg font-semibold leading-snug text-slate-900 dark:text-zinc-100" data-testid="plan-title">
          ${() => state.doc.title || state.key}
        </h1>
        <div class="contents">
          ${() =>
            state.doc.url
              ? html`<a
                  href="${state.doc.url}"
                  target="_blank"
                  rel="noreferrer"
                  class="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600 ring-1 ring-inset ring-indigo-200 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-400 dark:ring-indigo-500/30"
                  data-testid="plan-jira-link"
                  >${state.key} ›</a
                >`
              : html`<span class="shrink-0 font-mono text-[11px] text-slate-400 dark:text-zinc-500">${state.key}</span>`}
        </div>
      </div>
      <div class="contents">
        ${() =>
          state.doc.parentKey
            ? html`<a
                href="${'/plan/' + encodeURIComponent(state.doc.parentKey)}"
                class="mt-2 flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[11.5px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700"
                data-testid="plan-parent-link"
                >${'↑ ' + t('Hoofdtaak') + ' ' + state.doc.parentKey + (state.doc.parentTitle ? ' — ' + state.doc.parentTitle : '')}</a
              >`
            : ''}
      </div>
      <div class="mt-3 flex shrink-0 items-center justify-between">
        <span class="${LABEL}">${t('Weergave')}</span>
        <div class="flex items-center gap-1.5">
          <a
            href="/pr-overview"
            class="flex h-7 items-center rounded-lg bg-slate-50 px-2 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700"
            data-testid="plan-back"
            >← ${t('Overzicht')}</a
          >
          ${themeToggleButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
          ${settingsButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
        </div>
      </div>
      <div class="mt-3 min-h-0 flex-1 overflow-auto" data-testid="plan-description">
        <div class="${LABEL + ' mb-1'}">${t('Omschrijving')}</div>
        ${() =>
          state.doc.description
            ? html`<div
                class="markdown-body text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300"
                .innerHTML="${() => renderMarkdown(state.doc.description)}"
              ></div>`
            : html`<p class="text-[13px] italic text-slate-400 dark:text-zinc-500">
                ${() => (state.loading ? t('laden…') : t('geen omschrijving'))}
              </p>`}
        <div class="contents">
          ${() =>
            state.doc.parentDescription
              ? html`<div class="mt-3 border-t border-slate-100 pt-2 dark:border-zinc-800" data-testid="plan-parent-description">
                  <div class="${LABEL + ' mb-1'}">${t('Omschrijving hoofdtaak')}</div>
                  <div
                    class="markdown-body text-[12.5px] leading-relaxed text-slate-500 dark:text-zinc-400"
                    .innerHTML="${() => renderMarkdown(state.doc.parentDescription)}"
                  ></div>
                </div>`
              : ''}
        </div>
      </div>
      <div class="contents">
        ${() =>
          state.doc.error
            ? html`<p
                class="mt-3 shrink-0 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                data-testid="plan-note"
              >
                ${state.doc.error}
              </p>`
            : ''}
      </div>
    </div>
  `
}

const RUN_STATUS_WORD = {
  running: 'draait',
  waiting: 'wacht',
  completed: 'klaar',
  failed: 'mislukt',
}

function runRow(run) {
  return html`
    <div class="flex items-center gap-2 border-t border-slate-100 px-1 py-1.5 first:border-t-0 dark:border-zinc-800" data-testid="plan-run">
      <span class="min-w-0 flex-1 truncate text-[12.5px] text-slate-700 dark:text-zinc-300">${labelForWorkflow(run.workflow)}</span>
      <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
        >${t(RUN_STATUS_WORD[run.status] || run.status || 'onbekend')}</span
      >
    </div>
  `.key('run:' + run.runId)
}

function tasksCard() {
  return html`
    <div class="${'shrink-0 ' + CARD + CARD_IDLE}" data-testid="plan-runs-card">
      <div class="mb-1 flex items-center gap-2">
        <span class="${LABEL}">${t('Taken')}</span>
        <div class="contents">
          ${() =>
            busyGenerating()
              ? html`<span
                  class="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30"
                  data-testid="plan-generating"
                  >${t('plan wordt opgesteld…')}</span
                >`
              : ''}
        </div>
      </div>
      ${() =>
        state.runs.length
          ? state.runs.map((run) => runRow(run))
          : [html`<p class="px-1 py-1 text-[12.5px] italic text-slate-400 dark:text-zinc-500">${t('geen taken voor dit ticket')}</p>`.key(
              'no-runs',
            )]}
    </div>
  `
}

// ---------------------------------------------- column 2: questions + tasks

// optionRow is one answer option: the choice itself plus its own free-text
// field. `value` is a STATIC interpolation — filled in once, when the node is
// created, and only for the option that is already chosen (the document stores
// one answer, option + text, per question). A reactive value binding would
// overwrite whatever the reviewer is typing on the very next poll, and the
// row's key is stable so the field survives a re-render either way.
function optionRow(row) {
  const { q, o } = row
  return html`
    <div
      class="${() =>
        'rounded-lg border px-2.5 py-2 ' +
        // The cursor row keeps its ring while the keyboard is in a BLOCK
        // column: those columns show this very row's example code, so losing
        // the marker would leave nothing saying what they belong to. Only the
        // background tint follows the focus itself.
        (state.cur === o.id
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10 ' : '')
          : 'border-slate-200 dark:border-zinc-800 ') +
        (isChosen(q, o) ? 'bg-emerald-50/60 dark:bg-emerald-500/10' : '')}"
      data-testid="plan-option"
      data-option-id="${o.id}"
      data-cursor="${() => (state.cur === o.id ? 'true' : 'false')}"
      data-chosen="${() => (isChosen(q, o) ? 'true' : 'false')}"
      @click="${() => {
        state.cur = o.id
        state.col = 1
        state.path = [0]
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-500 dark:text-zinc-400">${() => (isChosen(q, o) ? '●' : '○')}</span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium leading-snug text-slate-900 dark:text-zinc-100">${o.label}</div>
          <div class="contents">
            ${() => (o.detail ? html`<p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">${o.detail}</p>` : '')}
          </div>
        </div>
        <div class="contents">
          ${() =>
            isChosen(q, o)
              ? html`<span
                  class="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
                  >${t('gekozen')}</span
                >`
              : ''}
        </div>
      </div>
      <input
        type="text"
        placeholder="${t('eigen invulling…')}"
        value="${isChosen(q, o) ? answerTextFor(q.id) : ''}"
        data-testid="plan-option-input"
        class="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        @keydown="${(e) => {
          if (!e) return
          if (e.key === 'Enter') {
            e.stopPropagation()
            sendAnswer(q, o, e.target.value)
            e.target.blur()
          }
        }}"
        @focus="${() => {
          state.cur = o.id
          state.col = 1
        }}"
      />
      <div class="contents">
        ${() =>
          state.saving === o.id ? html`<p class="mt-1 text-[10.5px] text-slate-400 dark:text-zinc-500">${t('opslaan…')}</p>` : ''}
      </div>
    </div>
  `.key('opt:' + o.id)
}

// scopeRow is one choice of the scope question: the main task itself, or one
// of its subtasks. Same shape as optionRow (glyph + word, never a colour on its
// own), but it answers a question that comes BEFORE the plan exists.
function scopeRow(row) {
  const isParent = row.target === 'parent'
  const key = isParent ? state.doc.key || state.key : row.subtask.key
  const title = isParent ? state.doc.title || '' : row.subtask.title || ''
  const status = isParent ? '' : row.subtask.status || ''
  return html`
    <div
      class="${() =>
        'cursor-pointer rounded-lg border px-2.5 py-2 ' +
        (state.cur === row.id
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-scope-option"
      data-scope-target="${isParent ? 'parent' : 'subtask'}"
      data-scope-key="${key}"
      data-cursor="${() => (state.cur === row.id ? 'true' : 'false')}"
      @click="${() => {
        state.cur = row.id
        state.col = 1
        chooseScope(row)
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-500 dark:text-zinc-400">${isParent ? '◆' : '↳'}</span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium leading-snug text-slate-900 dark:text-zinc-100">
            ${isParent ? t('De hoofdtaak zelf') : key + (title ? ' — ' + title : '')}
          </div>
          <div class="contents">
            ${() =>
              isParent
                ? html`<p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
                    ${key + (title ? ' — ' + title : '')}
                  </p>`
                : ''}
          </div>
        </div>
        <div class="contents">
          ${() =>
            status
              ? html`<span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
                  >${status}</span
                >`
              : ''}
        </div>
      </div>
      <div class="contents">
        ${() => (state.saving === row.id ? html`<p class="mt-1 text-[10.5px] text-slate-400 dark:text-zinc-500">${t('opslaan…')}</p>` : '')}
      </div>
    </div>
  `.key('scope:' + row.id)
}

// scopeCard is the whole question — the only thing column 2 shows while it
// stands, so the rest of the index (questions, tasks, the execute action) is
// not even built yet.
function scopeCard() {
  return html`
    <section class="${CARD + CARD_IDLE}" data-testid="plan-scope">
      <div class="mb-2 flex items-start gap-2">
        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
          >${t('Eerst dit')}</span
        >
        <h2 class="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-slate-900 dark:text-zinc-100">
          ${t('Dit ticket heeft subtaken. Waar gaat dit plan over?')}
        </h2>
      </div>
      <p class="mb-2 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
        ${t('Een subtaak opent zijn eigen planpagina. De keuze voor de hoofdtaak is definitief voor dit plan.')}
      </p>
      <div class="flex flex-col gap-1.5">${() => navRows().map((r) => scopeRow(r))}</div>
    </section>
  `.key('scope-card')
}

function questionCard(q, qi) {
  return html`
    <section class="${'mb-3 ' + CARD + CARD_IDLE}" data-testid="plan-question" data-question-id="${q.id}">
      <div class="mb-2 flex items-start gap-2">
        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
          >${t('Vraag')} ${qi + 1}</span
        >
        <h2 class="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-slate-900 dark:text-zinc-100">${q.question}</h2>
      </div>
      <div class="contents">
        ${() => (q.why ? html`<p class="mb-2 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">${q.why}</p>` : '')}
      </div>
      <div class="flex flex-col gap-1.5">
        ${() =>
          navRows()
            .filter((r) => r.kind === 'option' && r.q.id === q.id)
            .map((r) => optionRow(r))}
      </div>
    </section>
  `.key('q:' + q.id)
}

function taskRow(row) {
  const task = row.task
  return html`
    <div
      class="${() =>
        'rounded-lg border px-2.5 py-2 ' +
        (state.cur === task.id
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-task"
      data-task-id="${task.id}"
      data-cursor="${() => (state.cur === task.id ? 'true' : 'false')}"
      @click="${() => {
        state.cur = task.id
        state.col = 1
        state.path = [0]
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-400 dark:text-zinc-500">${row.ti + 1}.</span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium leading-snug text-slate-900 dark:text-zinc-100">${task.title}</div>
          <div class="contents">
            ${() =>
              task.explanation
                ? html`<p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">${task.explanation}</p>`
                : ''}
          </div>
        </div>
        <div class="contents">
          ${() =>
            (task.blocks || []).length
              ? html`<span class="shrink-0 text-[10.5px] text-slate-400 dark:text-zinc-500">${(task.blocks || []).length} ${t('blokken')} →</span>`
              : ''}
        </div>
      </div>
    </div>
  `.key('task:' + task.id)
}

// executeCard is the last card of the index: one action row that runs the
// plan. It reports its state in WORDS (never a colour on its own, per the
// colourblind rule) and links to the draft PR once there is one.
function execStatusWord() {
  if (state.startingExec) return t('starten…')
  if (!state.exec) return t('nog niet uitgevoerd')
  if (state.exec.status === 'running') return t('draait…')
  if (state.exec.status === 'failed') return t('mislukt')
  if (state.exec.prUrl) return t('draft-PR klaar')
  return t('klaar')
}

function execButtonWord() {
  if (state.startingExec) return t('starten…')
  if (execRunning()) return t('draait…')
  if (state.confirmExec) return t('Zeker weten? Druk nog een keer')
  if (state.exec) return t('Opnieuw uitvoeren en draft-PR maken')
  return t('Plan uitvoeren en draft-PR maken')
}

function executeCard(row) {
  return html`
    <div
      class="${() =>
        'mt-3 rounded-lg border px-2.5 py-2 ' +
        (state.cur === EXEC_ROW_ID
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-execute"
      data-cursor="${() => (state.cur === EXEC_ROW_ID ? 'true' : 'false')}"
      @click="${() => {
        state.cur = EXEC_ROW_ID
        state.col = 1
        state.path = [0]
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-400 dark:text-zinc-500">→</span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium leading-snug text-slate-900 dark:text-zinc-100">${t('Naar een draft-PR')}</div>
          <p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
            ${t('Claude voert het plan uit op een verse branch en zet het klaar als draft-PR.')}
          </p>
        </div>
        <span
          class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
          data-testid="plan-execute-status"
          >${() => execStatusWord()}</span
        >
      </div>
      <button
        type="button"
        data-testid="plan-execute-button"
        disabled="${() => state.startingExec || execRunning()}"
        class="mt-2 w-full rounded-md bg-indigo-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        @click="${(e) => {
          if (e && e.stopPropagation) e.stopPropagation()
          state.cur = EXEC_ROW_ID
          state.col = 1
          triggerExecute()
        }}"
      >
        ${() => execButtonWord()}
      </button>
      <div class="contents">
        ${() =>
          state.exec && state.exec.prUrl
            ? html`<a
                href="${state.exec.prUrl}"
                target="_blank"
                rel="noreferrer"
                data-testid="plan-execute-pr"
                class="mt-1.5 block truncate text-[12px] font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                >${t('Draft-PR')} #${state.exec.prNumber || ''} →</a
              >`
            : ''}
      </div>
      <div class="contents">
        ${() =>
          state.exec && state.exec.note
            ? html`<p class="mt-1.5 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300" data-testid="plan-execute-note">
                ${state.exec.note}
              </p>`
            : ''}
      </div>
      <div class="contents">
        ${() =>
          state.exec && state.exec.branch
            ? html`<p class="mt-1 truncate font-mono text-[11px] text-slate-400 dark:text-zinc-500">${state.exec.branch}</p>`
            : ''}
      </div>
    </div>
  `.key('exec:' + (row ? row.id : EXEC_ROW_ID))
}

function tasksSection() {
  return html`
        <section class="${CARD + CARD_IDLE}" data-testid="plan-tasks">
          <div class="mb-2 flex items-center gap-2">
            <span class="${LABEL}">${t('Wat er moet gebeuren')}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
              >${() => (state.doc.tasks || []).length}</span
            >
          </div>
          <div class="flex flex-col gap-1.5">
            ${() =>
              (state.doc.tasks || []).length
                ? navRows()
                    .filter((r) => r.kind === 'task')
                    .map((r) => taskRow(r))
                : [html`<p class="text-[12.5px] italic text-slate-400 dark:text-zinc-500">
                    ${busyGenerating() ? t('de takenlijst wordt opgesteld…') : t('nog geen taken')}
                  </p>`.key('no-tasks')]}
          </div>
          <div class="contents">
            ${() => {
              const row = navRows().find((r) => r.kind === 'action')
              return row ? executeCard(row) : ''
            }}
          </div>
        </section>
  `.key('tasks')
}

function questionsColumn() {
  return html`
    <div
      class="flex w-[31rem] shrink-0 flex-col"
      data-testid="plan-questions-column"
      data-column-focused="${() => (state.col === 1 ? 'true' : 'false')}"
      @click="${() => (state.col = 1)}"
    >
      ${columnHeader(t('Vragen over het plan'), () => state.col === 1)}
      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        ${() => (needsScope() ? [] : (state.doc.questions || []).map((q, qi) => questionCard(q, qi)))}
        ${() =>
          !needsScope() && !state.loading && !(state.doc.questions || []).length
            ? [
                html`<p class="mb-3 rounded-2xl border border-dashed border-slate-300 p-4 text-[12.5px] italic text-slate-400 dark:border-zinc-700 dark:text-zinc-500">
                  ${busyGenerating() ? t('Claude stelt de vragen op…') : t('geen vragen')}
                </p>`.key('no-questions'),
              ]
            : []}
        <div class="contents">${() => (needsScope() ? [scopeCard()] : [])}</div>
        <div class="contents">${() => (needsScope() ? [] : [tasksSection()])}</div>
      </div>
    </div>
  `
}

// -------------------------------------------- columns 3+: the example blocks

function blockCard(block, level, index) {
  const focused = () => state.col === level + 2 && cursorAt(level, blockLevels()[level] || []) === index
  const kids = Array.isArray(block.children) ? block.children : []
  return html`
    <div
      class="${() => 'mb-3 overflow-hidden rounded-2xl border shadow-sm ' + (focused() ? CARD_FOCUS : CARD_IDLE)}"
      data-testid="plan-block"
      data-cursor="${() => (focused() ? 'true' : 'false')}"
      @click="${() => {
        const path = state.path.slice(0, level + 1)
        path[level] = index
        state.path = path
        state.col = level + 2
      }}"
    >
      <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-800/60">
        <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-700 dark:text-zinc-200">${block.title}</span>
        <div class="contents">
          ${() =>
            block.label
              ? html`<span class="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10.5px] text-slate-500 dark:bg-zinc-900 dark:text-zinc-400"
                  >${block.label}</span
                >`
              : ''}
        </div>
        <span class="shrink-0 text-[10.5px] uppercase tracking-wide text-slate-400 dark:text-zinc-500">${block.lang || 'php'}</span>
      </div>
      <div class="contents">
        ${() =>
          block.note
            ? html`<p
                class="border-b border-slate-100 bg-white px-3 py-1.5 text-[12px] leading-relaxed text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                data-testid="plan-block-note"
              >
                ${block.note}
              </p>`
            : ''}
      </div>
      <pre
        class="overflow-x-auto bg-white px-3 py-2 text-[12px] leading-relaxed dark:bg-zinc-900"
      ><code class="${'language-' + prismName(block.lang) + ' whitespace-pre-wrap break-words'}" .innerHTML="${() => highlight(block.code, block.lang)}"></code></pre>
      <div class="contents">
        ${() =>
          kids.length
            ? html`<button
                type="button"
                data-testid="plan-block-drill"
                class="flex w-full items-center gap-1.5 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-[11px] font-medium text-indigo-600 hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-indigo-400 dark:hover:bg-zinc-800"
                @click="${(e) => {
                  if (e && e.stopPropagation) e.stopPropagation()
                  const path = state.path.slice(0, level + 1)
                  path[level] = index
                  state.path = path.concat([0])
                  state.col = level + 3
                  scrollFocusIntoView()
                }}"
              >
                ${kids.length} ${t('onderliggende blokken')} →
              </button>`
            : ''}
      </div>
    </div>
  `.key('block:' + level + ':' + index + ':' + block.title)
}

function blockColumn(list, level) {
  const row = curRow()
  const parent = level === 0 ? null : blockAt(level - 1)
  const title =
    level === 0
      ? row && row.kind === 'task'
        ? t('Voorbeeldcode bij de taak')
        : t('Voorbeeldcode bij de keuze')
      : t('Onderliggend: {name}', { name: (parent && parent.title) || '' })
  return html`
    <div
      class="flex w-[40rem] shrink-0 flex-col"
      data-testid="plan-block-column"
      data-level="${String(level)}"
      data-column-focused="${() => (state.col === level + 2 ? 'true' : 'false')}"
      @click="${() => (state.col = level + 2)}"
    >
      ${columnHeader(title, () => state.col === level + 2)}
      <div class="min-h-0 flex-1 overflow-y-auto pr-1">${() => list.map((b, i) => blockCard(b, level, i))}</div>
    </div>
  `.key('blockcol:' + level + ':' + (state.cur || '-'))
}

// ------------------------------------------------------------------ the page

function App() {
  return html`
    <div class="fixed inset-0 flex items-stretch gap-5 overflow-x-auto overflow-y-hidden p-5" data-testid="plan-columns">
      <div class="flex w-[34rem] shrink-0 flex-col gap-4" data-testid="plan-info-column" data-column-focused="${() => (state.col === 0 ? 'true' : 'false')}">
        ${ticketCard()} ${tasksCard()}
      </div>
      ${questionsColumn()}
      ${() => blockLevels().map((list, level) => blockColumn(list, level))}
      <div class="contents">
        ${() =>
          state.error
            ? html`<div class="${'w-[24rem] shrink-0 ' + CARD + CARD_IDLE}" data-testid="plan-error">
                <p class="text-[13px] text-rose-600 dark:text-rose-400">${state.error}</p>
              </div>`
            : ''}
      </div>
    </div>
  `
}

if (!planKey) {
  location.replace('/pr-overview')
} else {
  html`${App()}`(document.getElementById('app'))
  document.addEventListener('keydown', onKeydown)
  // clampCursor is called from loadPlan (the one place the document is
  // replaced), deliberately NOT from a watch on state.doc/state.cur: the
  // vendored proxy notifies on EVERY assignment, also one that writes back the
  // same value, so a watch whose own callback re-assigns those keys re-triggers
  // itself forever — a hung tab, not a render bug (see the "watch fires even
  // when the write reassigns the SAME value" pitfall in
  // .claude/rules/arrowjs-pitfalls.md).
  ensureTracker().then(loadPlan)
  setInterval(loadPlan, POLL_MS)
}
