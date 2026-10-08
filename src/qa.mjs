// qa.mjs — the /qa/<pr> page: "laat deze PR testen in de admin". A QA report
// produced by the qa_run workflow (qa_run.go), shown as a step viewer whose
// steps are COLUMNS that continue to the right (→/←), with a comments dock at
// the bottom (comment per step + a Claude chat on a comment, like the review
// tree). Reviewer request + the example it was modelled on: see
// .claude/docs/qa-page.md.
//
// Like plan.mjs this is deliberately its OWN code — it imports nothing from
// home.mjs/Block.mjs. Reused as-is: ClaudeChat.mjs's claudeChatColumn (pure
// template, fed by this page's own small chat engine below, same shape as
// plan.mjs's chatView/chatCallbacks), the werkmap overlay (workDirOverlay.mjs,
// so an open checkout choice is asked here exactly as in the tree), the image
// lightbox, markdown, theme, settings and URL-state helpers.
import { html, reactive, watch } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { renderMarkdown } from './markdown.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { initDebugLog } from './debugLog.mjs'
import { initSelfUpdate } from './selfUpdate.mjs'
import { settingsButton } from './settingsLink.mjs'
import { bindUrlState, num } from './urlState.mjs'
import { claudeChatColumn, claudeStatusText } from './ClaudeChat.mjs'
import { restorePendingAttachments, takePendingAttachments } from './chatAttachments.mjs'
import ImageLightboxHost, { initImageLightbox, isLightboxOpen, handleLightboxKeydown } from './imageLightbox.mjs'
import WorkDirOverlayHost, { initWorkDirOverlay, isWorkDirOverlayOpen, handleWorkDirOverlayKeydown } from './workDirOverlay.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { setTurnProgress, turnProgress } from './claudeTurns.mjs'
import { avatarHtmlString, ensureMe, identityOf } from './avatar.mjs'
import { relativeTime } from './relativeTime.mjs'

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
  // focus — who owns the keyboard: the columns, the comments dock, or chat.
  focus: 'steps',
  comments: [],
  commentSel: -1, // -1 = the composer row, otherwise an index into stepComments()
  composeBusy: false,
  composeError: '',
  startBusy: false,
  startError: '',
  // the Claude chat on one comment (its conversation id IS the comment id)
  chatCommentId: '',
  chatRunId: '',
  chatMessages: [],
  chatBusy: false,
  chatError: '',
  chatTick: 0,
  checkout: null, // the werkmap read model, for workDirOverlay.mjs
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

async function loadComments() {
  try {
    // identityOf (own comment → the local reviewer) reads plain, non-reactive
    // state, so it must be loaded BEFORE the rows render (conventions.md).
    await ensureMe()
    const res = await fetch(`/api/comments?pr=${PR}`)
    if (!res.ok) return
    const list = await res.json()
    state.comments = Array.isArray(list) ? list.filter((c) => (c.seg || '').startsWith('qa:')) : []
  } catch (_) {
    /* keep the last good list */
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

function stepComments() {
  const key = stepKey(state.step)
  return key ? state.comments.filter((c) => c.seg === key) : []
}

function commentCountFor(i) {
  const key = stepKey(i)
  return key ? state.comments.filter((c) => c.seg === key).length : 0
}

function stepTitle(i) {
  if (i === 0) return t('Overzicht')
  const s = steps()[i - 1]
  return s ? s.title || '' : ''
}

// placeComment writes through the review tree's own comment workflow
// (task_code_comment) as a PR-wide comment (kind 'issue') — so it appears in
// the tree's comment index too, and posting to GitHub works exactly as there.
// seg carries the step it belongs to; the body names the step for a reader on
// GitHub, who has no other way to know.
async function placeComment(local) {
  const el = document.querySelector('[data-testid=qa-comment-compose]')
  const text = el ? el.value.trim() : ''
  const r = currentRound()
  if (!text || !r || state.composeBusy) return
  const title = stepTitle(state.step)
  const label = state.step === 0
    ? t('QA ronde {r} · overzicht', { r: r.round })
    : t('QA ronde {r} · stap {n} — {title}', { r: r.round, n: state.step, title })
  state.composeBusy = true
  state.composeError = ''
  try {
    const res = await fetch('/api/workflows/task_code_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pr: PR,
        file: '',
        line: 0,
        author: 'reviewer',
        body: '**' + label + '**\n\n' + text,
        gran: 'qa',
        label,
        seg: stepKey(state.step),
        rowStart: -1,
        rowEnd: -1,
        local: !!local,
        kind: 'issue',
      }),
    })
    if (!res.ok) {
      state.composeError = t('Kon de comment niet plaatsen.')
    } else {
      el.value = ''
      let newId = ''
      try {
        newId = ((await res.json()) || {}).runId || ''
      } catch (_) {
        /* keep '' */
      }
      await loadComments()
      const at = stepComments().findIndex((c) => c.id === newId)
      if (at >= 0) state.commentSel = at
    }
  } catch (_) {
    state.composeError = t('Geen verbinding met de server — draait slash nog?')
  }
  state.composeBusy = false
}

