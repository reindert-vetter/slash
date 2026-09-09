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

import { html, reactive, watch } from './vendor/arrow.js'
import Prism from './vendor/prism.js'
import { t } from './i18n.mjs'
import { renderMarkdown } from './markdown.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { initDebugLog, logAction } from './debugLog.mjs'
import { settingsButton } from './settingsLink.mjs'
import { bindUrlState, num } from './urlState.mjs'
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
// claudeChatColumn is the review tree's own Claude chat component (a pure
// template layer, see ClaudeChat.mjs's own file header) — reused here for the
// general chat about this ticket (reviewer request: "die mag je hergebruiken",
// see .claude/docs/plan-page.md). Only the PRESENTATION is reused: the
// backend behind it is this page's own (the plan_answer Signal's "chat" Kind,
// keyed on the Jira key rather than a GitHub PR number, since there is no PR
// yet at planning time) — never home.mjs/RelatedPanel.mjs's whole PR-scoped
// chat engine (retry ladder, queueing, checkout/werkmap), which this page has
// no PR to hang on. The one piece of that engine THIS page does reuse is the
// live progress channel (events.mjs + claudeTurns.mjs) — see
// ensurePlanChatEvents/chatView below and "Live progress" in
// .claude/docs/plan-page.md. See planChatOverlay below.
import { claudeChatColumn } from './ClaudeChat.mjs'
// The live "what is Claude doing right now" wiring behind this chat is
// reused unchanged from the review tree: events.mjs's one multiplexed SSE
// stream and claudeTurns.mjs's per-conversation snapshot store are both pure,
// component-less utilities that only need a conversation id — see
// ensurePlanChatEvents below and "Live progress" in .claude/docs/plan-page.md.
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { setTurnProgress, turnProgress, lastTurnProgressAt } from './claudeTurns.mjs'
import { updateScrollHints } from './scrollFade.mjs'
import { assigneeMark, avatarHTML } from './avatar.mjs'
import { relativeTime } from './relativeTime.mjs'
// alignRows is the review tree's OWN line aligner, extracted to its own module
// so this page can reuse the exact same comparison without importing
// Block.mjs's whole card (see src/lineDiff.mjs). The second deliberate
// exception to this page's "own code" rule, next to claudeChatColumn above —
// reviewer request for task 26: "huidige code naast de voorgestelde code, de
// blok-weergave van de review-tree overnemen".
import { alignRows, tokenize, diffChars, markChars } from './lineDiff.mjs'
// TasksPanel is the review tree's own merged "Taken" block (RelatedPanel.mjs)
// — reused OUTRIGHT, visual style included, per explicit reviewer request
// ("dit blokje met workflows, mag exact hetzelfde werken als in pr tree"). A
// third deliberate exception to this page's "own code" rule, next to
// claudeChatColumn/alignRows above — see "The Taken block is the literal
// TasksPanel" in .claude/docs/plan-page.md for what this pulls in and the
// small client-side shim (planWorkflowsForPanel/planProblemsForPanel below)
// that feeds it plan-shaped data.
import {
  TasksPanel,
  markTaskRetrying,
  clearTaskRetrying,
  isRetryingRun,
  setTasksRefreshBusy,
} from './RelatedPanel.mjs'

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

const EMPTY_DOC = { key: planKey, title: '', description: '', url: '', questions: [], tasks: [], answers: [], error: '', chat: [] }

// JIRA_BASE mirrors home.mjs/overview.mjs's own constant — used as the
// fallback link when the document hasn't loaded (yet), or never resolved a
// real url, a Jira ticket.
const JIRA_BASE = 'https://plugandpaybv.atlassian.net/browse/'

const state = reactive({
  key: planKey,
  loading: true,
  error: '',
  doc: EMPTY_DOC,
  runs: [],
  generating: false,
  runId: '',
  // The CURRENT intent.md text — the auto-generated document, or the
  // reviewer's own override (state.doc.intentOverride) once they edit it.
  // Computed server-side (renderPlanIntent) and sent as its own top-level
  // GET /api/plan field, same as `artifacts` — the "Intentie" field in
  // column 0 seeds itself with this. See .claude/docs/plan-page.md.
  intentText: '',
  // The intent textarea in the TICKET column (phase specs/plan) is read-only
  // until Enter unlocks it — see intentField. Reactive because both the
  // textarea's own `readonly` and the word next to the label follow it.
  // Always false while the field lives in the questions column (phase
  // intent), where typing straight into it is the whole point.
  intentEditing: false,
  // Which column owns the keyboard: 0 = the ticket, 1 = questions/tasks,
  // 2 + n = the n-th block column (2 is the first one).
  col: 1,
  // Which sub-block of the ticket card (column 0) was last clicked into:
  // 'description' | 'intent' | null. Purely local/ephemeral UI state (not
  // URL-persisted, like state.descExpanded) — it only decides whether the
  // dedicated Jira-opmerkingen side column (intentCommentsColumn) shows next
  // to the ticket, see "A dedicated Jira-opmerkingen column next to the
  // ticket" in .claude/docs/plan-page.md.
  col0Focus: null,
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
  // workflows/pageProblems — the two properties TasksPanel's own
  // buildTaskRows/visibleWorkflowRuns (RelatedPanel.mjs) read off whatever
  // state object they're given. Recomputed by syncTaskPanelState (below)
  // from state.runs/state.doc.error/busyGenerating() — see "The Taken block
  // is the literal TasksPanel" in .claude/docs/plan-page.md.
  workflows: [],
  pageProblems: { failedRuns: [], logErrors: [] },
  // The newest plan_execute run of this ticket (GET /api/plan's `exec`), or
  // null when the plan was never executed — see the execute card below.
  exec: null,
  // The three planning phases (intent -> specs -> plan) and the files behind
  // them, as GET /api/plan reports them (see plan_artifacts.go): {dir, phase,
  // files:[{phase, file, path, exists}]}. Null until the first read lands.
  artifacts: null,
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
  // Same for the base-branch question every ticket is asked right after it
  // (see needsHotfix): the answer runs the first generation inline, so the
  // stored document still says needsHotfix until it lands.
  hotfixPending: false,
  // The hotfix question's third choice — "another branch" — is a dropdown with
  // its own search field. branchOpen is whether it is unfolded, branchQuery
  // what is typed in it, branchList what GET /api/branches answered (own
  // branches first) and branchLoading whether that read is in flight.
  branchOpen: false,
  branchQuery: '',
  branchList: [],
  branchLoading: false,
  // "Meer vragen" was just asked for: the signal runs the generation inline,
  // so the stored document only grows its new questions once it lands. Local,
  // exactly like scopePending/hotfixPending.
  followupPending: false,
  // "Plan opstellen [opnieuw]" was just asked for: the signal wipes the whole
  // plan and regenerates from scratch inline, so the stored document still
  // shows the OLD questions/tasks until it lands. Local, exactly like
  // followupPending/scopePending/hotfixPending.
  regeneratePending: false,
  // The reviewer's own bookkeeping per task (task 22): the CHECKBOX (default
  // on — unchecking drops the task from the plan and from every later
  // regeneration) and the FIELD next to it (which travels to the execution
  // only). Keyed by the normalized task TITLE, exactly like the backend's
  // planTaskState — a task id is positional and every regeneration renumbers
  // the list. This is the local "my pick wins until the document catches up"
  // overlay, same shape as state.pending for an answer.
  taskPending: {},
  // The current code of a block's own file, read out of the plan's werkmap
  // (GET /api/plan/current), keyed by the file path: {loading, found, code,
  // dir, truncated}. Plain per-file cache — nothing here is the source of
  // truth, so a miss simply shows the proposed code on its own.
  current: {},
  // The general chat about this ticket (reused from the review tree, see the
  // import comment above and planChatOverlay below). chatOpen gates the
  // fullscreen overlay (ephemeral — not in the URL/localStorage, exactly like
  // the tree's own generalChatOverlay.mjs: Escape simply hides it again, the
  // conversation itself is durable on the document). chatBusy/chatError cover
  // the one in-flight Signal round trip (the reviewer's own "did my send go
  // through" state); the LIVE turn itself — what Claude is doing right now,
  // streamed token by token — lives in claudeTurns.mjs's shared per-
  // conversation store instead (see chatConvId/ensurePlanChatEvents), keyed
  // by the same conversation id as every other conversation this tab knows
  // about. chatTick is read purely to register a reactive dependency for the
  // 1s elapsed-seconds heartbeat (see syncPlanChatTicker) — the value itself
  // is never used, same trick as RelatedPanel.mjs's own cc.tick.
  chatOpen: false,
  chatBusy: false,
  chatError: '',
  chatTick: 0,
  // The Jira-comments panel above the questions index (task 23b, see
  // .claude/docs/plan-page.md). comments mirrors GET /api/jira/comments's own
  // shape plus a loading/error flag; loaded is false until the first read
  // returns, so the panel shows "laden…" instead of "geen opmerkingen" while
  // the very first fetch is still in flight.
  comments: { loaded: false, loading: true, error: '', groups: [], canPost: false, canMention: false },
  // Which group's (ticket's own key) reply composer is open — '' means none.
  // Only one at a time, mirroring the option/hotfix rows' own single-cursor
  // discipline elsewhere on this page.
  commentReplyKey: '',
  commentReplyText: '',
  // Mentions picked for the OPEN composer, each {accountId, text} exactly as
  // jira.Mention expects — only ever added by the reviewer picking a
  // suggestion, never inferred from typed text (reviewer decision: "alleen
  // als ik ze zelf typ").
  commentMentions: [],
  // The @-query currently being typed (text after the last unresolved '@' in
  // the composer) and what it resolved to; '' means no mention is being typed
  // right now, so the picker stays hidden.
  commentMentionQuery: '',
  commentMentionResults: [],
  commentMentionLoading: false,
  // The reply currently being posted (a group key, so only that group's own
  // button shows "versturen…" — never a colour-only spinner).
  commentSending: '',
  commentSendError: '',
  // The Jira-opmerkingen block is a stop of its own in the → chain (like an
  // ordinary option/task row, cur === COMMENTS_ROW_ID) and Enter on it hands
  // ↑/↓ to the comments themselves — the same "block is a stop, Enter moves
  // the keyboard into a nested list" shape the review tree's methodes-kolom
  // uses (see .claude/docs/test-class-grouping.md). commentsFocused mirrors
  // that column's own testColumnFocused; commentCursor is the active
  // comment's stable id (see commentId below). commentsFocused ALSO doubles
  // as "is the whole comments list expanded" (see commentsListExpanded) —
  // collapsed by default, showing only the last ~2.5 comments (see
  // "Collapsed by default" below).
  commentsFocused: false,
  commentCursor: '',
})

// menu is the stable {open} flag the Enter-menu on the ticket column renders
// off (mirrors the review tree's own `menu`/`ms` split, see
// .claude/rules/arrowjs-pitfalls.md's "ms-swap" note: `ms` itself is
// replaced wholesale on every open, so a stale binding from a torn-down menu
// never fires against a freed slot). PLAN_COMMANDS is a tiny, fixed list —
// this page has no GitHub PR/approve actions yet, only what genuinely exists
// before one: the Jira ticket and the way back to the overview.
const menu = reactive({ open: false })
let ms = null

const PLAN_COMMANDS = [
  { id: 'close-menu', label: t('Sluit menu'), hint: 'sluit', run: () => {} },
  {
    id: 'plan-jira-open',
    label: () => t('Open in Jira ({key})', { key: state.key }),
    hint: 'jira',
    run: () => window.open(state.doc.url || JIRA_BASE + state.key, '_blank'),
  },
  {
    id: 'plan-back-overview',
    label: t('Terug naar overzicht'),
    hint: 'overzicht',
    run: () => {
      location.href = '/pr-overview'
    },
  },
]

// planCommands adds "Opnieuw plannen" to the fixed PLAN_COMMANDS list, but
// only while there is a `plan` tracker run to resume — either genuinely
// failed, or a swallowed generation error (state.pageProblems.failedRuns'
// synthetic entry, see planProblemsForPanel) — same "never offer an action
// that would be a no-op" rule as jiraNotificationCommands (overview.mjs).
// Reading state.pageProblems here (not state.runs directly) is what used to
// be missing: this menu never offered a retry at all for the swallowed-error
// case, leaving the Taken block's row click as the only way in — and THAT
// path silently failed too before retryPlanRun learned the synthetic branch
// (see its own doc comment). Resolved ONCE, at open time (see openPlanMenu
// below), never as a reactive label — a still-open menu keeps showing the
// item it opened with even if the run resolves itself a moment later; the
// next open re-evaluates.
function planCommands() {
  const failed = (state.pageProblems && state.pageProblems.failedRuns || []).find((r) => r.workflow === 'plan')
  if (!failed || isRetryingRun(failed.runId)) return PLAN_COMMANDS
  return [
    ...PLAN_COMMANDS,
    {
      id: 'plan-retry',
      label: t('Opnieuw plannen'),
      hint: 'opnieuw retry',
      run: () => retryPlanRun(failed.runId, !!failed.synthetic),
    },
  ]
}

// resolvePlanCommands reads `ms.commands` (not the fixed PLAN_COMMANDS
// constant) so the conditional "Opnieuw plannen" item planCommands() may have
// added at open time is actually offered/filtered/run — the ONE list both
// CommandMenu's render and its own ↑/↓/Enter index into, same single-source
// rule as home.mjs's resolveCommands.
function resolvePlanCommands(query) {
  return filterCommands(ms ? ms.commands : PLAN_COMMANDS, query)
}

// openPlanMenu/closeMenu/runCommand mirror home.mjs's own menu machinery
// (openMenu/closeMenu/runCommand) at the scale this page actually needs: no
// submenus, no native (right-click) variant, no positioning math — the
// popover is simply anchored under the ticket card's own menu button via
// plain CSS (planMenuOverlay below), so there is nothing to reposition on
// scroll/resize the way the tree's own anchored-to-a-list-row menu needs.
function openPlanMenu() {
  const commands = planCommands()
  ms = reactive({ query: '', sel: Math.min(1, commands.length - 1), mode: 'plan', commands, native: false })
  menu.open = true
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
}

function closeMenu() {
  // Only flip the flag; `ms` is replaced wholesale on the next openPlanMenu,
  // so the just-closed instance's own bindings are never touched again (see
  // the arrowjs-pitfalls.md note above).
  menu.open = false
}

// runCommand closes the menu first and runs the command a frame later — the
// menu's own (keyed) row list unmounts in the same reactive flush that
// closing it triggers, so running the command's own state change in that
// same flush risks losing it if the teardown throws before later-queued
// effects run. See the identical reasoning in home.mjs's own runCommand.
function runCommand(cmd) {
  closeMenu()
  requestAnimationFrame(() => cmd.run())
}

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
  // ccol mirrors a real "the comments block has the keyboard" focus — same
  // shape as the review tree's own ?tcol=, only present while it's really
  // true, so a plain refresh on an ordinary question/task doesn't silently
  // steal ↑/↓ away from the index.
  { key: 'commentsFocused', param: 'ccol', parse: (raw) => raw === '1', format: (v) => (v ? '1' : ''), default: false },
  { key: 'commentCursor', param: 'ccur', default: '' },
])

// ---------------------------------------------------------------- data reads

// loadPlan reads the whole document in one read-only GET. The response is
// compared as text first: the poll runs every few seconds and a reassignment
// would rebuild the option rows (and thereby wipe a half-typed answer field).
//
// MEASURED BUG, fixed here: sendChatMessage echoes the reviewer's own message
// onto state.doc.chat optimistically and then awaits a BLOCKING Signal POST
// (handlePlanChat runs the whole Claude reply inline, which can take many
// seconds) — but the 3s poll below keeps running meanwhile, and it used to
// overwrite state.doc (chat included) with whatever the server still had
// stored, i.e. WITHOUT the just-sent message, the moment it landed before the
// blocking POST returned. Reported as "ik typ hier iets, maar de chat is
// opeens weg" (data/review-shots/task7-ticket-chat-gone.png: the overlay back
// to "Nog geen gesprek…"). Fix: keep the locally-echoed chat array for as
// long as the server's own chat still reports FEWER messages than we already
// show — the moment it catches up (its own count is at least as high,
// whether that arrives via the chat.message push, sendChatMessage's own
// post-Signal refetch, or an ordinary poll) its version wins again, chatBusy
// or not. A plain length comparison, not object equality: the reviewer never
// has two messages in flight at once (sendChatMessage refuses a second send
// while chatBusy), so "server has caught up" only ever means "at least as
// many rows".
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
    const freshDoc = body.doc || EMPTY_DOC
    const freshChat = freshDoc.chat || []
    const localChat = state.doc.chat || []
    state.doc = freshChat.length < localChat.length ? { ...freshDoc, chat: localChat } : freshDoc
    state.runs = Array.isArray(body.runs) ? body.runs : []
    state.generating = !!body.generating
    state.exec = body.exec || null
    state.artifacts = body.artifacts || null
    state.intentText = body.intent || ''
    state.error = ''
    state.loading = false
    if (!state.doc.needsScope) state.scopePending = false
    if (!state.doc.needsHotfix) state.hotfixPending = false
    dropSettledPending()
    dropSettledRetrying()
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
  dropSettledTaskPending()
}

// dropSettledTaskPending is the same for a task's checkbox/field: the stored
// document only carries a state that DEVIATES from the default (checked, no
// note), so a local pick that is itself the default settles as soon as the
// document has no row for it either.
function dropSettledTaskPending() {
  const stored = state.doc.taskStates || []
  const keep = {}
  let changed = false
  for (const [key, st] of Object.entries(state.taskPending)) {
    const on = stored.find((s) => s.key === key)
    const isDefault = !st.off && !(st.note || '')
    if (on ? !!on.off === !!st.off && (on.note || '') === (st.note || '') : isDefault) changed = true
    else keep[key] = st
  }
  if (changed) state.taskPending = keep
}

