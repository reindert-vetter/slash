// qa.mjs — the /qa/<pr> page: "laat deze PR testen in de admin". A QA report
// produced by the qa_run workflow (qa_run.go), shown as a step viewer whose
// steps are COLUMNS that continue to the right (→/←), with a comments dock at
// the bottom (comment per step + a Claude chat on a comment). Reviewer request
// + the example it was modelled on: see .claude/docs/qa-page.md.
//
// The comments dock is the review tree's OWN comment + Claude block
// (RelatedPanel.mjs's InlineComments/ClaudeChatPanel/CommentClaudeFooter/
// CodePreviewPanel), scoped to the focused step through a QA scope
// (setCommentScope({ qa: true, seg })) and a QA commentTarget — so every tree
// feature (image paste, drafts, dictation, retry/edit/queue, code previews,
// resolve/delete/edit, …) is simply there. Its menus are the tree's own lists
// from commentCommands.mjs. Nothing from home.mjs/Block.mjs is imported.
import { html, reactive, watch } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { renderMarkdown } from './markdown.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { initDebugLog } from './debugLog.mjs'
import { initSelfUpdate } from './selfUpdate.mjs'
import { settingsButton } from './settingsLink.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { claudeStatusText } from './ClaudeChat.mjs'
import ImageLightboxHost, { initImageLightbox, isLightboxOpen, handleLightboxKeydown } from './imageLightbox.mjs'
// The ONE global "er is werk mislukt" dialog (src/failedTasks.mjs) — also on
// this page, so a failed GitHub post or review never goes unnoticed here.
import FailedTasksHost, { initFailedTasksPopup, isFailedTasksOpen, handleFailedTasksKeydown } from './failedTasks.mjs'
import WorkDirOverlayHost, { initWorkDirOverlay, isWorkDirOverlayOpen, handleWorkDirOverlayKeydown } from './workDirOverlay.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { relativeTime } from './relativeTime.mjs'
import { initMarkdownCodeCopy } from './codeCopy.mjs'
import { initDictation, handleDictationKeydown } from './dictation.mjs'
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
import { ShortcutHintBar } from './shortcutHints.mjs'
import { loadColumnWidths } from './columnWidth.mjs'
import {
  isEditableFocused,
  isModifiedKey,
  isNativeTextEditKey,
  editableCaretCanMoveLeft,
  editableCaretCanMoveRight,
  editableCaretCanMoveUp,
  editableCaretCanMoveDown,
} from './editableKeys.mjs'
import {
  commentCommandsFor,
  claudeChatCommandsFor,
  prCommentCommandsFor,
  composeCommandsFor,
  replyPublishCommandsFor,
} from './commentCommands.mjs'
import {
  InlineComments,
  ClaudeChatPanel,
  CommentClaudeFooter,
  CodePreviewPanel,
  commentClaudeShortcutHints,
  claudeChatVisible,
  claudeColumnVisible,
  hasCommentClaudeFooter,
  hasAnyComments,
  hasVisibleComments,
  setCommentScope,
  commentListSnapshot,
  relatedActive,
  handleRelatedKey,
  leaveRelated,
  enterCommentsOrRelated,
  enterClaudeChatOrFromNew,
  startComment,
  selectComment,
  placeComment,
  composeHasText,
  isComposeOpen,
  isConvertingAiWarning,
  isCommentOrThreadFocused,
  commentReplyEmpty,
  isClaudeChatFocused,
  selectHighlightedClaudeOption,
  selectHighlightedClaudeTask,
  isFooterTasksFocused,
  activeCodePreviewKey,
  toggleCodePreviewExpanded,
  activeClaudeMessage,
  canEditClaudeMessage,
  startEditClaudeMessage,
  clearClaudeChat,
  deleteFocusedComment,
  deletePrCommentItem,
  publishThreadOnly,
  setClaudeMenuOpener,
  setCommentMenuOpener,
  setPrCommentMenuOpener,
  setReplyPublishMenuOpener,
  setClaudeTaskJump,
  setCheckoutRefresher,
} from './RelatedPanel.mjs'

initTheme()

// The PR lives in the path (/qa/<pr>), like /pr/<id>.
const PR = (() => {
  const m = location.pathname.match(/^\/qa\/(\d+)/)
  return m ? Number(m[1]) : 0
})()

const state = reactive({
  pr: PR,
  repo: '', // primary repo only (see qa-page.md)
  prTitle: '',
  rounds: [],
  progress: null,
  loaded: false,
  loadError: '',
  // roundRef — the selected round's run id ('' = the newest round). An id,
  // never an index (conventions.md: snapshot a selection by stable ID).
  roundRef: '',
  // step — the focused column: 0 = Overzicht, n = step n of the round.
  step: 0,
  // cardFull — Enter on the columns: every card shows its full height (no
  // inner scroll) and the column row scrolls vertically instead.
  cardFull: false,
  startBusy: false,
  startError: '',
  tick: 0, // the QA status line's elapsed-seconds counter
  checkout: null, // the werkmap read model, for workDirOverlay.mjs
})

// rpState — the `state` RelatedPanel.mjs's block renders against. It is the
// tree's state shape, reduced to what that block reads: the PR, one synthetic
// "block" (so its "is there something to anchor on" guards pass — the real
// anchor is the QA commentTarget below), and the column-width bookkeeping.
const rpState = reactive({
  pr: PR,
  blocks: [{ id: 'qa', kind: 'qa', file: '', label: 'QA', line: 0 }],
  selected: 0,
  commentClaudeNarrow: false,
  workflows: [],
  ignoredComments: {},
  colWidths: loadColumnWidths(),
  colWidthVersion: 0,
  codeVersion: 0,
})

bindUrlState(state, [
  { key: 'roundRef', param: 'round', default: '' },
  { key: 'step', param: 'step', parse: num(0), default: 0 },
])

// ---------------------------------------------------------------- data