// ---------------------------------------------------------------- chat

async function openChat(c) {
  if (!c) return
  if (state.chatCommentId !== c.id) {
    state.chatCommentId = c.id
    state.chatMessages = []
    state.chatRunId = ''
    state.chatError = ''
  }
  state.focus = 'chat'
  try {
    const res = await fetch('/api/workflows/claude_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: PR, repo: state.repo, commentId: c.id }),
    })
    if (res.ok) state.chatRunId = (await res.json()).runId || ''
  } catch (_) {
    state.chatError = t('Kon de chat niet openen.')
  }
  await loadChat()
  focusChatComposer()
}

function closeChat() {
  state.chatCommentId = ''
  state.focus = 'comments'
}

function focusChatComposer() {
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=qa-chat] [data-testid=claude-chat-compose]')
    if (el) el.focus()
  })
}

async function loadChat() {
  const id = state.chatCommentId
  if (!id) return
  try {
    const res = await fetch('/api/chat?commentId=' + encodeURIComponent(id))
    if (!res.ok) return
    const json = await res.json()
    if (state.chatCommentId !== id) return
    state.chatMessages = json.messages || []
  } catch (_) {
    /* keep the last good transcript */
  }
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

let pendingSeq = 0
async function sendChatMessage(text) {
  const trimmed = (text || '').trim()
  const id = state.chatCommentId
  if (!state.chatRunId || !id) return
  const attachments = await takePendingAttachments(id, id)
  if (!trimmed && !attachments.length) return
  const first = state.chatMessages.length === 0
  state.chatBusy = true
  state.chatError = ''
  pendingSeq += 1
  const pendingId = '__pending__' + pendingSeq
  state.chatMessages = state.chatMessages.concat([{ id: pendingId, role: 'user', kind: '', body: trimmed, attachments }])
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(state.chatRunId) + '/signals/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: 'reviewer',
        body: trimmed,
        context: first ? stepContext() : undefined,
        attachments: attachments.length ? attachments : undefined,
      }),
    })
    if (!res.ok) {
      state.chatMessages = state.chatMessages.filter((m) => m.id !== pendingId)
      restorePendingAttachments(id, id, attachments)
      state.chatError = t('Kon niet verstuurd worden.')
    } else {
      await loadChat()
    }
  } catch (_) {
    state.chatMessages = state.chatMessages.filter((m) => m.id !== pendingId)
    restorePendingAttachments(id, id, attachments)
    state.chatError = t('Geen verbinding met de server — draait slash nog?')
  }
  state.chatBusy = false
}

async function cancelChat() {
  if (!state.chatCommentId) return
  try {
    await fetch('/api/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId: state.chatCommentId }),
    })
  } catch (_) {
    /* the progress event tells the truth */
  }
}

// chatView/chatCallbacks: claudeChatColumn's two arguments, the same shape
// plan.mjs passes (getters + plain callbacks). No retry ladder/queue here.
function chatView() {
  return {
    messages: () => state.chatMessages,
    conversationId: () => state.chatCommentId,
    status: () => 'ok',
    busy: () => state.chatBusy,
    retryAllBusy: () => false,
    active: () => state.chatBusy || !!(turnProgress(state.chatCommentId) || {}).running,
    sendError: () => state.chatError,
    claudePos: () => 0,
    pinned: () => true,
    claudeOptionSel: () => 0,
    anchorHint: () => '',
    progress: () => turnProgress(state.chatCommentId),
    queued: () => [],
    elapsed: () => {
      const p = turnProgress(state.chatCommentId)
      void state.chatTick
      return p && p.startedAt ? Math.max(0, Math.round((Date.now() - p.startedAt) / 1000)) : 0
    },
  }
}

function chatCallbacks() {
  return {
    onSend: (text) => sendChatMessage(text),
    onRetry: () => {},
    onRetryAll: () => {},
    onCleanup: () => {},
    onCancel: () => cancelChat(),
    onFocus: () => {
      state.focus = 'chat'
    },
    onEmptyEnter: () => {},
    onInput: () => {},
    onSent: () => {},
    onThreadScroll: () => {},
    onJumpToBottom: () => {},
  }
}

// ---------------------------------------------------------------- navigation