// retryPlanRun resumes a failed workflow run of this ticket in place. Two
// mechanisms, chosen by `synthetic` (see planProblemsForPanel's own doc
// comment for why they cannot share one):
//
//   - a GENUINELY failed run (`synthetic` false) resumes via
//     POST /api/workflows/retry — the same sanctioned, generic resume-in-place
//     endpoint the review tree's own retryFailedRun (home.mjs) and the global
//     failed-tasks dialog use, see .claude/docs/tembed-endpoints.md. That
//     endpoint requires the run to actually BE `failed` (TaskManager.RetryRun).
//   - a SWALLOWED generation error (`synthetic` true — planGenerate recorded
//     the error onto the document instead of failing the Execution, so the
//     run itself is still `waiting`) instead sends the plan_answer Signal's
//     "retry" Kind, which re-runs the generation in place without requiring a
//     `failed` status at all. Reported bug: every retry
//     click here used to go through the generic endpoint above, which
//     silently refused ("run is waiting, not failed") and left the reviewer
//     with no way to make a parse-error'd plan try again.
//
// markTaskRetrying (RelatedPanel.mjs, shared with the review tree's own
// retryFailedRun) marks the run busy immediately, cleared again right away on
// a failed request (so the row honestly returns to "mislukt") — the same
// "mark it optimistically" shape as home.mjs, at the same shared spot rather
// than a second, page-local map. dropSettledRetrying (below) clears it again
// once the retry has actually run.
async function retryPlanRun(runId, synthetic) {
  if (!runId) return
  const before = (state.runs || []).find((r) => r.runId === runId)
  planRetryStamps.set(runId, (before && before.updatedAt) || '')
  markTaskRetrying(runId)
  try {
    const res = synthetic
      ? await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/plan_answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId: '', optionId: '', text: '', kind: 'retry' }),
        })
      : await fetch('/api/workflows/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        })
    if (!res.ok) {
      clearRetryMark(runId)
      console.error('plan retry failed:', res.status, await res.text())
      return
    }
  } catch (err) {
    clearRetryMark(runId)
    console.error('plan retry failed:', err)
    return
  }
  lastPayload = ''
  await loadPlan()
}

// planRetryStamps — the `updatedAt` each retried run carried at the moment of
// the click, so dropSettledRetrying can tell "the retry has actually run" from
// "nothing has happened yet". A plain, non-reactive Map: purely display
// bookkeeping, like RelatedPanel.mjs's own taskUi.retrying it accompanies.
const planRetryStamps = new Map()

function clearRetryMark(runId) {
  planRetryStamps.delete(runId)
  clearTaskRetrying(runId)
}

// dropSettledRetrying forgets a run marked "↻ opnieuw gestart" as soon as a
// freshly loaded document shows the retry has run — the problem row is gone,
// or the run's own `updatedAt` moved past what it was at the click. Without
// this the mark never went away at all: it lives in RelatedPanel.mjs's SHARED
// taskUi.retrying, which the review tree only ever gets rid of because
// /api/problems replaces the failure row with a new Run ID. Both retry
// mechanisms here resume IN PLACE (see retryPlanRun), so the Run ID never
// changes and the row stayed "opnieuw gestart" forever — inert on a second
// click (openPlanTaskRowMenu bails on `row.retrying`) and dropped from the
// ticket column's Enter-menu (planCommands' isRetryingRun gate), so a
// recurring parse error was stuck again until the tab was reloaded.
function dropSettledRetrying() {
  if (!planRetryStamps.size) return
  const failing = new Map((planProblemsForPanel().failedRuns || []).map((r) => [r.runId, r.updatedAt]))
  for (const runId of [...planRetryStamps.keys()]) {
    const now = failing.get(runId)
    if (now === undefined || now !== planRetryStamps.get(runId)) clearRetryMark(runId)
  }
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
  // Reviewer report (task4, no screenshot, debug mode on): "typen in eigen
  // antwoord submit direct" — not reproduced (this is the ONLY place an
  // answer is actually signalled to the tracker, and it's only ever called
  // from optionInputKeydown's Enter branch or onKeydown's own Enter-on-row
  // branch, never from an `@input`/keystroke handler). Logged anyway so a
  // future real occurrence leaves a line in data/debug-log.jsonl instead of
  // being unfalsifiable after the fact — see .claude/docs/debug-mode.md.
  logAction('plan-answer-submit', question.id + ':' + option.id + (option.own ? ':own' : '') + ' len=' + (text || '').length)
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

// ------------------------------------------------ task checkbox + own field

// taskKeyOf mirrors the backend's planTaskKey: lowercased, whitespace runs
// collapsed. The checkbox/note state hangs off the task TITLE rather than its
// id, because a task id is positional (t1..tn) and every regeneration
// renumbers the list — see planTaskState in plan_workflow.go.
function taskKeyOf(title) {
  return String(title || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

// taskStateFor merges the just-made local pick over the stored document, the
// same "an event/read is never the source of truth" overlay answerFor uses:
// the tracker saves within a second, but a poll in between must not make the
// checkbox jump back.
function taskStateFor(task) {
  const key = taskKeyOf(task && task.title)
  if (!key) return null
  const pending = state.taskPending[key]
  if (pending) return pending
  return (state.doc.taskStates || []).find((st) => st.key === key) || null
}

// taskEnabled: the DEFAULT is on. A task the reviewer never touched (and every
// document written before this existed) carries no state at all.
function taskEnabled(task) {
  const st = taskStateFor(task)
  return !(st && st.off)
}

function taskNoteFor(task) {
  const st = taskStateFor(task)
  return (st && st.note) || ''
}

// sendTaskState signals one task's checkbox + field to the tracker. It rides on
// the SAME plan_answer Signal with kind:"task" (a workflow can only wait on one
// signal name at a time) and the tracker only SAVES it — no regeneration, so
// typing in the field never costs a Claude call. Unchecking takes effect on the
// next regeneration, which is exactly the reviewer's own decision.
async function sendTaskState(task, off, note) {
  const key = taskKeyOf(task && task.title)
  if (!key) return
  state.taskPending = { ...state.taskPending, [key]: { key, title: task.title, off: !!off, note: note || '' } }
  lastPayload = ''
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = task.id
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'task', taskId: task.id || '', taskTitle: task.title || '', taskOff: !!off, taskNote: note || '' }),
    })
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really stored.
  }
  state.saving = ''
}

// sendIntentOverride replaces the auto-generated intent.md WHOLESALE with the
// reviewer's own edited text (planAnswerIntent Kind, see plan_workflow.go) —
// an empty text clears the override, reverting to the auto-generated one.
// lastPayload is reset so the very next poll's (possibly slower-arriving)
// response is not mistaken for "nothing changed" and skipped.
async function sendIntentOverride(text) {
  lastPayload = ''
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = INTENT_SAVE_ID
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'intent', text: text || '' }),
    })
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really stored.
  }
  state.saving = ''
}

// INTENT_SAVE_ID is the state.saving marker for an intent-field edit — the
// same shared "id of whatever is being saved right now" state every
// option/scope/hotfix/task row already uses (never a colour-only spinner).
const INTENT_SAVE_ID = 'intent'

// toggleTask flips the checkbox, keeping whatever is typed in the field. This
// is what Enter/Space on a task row does (an agreed default, see
// todo/plan-page-workflow.md) as well as a click on the box itself.
function toggleTask(task) {
  sendTaskState(task, taskEnabled(task), taskNoteFor(task))
}

// FOLLOWUP_ROW_ID is the stable id of the "meer vragen" action row — the same
// id space as an option ("q1o2") or a task ("t3"), so ?cur= restores it like
// any other row.
const FOLLOWUP_ROW_ID = 'followup'

// sendFollowup asks the tracker for follow-up questions to sharpen the plan
// further. It rides on the SAME plan_answer Signal with kind:"followup" — a
// workflow can only wait on one signal name at a time — and the tracker
// appends the new questions and then rebuilds the task list, exactly as an
// answer does.
async function sendFollowup() {
  if (state.saving || state.followupPending) return
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = FOLLOWUP_ROW_ID
  state.followupPending = true
  lastPayload = ''
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: '', optionId: '', text: '', kind: 'followup' }),
    })
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really stored.
  }
  state.saving = ''
  state.followupPending = false
  lastPayload = ''
}

// REGENERATE_ROW_ID is the stable id of the "plan opstellen" action row —
// same id space as FOLLOWUP_ROW_ID above.
const REGENERATE_ROW_ID = 'regenerate'

// sendRegenerate asks the tracker to throw away the current plan entirely and
// generate a fresh one from scratch (kind:"regenerate" — see
// planAnswerRegenerate's own doc comment in plan_workflow.go). Reviewer
// request: a second button next to "meer vragen genereren" for when
// sharpening the existing plan isn't the ask, a genuinely new one is.
async function sendRegenerate() {
  if (state.saving || state.regeneratePending) return
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = REGENERATE_ROW_ID
  state.regeneratePending = true
  lastPayload = ''
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: '', optionId: '', text: '', kind: 'regenerate' }),
    })
  } catch (err) {
    // Nothing to undo: the next poll shows what the tracker really stored.
  }
  state.saving = ''
  state.regeneratePending = false
  lastPayload = ''
}

// ------------------------------------------------- Jira comments (task 23b)
//
// The panel above the questions index (see .claude/docs/plan-page.md,
// "Jira-opmerkingen: lezen, beantwoorden, @-mentions"): read-only comment
// reading from GET /api/jira/comments, replying via the jira_comment
// workflow, and an @-mention picker off GET /api/jira/users. Deliberately
// small — no drafts, no reactions, no resolve/ignore, no AI titles.

// loadComments reads the whole family's comments in one GET. Called once at
// startup and again with refresh:true right after a reply lands (and behind
// the panel's own "Ververs" button) — otherwise the day-long server cache
// (plan_comments.go) answers from memory.
async function loadComments(refresh) {
  state.comments = { ...state.comments, loading: true }
  try {
    const res = await fetch('/api/jira/comments?key=' + encodeURIComponent(state.key) + (refresh ? '&refresh=1' : ''))
    const body = res.ok ? await res.json() : null
    if (!body || !body.ok) {
      state.comments = { ...state.comments, loading: false, loaded: true, error: t('Kon de Jira-opmerkingen niet laden.') }
      return
    }
    state.comments = {
      loaded: true,
      loading: false,
      error: body.error ? t('Kon de Jira-opmerkingen niet laden.') : '',
      groups: Array.isArray(body.groups) ? body.groups : [],
      canPost: !!body.canPost,
      canMention: !!body.canMention,
    }
  } catch (err) {
    state.comments = { ...state.comments, loading: false, loaded: true, error: t('Kon de Jira-opmerkingen niet laden.') }
  }
}

// openCommentReply/closeCommentReply gate ONE open composer at a time (a
// group's own ticket key, '' meaning none) — the same single-cursor
// discipline the rest of this page follows.
function openCommentReply(key) {
  state.commentReplyKey = key
  state.commentReplyText = ''
  state.commentMentions = []
  state.commentMentionQuery = ''
  state.commentMentionResults = []
  state.commentSendError = ''
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="plan-comment-reply-input"]')
    if (el) el.focus()
  })
}

function closeCommentReply() {
  state.commentReplyKey = ''
  state.commentReplyText = ''
  state.commentMentions = []
  state.commentMentionQuery = ''
  state.commentMentionResults = []
  state.commentSendError = ''
}

// commentMentionTimer debounces the @-picker's own lookup — a plain module
// variable, not state: it holds a timer handle, not something to render.
let commentMentionTimer = null

// onCommentReplyInput tracks the typed body and, while the caret sits right
// after an unresolved "@word" at the END of the text, looks that word up as a
// possible mention. Deliberately anchored to the END of the string rather than
// the real caret position — simpler, and the reviewer types the reply
// top-to-bottom like every other composer on this page (no existing composer
// here supports inserting a mention mid-sentence either).
function onCommentReplyInput(e) {
  const value = e.target.value
  state.commentReplyText = value
  const m = /@([^\s@]{1,40})$/.exec(value)
  if (!m) {
    state.commentMentionQuery = ''
    state.commentMentionResults = []
    return
  }
  state.commentMentionQuery = m[1]
  clearTimeout(commentMentionTimer)
  if (!state.comments.canMention) return
  commentMentionTimer = setTimeout(async () => {
    state.commentMentionLoading = true
    try {
      const res = await fetch('/api/jira/users?q=' + encodeURIComponent(m[1]))
      const body = res.ok ? await res.json() : null
      state.commentMentionResults = body && Array.isArray(body.users) ? body.users : []
    } catch (err) {
      state.commentMentionResults = []
    }
    state.commentMentionLoading = false
  }, 200)
}

// pickCommentMention replaces the trailing "@query" with the picked person's
// full "@Display Name" and records the mention — the ONLY way a mention is
// ever added (reviewer decision: never inferred from typed text alone). The
// textarea is uncontrolled (no reactive `value=`, same shape as
// ClaudeChat.mjs's composer — a controlled value would fight the caret while
// typing), so the DOM is the source of truth here: read it, patch it, write
// it back, and mirror the result onto state.commentReplyText for
// sendCommentReply to read.
function pickCommentMention(user) {
  const el = document.querySelector('[data-testid="plan-comment-reply-input"]')
  const mentionText = '@' + user.displayName
  const current = el ? el.value : state.commentReplyText
  const next = current.replace(/@[^\s@]{1,40}$/, mentionText + ' ')
  state.commentReplyText = next
  state.commentMentions = state.commentMentions.concat([{ accountId: user.accountId, text: mentionText }])
  state.commentMentionQuery = ''
  state.commentMentionResults = []
  requestAnimationFrame(() => {
    const input = document.querySelector('[data-testid="plan-comment-reply-input"]')
    if (input) {
      input.value = next
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  })
}

// sendCommentReply posts the composer's body via the jira_comment workflow
// (the sanctioned write path — .claude/rules/workflows-write-boundary.md),
// then re-reads the panel fresh and feeds the new comment back into the plan
// exactly like an answer does (the plan_answer Signal's "comment" Kind, see
// plan_workflow.go's planAnswerComment).
async function sendCommentReply(key) {
  const body = state.commentReplyText.trim()
  if (!body || state.commentSending) return
  state.commentSending = key
  state.commentSendError = ''
  try {
    const res = await fetch('/api/workflows/jira_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, body, mentions: state.commentMentions }),
    })
    if (!res.ok) {
      state.commentSendError = t('Versturen mislukt.')
      state.commentSending = ''
      return
    }
    closeCommentReply()
    await loadComments(true)
    if (!state.runId) await ensureTracker()
    if (state.runId) {
      lastPayload = ''
      fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: '', optionId: '', text: '', kind: 'comment' }),
      }).catch(() => {})
    }
  } catch (err) {
    state.commentSendError = t('Versturen mislukt.')
  }
  state.commentSending = ''
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
  return state.generating || state.scopePending || state.hotfixPending || state.followupPending || state.regeneratePending
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

// needsHotfix is true while the tracker is parked on the question EVERY ticket
// is asked before anything is generated: hotfix (from master), the ordinary
// base branch, or another branch entirely? It comes AFTER the scope question,
// so only one gate is ever on screen.
function needsHotfix() {
  return !state.hotfixPending && !!state.doc.needsHotfix && !needsScope()
}

// gateOpen is "one of the two questions that come BEFORE the plan still
// stands", so nothing of the index itself is built yet.
function gateOpen() {
  return needsScope() || needsHotfix()
}

// loadBranches fills the "another branch" dropdown, once per unfold. Read-only
// (GET /api/branches): the primary repo's remote branches, the reviewer's own
// first. The search itself is client-side over this one list.
async function loadBranches() {
  if (state.branchLoading || state.branchList.length) return
  state.branchLoading = true
  try {
    const res = await fetch('/api/branches')
    const body = res.ok ? await res.json() : null
    state.branchList = body && Array.isArray(body.branches) ? body.branches : []
  } catch (err) {
    state.branchList = []
  }
  state.branchLoading = false
}

// visibleBranches is the dropdown's own list: everything matching the typed
// search, own branches still first (the server already ordered them), capped
// so a repo with hundreds of branches stays a dropdown.
const MAX_BRANCH_ROWS = 40
function visibleBranches() {
  const q = state.branchQuery.trim().toLowerCase()
  const list = q ? state.branchList.filter((b) => b.name.toLowerCase().includes(q)) : state.branchList
  return list.slice(0, MAX_BRANCH_ROWS)
}

// chooseHotfix answers the base-branch question. "other" only UNFOLDS the dropdown —
// the answer follows once a branch is picked from it (chooseBranch).
async function chooseHotfix(row) {
  if (row.target === 'other') {
    state.branchOpen = true
    loadBranches()
    return
  }
  await sendHotfix({ hotfix: row.target === 'yes' }, row.id)
}

// chooseBranch answers with a branch picked from the dropdown (the third
// choice). The branch travels as a name; the server validates it against the
// same ref allow-list `git`/`gh` will see it through.
async function chooseBranch(name) {
  await sendHotfix({ hotfix: false, branch: name }, 'hotfix:other')
}

// sendHotfix signals the answer to the tracker, which releases it into its
// first generation — the mirror of chooseScope.
async function sendHotfix(body, rowID) {
  if (state.saving) return
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.saving = rowID
  state.hotfixPending = true
  state.branchOpen = false
  lastPayload = ''
  try {
    await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/plan_hotfix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

// ---------------------------------------------------- the general chat ----
// "die mag je hergebruiken" — the review tree's own Claude chat component
// (ClaudeChat.mjs's claudeChatColumn), fed by this page's OWN, much simpler
// backend: one blocking Signal (plan_answer, Kind "chat") that appends the
// reviewer's message, runs ONE Claude call and appends the reply — all on
// the SAME per-ticket document every other answer already lives on, keyed
// by the Jira key (from the URL) rather than a GitHub PR number, since
// planning happens before a PR exists. See .claude/docs/plan-page.md.

// chatMessages adapts the stored transcript into the small, stable shape
// claudeChatColumn/claudeBubble expect (id/role/body) — no kind/model/
// noShell/options: those all describe review-tree turn machinery (retry
// ladders, agentic tool use, questions with options) this page's own single
// one-shot Claude call never produces.
function chatMessages() {
  return (state.doc.chat || []).map((m, i) => ({ id: 'chat:' + i, role: m.role, body: m.body }))
}

// chatConvId is the conversation id this ticket's chat pushes/polls live
// progress under — planChatConversationID(key) on the Go side (plan_workflow.go),
// mirrored here so both sides agree without either reading the other's code.
// Prefixed (never a bare Jira key) so it can never collide with a real GitHub
// comment id, which is always numeric.
function chatConvId() {
  return 'plan:' + state.key
}

// syncPlanChatTicker runs a 1s heartbeat only while this ticket's own chat
// turn is actually running — mirrors RelatedPanel.mjs's syncChatTicker
// (module-private there, so a small copy lives here too), trimmed to the one
// conversation this page ever has.
let chatTickTimer = null
function syncPlanChatTicker() {
  const p = turnProgress(chatConvId())
  const running = !!(p && p.running)
  if (running && !chatTickTimer) {
    chatTickTimer = setInterval(() => {
      state.chatTick = Date.now()
    }, 1000)
  } else if (!running && chatTickTimer) {
    clearInterval(chatTickTimer)
    chatTickTimer = null
  }
}

// scrollPlanChatThreadToBottom mirrors RelatedPanel.mjs's
// scrollClaudeThreadToBottom (`claude-chat-thread` scrolls ITSELF, never an
// ancestor — see .claude/docs/claude-chat-panel.md) — this page's own
// implementation of the same call, since plan.mjs deliberately imports none
// of RelatedPanel.mjs's chat engine. Trimmed to what this page actually
// needs: no claudePos/pinned guard, since this chat has no turn-by-turn `↑`
// navigation and chatView().pinned() is hard-coded `true` anyway. Reviewer
// report (data/review-shots/task53-reactie-niet-in-conversatie.png): a long
// reply never scrolled into view at all, reading as "the reply just doesn't
// appear" — because nothing ever moved this div's own scrollTop.
function scrollPlanChatThreadToBottom() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=claude-chat-thread]')
    if (!el) return
    el.scrollTop = el.scrollHeight
    // A JS-driven scrollTop write isn't guaranteed to fire a native 'scroll'
    // event in every browser — update the scroll hints directly too, same
    // reasoning as scrollClaudeThreadToBottom's own comment.
    updateScrollHints(el)
  })
}