function currentRound() {
  const rs = state.rounds
  if (!rs.length) return null
  if (state.roundRef) {
    const r = rs.find((x) => x.runId === state.roundRef)
    if (r) return r
  }
  return rs[rs.length - 1]
}

function currentReport() {
  const r = currentRound()
  return r && r.result && r.result.report ? r.result.report : null
}

function steps() {
  const rep = currentReport()
  return rep && Array.isArray(rep.steps) ? rep.steps : []
}

function stepCount() {
  return steps().length
}

function isRunning() {
  return !!(state.progress && state.progress.running)
}

async function loadQA() {
  try {
    const res = await fetch(`/api/qa?pr=${PR}`)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    state.rounds = Array.isArray(data.rounds) ? data.rounds : []
    state.progress = data.progress || null
    state.loadError = ''
  } catch (_) {
    state.loadError = t('Kon de QA-gegevens niet laden.')
  }
  state.loaded = true
  if (state.step > stepCount()) state.step = stepCount()
  if (state.step < 0) state.step = 0
}

async function loadPrTitle() {
  try {
    const res = await fetch(`/api/pr?pr=${PR}`)
    if (!res.ok) return
    const meta = await res.json()
    if (meta && meta.ok && meta.title) {
      state.prTitle = meta.title
      document.title = `QA · ${meta.title}`
    }
  } catch (_) {
    /* offline: the header just shows the PR number */
  }
}

// startQA — the one write this page starts itself: a new round (a workflow
// start, POST /api/workflows/qa_run). The round number is derived server-side.
async function startQA() {
  if (state.startBusy || isRunning()) return
  const el = document.querySelector('[data-testid=qa-instructions]')
  const instructions = el ? el.value.trim() : ''
  state.startBusy = true
  state.startError = ''
  try {
    const res = await fetch('/api/workflows/qa_run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: PR, instructions }),
    })
    if (res.status === 409) state.startError = t('Er loopt al een QA-test voor deze PR.')
    else if (!res.ok) state.startError = t('Kon de QA-test niet starten.')
    else {
      if (el) el.value = ''
      state.roundRef = ''
      state.step = 0
    }
  } catch (_) {
    state.startError = t('Geen verbinding met de server — draait slash nog?')
  }
  state.startBusy = false
  await loadQA()
}

async function cancelQA() {
  try {
    await fetch('/api/qa/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: PR }),
    })
  } catch (_) {
    /* the next snapshot tells the truth either way */
  }
}

// ---------------------------------------------------------------- werkmap

async function loadCheckout() {
  try {
    const res = await fetch(`/api/chat/checkout?prs=${PR}`)
    if (!res.ok) return
    const data = await res.json()
    state.checkout = (data && data.checkout && data.checkout[String(PR)]) || null
  } catch (_) {
    /* keep what we have */
  }
}