function goStep(n) {
  const max = stepCount()
  state.step = Math.max(0, Math.min(max, n))
  state.commentSel = -1
  if (state.chatCommentId && !stepComments().some((c) => c.id === state.chatCommentId)) state.chatCommentId = ''
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-qa-col="${state.step}"]`)
    // inline:'start' on purpose: this IS the one horizontal "follow the
    // focused column" scroll (arrowjs-pitfalls.md's scrollIntoView rule).
    if (el) el.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' })
  })
}

function focusComposer() {
  state.focus = 'comments'
  state.commentSel = -1
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid=qa-comment-compose]')
    if (el) el.focus()
  })
}

function onKeydown(e) {
  if (isLightboxOpen()) return handleLightboxKeydown(e)
  if (isWorkDirOverlayOpen()) return handleWorkDirOverlayKeydown(e)
  const tag = (e.target && e.target.tagName) || ''
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    if (e.key === 'Escape') {
      e.target.blur()
      state.focus = state.chatCommentId && e.target.closest('[data-testid=qa-chat]') ? 'comments' : 'steps'
    }
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (state.focus === 'steps') {
    if (e.key === 'ArrowRight') goStep(state.step + 1)
    else if (e.key === 'ArrowLeft') goStep(state.step - 1)
    else if (e.key === 'ArrowDown') {
      state.focus = 'comments'
      state.commentSel = stepComments().length ? 0 : -1
    } else if (e.key === '/' || e.key === 'c') focusComposer()
    else return
    e.preventDefault()
    return
  }
  // the comments dock
  const list = stepComments()
  if (e.key === 'ArrowUp') {
    if (state.commentSel <= 0) state.focus = 'steps'
    state.commentSel = Math.max(-1, state.commentSel - 1)
  } else if (e.key === 'ArrowDown') {
    state.commentSel = Math.min(list.length - 1, state.commentSel + 1)
  } else if (e.key === 'Enter') {
    if (state.commentSel >= 0 && list[state.commentSel]) openChat(list[state.commentSel])
    else focusComposer()
  } else if (e.key === 'Escape') {
    if (state.chatCommentId) closeChat()
    else state.focus = 'steps'
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    state.focus = 'steps'
    goStep(state.step + (e.key === 'ArrowRight' ? 1 : -1))
  } else if (e.key === '/' || e.key === 'c') focusComposer()
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
  return 'flex shrink-0 snap-start flex-col overflow-hidden ' + width + ' ' + CARD + (state.step === i && state.focus === 'steps' ? CARD_FOCUS : CARD_IDLE)
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
        state.focus = 'steps'
        if (state.step !== i) goStep(i)
      }}"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-zinc-800/60">
        <span class="font-mono text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400"
          >${String(i) + '. ' + (s.eyebrow || groupLabel || '')}</span
        >
        <span class="ml-auto text-[11px] text-slate-400 dark:text-zinc-500" data-testid="qa-step-comments">${() => commentBadge(i)}</span>
      </div>
      <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
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
  void state.chatTick
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
        state.focus = 'steps'
        if (state.step !== 0) goStep(0)
      }}"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-zinc-800/60">
        <span class="font-mono text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">${() => '0. ' + t('Overzicht')}</span>
        <span class="ml-auto text-[11px] text-slate-400 dark:text-zinc-500">${() => commentBadge(0)}</span>
      </div>
      <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
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
    return [html`<p class="text-[13px] text-slate-600 dark:text-zinc-300" data-testid="qa-round-noreport">${why}</p>`.key('noreport:' + r.runId)]
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
              state.focus = 'steps'
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
        state.chatCommentId = ''
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

function commentRow(c, k) {
  return html`<li
    data-testid="qa-comment"
    class="${() => 'flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-[13px] ' + (state.focus !== 'steps' && state.commentSel === k ? CARD_FOCUS : 'border-slate-200 dark:border-zinc-800') + (state.chatCommentId === c.id ? ' bg-indigo-50/60 dark:bg-indigo-500/10' : '')}"
    @click="${() => {
      state.commentSel = k
      openChat(c)
    }}"
  >
    <div class="flex items-center gap-2 text-[11px] text-slate-500 dark:text-zinc-400">
      <span .innerHTML="${() => avatarHtmlString(identityOf(c.source, c.author, c.avatarUrl).name, identityOf(c.source, c.author, c.avatarUrl).avatarUrl, 'h-4 w-4', '')}"></span>
      <span>${identityOf(c.source, c.author, c.avatarUrl).name || ''}</span>
      <span>${relativeTime(c.createdAt)}</span>
      <span class="ml-auto rounded bg-slate-100 px-1.5 dark:bg-zinc-800">${c.githubId ? t('op GitHub') : t('lokaal')}</span>
    </div>
    <div class="markdown-body [overflow-wrap:anywhere]" .innerHTML="${() => renderMarkdown(c.body || '')}"></div>
    <span class="text-[11px] text-indigo-600 dark:text-indigo-400">${t('Enter / klik: chat met Claude hierover')}</span>
  </li>`
}

function dock() {
  return html`<div class="flex h-[36vh] shrink-0 gap-4 border-t border-slate-200 bg-slate-100/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/40" data-testid="qa-dock">
    <div class="flex w-[36rem] shrink-0 flex-col gap-2">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400" data-testid="qa-dock-title"
        >${() => t('Comments · {step}', { step: state.step === 0 ? t('Overzicht') : state.step + '. ' + stepTitle(state.step) })}</span
      >
      <ul class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="qa-comments">
        ${() => {
          const list = stepComments()
          return list.length
            ? list.map((c, k) => commentRow(c, k).key('qc:' + c.id + ':' + k))
            : [html`<li class="text-[12px] text-slate-400 dark:text-zinc-500">${t('Nog geen comments op deze stap.')}</li>`.key('qc-empty')]
        }}
      </ul>
      <textarea
        data-testid="qa-comment-compose"
        rows="2"
        placeholder="${t('Comment op deze stap… (Cmd+Enter plaatst op GitHub)')}"
        class="w-full resize-none rounded border border-slate-300 bg-white px-2 py-1.5 text-[13px] dark:border-zinc-700 dark:bg-zinc-950"
        @focus="${() => {
          state.focus = 'comments'
          state.commentSel = -1
        }}"
        @keydown="${(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            placeComment(false)
          }
        }}"
      ></textarea>
      <div class="flex items-center gap-2">
        <button type="button" data-testid="qa-comment-send" disabled="${() => state.composeBusy || !currentRound()}" class="rounded bg-indigo-600 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50" @click="${() => placeComment(false)}">${t('Plaats op GitHub')}</button>
        <button type="button" data-testid="qa-comment-local" disabled="${() => state.composeBusy || !currentRound()}" class="rounded border border-slate-300 px-2.5 py-1 text-[12px] hover:bg-white disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800" @click="${() => placeComment(true)}">${t('Alleen voor mij')}</button>
        <span class="text-[12px] text-rose-600 dark:text-rose-400">${() => state.composeError}</span>
      </div>
    </div>
    <div class="relative flex min-w-0 flex-1 flex-col" data-testid="qa-chat">
      ${() =>
        state.chatCommentId
          ? html`<div class="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              ${claudeChatColumn(chatView(), chatCallbacks(), false, () => {}, { inOverlay: true })}
            </div>`.key('qa-chat:' + state.chatCommentId)
          : html`<p class="text-[12px] text-slate-400 dark:text-zinc-500">${t('Kies een comment (↓ en Enter, of klik) om er met Claude over te chatten. Plaats eerst een comment als er nog geen is.')}</p>`.key('qa-chat-empty')}
    </div>
  </div>`
}

function App() {
  return html`<div class="fixed inset-0 flex flex-col">
    ${header()}
    <main class="flex min-h-0 flex-1 snap-x items-stretch gap-5 overflow-x-auto overflow-y-hidden p-5" data-testid="qa-columns">
      ${() => columns()}
    </main>
    ${dock()}
  </div>`
}

// ---------------------------------------------------------------- boot

if (!PR) {
  location.replace('/pr-overview')
} else {
  const app = document.getElementById('app')
  html`${App()}`(app)
  ImageLightboxHost()(app)
  initWorkDirOverlay(state, sendCheckoutAction)
  WorkDirOverlayHost()(app)
  initDebugLog()
  initImageLightbox()
  initSelfUpdate()
  document.addEventListener('keydown', onKeydown)

  ensureEvents(PR)
  onEvent('qa.progress', (ev) => {
    const wasRunning = isRunning()
    state.progress = ev.data || null
    if (wasRunning && !isRunning()) loadQA()
    if (state.progress && state.progress.waitingChoice) loadCheckout()
  })
  onEvent('chat.progress', (ev) => {
    if (ev.key) setTurnProgress(ev.key, ev.data || null)
  })
  onEvent('chat.message', (ev) => {
    if (ev.key && ev.key === state.chatCommentId) loadChat()
  })
  onEvent('checkout.changed', () => loadCheckout())
  onEventsResync(() => {
    loadQA()
    loadComments()
    loadCheckout()
    loadChat()
  })
  // The elapsed-seconds counters (QA status line, chat status line).
  setInterval(() => {
    if (isRunning() || (turnProgress(state.chatCommentId) || {}).running) state.chatTick++
  }, 1000)
  // Safety net next to the SSE stream: an event is never the source of truth.
  setInterval(() => {
    if (isRunning()) loadQA()
    loadComments()
  }, 15000)
  // A newly selected round/step must keep the dock's selection in range.
  watch(
    () => [state.step, state.roundRef],
    () => {
      if (state.commentSel >= stepComments().length) state.commentSel = -1
    },
  )
  loadPrTitle()
  loadCheckout()
  Promise.all([loadQA(), loadComments()]).then(() => {
    if (state.step) goStep(state.step)
  })
}