// loadChatProgressResync is the RESYNC read for the live-progress channel
// (GET /api/chat/progress?commentId=...) — same generic, conversation-id-keyed
// endpoint the review tree's own loadChatProgress uses (RelatedPanel.mjs),
// just for this page's single fixed conversation. Runs on first connect and on
// every SSE reconnect, never as a poll.
async function loadChatProgressResync() {
  const convId = chatConvId()
  const startedAt = Date.now()
  try {
    const res = await fetch('/api/chat/progress?commentId=' + encodeURIComponent(convId))
    if (!res.ok) return
    const json = await res.json()
    // A pushed event that landed WHILE this request was in flight is newer —
    // it must win, same guard as RelatedPanel.mjs's loadChatProgress.
    if (lastTurnProgressAt(convId) > startedAt) return
    setTurnProgress(convId, json.running && json.progress ? json.progress : null)
    syncPlanChatTicker()
    scrollPlanChatThreadToBottom()
  } catch (_) {
    // a missing snapshot just means "no live turn known" — nothing to show
  }
}

// ensurePlanChatEvents wires this ticket's chat into the shared SSE stream
// (events.mjs) and the shared per-conversation progress store (claudeTurns.mjs)
// — called once at page load, next to setInterval(loadPlan, POLL_MS) below.
// This page has no PR, so ensureEvents() opens the plain, unscoped connection
// (every PR-less push, plus a plan chat's own — see eventbus.go's publish,
// which never scopes a pr:0 event to one PR); every handler below filters on
// this ticket's OWN conversation id, so an unrelated event from another open
// tab (a review-tree turn, another ticket's chat) is simply ignored.
let planChatEventsBound = false
function ensurePlanChatEvents() {
  ensureEvents()
  if (planChatEventsBound) return
  planChatEventsBound = true
  const convId = chatConvId()
  onEvent('chat.progress', (ev) => {
    if (ev.key !== convId) return
    setTurnProgress(convId, ev.data || null)
    syncPlanChatTicker()
    scrollPlanChatThreadToBottom()
  })
  onEvent('chat.message', (ev) => {
    if (ev.key !== convId) return
    // The transcript changed server-side (the reply landed) — refetch it the
    // ordinary way, same "an event is never the source of truth" rule as
    // every other SSE consumer (see .claude/docs/server-events.md).
    lastPayload = ''
    loadPlan().then(scrollPlanChatThreadToBottom)
  })
  onEventsResync(loadChatProgressResync)
  loadChatProgressResync()
}

// chatSignalName picks which signal the chat message rides on: tembed can
// only WaitSignal on one name at a time, and the tracker is parked on a
// DIFFERENT signal while the scope/hotfix gate stands (see needsScope/
// needsHotfix and handlePlanChat in plan_workflow.go) — the chat must keep
// working there too, not only once every gate is answered.
function chatSignalName() {
  if (needsScope()) return 'plan_scope'
  if (needsHotfix()) return 'plan_hotfix'
  return 'plan_answer'
}

// sendChatMessage sends one reviewer message. The message is echoed onto
// state.doc locally FIRST (optimistic — the same "local pick wins until the
// document catches up" shape answerFor uses) so it appears immediately. The
// Signal round trip still blocks until the whole reply is generated
// (handlePlanChat runs it inline), but the reviewer no longer just waits on a
// blank overlay for that: the LIVE turn — status/streamed text — arrives
// meanwhile over the same SSE channel the review tree's own chat uses, see
// ensurePlanChatEvents/chatView. This await is only the belt-and-braces
// refetch for the reviewer's OWN send, exactly like RelatedPanel.mjs's
// sendClaudeMessage.
async function sendChatMessage(text) {
  const trimmed = (text || '').trim()
  if (!trimmed || state.chatBusy) return
  if (!state.runId) await ensureTracker()
  if (!state.runId) return
  state.chatBusy = true
  state.chatError = ''
  state.doc = { ...state.doc, chat: [...(state.doc.chat || []), { role: 'user', body: trimmed }] }
  scrollPlanChatThreadToBottom()
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(state.runId) + '/signals/' + chatSignalName(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', text: trimmed }),
    })
    if (!res.ok) state.chatError = t('Kon niet verstuurd worden.')
    lastPayload = ''
    await loadPlan()
    scrollPlanChatThreadToBottom()
  } catch (err) {
    state.chatError = t('Kon niet verstuurd worden.')
  }
  state.chatBusy = false
}

// chatView/chatCallbacks are claudeChatColumn's own two arguments (see
// ClaudeChat.mjs's file header: getters + plain callbacks, no reactive state
// of its own). Most fields the review tree's richer engine needs stay
// stubbed to their inert value on purpose — this page's chat still has no
// retry ladder, queueing, or werkmap — but progress/busy/elapsed now read the
// SAME live per-conversation snapshot the tree's own chat does (turnProgress,
// claudeTurns.mjs), keyed by chatConvId(), so claudeChatColumn's existing
// status line/partial-answer bubble render for real here too.
function chatView() {
  return {
    messages: () => chatMessages(),
    status: () => 'ok',
    busy: () => state.chatBusy,
    retryAllBusy: () => false,
    active: () => state.chatBusy,
    sendError: () => state.chatError,
    claudePos: () => 0,
    pinned: () => true,
    claudeOptionSel: () => 0,
    anchorHint: () => '',
    progress: () => turnProgress(chatConvId()),
    queued: () => [],
    elapsed: () => {
      const p = turnProgress(chatConvId())
      if (!p || !p.startedAt) return 0
      void state.chatTick
      return Math.max(0, Math.round((Date.now() - p.startedAt) / 1000))
    },
  }
}

function chatCallbacks() {
  return {
    onSend: (text) => sendChatMessage(text),
    onRetry: () => {},
    onRetryAll: () => {},
    onCleanup: () => {},
    onCancel: () => {},
    onFocus: () => {},
    onEmptyEnter: () => {},
    onInput: () => {},
    onSent: () => {},
    onThreadScroll: () => {},
    onJumpToBottom: () => {},
  }
}

function openPlanChat() {
  state.chatOpen = true
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=claude-chat-compose]')
    if (el) el.focus()
  })
  // Reopening an already-running conversation should land on its latest
  // turn, not scrolled to the top — see scrollPlanChatThreadToBottom's own
  // doc comment.
  scrollPlanChatThreadToBottom()
}

function closePlanChat() {
  state.chatOpen = false
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

// COMMENTS_ROW_ID is the stable id of the Jira-opmerkingen block, the FIRST
// row of the index whenever the ticket family has any comment at all —
// reviewer request: "als ik naar rechts ga, wil ik eerst jira opmerkingen
// blok volledig selecteren". It carries no example code (curBlocks() below
// only recognises 'option'/'task'), so → never opens a block column for it.
const COMMENTS_ROW_ID = 'comments'

// COMMENTS_COLLAPSED_CLS caps the collapsed comments list's height to roughly
// 2.5 short comments and bottom-anchors its content — see commentsPanel's own
// doc comment for the full reasoning (task 48b).
const COMMENTS_COLLAPSED_CLS = 'max-h-[260px] justify-end plan-comments-fade-top'

// COMMENTS_COLLAPSE_HINT_MIN: below this many comments in the whole flattened
// list, the fold cannot plausibly be hiding anything worth naming, so
// `plan-comments-expand-hint` stays silent — same "never offer a no-op
// affordance" reasoning as e.g. planCommands' conditional "Opnieuw plannen".
const COMMENTS_COLLAPSE_HINT_MIN = 3

// commentId gives one comment a stable id across a re-fetch (the panel has no
// polling, but "Ververs"/a posted reply re-reads the whole list) — the same
// group-key + comment-id-or-created-or-index shape commentRow's own `.key()`
// already used, now also the identity the keyboard cursor walks by (never a
// raw index, .claude/rules/conventions.md).
function commentId(groupKey, c, i) {
  return groupKey + ':' + (c.id || c.created || i)
}

// commentFlatList flattens every group's comments into ONE ordered list —
// exactly like navRows() flattens every question's options — so ↓ walks
// straight from one ticket's last comment into the next ticket's first one.
function commentFlatList() {
  const out = []
  ;(state.comments.groups || []).forEach((g) => {
    ;(g.comments || []).forEach((c, i) => out.push({ id: commentId(g.key, c, i), group: g, c }))
  })
  return out
}

// ownOptionId/ownOptionFor synthesize the always-present, no-generated-
// content last option of every question (see the comment above its push in
// navRows below) — never persisted on the document, built fresh on every
// render, purely a client-side rendering concern. `.own = true` is the flag
// optionRow/ownOptionRow branch on.
function ownOptionId(q) {
  return q.id + ':own'
}

function ownOptionFor(q) {
  return { id: ownOptionId(q), own: true }
}

function navRows() {
  const out = []
  // The Jira-opmerkingen block is always the first stop, independent of the
  // scope/hotfix gate below — commentsPanel() itself renders unconditionally
  // for the same reason (reading comments is useful before a plan exists).
  // Guarded on having any comment at all, same as the follow-up row's own
  // "only once there is something" guard.
  if (commentFlatList().length) out.push({ id: COMMENTS_ROW_ID, kind: 'comments' })
  // The scope question REPLACES the rest of the index while it stands: the
  // reviewer is asked what is being planned before anything else is shown.
  if (needsScope()) {
    out.push({ id: SCOPE_PARENT_ID, kind: 'scope', target: 'parent' })
    ;(state.doc.subtasks || []).forEach((st) => out.push({ id: 'scope:' + st.key, kind: 'scope', target: 'subtask', subtask: st }))
    return out
  }
  // The base-branch question replaces the index the same way, for the same
  // reason.
  if (needsHotfix()) {
    out.push({ id: 'hotfix:yes', kind: 'hotfix', target: 'yes' })
    out.push({ id: 'hotfix:no', kind: 'hotfix', target: 'no' })
    out.push({ id: 'hotfix:other', kind: 'hotfix', target: 'other' })
    return out
  }
  ;(state.doc.questions || []).forEach((q, qi) => {
    ;(q.options || []).forEach((o, oi) => out.push({ id: o.id, kind: 'option', q, o, qi, oi }))
    // Reviewer request: "altijd een laatste optie met alleen input velden" —
    // every question also gets one synthetic, generated-content-free option
    // at the end, so a reviewer whose real cause isn't among Claude's
    // suggested choices can still type it instead of forcing a pick among
    // options that don't fit. Its id (`<questionId>:own`) never collides with
    // a real option's (`q1o1`, `q1o2`, …) — a real option id never contains
    // a `:` — so it's safe alongside whatever the model generated.
    out.push({ id: ownOptionId(q), kind: 'option', q, o: ownOptionFor(q), qi, oi: (q.options || []).length })
  })
  // "Meer vragen om het plan te perfectioneren" and "Plan opstellen [opnieuw]"
  // — only once there IS a plan to perfect/replace, so a still-generating
  // page does not park the default cursor on either.
  if ((state.doc.questions || []).length || (state.doc.tasks || []).length) {
    out.push({ id: FOLLOWUP_ROW_ID, kind: 'followup' })
    out.push({ id: REGENERATE_ROW_ID, kind: 'regenerate' })
  }
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
  // A stale nested comment focus (the comments row itself disappeared, or the
  // cursor moved off it some other way) must never keep ↑/↓ hijacked.
  if (state.commentsFocused && state.cur !== COMMENTS_ROW_ID) state.commentsFocused = false
  if (state.commentCursor && !commentFlatList().some((c) => c.id === state.commentCursor)) state.commentCursor = ''
}

// isCommentsRowSelected/commentsActive mirror the review tree's own
// isTestColumnActive(): the block-level ring (isCommentsRowSelected, not
// focused) and the per-comment ring (commentsActive) are mutually exclusive —
// .claude/rules/conventions.md's "never two selections visible at once".
function isCommentsRowSelected() {
  return state.cur === COMMENTS_ROW_ID && state.col !== 0
}

function commentsActive() {
  return isCommentsRowSelected() && state.col === 1 && state.commentsFocused
}

// commentsListExpanded reuses commentsFocused itself as the "is the whole
// Jira-opmerkingen list expanded" flag (reviewer request, task 48b — see
// "Collapsed by default" in commentsPanel's own doc comment): the exact same
// action that hands ↑/↓ to the individual comments (Enter on the block, or a
// click on one) is what should reveal the full history, and leaving that mode
// (←) is exactly when it should fold back down. No separate state needed.
function commentsListExpanded() {
  return state.commentsFocused
}

// selectCommentsRow is what a click on the panel's own background does — the
// block-level selection stepRight() already lands on with a plain →, kept as
// its own function so the mouse can run it too (mouse-navigation.md rule 1).
function selectCommentsRow() {
  state.cur = COMMENTS_ROW_ID
  focusColumn1()
  state.path = [0]
  state.commentsFocused = false
}

// enterCommentsFocus hands ↑/↓ to the comments themselves — Enter on the
// block (kind: 'comments' in onKeydown) or a direct click on one comment
// (commentRow, which passes its own id so the click can jump straight to it —
// mouse-navigation.md rule 2, still reachable in two keyboard steps).
function enterCommentsFocus(startId) {
  const list = commentFlatList()
  if (!list.length) return
  state.cur = COMMENTS_ROW_ID
  focusColumn1()
  state.path = [0]
  state.commentsFocused = true
  const want = startId || state.commentCursor
  state.commentCursor = list.some((c) => c.id === want) ? want : list[0].id
  scrollCommentCursorIntoView()
}

function exitCommentsFocus() {
  state.commentsFocused = false
}

function moveCommentCursor(delta) {
  const list = commentFlatList()
  if (!list.length) return
  const at = Math.max(
    0,
    list.findIndex((c) => c.id === state.commentCursor),
  )
  const next = Math.min(Math.max(at + delta, 0), list.length - 1)
  if (list[next].id === state.commentCursor) return
  state.commentCursor = list[next].id
  scrollCommentCursorIntoView()
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
  // Moving to a different top-level row always leaves any nested comment
  // focus behind, exactly like selectRow resets classMethodSel/
  // testColumnFocused in the review tree.
  state.commentsFocused = false
  scrollCurIntoView()
  // Reviewer request: "als ik eerste antwoord selecteer, moet ook gelijk het
  // blok worden gezien" — a step here can change WHICH example-code column
  // renders (a different option/task's own blocks) without state.col moving
  // off 1, so scrollCurIntoView's vertical-only scroll never brings it into
  // view on its own.
  scrollBlockPreviewIntoView()
  syncOptionFocus(rows[next])
}

// syncOptionFocus keeps DOM focus in sync with the ARROW-KEY cursor —
// reviewer request: "de auto-focus moet zijn als je er gewoon overheen gaat
// met pijltjes, niet als gevolg van enter". Landing on an option row (real or
// the always-present "eigen antwoord" one) via ↑/↓ focuses its own free-text
// field right away, so the reviewer can start typing without an extra
// click/Tab/Enter; landing on any other kind of row blurs a still-focused
// option field, so a stale caret never lingers on a row that no longer
// carries the visible cursor ring (see "Never two selections visible at
// once"). Never called from advanceToNextQuestion — Enter must NOT trigger
// this, per the same reviewer request.
function syncOptionFocus(row) {
  if (row && row.kind === 'option') {
    focusOptionInput(row.o.id)
    return
  }
  if (isEditableFocused() && document.activeElement.closest('[data-testid="plan-option"]')) {
    document.activeElement.blur()
  }
}

// scrollBlockPreviewIntoView brings the cursor's own example-code column
// (blockLevels()[0], data-level="0") into view WITHOUT stealing keyboard
// focus away from column 1 — 'nearest', not 'start', so it only scrolls the
// minimum needed and never hides column 1 itself while the reviewer is still
// walking the questions/tasks list (see .claude/docs/plan-page.md, "Column 0
// slides out of view, and the example-code column follows the cursor").
function scrollBlockPreviewIntoView() {
  if (!curBlocks().length) return
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="plan-block-column"][data-level="0"]')
    if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  })
}

// focusOptionInput hands DOM focus to one option's own free-text field —
// called by syncOptionFocus as the arrow-key cursor lands on an option row, so
// the reviewer can start typing immediately. Deferred a frame like every other
// helper here that reaches into freshly-relevant DOM (though this node is
// always mounted already; the defer is just cheap insurance against a
// same-tick rebuild). `select()` so a re-chosen option with existing text
// starts fully selected rather than leaving the caret buried mid-word.
function focusOptionInput(optionId) {
  requestAnimationFrame(() => {
    const el = document.querySelector(
      '[data-testid="plan-option"][data-option-id="' + optionId + '"] input[data-testid="plan-option-input"]',
    )
    if (el) {
      el.focus()
      el.select()
    }
  })
}