// sendCheckoutAction answers the werkmap overlay's choice through the SAME
// chat_merge "merge" Signal the tree's checkout chip uses (home.mjs) — ensure
// the queue first (idempotent), then signal it.
async function sendCheckoutAction(action, reply, extra) {
  let runId = state.checkout && state.checkout.runId
  try {
    const res = await fetch('/api/workflows/chat_merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: PR, repo: state.repo }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.runId) runId = data.runId
    }
  } catch (_) {
    /* best-effort */
  }
  if (runId) {
    try {
      await fetch(`/api/workflows/${runId}/signals/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(action ? { action } : {}), ...(reply ? { reply } : {}), ...(extra || {}) }),
      })
    } catch (_) {
      /* best-effort */
    }
  }
  loadCheckout()
}

// ---------------------------------------------------------------- comments

function stepKey(i) {
  const r = currentRound()
  return r ? 'qa:' + r.runId + ':' + i : ''
}

function stepTitle(i) {
  if (i === 0) return t('Overzicht')
  const s = steps()[i - 1]
  return s ? s.title || '' : ''
}

// stepLabel names the step on a comment (its `label`, and the bold first line
// of its body, so a reader on GitHub knows which QA step it is about). It must
// stay stable: RelatedPanel finds a step's Claude-chat placeholder anchor by
// (file, label, gran, rows, seg), see draftKeyFor/placeholderAnchorFor there.
function stepLabel(i) {
  const r = currentRound()
  if (!r) return ''
  return i === 0
    ? t('QA ronde {r} · overzicht', { r: r.round })
    : t('QA ronde {r} · stap {n} — {title}', { r: r.round, n: i, title: stepTitle(i) })
}

// commentTarget — what a NEW comment or a first Claude turn on this step
// anchors on: a PR-wide ('issue') comment carrying the step in seg. The `qa`
// flag routes RelatedPanel's placeComment/ensureClaudeAnchorForNew/
// claudeContextBlock to their QA branch. null without a round.
function commentTarget() {
  const r = currentRound()
  if (!r) return null
  const label = stepLabel(state.step)
  return {
    qa: true,
    kind: 'issue',
    file: '',
    line: 0,
    label,
    gran: 'qa',
    rowStart: -1,
    rowEnd: -1,
    seg: stepKey(state.step),
    code: '',
    startLine: 0,
    endLine: 0,
    side: 'RIGHT',
    segment: '',
    bodyPrefix: '**' + label + '**\n\n',
    context: stepContext(),
  }
}

// The scope RelatedPanel filters its comment list by: this step's seg.
function commentScope() {
  const r = currentRound()
  if (!r) return { none: true }
  return { qa: true, seg: stepKey(state.step), file: '', label: stepLabel(state.step), mode: 'qa', gran: 'qa', rowStart: -1, rowEnd: -1 }
}

function commentCountFor(i) {
  const key = stepKey(i)
  return key ? commentListSnapshot().filter((c) => c.seg === key && !c.deleted).length : 0
}

// stepContext is the invisible context the FIRST turn of a conversation gets
// (the claude_chat "context" field, like the tree's selection context): which
// round/step the comment is about and what the QA run reported for it.
function stepContext() {
  const r = currentRound()
  const rep = currentReport()
  if (!r || !rep) return ''
  const lines = [`QA-verslag van PR #${PR}, ronde ${r.round}${rep.headSha ? ' (commit ' + rep.headSha + ')' : ''}.`]
  if (state.step === 0) {
    lines.push('Het gaat over het overzicht:', rep.summary || '')
    ;(rep.scenarios || []).forEach((s) => lines.push(`- [${s.status}] ${s.name}: ${s.result || ''}`))
    ;(rep.deviations || []).forEach((d) => lines.push('- afwijking: ' + d))
  } else {
    const s = steps()[state.step - 1]
    if (s) {
      lines.push(`Het gaat over stap ${state.step}: ${s.title} (${s.status}${s.eyebrow ? ', ' + s.eyebrow : ''}).`, s.body || '')
      if (s.pre) lines.push('```\n' + s.pre + '\n```')
      if ((s.images || []).length) lines.push('Screenshots: ' + s.images.map((im) => im.file + (im.caption ? ' (' + im.caption + ')' : '')).join(', '))
    }
  }
  return lines.join('\n')
}

// placeQAComment — "Plaats op GitHub" or "Alleen voor mij" from the QA compose
// menu (the tree has no local option any more; a QA page keeps it).
async function placeQAComment(local) {
  await placeComment(rpState, commentTarget, { local })
}

// ---------------------------------------------------------------- menus

// The command palette: CommandMenu.mjs plus the tree's own comment/Claude
// lists (commentCommands.mjs). qaCommandHost is what those lists need from
// this page — after a resolve/delete/publish the keyboard simply stays in the
// dock (there is no index row to move to).
const qaCommandHost = {
  afterResolve: async (doResolve) => {
    await doResolve()
  },
  deleteFocused: () => deleteFocusedComment(),
  deletePrComment: (c) => deletePrCommentItem(c),
  publishThread: (c, withHistory, how) => (how || publishThreadOnly)(c, withHistory),
  publishPrComment: (c, withHistory) => publishThreadOnly(c, withHistory),
  selectedComment: () => null,
  clearClaudeChat: () => clearClaudeChat(),
  prUrl: () => `https://github.com/plug-and-pay/plug-and-pay/pull/${PR}`,
  composePost: () => openMenu('qaCompose'),
  granNoun: () => 'stap',
  ignore: null,
}

// QA_COMPOSE — Enter on a filled composer: where the comment goes. "Alleen voor
// mij" stays local (never posted to GitHub); "Plaats op GitHub" posts it.
function qaComposeCommands() {
  return [
    { id: 'close-menu', label: t('Sluit menu'), hint: 'sluit', run: () => {} },
    { id: 'qa-compose-github', label: t('Plaats op GitHub'), hint: 'github', run: () => placeQAComment(false) },
    { id: 'qa-compose-local', label: t('Alleen voor mij'), hint: 'lokaal', run: () => placeQAComment(true) },
  ]
}

function rootCommandsFor(mode) {
  if (mode === 'comment') return commentCommandsFor(qaCommandHost)
  if (mode === 'claude') return claudeChatCommandsFor(qaCommandHost)
  if (mode === 'prComment') return prCommentCommandsFor(qaCommandHost)
  if (mode === 'replyPublish') return replyPublishCommandsFor()
  if (mode === 'compose') return composeCommandsFor(qaCommandHost)
  if (mode === 'qaCompose') return qaComposeCommands()
  return []
}

// snapshotCommands resolves every label function ONCE, here, so no live
// reactive read ever reaches CommandMenu's never-disposed tree (see the
// orphan-bindings entry in arrowjs-pitfalls.md).
function snapshotCommands(list) {
  return list
    .filter((c) => !c.when || c.when())
    .map((c) => ({
      ...c,
      label: typeof c.label === 'function' ? c.label() : c.label,
      children: c.children ? snapshotCommands(c.children) : undefined,
    }))
}

const menu = reactive({ open: false })
let ms = reactive({ query: '', sel: 0, sub: null, mode: '', commands: [], native: false, x: 0, y: 0 })

function defaultSel(list, native) {
  if (native) return 0
  return Math.min(1, Math.max(0, list.length - 1))
}

function resolveCommands(query) {
  const list = filterCommands(ms.sub || ms.commands, query)
  return ms.native ? list.filter((c) => c.id !== 'close-menu') : list
}

function openMenu(mode, opts = {}) {
  const native = !!(opts && opts.native)
  const commands = snapshotCommands(rootCommandsFor(mode))
  if (!commands.length) return
  ms = reactive({ query: '', sel: defaultSel(commands, native), sub: null, mode, commands, native, x: opts.x || 0, y: opts.y || 0 })
  menu.open = true
  requestAnimationFrame(() => {
    positionMenu()
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
}

function closeMenu() {
  menu.open = false
}

function runCommand(cmd) {
  if (cmd && cmd.children) {
    ms.sub = cmd.children
    ms.query = ''
    ms.sel = defaultSel(cmd.children, ms.native)
    return
  }
  closeMenu()
  if (cmd && cmd.run) requestAnimationFrame(() => cmd.run())
}

// positionMenu: a native (right-click) menu sits at the cursor; otherwise just
// above the dock, so it never covers the comment/Claude block it acts on.
function positionMenu() {
  const el = document.querySelector('[data-testid="command-anchor"]')
  if (!el) return
  if (ms.native) {
    el.style.width = 'auto'
    el.style.left = Math.max(4, Math.min(ms.x, window.innerWidth - el.offsetWidth - 4)) + 'px'
    el.style.top = Math.max(4, Math.min(ms.y, window.innerHeight - el.offsetHeight - 4)) + 'px'
  } else {
    const width = Math.min(480, window.innerWidth - 16)
    el.style.width = width + 'px'
    const dock = document.querySelector('[data-testid="qa-dock"]')
    const top = dock ? dock.getBoundingClientRect().top : window.innerHeight
    el.style.left = Math.max(8, (window.innerWidth - width) / 2) + 'px'
    el.style.top = Math.max(8, top - (el.offsetHeight || 240) - 8) + 'px'
  }
  el.style.visibility = 'visible'
}

function menuOverlay() {
  return html`
    <div class="fixed inset-0 z-40" data-testid="command-overlay" @click="${() => closeMenu()}">
      <div
        class="fixed z-50 max-w-[calc(100vw-1rem)]"
        style="top:0;left:0;visibility:hidden"
        data-testid="command-anchor"
        @click="${(e) => e.stopPropagation()}"
      >
        ${CommandMenu(ms, resolveCommands, runCommand, { native: ms.native })}
      </div>
    </div>
  `
}

function MenuHost() {
  return html`<div class="contents">${() => (menu.open ? menuOverlay() : '')}</div>`
}

function handleMenuKeydown(e) {
  const list = resolveCommands(ms.query)
  if (e.key === 'Escape') {
    e.preventDefault()
    if (ms.sub) {
      ms.sub = null
      ms.query = ''
      ms.sel = defaultSel(ms.commands, ms.native)
    } else closeMenu()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    ms.sel = Math.min(ms.sel + 1, Math.max(0, list.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    ms.sel = Math.max(ms.sel - 1, 0)
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (list[ms.sel]) runCommand(list[ms.sel])
  } else if (e.key === ' ' && ms.query === '' && !ms.native) {
    e.preventDefault()
    if (list[ms.sel]) runCommand(list[ms.sel])
  }
  if (menu.open) requestAnimationFrame(positionMenu)
}

// ---------------------------------------------------------------- navigation

// dockOpen — the dock is open exactly while RelatedPanel's block owns the
// keyboard (its own cs.focus); collapsed otherwise.
function dockOpen() {
  return relatedActive()
}

function goStep(n) {
  const max = stepCount()
  state.step = Math.max(0, Math.min(max, n))
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-qa-col="${state.step}"]`)
    // inline:'start' on purpose: this IS the one horizontal "follow the
    // focused column" scroll (arrowjs-pitfalls.md's scrollIntoView rule).
    if (el) el.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' })
  })
}

// openDock: ↓ from the columns (or a click on the collapsed dock bar) — the
// tree's own → into the comment block: the first open comment, or else the
// Claude column/new composer.
function openDock() {
  if (!currentRound()) return
  if (hasVisibleComments()) enterCommentsOrRelated(PR)
  else startComment(commentTarget)
}

function leaveDock() {
  if (relatedActive()) leaveRelated()
}

// focusComposer: `/`/`c` — a new comment on this step.
function focusComposer() {
  if (!currentRound()) return
  startComment(commentTarget)
}

// onKeydown — the page's own keys plus the tree's routing for its comment/
// Claude block (the relatedActive() branch mirrors home.mjs's onKeydown).
function onKeydown(e) {
  // The global failed-tasks dialog owns the keyboard while it is up — checked
  // first, same contract as home.mjs.
  if (isFailedTasksOpen()) {
    handleFailedTasksKeydown(e)
    return
  }
  if (isNativeTextEditKey(e)) return
  if (handleDictationKeydown(e)) return
  if (isLightboxOpen()) return handleLightboxKeydown(e)
  if (isWorkDirOverlayOpen()) return handleWorkDirOverlayKeydown(e)
  if (menu.open) return handleMenuKeydown(e)

  if (e.key === 'Enter' && !e.shiftKey && isComposeOpen()) {
    e.preventDefault()
    if (composeHasText()) openMenu(isConvertingAiWarning() ? 'compose' : 'qaCompose')
    return
  }
  if (e.key === 'e' && !isModifiedKey(e) && !isEditableFocused() && isClaudeChatFocused() && canEditClaudeMessage(activeClaudeMessage())) {
    e.preventDefault()
    startEditClaudeMessage()
    return
  }

  if (relatedActive()) {
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key) &&
      !(e.key === 'ArrowLeft' && editableCaretCanMoveLeft() && !isModifiedKey(e)) &&
      !(e.key === 'ArrowRight' && editableCaretCanMoveRight() && !isModifiedKey(e)) &&
      !(e.key === 'ArrowUp' && editableCaretCanMoveUp()) &&
      !(e.key === 'ArrowDown' && editableCaretCanMoveDown())
    ) {
      e.preventDefault()
      // 'advance' (→ past the Claude column) has no next block here: stay.
      handleRelatedKey(e.key)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && isCommentOrThreadFocused() && commentReplyEmpty()) {
      e.preventDefault()
      openMenu('comment')
      return
    }
    if (e.key === 'Enter' && isClaudeChatFocused() && selectHighlightedClaudeOption(rpState, commentTarget)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && (isClaudeChatFocused() || isFooterTasksFocused()) && selectHighlightedClaudeTask()) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && isClaudeChatFocused()) {
      const key = activeCodePreviewKey()
      if (key != null) {
        e.preventDefault()
        toggleCodePreviewExpanded(key)
        return
      }
    }
    if (e.key === 'Enter' && isClaudeChatFocused() && document.activeElement !== document.querySelector('[data-testid=claude-chat-compose]')) {
      e.preventDefault()
      openMenu('claude')
    }
    return
  }
  if (isEditableFocused()) {
    if (e.key === 'Escape') e.target.blur()
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const main = document.querySelector('[data-testid=qa-columns]')
  if (e.key === 'ArrowRight') goStep(state.step + 1)
  else if (e.key === 'ArrowLeft') goStep(state.step - 1)
  else if (e.key === 'Enter') state.cardFull = !state.cardFull
  else if (e.key === 'Escape' && state.cardFull) state.cardFull = false
  // Full height: ↑/↓ scroll the columns first; ↓ at the bottom opens the dock.
  else if (e.key === 'ArrowUp' && state.cardFull && main) main.scrollBy({ top: -main.clientHeight * 0.8, behavior: 'smooth' })
  else if (e.key === 'ArrowDown' && state.cardFull && main && main.scrollTop + main.clientHeight < main.scrollHeight - 2) {
    main.scrollBy({ top: main.clientHeight * 0.8, behavior: 'smooth' })
  } else if (e.key === 'ArrowDown') openDock()
  else if (e.key === '/' || e.key === 'c') focusComposer()
  else return
  e.preventDefault()
}

// ---------------------------------------------------------------- rendering

const CARD = 'rounded-xl border bg-white ring-1 ring-black/5 dark:bg-zinc-900 '
const CARD_IDLE = 'border-slate-200 dark:border-zinc-800'
const CARD_FOCUS = 'border-indigo-400 ring-2 ring-indigo-400/40 dark:border-indigo-500'

// STATUS: glyph + word, never colour alone (Reindert is colourblind).
const STATUS = {
  ok: { glyph: '✓', word: 'Geslaagd', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  warn: { glyph: '!', word: 'Aandachtspunt', cls: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
  fail: { glyph: '✗', word: 'Werkt niet', cls: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
  info: { glyph: 'i', word: 'Context', cls: 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300' },
}

function statusOf(s) {
  return STATUS[s] || STATUS.info
}

function chip(s) {
  const st = statusOf(s)
  return html`<span class="${'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ' + st.cls}"
    data-testid="qa-status" data-status="${s || 'info'}"
    ><span aria-hidden="true">${st.glyph}</span>${t(st.word)}</span
  >`
}

function imageUrl(file) {
  const r = currentRound()
  return `/api/qa/image?pr=${PR}&run=${r ? r.runId : ''}&file=${encodeURIComponent(file)}`
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

// tableHTML/imagesHTML are plain, already-escaped HTML strings (an .innerHTML
// binding), so no template-shape question can arise for these variable-sized
// blocks. The images carry data-md-image inside a .markdown-body so the shared
// lightbox (imageLightbox.mjs) opens them full screen with ←/→.
function tableHTML(rows) {
  if (!Array.isArray(rows) || !rows.length) return ''
  const [head, ...body] = rows
  return (
    '<div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-800"><table class="w-full text-[13px]"><thead><tr>' +
    head.map((h) => '<th class="border-b border-slate-200 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-zinc-800 dark:text-zinc-400">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' +
    body.map((r) => '<tr>' + r.map((c) => '<td class="border-b border-slate-100 px-3 py-1.5 align-top dark:border-zinc-800/60">' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>'
  )
}

function imagesHTML(images) {
  if (!Array.isArray(images) || !images.length) return ''
  return (
    '<div class="markdown-body flex flex-col gap-3">' +
    images
      .map(
        (im) =>
          '<figure class="m-0 flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-zinc-800 dark:bg-zinc-950">' +
          '<img data-md-image="true" data-testid="qa-image" class="block w-full cursor-zoom-in rounded border border-slate-200 bg-white dark:border-zinc-800" src="' +
          esc(imageUrl(im.file)) + '" alt="' + esc(im.caption || im.file) + '" loading="lazy">' +
          (im.caption ? '<figcaption class="text-[12px] text-slate-500 dark:text-zinc-400">' + esc(im.caption) + '</figcaption>' : '') +
          '</figure>',
      )
      .join('') +
    '</div>'
  )
}

function colCls(i, width) {
  return 'flex shrink-0 snap-start flex-col overflow-hidden ' + (state.cardFull ? 'h-auto ' : '') + width + ' ' + CARD + (state.step === i && !dockOpen() ? CARD_FOCUS : CARD_IDLE)
}

function bodyCls() {
  return state.cardFull ? 'flex flex-col gap-3 px-4 py-3' : 'no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3'
}

// fullToggle: the Enter hint on the focused card, clickable (a click runs the
// same function the key runs). Always the same element, only its text/class move.
function fullToggle(i) {
  return html`<button
    type="button"
    data-testid="qa-card-full"
    class="${() => (state.step === i ? 'rounded px-1.5 text-[11px] text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800' : 'hidden')}"
    @click="${(e) => {
      e.stopPropagation()
      leaveDock()
      state.cardFull = !state.cardFull
    }}"
  >${() => (state.cardFull ? t('↵ inklappen') : t('↵ volledige hoogte'))}</button>`
}

function commentBadge(i) {
  const n = commentCountFor(i)
  return n ? t(n === 1 ? '{n} comment' : '{n} comments', { n }) : ''
}

function stepColumn(s, i, groupLabel) {
  return html`
    <section
      class="${() => colCls(i, 'w-[44rem]')}"
      data-qa-col="${String(i)}"
      data-testid="qa-step"
      @click="${() => {
        leaveDock()
        if (state.step !== i) goStep(i)
      }}"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-zinc-800/60">
        <span class="font-mono text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400"
          >${String(i) + '. ' + (s.eyebrow || groupLabel || '')}</span
        >
        <span class="ml-auto text-[11px] text-slate-400 dark:text-zinc-500" data-testid="qa-step-comments">${() => commentBadge(i)}</span>
        ${fullToggle(i)}
      </div>
      <div class="${() => bodyCls()}">
        <h2 class="text-lg font-bold leading-snug text-slate-900 dark:text-zinc-100" data-testid="qa-step-title">${s.title || ''}</h2>
        <div>${chip(s.status)}</div>
        <div class="markdown-body text-[14px] leading-relaxed" .innerHTML="${() => renderMarkdown(s.body || '')}"></div>
        <div .innerHTML="${() => (s.pre ? '<pre class="overflow-x-auto rounded-lg bg-slate-100 p-3 text-[12px] leading-relaxed dark:bg-zinc-950">' + esc(s.pre) + '</pre>' : '')}"></div>
        <div .innerHTML="${() => tableHTML(s.table)}"></div>
        <div .innerHTML="${() => imagesHTML(s.images)}"></div>
      </div>
    </section>
  `
}

// progressBlock: the outer slot only picks the SHAPE (running / error /
// nothing); every inner value reads state.progress live, so a reused chunk
// never shows a captured, stale snapshot (arrowjs-pitfalls.md, "a keyed node
// is reused without re-running its bindings").
function progressMode() {
  const p = state.progress
  if (!p) return ''
  // The snapshot is PR-wide; only show it on the round it belongs to.
  const r = currentRound()
  if (p.runId && r && r.runId !== p.runId) return ''
  return p.running ? 'run' : p.error ? 'err' : ''
}

// prettyTool shortens an MCP tool name for the status line
// ("mcp__playwright__browser_click" → "browser click").
function prettyTool(tool) {
  return String(tool || '').replace(/^mcp__playwright__browser_/, 'browser ').replace(/^mcp__laravel-boost__/, 'laravel-boost ').replace(/_/g, ' ')
}

function progressStatusText() {
  const p = state.progress
  if (!p) return ''
  if (p.waitingChoice) return t('Wacht op jouw werkmap-keuze…')
  void state.tick
  const elapsed = p.startedAt ? Math.round((Date.now() - p.startedAt) / 1000) : 0
  return claudeStatusText(p.tool ? { ...p, tool: prettyTool(p.tool) } : p, elapsed)
}

function progressBlock() {
  return html`<div class="contents">
    ${() => {
      const mode = progressMode()
      if (mode === 'run') {
        return html`<div class="flex flex-col gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-[13px] dark:border-indigo-500/30 dark:bg-indigo-500/10" data-testid="qa-progress">
          <div class="flex items-center gap-2">
            <span class="font-semibold">${t('QA-test loopt…')}</span>
            <button type="button" class="ml-auto rounded border border-slate-300 px-2 py-0.5 text-[12px] hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800" data-testid="qa-cancel" @click="${(e) => {
              e.stopPropagation()
              cancelQA()
            }}">${t('Stop')}</button>
          </div>
          <span class="text-slate-600 dark:text-zinc-300" data-testid="qa-progress-status">${() => progressStatusText()}</span>
          <span class="text-slate-500 dark:text-zinc-400">${() => (state.progress && state.progress.plan ? t('Plan: {plan}', { plan: state.progress.plan }) : '')}</span>
          <ol class="list-decimal pl-5 text-slate-600 dark:text-zinc-300">${() => ((state.progress && state.progress.steps) || []).map((x, k) => html`<li>${x}</li>`.key('ps:' + k + ':' + x))}</ol>
        </div>`.key('qa-progress-run')
      }
      if (mode === 'err') {
        return html`<p class="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300" data-testid="qa-progress-error">${() => '✗ ' + ((state.progress && state.progress.error) || '')}</p>`.key('qa-progress-err')
      }
      return ''
    }}
  </div>`
}

function startCard() {
  return html`<div class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-zinc-800" data-testid="qa-start">
    <span class="text-[13px] font-semibold">${() => (state.rounds.length ? t('Opnieuw testen (nieuwe ronde)') : t('QA-test in de lokale admin starten'))}</span>
    <span class="text-[12px] text-slate-500 dark:text-zinc-400"
      >${t('Claude leidt de scenario\'s af uit het Jira-ticket, de QA-subtaak, de PR-omschrijving en de diff, en test ze in de lokaal draaiende admin.')}</span
    >
    <textarea
      data-testid="qa-instructions"
      rows="2"
      placeholder="${t('Extra instructies (optioneel)')}"
      class="w-full resize-y rounded border border-slate-300 bg-white px-2 py-1.5 text-[13px] dark:border-zinc-700 dark:bg-zinc-950"
      @keydown="${(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          startQA()
        }
      }}"
    ></textarea>
    <div class="flex items-center gap-2">
      <button
        type="button"
        data-testid="qa-start-button"
        disabled="${() => state.startBusy || isRunning()}"
        class="rounded bg-indigo-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        @click="${() => startQA()}"
      >${() => (isRunning() ? t('Loopt al…') : state.rounds.length ? t('Start nieuwe ronde') : t('Start QA-test'))}</button>
      <span class="text-[12px] text-rose-600 dark:text-rose-400">${() => state.startError}</span>
    </div>
  </div>`
}

function overviewColumn() {
  return html`
    <section
      class="${() => colCls(0, 'w-[40rem]')}"
      data-qa-col="0"
      data-testid="qa-overview"
      @click="${() => {
        leaveDock()
        if (state.step !== 0) goStep(0)
      }}"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-zinc-800/60">
        <span class="font-mono text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">${() => '0. ' + t('Overzicht')}</span>
        <span class="ml-auto text-[11px] text-slate-400 dark:text-zinc-500">${() => commentBadge(0)}</span>
        ${fullToggle(0)}
      </div>
      <div class="${() => bodyCls()}">
        ${progressBlock()}
        <div class="contents">${() => overviewBody()}</div>
        ${startCard()}
      </div>
    </section>
  `
}

function overviewBody() {
  const r = currentRound()
  if (!r) {
    return [html`<p class="text-[13px] text-slate-500 dark:text-zinc-400" data-testid="qa-empty">${state.loaded ? t('Nog geen QA-test voor deze PR.') : t('Laden…')}</p>`.key('qa-empty')]
  }
  const res = r.result
  const rep = res && res.report
  if (!rep) {
    const why = !res ? (r.status === 'failed' ? t('Deze ronde is mislukt.') : t('Deze ronde loopt nog.')) : res.cancelled ? t('Deze ronde is gestopt.') : res.error || t('Geen verslag.')
    // A run without a report can still have had files put back by the
    // checkout guard (qa_checkout_guard.go) — name them, a report would list
    // them under the deviations.
    const back = (res && res.restored) || []
    const notes = (res && res.restoreNotes) || []
    const extra = back.length || notes.length
      ? '<br><span data-testid="qa-restored">! ' + esc(back.length ? t('Teruggezet in de werkmap: {list}', { list: back.join(', ') }) : '') + (notes.length ? ' ' + esc(notes.join(' ')) : '') + '</span>'
      : ''
    return [html`<p class="text-[13px] text-slate-600 dark:text-zinc-300" data-testid="qa-round-noreport" .innerHTML="${esc(why) + extra}"></p>`.key('noreport:' + r.runId)]
  }
  const devs = rep.deviations || []
  return [
    html`<div class="flex flex-col gap-3" data-testid="qa-summary">
      <span class="font-mono text-[11px] uppercase tracking-wide text-slate-500 dark:text-zinc-400">${rep.kicker || ''}</span>
      <h1 class="text-xl font-bold leading-tight">${rep.title || t('QA-verslag')}</h1>
      <span class="text-[12px] text-slate-500 dark:text-zinc-400"
        >${t('Ronde {r}', { r: r.round }) + (rep.headSha ? ' · ' + rep.headSha : '') + ' · ' + relativeTime(r.updatedAt) + (r.instructions ? ' · ' + t('instructies: {i}', { i: r.instructions }) : '')}</span
      >
      <div class="markdown-body text-[14px] leading-relaxed" .innerHTML="${() => renderMarkdown(rep.summary || '')}"></div>
      <div class="${devs.length ? 'flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-[13px] dark:border-amber-500/40 dark:bg-amber-500/10' : 'hidden'}" data-testid="qa-deviations">
        <span class="font-semibold">! ${t('Afwijkingen van de opdracht')}</span>
        <ul class="list-disc pl-5">${devs.map((d, k) => html`<li>${d}</li>`.key('dev:' + k))}</ul>
      </div>
      <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-zinc-800">
        <table class="w-full text-[13px]" data-testid="qa-scenarios">
          <tbody>
            ${(rep.scenarios || []).map(
              (sc, k) => html`<tr>
                <td class="border-b border-slate-100 px-3 py-1.5 align-top dark:border-zinc-800/60">${sc.name}</td>
                <td class="border-b border-slate-100 px-3 py-1.5 align-top text-slate-600 dark:border-zinc-800/60 dark:text-zinc-300">${sc.result || ''}</td>
                <td class="border-b border-slate-100 px-3 py-1.5 align-top dark:border-zinc-800/60">${chip(sc.status)}</td>
              </tr>`.key('sc:' + k),
            )}
          </tbody>
        </table>
      </div>
      <ol class="flex flex-col gap-0.5 text-[13px]" data-testid="qa-step-index">
        ${(rep.steps || []).map(
          (s, k) => html`<li>
            <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-100 dark:hover:bg-zinc-800" @click="${(e) => {
              e.stopPropagation()
              leaveDock()
              goStep(k + 1)
            }}">
              <span class="w-6 shrink-0 font-mono text-[11px] text-slate-400">${String(k + 1)}</span>
              <span class="w-4 shrink-0 text-center font-bold" aria-hidden="true">${statusOf(s.status).glyph}</span>
              <span class="min-w-0 flex-1 truncate">${s.title || ''}</span>
            </button>
          </li>`.key('idx:' + k),
        )}
      </ol>
    </div>`.key('summary:' + r.runId),
  ]
}

function columns() {
  const r = currentRound()
  const rep = currentReport()
  const groups = {}
  ;((rep && rep.groups) || []).forEach((g) => (groups[g.id] = g.label))
  const out = [overviewColumn().key('col:' + (r ? r.runId : '-') + ':0')]
  steps().forEach((s, k) => out.push(stepColumn(s, k + 1, groups[s.group] || '').key('col:' + r.runId + ':' + (k + 1))))
  return out
}

function roundButtons() {
  return state.rounds.map((r) => {
    const cur = currentRound() === r
    const word = r.status === 'completed' ? (r.result && r.result.report ? '' : ' · ' + t('geen verslag')) : ' · ' + t(r.status === 'failed' ? 'mislukt' : 'loopt')
    return html`<button
      type="button"
      data-testid="qa-round"
      data-current="${cur ? 'true' : 'false'}"
      class="${'rounded-full border px-2.5 py-0.5 text-[12px] ' + (cur ? 'border-indigo-500 bg-indigo-50 font-semibold dark:bg-indigo-500/15' : 'border-slate-300 hover:bg-slate-100 dark:border-zinc-700 dark:hover:bg-zinc-800')}"
      @click="${() => {
        state.roundRef = r.runId === state.rounds[state.rounds.length - 1].runId ? '' : r.runId
        state.step = 0
      }}"
    >${(cur ? '● ' : '○ ') + t('Ronde {r}', { r: r.round }) + word}</button>`.key('round:' + r.runId + ':' + (cur ? 1 : 0) + ':' + r.status)
  })
}

function header() {
  return html`<header class="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-2.5 dark:border-zinc-800">
    <a href="${'/pr/' + PR}" class="rounded px-2 py-1 text-[13px] text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800" data-testid="qa-back">← ${t('Review-boom')}</a>
    <div class="flex min-w-0 flex-col">
      <span class="font-mono text-[11px] uppercase tracking-wide text-slate-500 dark:text-zinc-400">${() => t('QA-test in admin · PR #{pr}', { pr: PR })}</span>
      <span class="truncate text-[14px] font-semibold">${() => state.prTitle}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">${() => roundButtons()}</div>
    <span class="ml-auto font-mono text-[12px] text-slate-500 dark:text-zinc-400" data-testid="qa-counter">${() => (stepCount() ? state.step + ' / ' + stepCount() : '')}</span>
    ${themeToggleButton('')} ${settingsButton('')}
  </header>`
}

// The dock: RelatedPanel's merged comment + Claude card, the shared status
// footer and the code-preview row, the same composition as the tree's
// comments-and-related column (home.mjs). It stays MOUNTED while collapsed
// (InlineComments starts the comment poll from its own body, see the
// comment-claude-row note in home.mjs) — collapsing is a CSS `hidden`.
// data-testid=detail-panel: RelatedPanel's exitRelated only blurs a field
// inside that element.
function dock() {
  return html`<div class="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-slate-100/60 px-5 py-2 dark:border-zinc-800 dark:bg-zinc-900/40" data-testid="qa-dock" data-open="${() => (dockOpen() ? 'true' : 'false')}">
    <button
      type="button"
      data-testid="qa-dock-bar"
      class="flex items-center gap-2 text-left"
      @click="${() => (dockOpen() ? leaveDock() : openDock())}"
    >
      <span class="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400" data-testid="qa-dock-title"
        >${() => t('Comments · {step}', { step: state.step === 0 ? t('Overzicht') : state.step + '. ' + stepTitle(state.step) })}</span
      >
      <span class="text-[11px] text-slate-400 dark:text-zinc-500">${() => commentBadge(state.step)}</span>
      <span class="ml-auto shrink-0 text-[11px] text-slate-400 dark:text-zinc-500">${() => (dockOpen() ? t('▾ Esc inklappen') : t('▴ ↓ openen'))}</span>
    </button>
    <div
      class="${() => (dockOpen() ? 'flex max-h-[55vh] min-h-0 flex-col gap-3 overflow-y-auto' : 'hidden')}"
      data-testid="detail-panel"
    >
      <div
        class="${() =>
          !claudeChatVisible() && !hasCommentClaudeFooter() && !hasAnyComments()
            ? 'hidden'
            : 'flex w-fit max-w-full flex-col rounded-xl border border-slate-300 bg-white ring-1 ring-black/5 dark:border-zinc-700 dark:bg-zinc-900'}"
        data-testid="comment-claude-row"
      >
        <div class="flex items-stretch overflow-hidden" data-testid="comment-claude-columns">
          ${() =>
            InlineComments(
              rpState,
              commentTarget,
              // The composer's own "Plaats…" button: the same menu Enter opens.
              () => {
                if (composeHasText()) openMenu(isConvertingAiWarning() ? 'compose' : 'qaCompose')
              },
              (opts) => openMenu('comment', opts),
              (opts) => openMenu('prComment', opts),
            ).key('inline-comments')}
          ${() =>
            claudeColumnVisible()
              ? html`<div
                  class="w-3 shrink-0 self-stretch border-l border-dashed border-slate-300 dark:border-zinc-700"
                  data-testid="comment-claude-connector"
                ></div>`
              : ''}
          ${() => ClaudeChatPanel(rpState, commentTarget).key('claude-chat')}
        </div>
        ${() => CommentClaudeFooter()}
        ${ShortcutHintBar(commentClaudeShortcutHints)}
      </div>
      ${() => CodePreviewPanel(rpState, commentTarget)}
    </div>
  </div>`
}

function App() {
  return html`<div class="fixed inset-0 flex flex-col">
    ${header()}
    <main class="${() => 'flex min-h-0 flex-1 snap-x gap-5 overflow-x-auto p-5 ' + (state.cardFull ? 'items-start overflow-y-auto' : 'items-stretch overflow-y-hidden')}" data-testid="qa-columns" data-full="${() => (state.cardFull ? 'true' : 'false')}">
      ${() => columns()}
    </main>
    ${dock()}
  </div>`
}

// claudeTaskJump — a row of the footer's "Andere chats in deze PR": a QA
// conversation of this page jumps to its round/step and selects it; any other
// one lives in the review tree.
function jumpToConversation(c) {
  if (!c) return
  const m = /^qa:([0-9a-f]+):(\d+)$/.exec(c.seg || '')
  const r = m && state.rounds.find((x) => x.runId === m[1])
  if (!r) {
    location.href = `/pr/${PR}?sel=${encodeURIComponent('comment:' + c.id)}`
    return
  }
  state.roundRef = r.runId === state.rounds[state.rounds.length - 1].runId ? '' : r.runId
  goStep(Number(m[2]))
  requestAnimationFrame(() => selectComment(c.id))
}

// ---------------------------------------------------------------- boot

if (!PR) {
  location.replace('/pr-overview')
} else {
  const app = document.getElementById('app')
  html`${App()}`(app)
  MenuHost()(app)
  ImageLightboxHost()(app)
  FailedTasksHost()(app)
  initFailedTasksPopup()
  initWorkDirOverlay(state, sendCheckoutAction)
  WorkDirOverlayHost()(app)
  initDebugLog()
  initImageLightbox()
  initMarkdownCodeCopy()
  initSelfUpdate()
  initDictation({
    openChat: () => {
      if (!relatedActive()) openDock()
      if (claudeColumnVisible()) enterClaudeChatOrFromNew(PR)
    },
  })
  setClaudeMenuOpener((opts) => openMenu('claude', opts))
  setCommentMenuOpener(() => openMenu('comment'))
  setPrCommentMenuOpener(() => openMenu('prComment'))
  setReplyPublishMenuOpener(() => openMenu('replyPublish'))
  setClaudeTaskJump(jumpToConversation)
  setCheckoutRefresher(() => loadCheckout())
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', () => menu.open && positionMenu())

  ensureEvents(PR)
  onEvent('qa.progress', (ev) => {
    const wasRunning = isRunning()
    state.progress = ev.data || null
    if (wasRunning && !isRunning()) {
      loadQA()
      setTimeout(loadQA, 2000)
    }
    if (state.progress && state.progress.waitingChoice) loadCheckout()
  })
  onEvent('checkout.changed', () => loadCheckout())
  onEventsResync(() => {
    loadQA()
    loadCheckout()
  })
  // The QA status line's elapsed-seconds counter.
  setInterval(() => {
    if (isRunning()) state.tick++
  }, 1000)
  // Safety net next to the SSE stream: an event is never the source of truth.
  // A round the store still lists as running is polled too: the progress
  // snapshot flips to "not running" (and its event's loadQA fires) a moment
  // BEFORE the run's result is recorded, so that one reload can still read
  // the round as running — the round button then said "loopt" forever.
  setInterval(() => {
    if (isRunning() || state.rounds.some((r) => r.status === 'running')) loadQA()
  }, 15000)
  // Push the focused step into RelatedPanel as its comment scope. Deps inline
  // in the getter (arrowjs-pitfalls.md's watch rule).
  watch(
    () => [state.step, state.roundRef, state.rounds],
    () => setCommentScope(commentScope()),
  )
  loadPrTitle()
  loadCheckout()
  loadQA().then(() => {
    setCommentScope(commentScope())
    if (state.step) goStep(state.step)
  })
}