// advanceToNextQuestion is moveRow's sibling for the one case where "next"
// must skip past sibling rows: pressing Enter — on an option row itself, or
// inside its own free-text field — should jump to the NEXT QUESTION, not to
// the next option of the SAME question (reviewer request: "als ik enter druk,
// moet ik gelijk naar de volgende vraag springen", confirmed/tightened to
// "één enter = door", i.e. no second Enter needed). Walks navRows() forward
// from the current cursor past every row that still shares this question's
// id, landing on whatever comes after — the next question's first option, or,
// at the end of the list, the follow-up/task/execute row exactly like moveRow
// would. Deliberately does NOT call syncOptionFocus: the free-text field only
// auto-focuses while ARROWING over options, never as a side effect of Enter.
function advanceToNextQuestion() {
  const rows = navRows()
  const at = rows.findIndex((r) => r.id === state.cur)
  if (at < 0) return
  const curQ = rows[at].q
  let next = at + 1
  while (next < rows.length && rows[next].kind === 'option' && curQ && rows[next].q && rows[next].q.id === curQ.id) next++
  if (next >= rows.length) next = rows.length - 1
  if (next === at || !rows[next]) return
  state.cur = rows[next].id
  state.path = [0]
  state.confirmExec = false
  scrollCurIntoView()
  scrollBlockPreviewIntoView()
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
    // Reviewer request: "als ik naar rechts ga, dan zie ik een prachtige
    // animatie ... als ik te ver naar rechts ga" — this very first
    // ticket→questions step used to skip scrollFocusIntoView entirely (only
    // the block-column steps further right called it), so the ticket card
    // never animated away and could linger on screen wasting width. Now every
    // column-focus change gets the same smooth scroll (see that helper).
    scrollFocusIntoView()
    return
  }
  if (state.col === 1) {
    if (!curBlocks().length) return
    state.col = 2
    scrollFocusIntoView()
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
    // Symmetric with stepRight above: bring the ticket card back into view
    // (it may have scrolled off to the left while column 1+ had the focus).
    scrollFocusIntoView()
    return
  }
  const level = state.col - 2
  state.col = state.col - 1
  if (level > 0) state.path = state.path.slice(0, level)
  scrollFocusIntoView()
}

// focusColumn1 is the CLICK-driven counterpart of stepRight/stepLeft's own
// `state.col` change — every option/scope/hotfix/task/comments row's own
// click handler (plus the questions column's own background click) forces
// the keyboard back onto column 1 this way. Reviewer report (task45's sibling
// bug, no screenshot the second time): clicking any of those from a deeper
// column (an open block/example-code column) silently, uncontrolled, dumped
// column 1 back to its double width and could reveal column 0 again with no
// explanation — because every one of these ~15 call sites used to just
// assign `state.col = 1` directly, unlike stepRight/stepLeft's own change
// (which always calls scrollFocusIntoView right after). The width class on
// the questions column really does flip between `w-[27rem]`/`w-[62rem]` on
// this (see "The questions column doubles in width…" in
// .claude/docs/plan-page.md), so this is a REAL layout width change, not a
// no-op — dropping an open block column shrinks the total scrollable width
// too, and the browser then silently clamps the stale scrollLeft to the new,
// smaller max, which is what actually moved column 0 back into view. One
// shared helper instead of every call site repeating the raw assignment, so
// the missing re-anchor can't quietly reoccur at a future call site. Also
// logs the jump to the debug-mode recording (.claude/docs/debug-mode.md) —
// only when state.col actually changes — since a reviewer reported a related
// "typing in eigen antwoord submits/changes something immediately" with no
// screenshot, debug mode on, and no confirmed mechanism; see sendAnswer's own
// logAction call for the matching "did a real answer get saved" line.
function focusColumn1() {
  const changed = state.col !== 1
  if (changed) logAction('plan-col-jump', 'col:' + state.col + '->1')
  state.col = 1
  if (changed) scrollFocusIntoView()
}

function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // The general-chat overlay owns the keyboard completely while open — same
  // shape as the review tree's own generalChatOverlay.mjs: Escape hides it
  // (ClaudeChat.mjs's own composer @keydown only intercepts Escape while a
  // turn is genuinely active, see view.active() above, so an idle Escape
  // reaches here and closes the overlay), every other key is left alone so
  // it keeps reaching the composer textarea exactly as ClaudeChat.mjs wires
  // it. Checked before isEditableFocused() below: that branch would
  // otherwise just blur the composer on Escape instead of closing the
  // overlay around it.
  if (state.chatOpen) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePlanChat()
    }
    return
  }
  // The ticket-column Enter-menu owns the keyboard the same way — mirrors
  // home.mjs's own `if (menu.open) {...}` branch, at the scale this page's
  // tiny, submenu-less PLAN_COMMANDS list needs.
  if (menu.open) {
    const list = resolvePlanCommands(ms.query)
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      ms.sel = Math.min(ms.sel + 1, Math.max(0, list.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      ms.sel = Math.max(ms.sel - 1, 0)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (list[ms.sel]) runCommand(list[ms.sel])
    }
    return
  }
  if (isEditableFocused()) {
    if (e.key === 'Escape') document.activeElement.blur()
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      // The comments block owns ↑/↓ once Enter has focused it — see the
      // 'comments' branch below and .claude/docs/plan-page.md.
      if (commentsActive()) moveCommentCursor(1)
      else if (state.col === 1) moveRow(1)
      else if (state.col > 1) moveBlock(state.col - 2, 1)
      return
    case 'ArrowUp':
      e.preventDefault()
      if (commentsActive()) moveCommentCursor(-1)
      else if (state.col === 1) moveRow(-1)
      else if (state.col > 1) moveBlock(state.col - 2, -1)
      return
    case 'ArrowRight':
      e.preventDefault()
      // No nested column to step into from inside the comments — a plain
      // no-op, same as f/d/s/a on stop 1 in the review tree.
      if (commentsActive()) return
      stepRight()
      return
    case 'ArrowLeft':
      e.preventDefault()
      // ← leaves the per-comment cursor and hands ↑/↓ back to the block row,
      // without changing state.col — mirrors the methodes-kolom's own ←.
      if (commentsActive()) {
        exitCommentsFocus()
        return
      }
      stepLeft()
      return
    case '/':
      // Always opens the general chat about this ticket — mirrors the review
      // tree's own rule ("/ wordt altijd het PR-menu", here: altijd de chat),
      // wherever the keyboard currently is.
      e.preventDefault()
      openPlanChat()
      return
    case 'Enter':
    case ' ': {
      // Enter on the ticket column (stop 0, no block/question context there)
      // opens the small ticket menu instead — mirrors the review tree's own
      // "Enter on stop 1 opens the PR-wide menu" rule. Checked first so it
      // wins regardless of what curRow() below would otherwise resolve to.
      if (state.col === 0) {
        e.preventDefault()
        openPlanMenu()
        return
      }
      // Already navigating the comments themselves — nothing further to do
      // with Enter/Space here (← is what leaves that mode, see ArrowLeft
      // above); without this guard curRow() below would just re-enter it.
      if (commentsActive()) {
        e.preventDefault()
        return
      }
      const row = curRow()
      if (state.col === 1 && row && row.kind === 'comments') {
        // "als ik enter druk, wil ik tussen de opmerkingen heen kunnen
        // navigeren" — hand ↑/↓ to the comments themselves.
        e.preventDefault()
        enterCommentsFocus()
      } else if (state.col === 1 && row && row.kind === 'option') {
        e.preventDefault()
        sendAnswer(row.q, row.o, answerTextFor(row.q.id))
        // Reviewer request, tightened: "één enter = door" — choosing an
        // option via Enter immediately advances to the next question, same as
        // Enter inside the option's own free-text field below. The free-text
        // field itself is focused while ARROWING over options (moveRow →
        // syncOptionFocus), not as a side effect of Enter.
        advanceToNextQuestion()
      } else if (state.col === 1 && row && row.kind === 'scope') {
        e.preventDefault()
        chooseScope(row)
      } else if (state.col === 1 && row && row.kind === 'hotfix') {
        e.preventDefault()
        chooseHotfix(row)
      } else if (state.col === 1 && row && row.kind === 'task') {
        // An agreed default (todo/plan-page-workflow.md): Enter on a task row
        // toggles its checkbox. The row's own field is reached by clicking/
        // Tabbing into it, exactly like an option's is.
        e.preventDefault()
        toggleTask(row.task)
      } else if (state.col === 1 && row && row.kind === 'followup') {
        e.preventDefault()
        sendFollowup()
      } else if (state.col === 1 && row && row.kind === 'regenerate') {
        e.preventDefault()
        sendRegenerate()
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

// scrollRowIntoView keeps a cursor row in view WITHOUT touching the
// horizontal axis — the column flow scrolls horizontally, so a plain
// scrollIntoView would drag the whole page sideways (the same rule as
// scrollIntoViewVertical in the review tree). Shared by scrollCurIntoView
// (the top-level index cursor) and scrollCommentCursorIntoView (the nested
// comment cursor) — same walk-up-to-the-first-scrollable-ancestor logic,
// only the selector differs.
function scrollRowIntoView(selector) {
  requestAnimationFrame(() => {
    const el = document.querySelector(selector)
    if (!el) return
    let box = el.parentElement
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement
    if (!box) return
    // Reviewer request (screenshot task45): "laat dat hele blokje volledig
    // zichtbaar zien" — landing on a new question left only the cursor's own
    // OPTION row in view, cutting off the rest of that question's card
    // (title/why + every other option) at the bottom. Prefer the whole
    // enclosing question card (header + all its options) as the element that
    // must fit, so switching questions doesn't leave the new one half
    // offscreen while the previous one still occupies the top of the view.
    const card = el.closest('[data-testid="plan-question"]')
    const fit = (target) => {
      const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
      const bottom = top + target.offsetHeight
      if (top < box.scrollTop) box.scrollTop = top - 12
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 12
    }
    // Falls back to the row itself when there's no such wrapper (scope/
    // hotfix/task/followup/action/comments rows), or when the whole card is
    // taller than the viewport — that's exactly the old row-only behaviour,
    // kept for a question long enough it could never fully fit anyway.
    if (card && card.offsetHeight <= box.clientHeight) fit(card)
    else fit(el)
  })
}

function scrollCurIntoView() {
  scrollRowIntoView('[data-cursor="true"]')
}

// scrollCommentCursorIntoView keeps the active comment (commentsActive()'s
// own cursor) in view while walking ↑/↓ inside the Jira-opmerkingen block.
function scrollCommentCursorIntoView() {
  scrollRowIntoView('[data-comment-cursor="true"]')
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

// ------------------------------------- the CURRENT code next to the proposal

// PLAN_FILE_RE is the same allow-list the endpoint validates against
// (plan_current_code.go's planCurrentFilePattern): a block titles itself with a
// repo-relative path, but the model is free to title one "de nieuwe check" —
// only something that really reads as a file path is ever looked up.
const PLAN_FILE_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/

// maxCurrentLines bounds what the current-code pane renders. The endpoint
// already caps the bytes; this keeps a 3000-line file from turning one block
// card into a wall (the word says it was cut, per the colourblind rule).
const maxCurrentLines = 400

function blockFilePath(block) {
  const title = String((block && block.title) || '').trim()
  if (!title || !title.includes('.') || !PLAN_FILE_RE.test(title)) return ''
  return title
}

// ensureCurrentCode reads what that file looks like RIGHT NOW in the plan's own
// werkmap (GET /api/plan/current — read-only, see plan_current_code.go). One
// request per file, cached on state.current: a block column re-renders on every
// cursor step and must not re-fetch.
function ensureCurrentCode(file) {
  if (!file || state.current[file]) return
  state.current = { ...state.current, [file]: { loading: true, found: false, code: '' } }
  fetch('/api/plan/current?key=' + encodeURIComponent(state.key) + '&file=' + encodeURIComponent(file))
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      state.current = {
        ...state.current,
        [file]: body
          ? { loading: false, found: !!body.found, code: body.code || '', dir: body.dir || '', truncated: !!body.truncated }
          : { loading: false, found: false, code: '' },
      }
    })
    .catch(() => {
      state.current = { ...state.current, [file]: { loading: false, found: false, code: '' } }
    })
}

// currentFor returns the cached entry, kicking off the read on first sight.
// Called from inside a reactive binding, so the state write it may schedule is
// the fetch's own (async) one — never a synchronous write during the render.
function currentFor(file) {
  if (!file) return null
  if (!state.current[file]) {
    requestAnimationFrame(() => ensureCurrentCode(file))
    return { loading: true, found: false, code: '' }
  }
  return state.current[file]
}

// newRangesInRight token-diffs two lines and returns the merged char ranges
// ({start, end}, half-open) in `right` that are genuinely new — a token
// present in `right` with no counterpart in `left`. Reuses the review tree's
// own token/char-diff (tokenize/diffChars, moved to src/lineDiff.mjs
// specifically so this page could reuse them without importing Block.mjs).
function newRangesInRight(left, right) {
  const a = tokenize(left || '')
  const b = tokenize(right || '')
  const ops = diffChars(
    a.map((t) => t.text),
    b.map((t) => t.text),
  )
  const ranges = []
  let ai = 0
  let bi = 0
  for (const op of ops) {
    if (op === 'eq') {
      ai++
      bi++
    } else if (op === 'del') {
      ai++
    } else {
      const tok = b[bi++]
      const start = tok.start
      const end = start + tok.text.length
      const last = ranges[ranges.length - 1]
      if (last && last.end === start) last.end = end
      else ranges.push({ start, end })
    }
  }
  return ranges
}

// newProposedLines marks which PART of each line of the PROPOSED sketch is not
// already in the current file, using the review tree's own line aligner
// (alignRows, see src/lineDiff.mjs — the same function its split diff panes
// are built on). Deliberately NOT rendered as a two-sided del/ins diff: a plan
// block is a ~25-line SKETCH of one function and the current code is the whole
// file, so every unmatched file line would show up as a "removal" the plan
// never asked for. Marking the proposal's own new fragments is the honest half
// of that comparison, and it is what a reviewer actually wants to know: which
// part of these lines does the file not have yet?
//
// Returns one char-range array per proposed line (index-aligned with the
// proposed code's own lines, same as the old boolean array): a line with no
// counterpart at all (a pure `ins` row) is new in full; an unchanged row (or a
// paired row that differs only in whitespace — a re-indent, not real new
// content) is `[]`; a genuinely changed paired row is token-diffed so only its
// new fragment is marked.
function newProposedLines(currentCode, proposedCode) {
  const marks = []
  for (const row of alignRows(currentCode || '', proposedCode || '')) {
    if (row.right === null || row.right === undefined) continue
    if (row.left === null || row.left === undefined) {
      marks.push([{ start: 0, end: row.right.length }])
    } else if (row.rightMark !== 'ins') {
      marks.push([])
    } else if (row.left.replace(/\s+/g, '') === row.right.replace(/\s+/g, '')) {
      marks.push([]) // a pure re-indent, not real new content
    } else {
      marks.push(newRangesInRight(row.left, row.right))
    }
  }
  return marks
}

// The tint on a new char range is decoration; the underline is the shape/word-
// adjacent cue a colourblind reviewer relies on (per the colourblind rule,
// never colour alone) — same background+non-colour-cue pairing as the
// `@`-mention highlight (src/mentions.mjs).
const NEW_CHARS_CLS =
  'bg-emerald-50 underline decoration-emerald-600 decoration-2 underline-offset-2 dark:bg-emerald-500/15 dark:decoration-emerald-400'

// codeLinesHTML renders one pane: a gutter glyph per line ('+' for a line that
// has any new fragment — the WORD/GLYPH carries the row-level "this changed",
// the tint is decoration, per the colourblind rule) plus the Prism-highlighted
// line, with only the NEW char ranges (which may be the whole line, or just
// part of it — see newProposedLines) tinted+underlined.
function codeLinesHTML(code, lang, marks) {
  const lines = String(code || '').split('\n')
  const cut = lines.length > maxCurrentLines
  const shown = cut ? lines.slice(0, maxCurrentLines) : lines
  const rows = shown.map((line, i) => {
    const ranges = (marks && marks[i]) || []
    const isNew = ranges.length > 0
    const inRange = (pi) => ranges.some((r) => pi >= r.start && pi < r.end)
    const body = markChars(highlight(line, lang), (pi) => (inRange(pi) ? NEW_CHARS_CLS : ''))
    return (
      '<div class="flex"><span class="w-4 shrink-0 select-none text-center text-slate-400 dark:text-zinc-600">' +
      (isNew ? '+' : '') +
      '</span><span class="min-w-0 flex-1 whitespace-pre-wrap break-words">' +
      (body || '&nbsp;') +
      '</span></div>'
    )
  })
  if (cut) {
    rows.push(
      '<div class="flex pt-1 text-[11px] italic text-slate-400 dark:text-zinc-500"><span class="w-4 shrink-0"></span><span>' +
        escapeHtml('…(afgekapt na ' + maxCurrentLines + ' van ' + lines.length + ' regels)') +
        '</span></div>'
    )
  }
  return rows.join('')
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

// relatedPRRow is one already-merged pull request of this ticket family — the
// context the plan was built on, shown so it is checkable (see
// plan_context.go for how the three are picked).
function relatedPRRow(pr) {
  return html`
    <a
      href="${pr.url}"
      target="_blank"
      rel="noreferrer"
      class="block rounded-md px-1 py-0.5 text-[11.5px] leading-snug text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
      data-testid="plan-related-pr"
      ><span>${'#' + pr.number + ' ' + (pr.title || '')}</span>
      <span class="ml-1 font-mono text-[10.5px] text-slate-400 dark:text-zinc-500">${pr.key || ''}</span></a
    >
  `.key('relpr:' + pr.number)
}

// referencedIssueRow is one ticket referenced by this one's family but
// OUTSIDE it — a Jira link or a bare key mention (see collectPlanReferencedKeys,
// plan_context.go) — with the branch it already has work on, if any was
// found. Reviewer request: "als het goed is moet PROD-254 dan rekening
// houden met PROD-216. kan je ervoor zorgen dat je achterhaalt wat de branch
// is waar PROD-216 al iets in heeft gedaan?". A Jira-text-guessed branch is
// worded as a guess ("vermoedelijk"), never presented as fact — only a real
// GitHub PR's own branch (BranchSource starting with "pr:") is stated
// plainly, same distinction renderPlanIntent's own text makes.
function referencedIssueRow(r) {
  const branchLine = r.branch
    ? (r.branchSource || '').startsWith('pr:')
      ? t('branch {branch} ({source})', { branch: r.branch, source: r.branchSource })
      : t('vermoedelijk branch {branch} (uit jira-tekst, ongeverifieerd)', { branch: r.branch })
    : t('nog geen bekende branch')
  return html`
    <a
      href="${'/plan/' + encodeURIComponent(r.key)}"
      class="block rounded-md px-1 py-0.5 text-[11.5px] leading-snug text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
      data-testid="plan-referenced-issue"
      ><span class="font-mono text-[10.5px] text-slate-400 dark:text-zinc-500">${r.key}</span>
      <span>${' ' + (r.title || '') + ' — ' + (r.reason || '')}</span>
      <span class="block text-[10.5px] text-slate-400 dark:text-zinc-500">${branchLine}</span></a
    >
  `.key('ref:' + r.key)
}

// planPhaseNow mirrors planPhase() in plan_artifacts.go: which of the three
// planning stages this ticket is in. It prefers the server's own answer
// (state.artifacts.phase) and falls back to the same rule that answer is
// derived from — nothing generated yet is stage 1 — so a response that
// carries no artifacts block at all (a ticket whose files were never written)
// still lands on a real phase instead of on nothing.
function planPhaseNow() {
  const p = state.artifacts && state.artifacts.phase
  if (p) return p
  return (state.doc.questions || []).length || (state.doc.tasks || []).length ? 'specs' : 'intent'
}

// intentInQuestionsColumn: during stage 1 the intent IS the work, so the field
// moves to the questions column (reviewer request: "laat mij intentie in 2e
// kolom zien als je nog in stap 1 zit"). From stage 2 on it goes back to its
// old spot under the ticket description, where the plan itself has taken over
// the questions column.
function intentInQuestionsColumn() {
  return planPhaseNow() === 'intent'
}

// parseIntentSections/buildIntentFromSections: reviewer request ("misschien
// dat de markdown titels niet aangepast kan worden, alleen de description
// daaronder, meer github markdown editor ofzo") — split intent.md's own
// markdown on every heading line (`#`..`######`) into {heading, body} pairs,
// so intentField (below) can render each heading as a fixed, non-editable
// label and only the text below it as its own editable field. The leading
// segment before the very first heading (normally empty — intent.md always
// starts with "# Intent — …") gets `heading: null` and is only rendered/kept
// when it actually has content. buildIntentFromSections is the inverse, used
// to reconstruct the single intent.md text sent to the `plan_answer` Signal —
// deliberately joined with a blank line between every part rather than
// preserving the original's exact blank-line layout, since the document is
// regenerated from scratch by Claude whenever there is no override anyway.
function parseIntentSections(text) {
  const lines = (text || '').split('\n')
  const sections = []
  let cur = { heading: null, body: [] }
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      sections.push(cur)
      cur = { heading: line, body: [] }
    } else {
      cur.body.push(line)
    }
  }
  sections.push(cur)
  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() })).filter((s) => s.heading || s.body)
}

// intentSections is what intentField actually renders: the CURRENT intent.md
// text split into sections, never an empty list. An empty/not-yet-generated
// intent parses to zero sections, which used to render zero textareas — so in
// stage 1 (intent), where writing the intent is the whole job, there was
// literally nothing to type into and the "wordt automatisch gegenereerd…"
// placeholder the single-textarea version always showed was gone. One empty,
// heading-less section is the honest equivalent of that old empty field.
function intentSections() {
  const parsed = parseIntentSections(state.doc.intentOverride || state.intentText)
  return parsed.length ? parsed : [{ heading: null, body: '' }]
}

function buildIntentFromSections(sections) {
  return sections
    .map((s) => (s.heading ? s.heading + (s.body ? '\n\n' + s.body : '') : s.body))
    .filter((s) => s.trim().length)
    .join('\n\n')
}

// intentSectionBody is one section's own editable field (the "description"
// under a fixed, non-editable heading — see parseIntentSections above). On
// blur it reconstructs the WHOLE intent.md text from every sibling section's
// CURRENT (possibly just-edited) value — found via the shared
// `data-testid=plan-intent-sections` container, and each heading read back off
// the field's OWN `data-section-heading`, never off a section array captured
// when this component mounted: arrow.js reuses a keyed node without re-running
// its bindings, so such a snapshot goes stale the moment the list grows (the
// empty→generated case) and a blur would then rebuild the document with the
// wrong headings. Same "seed once, save on blur" discipline as the
// single-textarea version this replaces.
//
// Its .key() carries the section's own CONTENT, not just its position, for
// that same keyed-node-reuse reason: a position-only key left the very first
// field showing the empty text it mounted with even after the generated
// intent arrived. Keying on the content re-seeds exactly that case and
// nothing else — a poll bringing back the same text keeps the same key, so an
// edit in progress is still never clobbered.
function intentSectionBody(s, i, place, locked) {
  const inTicket = place === 'ticket'
  const rows = Math.max(3, Math.min(16, s.body.split('\n').length + 2))
  const save = (container) => {
    if (!container) return
    const bodies = Array.from(container.querySelectorAll('[data-testid="plan-intent-section-body"]'))
    const next = bodies.map((el) => ({ heading: el.dataset.sectionHeading || null, body: el.value }))
    const text = buildIntentFromSections(next)
    if (text !== buildIntentFromSections(intentSections())) sendIntentOverride(text)
  }
  return html`
    <div class="mb-2" data-testid="plan-intent-section" data-section-idx="${i}">
      <div class="contents">
        ${() =>
          s.heading
            ? html`<div
                class="mb-1 select-none font-mono text-[11px] font-semibold text-slate-500 dark:text-zinc-400"
                data-testid="plan-intent-heading"
              >
                ${s.heading}
              </div>`.key('heading')
            : ''}
      </div>
      <textarea
        data-testid="plan-intent-section-body"
        data-section-idx="${i}"
        data-section-heading="${s.heading || ''}"
        rows="${rows}"
        placeholder="${t('Intentie wordt automatisch gegenereerd…')}"
        readonly="${() => (locked() ? 'true' : false)}"
        class="w-full resize-y rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        @click="${(e) => {
          if (!e || !inTicket) return
          // stopPropagation FIRST (the nested-@click rule in
          // arrowjs-pitfalls.md), then take the keyboard to the ticket
          // column — `state.col = 0` is what the description block's own
          // click already did and this one forgot, so clicking the intent
          // field from a block column set col0Focus but never satisfied
          // intentCommentsColumnVisible()'s own `state.col === 0`.
          e.stopPropagation()
          state.col = 0
          state.col0Focus = 'intent'
        }}"
        @keydown="${(e) => {
          if (!e || !inTicket) return
          // Enter on the locked field is what unlocks it — never a
          // newline, so the first Enter can't also edit the text.
          if (e.key === 'Enter' && !e.shiftKey && !state.intentEditing) {
            e.preventDefault()
            e.stopPropagation()
            state.intentEditing = true
            return
          }
          // Escape locks it again; the page's own onKeydown blurs the
          // textarea right after (isEditableFocused branch), which is
          // also where the blur handler saves.
          if (e.key === 'Escape') state.intentEditing = false
        }}"
        @blur="${(e) => {
          if (!e) return
          if (inTicket) state.intentEditing = false
          save(e.target.closest('[data-testid="plan-intent-sections"]'))
        }}"
      >${s.body}</textarea
      >
    </div>
  `.key('intent-sec-' + place + '-' + i + ':' + (s.heading || '') + ' ' + s.body)
}

// intentField is the "Intentie" block — reviewer request: "in taak
// description eerste kolom moet de intentie zichtbaar zijn, maar dat moeten
// we ook kunnen aanpassen". Shows the CURRENT intent.md text (auto-generated
// via state.intentText, or the reviewer's own state.doc.intentOverride once
// they edited it) as one editable field PER SECTION (see parseIntentSections
// above) — each section's own markdown heading is a fixed label, only the
// text below it can be typed in, closer to a GitHub-style structured editor
// than one big free-form textarea (reviewer request, verbatim: "misschien dat
// de markdown titels niet aangepast kan worden, alleen de description
// daaronder, meer github markdown editor ofzo"). Same "static seed, save on
// blur" pattern as plan-task-note above, so a slow poll never clobbers a
// half-typed edit — and, stacking one field per section, the whole block
// reads noticeably taller than the old single 6-row textarea by itself,
// covering the reviewer's other request ("intentie hoger": the box's bottom
// edge moves down, its top edge/position is unchanged).
//
// Keyed on the loading state AND on where it renders (not on
// state.intentText/doc.updatedAt) so every section's static seed is set
// exactly ONCE per placement, right after the first real load — remounting on
// every later poll would wipe an in-progress edit, exactly the bug
// plan-task-note's own key discipline avoids. A REMOTE change (another
// tab/reviewer editing the same ticket at the same time) is a known, accepted
// gap, same as plan-task-note.
//
// The section LIST itself is its own `${() => intentSections().map(...)}`
// binding (never a static `.map()` inside this conditional template — the
// "fifth variant" pitfall in .claude/rules/arrowjs-pitfalls.md), so a section
// that only EXISTS later still appears: an intent that was still empty at
// first load (or was generated while the page was open) used to leave this
// block permanently blank until a collapse toggle or a reload. An
// already-mounted field keeps its own key and therefore its own seed, so this
// costs nothing for an edit in progress.
//
// TWO placements, one function (see intentInQuestionsColumn):
//
//   - 'questions' (stage intent) — top of the questions column, never
//     collapsed, directly typable. Writing the intent is stage 1's whole job,
//     so nothing should stand between the reviewer and the caret.
//   - 'ticket' (stage specs/plan) — the historical spot under the ticket
//     description, collapsed while the questions column has the keyboard
//     (reviewer request: "2e kolom mag dubbel breed en intent inklappen als ik
//     in vragen kolom zit"), and READ-ONLY until Enter unlocks it ("alleen
//     editbaar als je enter erop drukt"): by then the reviewer is answering
//     questions, and a stray keystroke in a passed stage should not silently
//     rewrite the intent. Click/Tab focuses, Enter unlocks, Escape and blur
//     lock it again. A click into any section body also selects this ticket
//     placement as `state.col0Focus = 'intent'` — see "A dedicated
//     Jira-opmerkingen column next to the ticket" in .claude/docs/plan-page.md.
//
// Collapsing hides only the sections, the header (label + reset button)
// stays, plus the WORD "ingeklapt" — and, in the ticket placement, the word
// "vergrendeld"/"bewerken" — never a colour alone, per the colourblind rule.
// Every one of those is a nested `${() => ...}` binding in its own stable
// `contents` root (never a bare toggling expression, see
// `.claude/rules/arrowjs-pitfalls.md`) so the outer node's key — and thus
// every section's one-time seed — is untouched by a col/lock change.
function intentField(place) {
  const loaded = !state.loading
  const inTicket = place === 'ticket'
  const collapsed = () => inTicket && state.col === 1
  const locked = () => inTicket && !state.intentEditing
  return html`
    <div
      class="${inTicket ? 'mt-3 border-t border-slate-100 pt-2 dark:border-zinc-800' : 'mb-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200 dark:bg-zinc-900 dark:ring-zinc-800'}"
      data-testid="plan-intent"
      data-intent-place="${place}"
      data-collapsed="${() => (collapsed() ? 'true' : 'false')}"
      data-locked="${() => (locked() ? 'true' : 'false')}"
    >
      <div class="mb-1 flex items-center justify-between">
        <span class="${LABEL}">${t('Intentie')}</span>
        <div class="flex items-center gap-1.5">
          <div class="contents">
            ${() =>
              collapsed()
                ? html`<span class="text-[10.5px] text-slate-400 dark:text-zinc-500" data-testid="plan-intent-collapsed-label"
                    >${t('ingeklapt')}</span
                  >`.key('intent-collapsed-label')
                : ''}
          </div>
          <div class="contents">
            ${() =>
              inTicket && !collapsed()
                ? html`<span class="text-[10.5px] text-slate-400 dark:text-zinc-500" data-testid="plan-intent-lock-label"
                    >${() => (state.intentEditing ? t('bewerken') : t('vergrendeld — Enter om te bewerken'))}</span
                  >`.key('intent-lock-label')
                : ''}
          </div>
          <div class="contents">
            ${() =>
              state.saving === INTENT_SAVE_ID
                ? html`<span class="text-[10.5px] text-slate-400 dark:text-zinc-500" data-testid="plan-intent-saving">${t('opslaan…')}</span>`.key(
                    'intent-saving',
                  )
                : ''}
          </div>
          <div class="contents">
            ${() =>
              state.doc.intentOverride
                ? html`<button
                    type="button"
                    data-testid="plan-intent-reset"
                    class="text-[10.5px] text-slate-400 underline hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                    @click="${(e) => {
                      e.stopPropagation()
                      sendIntentOverride('')
                    }}"
                  >
                    ${t('Terug naar automatisch gegenereerd')}
                  </button>`
                : ''}
          </div>
        </div>
      </div>
      <div class="contents">
        ${() =>
          collapsed()
            ? ''
            : html`<div class="flex flex-col" data-testid="plan-intent-sections">
                ${() => intentSections().map((s, i) => intentSectionBody(s, i, place, locked))}
              </div>`.key('sections')}
      </div>
    </div>
  `.key('intent:' + place + ':' + (loaded ? 'ready' : 'pending'))
}

// intentToSpecsHint answers the reviewer's own question ("in kolom 2 moet het
// duidelijk zijn hoe ik van intent naar specs ga"): a short, status-aware line
// directly under the intent field while stage 1 (intent) is active, saying in
// words what happens next — there is deliberately no button here, the
// transition to specs (spec.md) happens automatically as soon as the intent is
// complete (the gate answered, if there is one), see planWorkflow's own
// `planGenerate Mode:"all"` call in plan_workflow.go. `busyGenerating()` picks
// between "not yet" and "happening right now", the same signal `phaseRow`'s
// own "bezig" state and `planRunStatusWord`'s pill read.
function intentToSpecsHint() {
  return html`
    <p
      class="mb-3 rounded-xl bg-sky-50 px-3 py-2 text-[11.5px] leading-relaxed text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
      data-testid="plan-intent-to-specs-hint"
    >
      ${busyGenerating()
        ? t('Specs (de vragen hieronder) worden nu gegenereerd vanuit deze intentie…')
        : t('Specs worden automatisch gegenereerd zodra de intentie compleet is.')}
    </p>
  `.key('intent-to-specs-hint')
}

// PHASE_WORD is the reviewer-facing word of each phase. The WORD carries the
// meaning, never a colour on its own (Reindert is colourblind), and the glyph
// (a filled/open/checked shape) is a second, non-colour signal on top of it.
const PHASE_WORD = { intent: 'intent', specs: 'specs', plan: 'plan' }

// phaseRow is one of the three phases: its number, glyph, word and file name.
// The state is POSITIONAL — "klaar" for a phase behind us, "nu" for the one the
// plan is in, "nog niet" for one still ahead — told apart by SHAPE (✓/◆/○) and
// by that WORD, never by a colour (Reindert is colourblind). A phase still
// ahead whose file is nonetheless already on disk says "concept": plan.md is
// written as a draft as soon as there are tasks, while the spec is still being
// sharpened (see planHasPhaseContent vs planPhase in plan_artifacts.go).
//
// A FOURTH state, "bezig": reviewer report (screenshot) — with the phase card
// stuck reading "1. intent … nu" while Claude was already generating specs
// (busyGenerating() true; the same signal also drives the Plan run row's own
// "plan wordt opgesteld…" pill, see planRunStatusWord below), the phase
// directly AFTER the current one still read "nog niet" — indistinguishable
// from "nothing is happening yet". Only the phase immediately following
// `current` can ever be the one actually being generated right now (never two
// at once, never one further ahead), so `busy` is scoped to exactly
// `i === at + 1`. A distinct glyph (a fourth shape, not one of the other
// three) plus the word "bezig" — never colour alone.
function phaseRow(f, i, current) {
  const order = ['intent', 'specs', 'plan']
  const at = order.indexOf(current)
  const isNow = f.phase === current
  const done = i < at
  const busy = !isNow && !done && i === at + 1 && busyGenerating()
  const glyph = isNow ? '\u25c6' : done ? '\u2713' : busy ? '\u23f3' : '\u25cb'
  const word = isNow ? t('nu') : done ? t('klaar') : busy ? t('bezig') : f.exists ? t('concept') : t('nog niet')
  return html`
    <div
      class="flex items-baseline gap-1.5 rounded-md px-1 py-0.5 text-[11.5px] leading-snug"
      data-testid="plan-phase-row"
      data-phase="${f.phase}"
      data-phase-state="${isNow ? 'now' : done ? 'done' : busy ? 'busy' : 'todo'}"
    >
      <span class="w-3 shrink-0 text-slate-400 dark:text-zinc-500">${glyph}</span>
      <span class="${isNow ? 'font-semibold text-slate-900 dark:text-zinc-100' : 'text-slate-600 dark:text-zinc-300'}"
        >${i + 1 + '. ' + PHASE_WORD[f.phase]}</span
      >
      <span class="font-mono text-[10.5px] text-slate-400 dark:text-zinc-500">${f.file}</span>
      <span class="ml-auto shrink-0 text-[10.5px] text-slate-500 dark:text-zinc-400">${word}</span>
    </div>
  `.key('phase:' + f.phase)
}

// phaseCard shows which of the three planning stages this plan is in and where
// the files live (see plan_artifacts.go). Its own card in the first column,
// under the ticket — the phase is a property of the plan, not of a question.
function phaseCard() {
  const a = state.artifacts
  if (!a || !Array.isArray(a.files) || !a.files.length) return ''
  return html`
    <div
      class="mt-2 shrink-0 rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200 dark:bg-zinc-800 dark:ring-zinc-700"
      data-testid="plan-phase"
      data-phase-current="${a.phase}"
    >
      <div class="${LABEL + ' mb-1'}">${t('Fase') + ' \u2014 ' + PHASE_WORD[a.phase]}</div>
      <div class="flex flex-col gap-0.5">${() => (state.artifacts.files || []).map((f, i) => phaseRow(f, i, state.artifacts.phase))}</div>
      <div class="mt-1 break-all font-mono text-[10px] text-slate-400 dark:text-zinc-500" data-testid="plan-phase-dir">${a.dir}</div>
    </div>
  `
}

function ticketCard() {
  return html`
    <div
      class="${() => 'flex min-h-0 flex-1 flex-col ' + CARD + (state.col === 0 ? CARD_FOCUS : CARD_IDLE)}"
      data-testid="plan-ticket-card"
      @click="${() => {
        state.col = 0
        state.col0Focus = null
      }}"
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
      <div class="mt-2 flex shrink-0 items-center gap-1.5" data-testid="plan-assignee-row">
        <span class="${LABEL}">${t('Toegewezen aan')}</span>
        ${() => assigneeMark(state.doc.assignee, state.doc.assigneeAvatarUrl, 'h-6 w-6')}
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
      <div class="contents">
        ${() =>
          state.doc.baseBranch
            ? html`<div
                class="mt-2 flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[11.5px] text-slate-600 ring-1 ring-slate-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700"
                data-testid="plan-base-branch"
                >${(state.doc.hotfix ? '⚡ ' + t('Hotfix vanaf') : '◆ ' + t('Vanaf')) + ' ' + state.doc.baseBranch}</div
              >`
            : ''}
      </div>
      <div class="contents">${() => phaseCard()}</div>
      <div class="contents">
        ${() =>
          (state.doc.relatedPRs || []).length
            ? html`<div class="mt-2 shrink-0 rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200 dark:bg-zinc-800 dark:ring-zinc-700" data-testid="plan-related-prs">
                <div class="${LABEL + ' mb-1'}">${t('Al gemerged hierover')}</div>
                <div class="flex flex-col gap-1">
                  ${() => (state.doc.relatedPRs || []).map((pr) => relatedPRRow(pr))}
                </div>
              </div>`
            : ''}
      </div>
      <div class="contents">
        ${() =>
          (state.doc.referenced || []).length
            ? html`<div class="mt-2 shrink-0 rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200 dark:bg-zinc-800 dark:ring-zinc-700" data-testid="plan-referenced-issues">
                <div class="${LABEL + ' mb-1'}">${t('Gerelateerde tickets')}</div>
                <div class="flex flex-col gap-1">
                  ${() => (state.doc.referenced || []).map((r) => referencedIssueRow(r))}
                </div>
              </div>`
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
          <button
            type="button"
            title="${t('Chat over dit ticket')}"
            data-testid="plan-chat-button"
            class="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700"
            @click="${(e) => {
              e.stopPropagation()
              openPlanChat()
            }}"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5"
            >
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
            </svg>
          </button>
          <div class="relative">
            <button
              type="button"
              title="${t('Menu')}"
              data-testid="plan-menu-button"
              class="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 text-slate-500 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700"
              @click="${(e) => {
                e.stopPropagation()
                menu.open ? closeMenu() : openPlanMenu()
              }}"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="h-3.5 w-3.5"
              >
                <circle cx="12" cy="5" r="1.5"></circle>
                <circle cx="12" cy="12" r="1.5"></circle>
                <circle cx="12" cy="19" r="1.5"></circle>
              </svg>
            </button>
          </div>
          ${themeToggleButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
          ${settingsButton('h-7 w-7 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}
        </div>
      </div>
      <div
        class="mt-3 min-h-0 flex-1 overflow-auto"
        data-testid="plan-description"
        @click="${(e) => {
          e.stopPropagation()
          state.col = 0
          state.col0Focus = 'description'
        }}"
      >
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
      <div class="contents">${() => (intentInQuestionsColumn() ? '' : intentField('ticket'))}</div>
    </div>
  `
}

// ── The Taken block: the literal TasksPanel (RelatedPanel.mjs) ─────────────
// Reviewer request: "dit blokje met workflows, mag exact hetzelfde werken als
// in pr tree" — so this is no longer its own render, it is the SAME
// TasksPanel/buildTaskRows/workflowNote machinery the PR review tree uses,
// imported at the top of this file (a third deliberate exception to this
// page's "own code" rule — see "The Taken block is the literal TasksPanel" in
// .claude/docs/plan-page.md for the full mechanism and its accepted gaps).
//
// buildTaskRows reads two properties off whatever state object it's given:
// `state.workflows` (the live/idle runs, via visibleWorkflowRuns) and
// `state.pageProblems` (`{failedRuns, logErrors}`, the merged failure view).
// Neither exists on GET /api/plan's own shape, so syncTaskPanelState below
// derives both from what this page already has (state.runs, state.doc.error,
// busyGenerating()) and keeps them on `state` itself, reactively.

// planWorkflowsForPanel is `state.workflows`: state.runs, verbatim, except the
// ticket's own `plan` tracker run gets a client-computed `note` + a `running`
// status override while busyGenerating() is true — the gap right after an
// answer where generation is happening but the run's own stored status may
// not have visibly flipped yet (see busyGenerating's own doc comment).
// workflowNote (RelatedPanel.mjs) reads `run.note` first, before its own
// workflow/status table, exactly so this override works with no change to
// what "trouble" rows the tree itself ever produces.
//
// Reviewer report (task 52): pressing "meer vragen genereren"/"plan
// opstellen" gave no sense that anything had started — the Taken block IS
// meant to show this (that's the whole point of the override above), but two
// gaps made it read as "nothing happening" rather than "busy right now":
// `updatedAt` stayed at the run's OLD timestamp, so the row said e.g. "bezig"
// right next to "3 uur geleden" — a contradiction easy to dismiss as stale —
// and both actions shared one generic note, giving no link back to which
// button was just pressed. Both are fixed here: `updatedAt` is bumped to now
// on every override, and the note matches the row's own wording
// (followupWord/regenerateWord). A THIRD gap — no `plan` run in state.runs at
// all yet (the very first action on a fresh ticket, before ensureTracker's
// run has ever been polled back) — is covered by synthesizing one row instead
// of silently having nothing to override.
function busyGeneratingNote() {
  if (state.followupPending) return t('vragen worden bedacht…')
  if (state.regeneratePending) return t('nieuw plan wordt opgesteld…')
  return t('plan wordt opgesteld…')
}

function planWorkflowsForPanel() {
  const runs = state.runs || []
  if (!busyGenerating()) return runs
  const note = busyGeneratingNote()
  const nowIso = new Date().toISOString()
  let found = false
  const mapped = runs.map((run) => {
    if (run.workflow === 'plan' && run.status !== 'failed') {
      found = true
      return { ...run, status: 'running', note, updatedAt: nowIso }
    }
    return run
  })
  if (!found) mapped.push({ runId: 'plan-pending', workflow: 'plan', status: 'running', note, updatedAt: nowIso })
  return mapped
}

// planProblemsForPanel is `state.pageProblems`: this page has no repo-wide
// /api/problems equivalent (a plan ticket isn't a PR), so `logErrors` is
// always empty — only `failedRuns`, built from state.runs' own `failed`
// status PLUS the swallowed-generation-error case (planGenerate's Activity
// records the error onto the document instead of failing the Execution, see
// plan_workflow.go, so `run.status` alone never carries it). Only the `plan`
// tracker's own run is ever retryable, matching what retryPlanRun can resume.
//
// The swallowed-error entry is tagged `synthetic: true` — its run status was
// NEVER genuinely `failed` (the workflow is still `waiting`, parked back on
// its own Signal), unlike the first branch's real failure. retryPlanRun reads
// this to pick the right resume mechanism: a real failure resumes via the
// generic POST /api/workflows/retry (TaskManager.RetryRun, which requires the
// run to actually BE `failed`), while a synthetic one sends the plan_answer
// Signal's "retry" Kind instead — that endpoint would otherwise refuse it
// with "run is waiting, not failed" and silently do nothing (the reported
// bug: a parse-error'd generation had no way to be retried at all).
//
// The synthetic entry is deliberately suppressed while busyGenerating() is
// true: reported bug (task 46) — a follow-up round (or an answer, or "opnieuw
// plannen") starts a FRESH planGenerate call, planWorkflowsForPanel already
// flips this same run to `running`/"plan wordt opgesteld…" for exactly that
// gap, but state.doc.error still carries the PREVIOUS attempt's error until
// the next poll lands — and buildTaskRows (RelatedPanel.mjs) always prefers a
// failedRuns entry over the live one for the same runId. So the stale
// "mislukt" row kept hiding the running task for as long as the new attempt
// was in flight, and "vragen worden bedacht…" never showed as a task at all.
// Unaffected: retryPlanRun's own "↻ opnieuw gestart" row, which never sets
// busyGenerating() (it uses the separate taskUi.retrying/markTaskRetrying
// mechanism, RelatedPanel.mjs) and so keeps rendering from this same
// failedRuns branch throughout a retry click.
function planProblemsForPanel() {
  const failedRuns = []
  for (const run of state.runs || []) {
    const isPlan = run.workflow === 'plan'
    if (run.status === 'failed') failedRuns.push({ ...run, retryable: isPlan })
    else if (isPlan && state.doc.error && !busyGenerating())
      failedRuns.push({ ...run, status: 'failed', error: state.doc.error, retryable: true, synthetic: true })
  }
  return { failedRuns, logErrors: [] }
}

// syncTaskPanelState keeps state.workflows/state.pageProblems in step with
// every input that can change the merged view — not just a fresh poll
// (state.runs/state.doc.error), but also the optimistic local flags that flip
// busyGenerating() before the very next poll would otherwise notice (see the
// "watch — enumerate reactive deps INLINE" rule in arrowjs-pitfalls.md).
watch(
  () => [state.runs, state.doc.error, state.generating, state.scopePending, state.hotfixPending, state.followupPending, state.regeneratePending],
  () => {
    state.workflows = planWorkflowsForPanel()
    state.pageProblems = planProblemsForPanel()
  },
)

// refreshTasks — the panel's own ⟳ button, wired to the same poll everything
// else here already uses (mirrors home.mjs's refreshTasks, at the scale this
// page needs: one poll, not two).
async function refreshTasks() {
  setTasksRefreshBusy(true)
  try {
    await loadPlan()
  } finally {
    setTasksRefreshBusy(false)
  }
}

// openPlanTaskRowMenu — a click on any row. The tree's own openTaskRowMenu
// opens a whole native context menu; this page's Taken block only ever has
// ONE possible action (retry the ticket's own failed `plan` run), so a click
// runs that action directly rather than standing up a matching anchored-menu
// subsystem for a single item — deliberately simpler, see "The Taken block is
// the literal TasksPanel" in .claude/docs/plan-page.md.
function openPlanTaskRowMenu(row) {
  if (row && row.retryable && !row.retrying) retryPlanRun(row.runId, !!(row.run && row.run.synthetic))
}

function tasksCard() {
  return TasksPanel(state, {
    openRowMenu: openPlanTaskRowMenu,
    refresh: refreshTasks,
    subtitle: t('workflow-runs · dit ticket'),
  })
}

// ---------------------------------------------- column 2: questions + tasks

// optionRow is one answer option: the choice itself plus its own free-text
// field. `value` is a STATIC interpolation — filled in once, when the node is
// created, and only for the option that is already chosen (the document stores
// one answer, option + text, per question). A reactive value binding would
// overwrite whatever the reviewer is typing on the very next poll, and the
// row's key is stable so the field survives a re-render either way.
// optionInputKeydown is shared by optionRow's and ownOptionRow's own
// free-text field (both call it from their `@keydown`). Enter always saves
// and advances — "één enter = door" (see advanceToNextQuestion's own doc
// comment). ArrowUp/ArrowDown re-implement moveRow here because the
// document-level onKeydown bails out entirely while an editable element has
// focus (isEditableFocused()) — without this, arrowing through options would
// freeze solid the moment the first option's own field took focus (see
// syncOptionFocus). ArrowLeft/ArrowRight: reviewer request "escape eerst
// behalve als er niks getyped is" — an EMPTY field still lets ←/→ step
// columns (stepLeft/stepRight, blurring first so keyboard control fully
// returns to the document-level handler, exactly like Enter does); a field
// that already has typed text keeps ordinary caret movement, and Escape (the
// existing isEditableFocused() branch in onKeydown) is what hands ←/→ back.
function optionInputKeydown(e, q, o) {
  if (!e) return
  if (e.key === 'Enter') {
    e.stopPropagation()
    sendAnswer(q, o, e.target.value)
    e.target.blur()
    advanceToNextQuestion()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    moveRow(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    moveRow(-1)
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.value) {
    e.preventDefault()
    e.stopPropagation()
    e.target.blur()
    if (e.key === 'ArrowRight') stepRight()
    else stepLeft()
  }
}

function optionRow(row) {
  const { q, o } = row
  if (o.own) return ownOptionRow(row)
  return html`
    <div
      class="${() =>
        'rounded-lg border px-2.5 py-2 ' +
        // The cursor row keeps its ring while the keyboard is in a BLOCK
        // column: those columns show this very row's example code, so losing
        // the marker would leave nothing saying what they belong to. Only the
        // background tint follows the focus itself.
        // `&& state.col !== 0` — never show this ring while the TICKET card
        // (column 0) itself has the focus: without it, a stale cursor left
        // on an option/task row from an earlier column visit kept its ring
        // even after `←` moved the keyboard back to the ticket, showing two
        // "selected" things on screen at once (reviewer report, see "Never
        // two selections visible at once" in .claude/docs/plan-page.md).
        (state.cur === o.id && state.col !== 0
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
        focusColumn1()
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
        @keydown="${(e) => optionInputKeydown(e, q, o)}"
        @focus="${() => {
          state.cur = o.id
          focusColumn1()
        }}"
      />
      <div class="contents">
        ${() =>
          state.saving === o.id ? html`<p class="mt-1 text-[10.5px] text-slate-400 dark:text-zinc-500">${t('opslaan…')}</p>` : ''}
      </div>
    </div>
  `.key('opt:' + o.id)
}

// ownOptionRow is the always-present, generated-content-free last choice of
// every question (reviewer request: "altijd een laatste optie met alleen
// input velden") — unlike a real option there is no label/detail to show,
// since the reviewer's own free text IS the entire answer, so the row is
// just the selection glyph plus its input field. Same selection/chosen/
// saving mechanics as optionRow otherwise.
function ownOptionRow(row) {
  const { q, o } = row
  return html`
    <div
      class="${() =>
        'rounded-lg border px-2.5 py-2 ' +
        (state.cur === o.id && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10 ' : '')
          : 'border-slate-200 dark:border-zinc-800 ') +
        (isChosen(q, o) ? 'bg-emerald-50/60 dark:bg-emerald-500/10' : '')}"
      data-testid="plan-option"
      data-option-id="${o.id}"
      data-own-option="true"
      data-cursor="${() => (state.cur === o.id ? 'true' : 'false')}"
      data-chosen="${() => (isChosen(q, o) ? 'true' : 'false')}"
      @click="${() => {
        state.cur = o.id
        focusColumn1()
        state.path = [0]
      }}"
    >
      <div class="flex items-center gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-500 dark:text-zinc-400">${() => (isChosen(q, o) ? '●' : '○')}</span>
        <div class="contents">
          ${() =>
            isChosen(q, o)
              ? html`<span
                  class="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
                  >${t('gekozen')}</span
                >`
              : ''}
        </div>
        <input
          type="text"
          placeholder="${t('eigen antwoord…')}"
          value="${isChosen(q, o) ? answerTextFor(q.id) : ''}"
          data-testid="plan-option-input"
          class="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          @keydown="${(e) => optionInputKeydown(e, q, o)}"
          @focus="${() => {
            state.cur = o.id
            focusColumn1()
          }}"
        />
      </div>
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
  // Who owns this choice — the whole point of task 24: the reviewer decides
  // what to plan partly on who is already on it. Shown for the main task as
  // well as for every subtask, also when that is himself; unassigned reads as
  // a question-mark circle plus the word (see assigneeMark).
  const assignee = isParent ? state.doc.assignee || '' : row.subtask.assignee || ''
  const assigneeAvatar = isParent ? state.doc.assigneeAvatarUrl || '' : row.subtask.assigneeAvatarUrl || ''
  return html`
    <div
      class="${() =>
        'cursor-pointer rounded-lg border px-2.5 py-2 ' +
        (state.cur === row.id && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-scope-option"
      data-scope-target="${isParent ? 'parent' : 'subtask'}"
      data-scope-key="${key}"
      data-cursor="${() => (state.cur === row.id ? 'true' : 'false')}"
      @click="${() => {
        state.cur = row.id
        focusColumn1()
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
        ${assigneeMark(assignee, assigneeAvatar, 'h-5 w-5')}
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
//
// It renders only the SCOPE rows of navRows(): that list also carries the
// Jira-comments row (COMMENTS_ROW_ID, present whenever this ticket has
// comments), which has no `subtask` of its own — without the filter scopeRow
// threw on it on every render, and invisibly so, because LOCAL PATCH 5
// catches a throwing reactive effect and only console.error's it (see
// .claude/rules/arrowjs-pitfalls.md).
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
      <div class="flex flex-col gap-1.5">${() => navRows().filter((r) => r.kind === 'scope').map((r) => scopeRow(r))}</div>
    </section>
  `.key('scope-card')
}

// hotfixRow is one choice of the base-branch question: from the hotfix branch, from
// the ordinary base branch, or another branch entirely. Same shape as
// scopeRow — a glyph plus a WORD, never a colour on its own.
function hotfixRow(row) {
  const branch = row.target === 'yes' ? state.doc.hotfixBranch || 'master' : row.target === 'no' ? state.doc.defaultBranch || 'develop' : ''
  const title =
    row.target === 'yes'
      ? t('Ja, hotfix') + ' — ' + branch
      : row.target === 'no'
        ? t('Nee, gewoon') + ' — ' + branch
        : t('Vanaf een andere branch…')
  const why =
    row.target === 'yes'
      ? t('Rechtstreeks naar productie: het plan blijft zo klein en risicoloos mogelijk.')
      : row.target === 'no'
        ? t('De gewone route, mee met de eerstvolgende release.')
        : t('Kies zelf een branch; jouw eigen branches staan bovenaan.')
  return html`
    <div
      class="${() =>
        'cursor-pointer rounded-lg border px-2.5 py-2 ' +
        (state.cur === row.id && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-hotfix-option"
      data-hotfix-target="${row.target}"
      data-cursor="${() => (state.cur === row.id ? 'true' : 'false')}"
      @click="${(e) => {
        if (e) e.stopPropagation()
        state.cur = row.id
        focusColumn1()
        chooseHotfix(row)
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="shrink-0 font-mono text-[12px] text-slate-500 dark:text-zinc-400"
          >${row.target === 'yes' ? '⚡' : row.target === 'no' ? '◆' : '⌥'}</span
        >
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium leading-snug text-slate-900 dark:text-zinc-100">${title}</div>
          <p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">${why}</p>
        </div>
      </div>
      <div class="contents">
        ${() => (state.saving === row.id ? html`<p class="mt-1 text-[10.5px] text-slate-400 dark:text-zinc-500">${t('opslaan…')}</p>` : '')}
      </div>
      <div class="contents">${() => (row.target === 'other' && state.branchOpen ? [branchPicker()] : [])}</div>
    </div>
  `.key('hotfix:' + row.id)
}

// branchPicker is the third choice unfolded: a search field over the repo's own
// branches, the reviewer's own first (GET /api/branches already ordered them).
// A row says "van jou" in words next to its own last-commit date — never a
// colour carrying that meaning. The search field has NO reactive value binding:
// the list below it is what reacts, and re-setting the attribute on every
// keystroke would fight the caret.
function branchPicker() {
  return html`
    <div
      class="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/60"
      data-testid="plan-branch-picker"
    >
      <input
        type="text"
        autofocus
        placeholder="${t('zoek een branch…')}"
        data-testid="plan-branch-search"
        class="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        @input="${(e) => e && (state.branchQuery = e.target.value)}"
        @click="${(e) => e && e.stopPropagation()}"
        @keydown="${(e) => {
          if (!e) return
          e.stopPropagation()
          if (e.key === 'Escape') {
            state.branchOpen = false
            e.target.blur()
          } else if (e.key === 'Enter') {
            const first = visibleBranches()[0]
            if (first) chooseBranch(first.name)
          }
        }}"
      />
      <div class="mt-1.5 max-h-56 overflow-y-auto">
        ${() =>
          state.branchLoading
            ? [html`<p class="px-1 py-1 text-[11.5px] italic text-slate-400 dark:text-zinc-500">${t('branches laden…')}</p>`.key('branches-loading')]
            : visibleBranches().length
              ? visibleBranches().map((b) => branchRow(b))
              : [html`<p class="px-1 py-1 text-[11.5px] italic text-slate-400 dark:text-zinc-500">${t('geen branch gevonden')}</p>`.key('branches-empty')]}
      </div>
    </div>
  `.key('branch-picker')
}

// branchRow is one branch in that dropdown.
function branchRow(b) {
  return html`
    <div
      class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-white dark:hover:bg-zinc-900"
      data-testid="plan-branch-option"
      data-branch="${b.name}"
      @click="${(e) => {
        if (e) e.stopPropagation()
        chooseBranch(b.name)
      }}"
    >
      <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-700 dark:text-zinc-200">${b.name}</span>
      <div class="contents">
        ${() =>
          b.own
            ? html`<span
                class="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30"
                >${t('van jou')}</span
              >`
            : ''}
      </div>
      <div class="contents">
        ${() => (b.updated ? html`<span class="shrink-0 text-[10px] text-slate-400 dark:text-zinc-500">${b.updated}</span>` : '')}
      </div>
    </div>
  `.key('branch:' + b.name)
}

// hotfixCard is the whole question — the only thing column 2 shows while it
// stands, exactly like scopeCard. It renders only the HOTFIX rows of
// navRows(): that list also carries the Jira-comments row (COMMENTS_ROW_ID,
// present whenever this ticket has comments), which has no `target` of its
// own — without the filter it rendered as a phantom "Vanaf een andere
// branch…" row (hotfixRow's fallback branch for an unset target), and
// because its id was the SAME as the real comments row, it also picked up
// that row's own selection ring: two rings visible at once (reviewer
// report, see "Never two selections visible at once" in
// .claude/docs/plan-page.md). Same fix scopeCard already applies to its own
// rows for the same reason.
function hotfixCard() {
  return html`
    <section class="${CARD + CARD_IDLE}" data-testid="plan-hotfix">
      <div class="mb-2 flex items-start gap-2">
        <span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-semibold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
          >${t('Eerst dit')}</span
        >
        <h2 class="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-slate-900 dark:text-zinc-100">
          ${t('Vanaf welke branch gaat dit?')}
        </h2>
      </div>
      <p class="mb-2 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">
        ${t('De keuze bepaalt waar de werkmap vandaan vertakt en tegen welke branch de draft-PR komt te staan.')}
      </p>
      <div class="flex flex-col gap-1.5">${() => navRows().filter((r) => r.kind === 'hotfix').map((r) => hotfixRow(r))}</div>
    </section>
  `.key('hotfix-card')
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

// TASK_DETAILS is the concrete half of a task, in the order it reads best:
// where it lands, every condition, every config, the migration, the endpoints,
// the error handling, the rollout/rollback, the edge cases and what is
// explicitly out of scope (reviewer request: "elke if statement moet in de
// plan, elke config ook"). Each entry is [field, label, kind]; a "list" field
// is an array, a "text" field a string. A field the model left empty is not
// rendered at all — an empty labelled row says nothing and costs a line.
const TASK_DETAILS = [
  ['location', 'Waar', 'text'],
  ['conditions', 'Voorwaarden', 'list'],
  ['config', 'Config', 'list'],
  ['migration', 'Migratie', 'text'],
  ['endpoints', 'Endpoints', 'list'],
  ['errors', 'Foutafhandeling', 'text'],
  ['rollout', 'Uitrol/terugdraaien', 'text'],
  ['edgeCases', 'Randgevallen', 'list'],
  ['outOfScope', 'Buiten scope', 'list'],
]

// taskDetailRows renders those fields as one labelled line each. The LABEL
// carries the meaning (never a colour on its own, per the colourblind rule),
// and a list is joined into that same line so a task stays one readable block
// instead of a nested tree.
function taskDetailRows(task) {
  return TASK_DETAILS.map(([field, label, kind]) => {
    const raw = task[field]
    const text = kind === 'list' ? (Array.isArray(raw) ? raw.filter(Boolean).join(' · ') : '') : (raw || '').trim()
    if (!text) return null
    return html`
      <div class="flex gap-1.5 text-[11.5px] leading-snug" data-testid="plan-task-detail" data-detail="${field}">
        <span class="shrink-0 font-medium text-slate-400 dark:text-zinc-500">${t(label)}</span>
        <span class="min-w-0 flex-1 text-slate-600 dark:text-zinc-400">${text}</span>
      </div>
    `.key('detail:' + task.id + ':' + field)
  }).filter(Boolean)
}

function taskRow(row) {
  const task = row.task
  return html`
    <div
      class="${() =>
        'rounded-lg border px-2.5 py-2 ' +
        (state.cur === task.id && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-task"
      data-task-id="${task.id}"
      data-task-enabled="${() => (taskEnabled(task) ? 'true' : 'false')}"
      data-cursor="${() => (state.cur === task.id ? 'true' : 'false')}"
      @click="${() => {
        state.cur = task.id
        focusColumn1()
        state.path = [0]
      }}"
    >
      <div class="flex items-start gap-2">
        <span class="w-5 shrink-0 pt-0.5 text-right font-mono text-[12px] text-slate-400 dark:text-zinc-500">${row.ti + 1}.</span>
        <label
          class="flex shrink-0 cursor-pointer items-center pt-0.5"
          @click="${(e) => {
            if (e && e.stopPropagation) e.stopPropagation()
          }}"
        >
          <input
            type="checkbox"
            data-testid="plan-task-check"
            checked="${() => taskEnabled(task)}"
            class="h-3.5 w-3.5 shrink-0 accent-indigo-600"
            @change="${() => {
              state.cur = task.id
              focusColumn1()
              toggleTask(task)
            }}"
          />
        </label>
        <div class="min-w-0 flex-1">
          <div
            class="${() =>
              'text-[13px] font-medium leading-snug ' +
              (taskEnabled(task) ? 'text-slate-900 dark:text-zinc-100' : 'text-slate-400 line-through dark:text-zinc-500')}"
          >
            ${task.title}
          </div>
          <div class="contents">
            ${() =>
              task.explanation
                ? html`<p class="mt-0.5 text-[12px] leading-relaxed text-slate-500 dark:text-zinc-400">${task.explanation}</p>`
                : ''}
          </div>
          <div class="mt-1 flex flex-col gap-0.5">${() => taskDetailRows(task)}</div>
          <input
            type="text"
            placeholder="${t('eigen aanvulling bij deze taak…')}"
            value="${taskNoteFor(task)}"
            data-testid="plan-task-note"
            class="mt-1.5 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            @keydown="${(e) => {
              if (!e) return
              if (e.key === 'Enter') {
                e.stopPropagation()
                sendTaskState(task, !taskEnabled(task), e.target.value)
                e.target.blur()
              }
            }}"
            @blur="${(e) => {
              if (!e) return
              if ((e.target.value || '') !== taskNoteFor(task)) sendTaskState(task, !taskEnabled(task), e.target.value)
            }}"
            @focus="${() => {
              state.cur = task.id
              focusColumn1()
            }}"
          />
          <div class="contents">
            ${() => (state.saving === task.id ? html`<p class="mt-1 text-[10.5px] text-slate-400 dark:text-zinc-500">${t('opslaan…')}</p>` : '')}
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

// executeCard also names the WERKMAP the newest attempt ran in: the reviewer's
// own local checkout, picked through the review tree's own selection ladder
// (plan_execute.go's resolvePlanWorkDir), never a throwaway worktree any more.
function executeCard(row) {
  return html`
    <div
      class="${() =>
        'mt-3 rounded-lg border px-2.5 py-2 ' +
        (state.cur === EXEC_ROW_ID && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-execute"
      data-cursor="${() => (state.cur === EXEC_ROW_ID ? 'true' : 'false')}"
      @click="${() => {
        state.cur = EXEC_ROW_ID
        focusColumn1()
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
          focusColumn1()
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
            ? html`<p class="mt-1 truncate font-mono text-[11px] text-slate-400 dark:text-zinc-500" data-testid="plan-execute-branch">
                ${state.exec.branch + (state.exec.base ? ' → ' + state.exec.base : '')}
              </p>`
            : ''}
      </div>
      <div class="contents">
        ${() =>
          state.exec && state.exec.dir
            ? html`<p
                class="mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-zinc-500"
                data-testid="plan-execute-dir"
              >
                ${t('werkmap')}: ${state.exec.dir}
              </p>`
            : ''}
      </div>
    </div>
  `.key('exec:' + (row ? row.id : EXEC_ROW_ID))
}

// followupCard is the row that asks the tracker for MORE questions (reviewer
// request: "maak het mogelijk om vervolg vragen te genereren om je plan te
// perfectioneren"). Its state is spelled out in WORDS, never a colour on its
// own — the colourblind rule, exactly like the execute card below.
function followupWord() {
  if (state.followupPending || state.saving === FOLLOWUP_ROW_ID) return t('vragen worden bedacht…')
  if (state.generating) return t('bezig…')
  return t('meer vragen genereren')
}

function followupCard() {
  return html`
    <section
      class="${() =>
        'mb-3 cursor-pointer rounded-2xl border px-3 py-2 ' +
        (state.cur === FOLLOWUP_ROW_ID && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-followup"
      data-cursor="${() => (state.cur === FOLLOWUP_ROW_ID ? 'true' : 'false')}"
      @click="${() => {
        state.cur = FOLLOWUP_ROW_ID
        focusColumn1()
        sendFollowup()
      }}"
    >
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 text-[13px] font-medium text-slate-900 dark:text-zinc-100">${t('Vervolgvragen om het plan te perfectioneren')}</span>
        <button
          type="button"
          class="shrink-0 rounded-md bg-indigo-500 px-2.5 py-1 text-[10.5px] font-medium text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="plan-followup-state"
          disabled="${() => busyGenerating() || !!state.saving}"
          @click="${(e) => {
            e.stopPropagation()
            state.cur = FOLLOWUP_ROW_ID
            focusColumn1()
            sendFollowup()
          }}"
          >${() => followupWord()}</button
        >
      </div>
      <p class="mt-0.5 text-[11.5px] leading-relaxed text-slate-500 dark:text-zinc-400">
        ${t('Claude stelt nieuwe vragen op basis van je antwoorden en stelt daarna de takenlijst opnieuw op.')}
      </p>
    </section>
  `.key('followup')
}

// regenerateCard is the row next to followupCard that asks the tracker to
// discard the current plan and generate a brand new one from scratch
// (reviewer request: two buttons here — "vervolgvragen genereren" of "plan
// opstellen [opnieuw]" — see .claude/docs/plan-page.md). Its own row/id,
// mirroring followupCard's own shape exactly, so it is a genuine keyboard
// stop with its own cursor, not a second button bolted onto the follow-up
// card.
function regenerateWord() {
  if (state.regeneratePending || state.saving === REGENERATE_ROW_ID) return t('nieuw plan wordt opgesteld…')
  if (state.generating) return t('bezig…')
  return t('plan opstellen')
}

function regenerateCard() {
  return html`
    <section
      class="${() =>
        'mb-3 cursor-pointer rounded-2xl border px-3 py-2 ' +
        (state.cur === REGENERATE_ROW_ID && state.col !== 0
          ? 'border-indigo-300 ring-2 ring-inset ring-indigo-400 dark:border-indigo-500 dark:ring-indigo-500 ' +
            (state.col === 1 ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : '')
          : 'border-slate-200 dark:border-zinc-800')}"
      data-testid="plan-regenerate"
      data-cursor="${() => (state.cur === REGENERATE_ROW_ID ? 'true' : 'false')}"
      @click="${() => {
        state.cur = REGENERATE_ROW_ID
        focusColumn1()
        sendRegenerate()
      }}"
    >
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 text-[13px] font-medium text-slate-900 dark:text-zinc-100">${t('Plan opnieuw opstellen')}</span>
        <button
          type="button"
          class="shrink-0 rounded-md bg-indigo-500 px-2.5 py-1 text-[10.5px] font-medium text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="plan-regenerate-state"
          disabled="${() => busyGenerating() || !!state.saving}"
          @click="${(e) => {
            e.stopPropagation()
            state.cur = REGENERATE_ROW_ID
            focusColumn1()
            sendRegenerate()
          }}"
          >${() => regenerateWord()}</button
        >
      </div>
      <p class="mt-0.5 text-[11.5px] leading-relaxed text-slate-500 dark:text-zinc-400">
        ${t('Het huidige plan (vragen en taken) wordt weggegooid en Claude stelt een volledig nieuw plan op.')}
      </p>
    </section>
  `.key('regenerate')
}

function tasksSection() {
  return html`
        <section class="${CARD + CARD_IDLE}" data-testid="plan-tasks">
          <div class="mb-2 flex items-center gap-2">
            <span class="${LABEL}">${t('Plan')}</span>
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

// -------------------------------------------- Jira comments panel (23b)

// COMMENT_RELATION_WORD is the word next to a group's key — never a colour
// alone, per the colourblind rule (Reindert).
const COMMENT_RELATION_WORD = { self: t('dit ticket'), parent: t('hoofdtaak'), subtask: t('subtaak') }

// commentMentionPicker is the @-suggestion dropdown, shown right under the
// composer while state.commentMentionQuery is non-empty.
function commentMentionPicker() {
  return html`
    <div
      class="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
      data-testid="plan-comment-mention-picker"
    >
      ${() =>
        state.commentMentionLoading
          ? html`<p class="px-2 py-1 text-[11px] italic text-slate-400 dark:text-zinc-500">${t('zoeken…')}</p>`.key('m-loading')
          : ''}
      <div class="contents">
        ${() =>
          !state.commentMentionLoading && !state.commentMentionResults.length
            ? [html`<p class="px-2 py-1 text-[11px] italic text-slate-400 dark:text-zinc-500">${t('geen mensen gevonden')}</p>`.key('m-empty')]
            : []}
      </div>
      ${() =>
        state.commentMentionResults.map(
          (u) => html`
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-indigo-50 dark:text-zinc-200 dark:hover:bg-indigo-500/10"
              data-testid="plan-comment-mention-item"
              @click="${() => pickCommentMention(u)}"
            >
              ${avatarHTML(u.displayName, u.avatarUrl, 'h-4 w-4')}
              <span>${u.displayName}</span>
            </button>
          `.key('m:' + u.accountId),
        )}
    </div>
  `
}

// commentReplyComposer is one group's own reply field — only rendered while
// state.commentReplyKey equals that group's key (single-composer discipline).
function commentReplyComposer(group) {
  return html`
    <div class="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/60" data-testid="plan-comment-composer">
      <textarea
        rows="2"
        placeholder="${t('Typ een antwoord… (@ om iemand te noemen)')}"
        data-testid="plan-comment-reply-input"
        class="w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        @input="${(e) => onCommentReplyInput(e)}"
        @keydown="${(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') closeCommentReply()
        }}"
      ></textarea>
      <div class="contents">${() => (state.commentMentionQuery ? commentMentionPicker() : '')}</div>
      <div class="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          class="rounded-md bg-indigo-500 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="plan-comment-reply-send"
          disabled="${() => state.commentSending === group.key}"
          @click="${() => sendCommentReply(group.key)}"
        >
          ${() => (state.commentSending === group.key ? t('versturen…') : t('Versturen'))}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-700"
          @click="${() => closeCommentReply()}"
        >
          ${t('Annuleren')}
        </button>
        <div class="contents">
          ${() =>
            state.commentSendError
              ? html`<span class="text-[11px] text-rose-600 dark:text-rose-400">${state.commentSendError}</span>`.key('send-err')
              : ''}
        </div>
      </div>
    </div>
  `
}

// commentRow's own id is what the keyboard cursor and a direct click both
// walk by — commentId's group-key + comment-id/created/index shape (see
// above). data-comment-cursor is a SEPARATE marker from the top-level
// navRows() data-cursor, so scrollCommentCursorIntoView never picks up a
// stray top-level row.
function commentRow(c, groupKey, i) {
  const id = commentId(groupKey, c, i)
  // active is the RING — where ↑/↓ currently is. A comment's own text is
  // ALWAYS shown in full, never clamped: "collapsing" this page's comments is
  // a PANEL-level concern now (see "Collapsed by default" below), not a
  // per-comment one.
  const active = () => commentsActive() && state.commentCursor === id
  return html`
    <div
      class="${() =>
        'rounded-md py-1.5 px-1.5 -mx-1.5 border-t border-slate-100 first:border-t-0 dark:border-zinc-800 ' +
        (active() ? 'ring-2 ring-inset ring-indigo-400 bg-indigo-50/50 dark:ring-indigo-500 dark:bg-indigo-500/10' : '')}"
      data-testid="plan-comment-row"
      data-comment-cursor="${() => (active() ? 'true' : 'false')}"
      @click="${(e) => {
        e.stopPropagation()
        enterCommentsFocus(id)
      }}"
    >
      <div class="flex items-start gap-2">
        ${avatarHTML(c.author, c.avatarUrl, 'h-5 w-5')}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400">
            <span class="font-medium text-slate-700 dark:text-zinc-200">${c.author || t('onbekend')}</span>
            <span title="${c.created || ''}">${relativeTime(c.created)}</span>
          </div>
          <div
            class="markdown-body mt-0.5 text-[12px] leading-relaxed text-slate-700 dark:text-zinc-300"
            data-testid="plan-comment-body"
            .innerHTML="${() => renderMarkdown(c.body || '')}"
          ></div>
        </div>
      </div>
    </div>
  `.key('c:' + id)
}

// commentGroupCard is one ticket's own block: header (key + relation word +
// external link), its comments, and the reply toggle/composer.
function commentGroupCard(group) {
  const comments = Array.isArray(group.comments) ? group.comments : []
  return html`
    <div class="mb-2 rounded-lg border border-slate-200 p-2.5 dark:border-zinc-800" data-testid="plan-comment-group" data-group-key="${group.key}">
      <div class="flex items-center gap-2">
        <a
          href="${group.url || JIRA_BASE + group.key}"
          target="_blank"
          rel="noreferrer"
          class="font-mono text-[11.5px] font-semibold text-indigo-600 hover:underline dark:text-indigo-300"
          >${group.key}</a
        >
        <span
          class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
          >${COMMENT_RELATION_WORD[group.relation] || group.relation}</span
        >
        <span class="min-w-0 flex-1 truncate text-[11.5px] text-slate-500 dark:text-zinc-400">${group.title || ''}</span>
        <span class="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
          >${comments.length}</span
        >
      </div>
      <div class="contents">
        ${() =>
          comments.length
            ? comments.map((c, i) => commentRow(c, group.key, i))
            : [html`<p class="py-1 text-[11.5px] italic text-slate-400 dark:text-zinc-500">${t('geen opmerkingen')}</p>`.key('empty:' + group.key)]}
      </div>
      <div class="contents">
        ${() =>
          state.comments.canPost && state.commentReplyKey !== group.key
            ? html`<button
                type="button"
                class="mt-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
                data-testid="plan-comment-reply-toggle"
                @click="${() => openCommentReply(group.key)}"
              >
                ${t('Beantwoorden')}
              </button>`
            : ''}
      </div>
      <div class="contents">${() => (state.commentReplyKey === group.key ? commentReplyComposer(group) : '')}</div>
    </div>
  `.key('cg:' + group.key)
}

// commentsPanel sits at the TOP of the questions index (kolom 2), per
// Reindert's own instruction. Always shown, independent of the scope/hotfix
// gate — reading a ticket's comments is useful before a plan exists too.
//
// It is a stop of its own in the → chain, exactly like an option/task row
// (see COMMENTS_ROW_ID / isCommentsRowSelected / commentsActive above): a
// plain → (or a click on the panel's own background) selects the WHOLE
// block, Enter (or a click on one comment, see commentRow) hands ↑/↓ to the
// comments themselves. The two selection levels are told apart in WORDS
// (the "blok geselecteerd"/"opmerking actief" badge below), never by ring
// colour alone — the colourblind rule — and are mutually exclusive so only
// one ring ever shows (isCommentsRowSelected() && !commentsFocused for the
// whole card, commentsActive() for one row inside it).
//
// Collapsed by default (reviewer request, task 48b, correcting an earlier,
// wrong reading of "opmerkingen inklappen": *"niet verticaal inklappen …
// comments moeten horizontaal inklappen tot 2,5 laatste comments … breedte
// blijft altijd hetzelfde"*) — this is a HEIGHT-only fold, over the WHOLE
// flattened list (not per ticket/group), never a width change and never a
// per-comment text clamp any more (see commentRow — a comment's own body is
// always shown in full). `COMMENTS_COLLAPSED_CLS` caps the list's height at
// roughly 2.5 short comments (`max-h-[…]`, necessarily an approximation —
// an individual comment's real height varies with its text) and bottom-
// anchors the content (`flex flex-col justify-end`) so it's the NEWEST
// comments that stay visible and the older ones that scroll out of view at
// the top — a `max-h` (not a fixed height) so a short list that already fits
// is never padded with blank space. `.plan-comments-fade-top` (`plan.html`)
// softens the cut edge, the mirror of the existing `.code-fence-fade-bottom`
// mask facing the opposite direction. `commentsListExpanded()` reuses
// `commentsFocused` itself — the exact same action that hands ↑/↓ to the
// comments (Enter on the block, or a click on one, see commentRow) is what
// reveals the full history, and leaving that mode (←) is exactly when it
// should fold back down — so no new state was needed for this. A discrete
// `plan-comments-expand-hint` button underneath names the same action in
// words (never relying on the fade alone), but only once there's enough
// comments for the fold to plausibly be hiding anything
// (`COMMENTS_COLLAPSE_HINT_MIN`).
function commentsPanel() {
  return html`
    <section
      class="${() => CARD + ' mb-3 ' + (isCommentsRowSelected() && !commentsActive() ? CARD_FOCUS : CARD_IDLE)}"
      data-testid="plan-comments-panel"
      data-cursor="${() => (state.cur === COMMENTS_ROW_ID ? 'true' : 'false')}"
      @click="${() => selectCommentsRow()}"
    >
      <div class="mb-1.5 flex items-center gap-2">
        <span class="${LABEL}">${t('Jira-opmerkingen')}</span>
        <div class="contents">
          ${() =>
            isCommentsRowSelected()
              ? html`<span
                  class="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30"
                  data-testid="plan-comments-state"
                  >◆ ${commentsActive() ? t('opmerking actief') : t('blok geselecteerd')}</span
                >`
              : ''}
        </div>
        <button
          type="button"
          class="ml-auto rounded-md px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-700"
          data-testid="plan-comments-refresh"
          disabled="${() => state.comments.loading}"
          @click="${(e) => {
            e.stopPropagation()
            loadComments(true)
          }}"
        >
          ${() => (state.comments.loading ? t('laden…') : t('Ververs'))}
        </button>
      </div>
      <div class="contents">
        ${() =>
          !state.comments.canPost && state.comments.loaded
            ? html`<p class="mb-1.5 text-[11px] italic text-slate-400 dark:text-zinc-500">
                ${t('Antwoorden vereist een Jira API-token (SLASH_JIRA_EMAIL/SLASH_JIRA_TOKEN).')}
              </p>`.key('no-token')
            : ''}
      </div>
      <div class="contents">
        ${() =>
          state.comments.error
            ? html`<p class="mb-1.5 text-[11.5px] text-rose-600 dark:text-rose-400">${state.comments.error}</p>`.key('c-error')
            : ''}
      </div>
      <div
        class="${() =>
          'flex flex-col overflow-hidden ' + (commentsListExpanded() ? '' : COMMENTS_COLLAPSED_CLS)}"
        data-testid="plan-comments-list"
        data-collapsed="${() => (commentsListExpanded() ? 'false' : 'true')}"
      >
        ${() =>
          !state.comments.loaded
            ? [html`<p class="text-[12px] italic text-slate-400 dark:text-zinc-500">${t('laden…')}</p>`.key('c-loading')]
            : state.comments.groups.map((g) => commentGroupCard(g))}
      </div>
      <div class="contents">
        ${() =>
          !commentsListExpanded() && commentFlatList().length > COMMENTS_COLLAPSE_HINT_MIN
            ? html`<button
                type="button"
                class="mt-1 w-full rounded-md py-1 text-center text-[10.5px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
                data-testid="plan-comments-expand-hint"
                @click="${(e) => {
                  e.stopPropagation()
                  enterCommentsFocus()
                }}"
              >
                ${t('Toon alle opmerkingen (Enter)')}
              </button>`.key('expand-hint')
            : ''}
      </div>
    </section>
  `
}

// questionsColumn holds ONE Jira-opmerkingen panel at a time: while the
// dedicated column next to the ticket is up (intentCommentsColumnVisible),
// this copy stands down. Both rendering at once put the same panel twice on
// screen, side by side, and — worse — gave the single-composer machinery two
// `plan-comment-reply-input` fields, of which openCommentReply/
// sendCommentReply's document.querySelector only ever sees the FIRST (the
// dedicated column, which comes earlier in the DOM), so a reply typed in this
// one was never read back.
function questionsColumn() {
  return html`
    <div
      class="${() => 'flex shrink-0 flex-col ' + (state.col === 1 ? 'w-[62rem]' : 'w-[27rem]')}"
      data-testid="plan-questions-column"
      data-column-focused="${() => (state.col === 1 ? 'true' : 'false')}"
      @click="${() => focusColumn1()}"
    >
      ${columnHeader(t('Vragen over het plan'), () => state.col === 1)}
      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        <div class="contents">${() => (intentInQuestionsColumn() ? [intentField('questions')] : [])}</div>
        <div class="contents">${() => (intentInQuestionsColumn() ? [intentToSpecsHint()] : [])}</div>
        <div class="contents">${() => (intentCommentsColumnVisible() ? [] : [commentsPanel()])}</div>
        ${() => (gateOpen() ? [] : (state.doc.questions || []).map((q, qi) => questionCard(q, qi)))}
        ${() =>
          !gateOpen() && !state.loading && !(state.doc.questions || []).length
            ? [
                html`<p class="mb-3 rounded-2xl border border-dashed border-slate-300 p-4 text-[12.5px] italic text-slate-400 dark:border-zinc-700 dark:text-zinc-500">
                  ${busyGenerating() ? t('Claude stelt de vragen op…') : t('geen vragen')}
                </p>`.key('no-questions'),
              ]
            : []}
        <div class="contents">${() => (needsScope() ? [scopeCard()] : [])}</div>
        <div class="contents">${() => (needsHotfix() ? [hotfixCard()] : [])}</div>
        <div class="contents">
          ${() => (!gateOpen() && navRows().some((r) => r.kind === 'followup') ? [followupCard()] : [])}
        </div>
        <div class="contents">
          ${() => (!gateOpen() && navRows().some((r) => r.kind === 'regenerate') ? [regenerateCard()] : [])}
        </div>
        <div class="contents">${() => (gateOpen() ? [] : [tasksSection()])}</div>
      </div>
    </div>
  `
}

// -------------------------------------------- columns 3+: the example blocks

// blockCodeBody is a block's code half: the CURRENT code of its own file (read
// out of the plan's werkmap) next to the code the plan proposes — the review
// tree's own two-pane block shape, reviewer request for task 26. Three stands:
//
//   - the block's title is not a file path at all (the model titled it "de
//     nieuwe check") → only the proposed code, as before;
//   - the file exists in the werkmap → two panes, "Huidige code" left and
//     "Voorgestelde code" right, with the lines the file does not have yet
//     marked '+' in the proposal's gutter (see newProposedLines);
//   - the file does not exist (or there is no werkmap) → only the proposed
//     code, with the word "nieuw bestand" — an agreed default, see
//     todo/plan-page-workflow.md.
//
// Always returns ONE template (never a bare string ↔ template toggle), and it
// is embedded through a `${() => [...]}` function binding, per
// .claude/rules/arrowjs-pitfalls.md.
function proposedPane(block, marks, label) {
  return html`
    <div class="min-w-0">
      <div class="flex items-center gap-1.5 border-b border-slate-100 px-3 py-1 dark:border-zinc-800">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${label}</span>
      </div>
      <pre
        class="overflow-x-auto bg-white px-3 py-2 font-mono text-[12px] leading-relaxed dark:bg-zinc-900"
        data-testid="plan-block-proposed"
      ><code class="${'language-' + prismName(block.lang)}" .innerHTML="${() => codeLinesHTML(block.code, block.lang, marks)}"></code></pre>
    </div>
  `.key('proposed:' + (block.title || '') + ':' + label)
}

function blockCodeBody(block) {
  const file = blockFilePath(block)
  if (!file) return proposedPane(block, null, t('Voorgestelde code'))
  const cur = currentFor(file)
  if (cur && cur.loading) {
    return html`
      <div>
        <p class="px-3 pt-1.5 text-[11px] text-slate-400 dark:text-zinc-500" data-testid="plan-block-current-state">
          ${t('huidige code laden…')}
        </p>
        ${[proposedPane(block, null, t('Voorgestelde code'))]}
      </div>
    `.key('body:loading:' + file)
  }
  if (!cur || !cur.found) {
    return html`
      <div>
        <p class="px-3 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300" data-testid="plan-block-new-file">
          ${t('nieuw bestand')}
        </p>
        ${[proposedPane(block, null, t('Voorgestelde code'))]}
      </div>
    `.key('body:new:' + file)
  }
  const marks = newProposedLines(cur.code, block.code)
  return html`
    <div class="grid grid-cols-2 divide-x divide-slate-200 dark:divide-zinc-800" data-testid="plan-block-split">
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 border-b border-slate-100 px-3 py-1 dark:border-zinc-800">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Huidige code')}</span>
        </div>
        <pre
          class="max-h-[28rem] overflow-auto bg-white px-3 py-2 font-mono text-[12px] leading-relaxed dark:bg-zinc-900"
          data-testid="plan-block-current"
        ><code class="${'language-' + prismName(block.lang)}" .innerHTML="${() => codeLinesHTML(cur.code, block.lang, null)}"></code></pre>
      </div>
      ${[proposedPane(block, marks, t('Voorgestelde code'))]}
    </div>
  `.key('body:split:' + file + ':' + (cur.code || '').length)
}

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
      <div class="contents">${() => [blockCodeBody(block)]}</div>
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
      class="flex w-[46rem] shrink-0 flex-col"
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

// -------------------------------------------------------- overlays: menu + chat

// planMenuOverlay is the ticket column's own small command menu (Enter on
// column 0, or the mouse's plan-menu-button) — CommandMenu.mjs, the exact
// review-tree component, anchored under the ticket card via plain CSS (no
// per-anchor positioning math: this page's layout is fixed, unlike the
// tree's scrolling index). A fixed, click-through-to-close backdrop mirrors
// home.mjs's own menuOverlay.
function planMenuOverlay() {
  return html`
    <div class="fixed inset-0 z-30" data-testid="plan-menu-overlay" @click="${() => closeMenu()}">
      <div class="absolute right-5 top-20 z-40 w-72" data-testid="plan-menu-anchor" @click="${(e) => e.stopPropagation()}">
        ${CommandMenu(ms, resolvePlanCommands, runCommand, {})}
      </div>
    </div>
  `.key('plan-menu-overlay')
}

// planChatOverlay is the general chat about this ticket — mirrors the review
// tree's own generalChatOverlay.mjs shape (a fullscreen backdrop, Escape/an
// outside click closes it) around the SAME claudeChatColumn, fed by this
// page's own chatView/chatCallbacks above.
function planChatOverlay() {
  return html`
    <div
      class="fixed inset-0 z-40 flex items-stretch justify-center bg-slate-900/40 p-4 backdrop-blur-sm dark:bg-black/60"
      data-testid="plan-chat-overlay"
      @click="${(e) => {
        if (e.target === e.currentTarget) closePlanChat()
      }}"
    >
      <div
        class="flex min-h-0 w-full max-w-[720px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-200 dark:bg-zinc-900 dark:ring-zinc-700"
        data-testid="plan-chat-card"
      >
        <div class="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-zinc-800">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400"
            >${() => t('Chat over dit ticket · {key}', { key: state.key })}</span
          >
          <span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">esc</span>
        </div>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          ${() =>
            // `{ inOverlay: true }` drops claudeChatColumn's tree-only
            // `max-h-[38vh]` cap — this overlay, like generalChatOverlay.mjs's
            // GeneralChatCard, already has a real, bounded height, so the
            // thread should fill it instead of leaving a dead gap above the
            // composer (see scrollPlanChatThreadToBottom's own doc comment).
            claudeChatColumn(chatView(), chatCallbacks(), false, () => {}, { inOverlay: true })}
        </div>
      </div>
    </div>
  `.key('plan-chat-overlay')
}

// intentCommentsColumnVisible: reviewer request ("als je dat selecteerd,
// alleen dan opmerkingen rechts daarvan zien (ook als je pr description
// selecteerd hebt)") — a DEDICATED column, separate from the questions
// column, that shows only the Jira-opmerkingen (reusing commentsPanel()
// as-is) while the reviewer has just clicked into either the ticket
// description or the intent field (state.col0Focus, set by the description
// block's own @click and by intentSectionBody's own @click, both only while
// `place === 'ticket'` — the questions-column placement already sits right
// above commentsPanel() in that same column, so it needs no extra column of
// its own). Scoped to `state.col === 0` too, so leaving the ticket column
// hides it again immediately rather than leaving a stale panel around. See
// "A dedicated Jira-opmerkingen column next to the ticket" in
// .claude/docs/plan-page.md.
function intentCommentsColumnVisible() {
  return state.col === 0 && (state.col0Focus === 'description' || state.col0Focus === 'intent')
}

function intentCommentsColumn() {
  return html`
    <div class="flex w-[26rem] shrink-0 flex-col gap-2" data-testid="plan-intent-comments-column">
      <div class="min-h-0 flex-1 overflow-y-auto pr-1">${commentsPanel()}</div>
    </div>
  `.key('intent-comments-column')
}

// ------------------------------------------------------------------ the page

function App() {
  return html`
    <div class="fixed inset-0 flex items-stretch gap-5 overflow-x-auto overflow-y-hidden p-5" data-testid="plan-columns">
      <div class="flex w-[34rem] shrink-0 flex-col gap-4" data-testid="plan-info-column" data-column-focused="${() => (state.col === 0 ? 'true' : 'false')}">
        ${ticketCard()} ${tasksCard()}
      </div>
      <div class="contents">${() => (intentCommentsColumnVisible() ? [intentCommentsColumn()] : [])}</div>
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
      <div class="contents">${() => (menu.open ? [planMenuOverlay()] : [])}</div>
      <div class="contents">${() => (state.chatOpen ? [planChatOverlay()] : [])}</div>
    </div>
  `
}

if (!planKey) {
  location.replace('/pr-overview')
} else {
  html`${App()}`(document.getElementById('app'))
  // Debug mode ("record my navigation so a later session can replay a
  // reported bug", .claude/docs/debug-mode.md) was wired into home.mjs/
  // overview.mjs/settings.mjs but never into this page — so a reviewer with
  // the switch on got zero session/nav/key/click lines from /plan/<KEY>.
  // Found while adding the two logAction() calls below (see focusColumn1 and
  // sendAnswer).
  initDebugLog()
  document.addEventListener('keydown', onKeydown)
  // clampCursor is called from loadPlan (the one place the document is
  // replaced), deliberately NOT from a watch on state.doc/state.cur: the
  // vendored proxy notifies on EVERY assignment, also one that writes back the
  // same value, so a watch whose own callback re-assigns those keys re-triggers
  // itself forever — a hung tab, not a render bug (see the "watch fires even
  // when the write reassigns the SAME value" pitfall in
  // .claude/rules/arrowjs-pitfalls.md).
  setInterval(loadPlan, POLL_MS)
  ensurePlanChatEvents()
  // The Jira-opmerkingen block only enters navRows() once commentFlatList()
  // has something in it, and loadPlan()'s own clampCursor() only defaults
  // state.cur when it isn't found at all — so on a genuinely cold cache
  // (loadComments can cost several `acli` calls, plan_comments.go) the FIRST
  // clampCursor() run can land the default cursor on the first question
  // before the comments have even arrived. Re-clamping once both initial
  // loads have settled (not a watch — a single explicit call, see the note
  // above) makes the very-first default landing on the comments block
  // deterministic regardless of which of the two wins the race; it never
  // moves a cursor the reviewer already put somewhere else, since clampCursor
  // only touches state.cur when the current value isn't a row at all.
  Promise.all([ensureTracker().then(loadPlan), loadComments()]).then(clampCursor)
}
