// ClaudeChat.mjs — pure template layer for the embedded Claude conversation
// column (see RelatedPanel.mjs's "Embedded Claude conversation" section,
// which owns all reactive state / polling / focusToken discipline and feeds
// this file a `view` of GETTER FUNCTIONS (`() => cc.messages`, not the array
// itself — see claudeChatView's own doc comment for why that's load-bearing)
// plus plain callbacks. Deliberately holds no reactive() state of its own and
// never imports RelatedPanel.mjs — the same split translationDiff.mjs already
// has with Block.mjs, so there is no circular import between the two files.
//
// Every dynamic piece below lives inside its OWN `${() => ...}` binding that
// calls a `view.*()` getter — mirroring reactionBubble's own `active`/class
// bindings in RelatedPanel.mjs. This is load-bearing, not stylistic: once a
// nested template of a given shape is mounted, arrow.js's chunk reuse
// re-patches it via a STATIC path that only re-applies attribute slots and
// slots whose value is itself a function — a plain array/string computed
// once by a helper function is never revisited on a later re-render of the
// same shape (see the "keyed node reused without re-running its bindings"
// pitfall in arrowjs-pitfalls.md; this is the same class of bug, just for a
// single nested template instead of a keyed list item).
import { html } from './vendor/arrow.js'
import { avatarHTML } from './avatar.mjs'
import { renderMarkdown, hardBreaks } from './markdown.mjs'
import { autoGrowTextarea, resetTextareaHeight } from './textareaAutoGrow.mjs'
// The "Opnemen…"/"Uitschrijven…" pill for F5 push-to-talk dictation. It lives
// in the composer row because that is where the transcript lands — one import
// here covers both pages that render this column (see src/dictation.mjs).
import { dictationStatusPill } from './dictation.mjs'
import { updateScrollHints } from './scrollFade.mjs'
import { scrollHint } from './Block.mjs'
import { t } from './i18n.mjs'

// Claude has no GitHub login/avatar of its own — a fixed, non-photo identity
// (avatarHTML's own initials-circle fallback, since avatarUrl is empty). Kept
// fixed on purpose: it names the actual speaker in every chat bubble
// (claudeBubble), so it must stay recognizable — unlike CLAUDE_MENTIONS
// below, which only varies the column's own "announcement" copy.
const CLAUDE_NAME = 'Claude'

// CLAUDE_MENTIONS — 30 pre-written, informal ways to refer to Claude in the
// column's own announcement copy (the empty-state sentence, the composer
// placeholder — never the per-message author name above, see CLAUDE_NAME;
// a third spot, the header label above the thread, used to show this too
// but was removed on request — the mention now only announces itself once
// the reviewer starts typing). One is picked at random ONCE per page load
// (claudeMention below) and reused across both remaining spots so a single
// column reads consistently; a fresh pick appears on the next reload/visit.
// Deliberately a fixed, pre-generated list rather than generating text at
// runtime — cheap, reviewable, and never depends on anything external.
// Each entry is capped at 5 words: the placeholder renders the mention
// itself (plus an ellipsis) with no extra prefix, so a longer mention would
// overflow the single-line composer box (it used to, via the now-removed
// "Typ een bericht voor …" wrapper — see the placeholder binding below).
const CLAUDE_MENTIONS = [
  'Claude',
  'je sparringpartner Claude',
  'Claude, je klankbord',
  'Claude, je denktank',
  'je AI-maatje Claude',
  'Claude, tijd om te sparren',
  'Claude, in voor een brainstorm',
  'je digitale collega Claude',
  'Claude, je meedenker',
  'Claude, klaar voor een sparsessie',
  'Claude, je co-piloot',
  'Claude, je reviewbuddy',
  'Claude, je vraagbaak',
  'je sparpartner Claude',
  'Claude, altijd bereid tot overleg',
  'Claude, je AI-sparringpartner',
  'Claude, je digitale klankbord',
  'Claude, je meedenkende assistent',
  'Claude, je brainstormmaatje',
  'Claude, je reviewmaatje',
  'Claude, je codecollega',
  'Claude, je AI-collega',
  'Claude, je denktank-maatje',
  'Claude, je sparbuddy',
  'Claude, je overlegpartner',
  'Claude, je AI-klankbord',
  'Claude, je meedenkbuddy',
  'Claude, je reflectiepartner',
  'Claude, je AI-adviseur',
  'Claude, je sparringmaatje',
]

// Picked once per module load (one page load/tab), not per render — so the
// header, empty-state text and placeholder of one column all agree, and a
// re-render (e.g. a new message arriving) never makes the label jump around
// mid-conversation.
const claudeMention = t(CLAUDE_MENTIONS[Math.floor(Math.random() * CLAUDE_MENTIONS.length)])

// claudeMessageBody mirrors RelatedPanel.mjs's commentBody: a getter of a
// safe HTML string (via the same renderMarkdown used for comment bodies/the
// PR summary), meant for an `.innerHTML` binding — never a plain-text slot.
//
// The reviewer's OWN message runs through hardBreaks first, so a line typed
// with Shift+Enter stays its own line instead of being collapsed into the
// previous one by Markdown (see hardBreaks in markdown.mjs). Deliberately not
// applied to Claude's own turns: those are written AS Markdown, where a
// soft-wrapped source line joining the sentence above it is the intended
// behaviour.
function claudeMessageBody(msg) {
  if (msg.kind === 'auto_check') {
    const parts = splitAutoCheckQuote(msg.body || '')
    if (parts) return () => autoCheckHTML(parts)
  }
  const body = msg.role === 'user' ? hardBreaks(msg.body || '') : msg.body || ''
  return () => renderMarkdown(body, 0, true)
}

// splitAutoCheckQuote takes an auto_check turn's body apart into the text
// BEFORE kilo's quoted finding, the quote itself (unprefixed), and the text
// after it. The body is built server-side by kiloCheckPrompt (workflows.go):
// one intro line naming file/line, kilo's own wording as ONE contiguous run of
// Markdown blockquote lines, then the instruction paragraph. Kilo's own blank
// lines survive as a bare '>' line, so the run really is contiguous — which is
// why "the first '>' line up to the last consecutive one" is enough here and
// no real Markdown parse is needed.
//
// Returns null when there is no blockquote at all (a body stored before this
// prompt shape existed, or a future/other shape), and the caller falls back to
// the ordinary rendering.
function splitAutoCheckQuote(body) {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => l.startsWith('>'))
  if (start < 0) return null
  let end = start
  while (end + 1 < lines.length && lines[end + 1].startsWith('>')) end++
  return {
    before: lines.slice(0, start).join('\n').trim(),
    quote: lines
      .slice(start, end + 1)
      .map((l) => l.replace(/^>\s?/, ''))
      .join('\n')
      .trim(),
    after: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  }
}

// autoCheckHTML renders an auto_check turn with kilo's own wording COLLAPSED —
// reviewer request: the kilo comment this chat verifies is already open right
// next to it, so repeating it in full inside the bubble is pure noise. Only
// the intro line (file/regel) and the instruction stay visible; the quote sits
// behind a native <details>, which needs no reactive state and no keyboard
// wiring, so this stays one plain HTML string for the existing .innerHTML
// binding (no arrow.js slot, hence none of the pitfalls in
// .claude/rules/arrowjs-pitfalls.md apply). The summary carries a WORD, not
// just the disclosure triangle — colorblind rule, same reasoning as
// chatKindBadge's own pill.
//
// Each part runs through hardBreaks separately (this is a role:'user' message,
// see claudeMessageBody) so a newline inside kilo's finding still stays a line
// of its own once the reviewer opens the details.
function autoCheckHTML({ before, quote, after }) {
  const section = (text) => (text ? renderMarkdown(hardBreaks(text), 0, true) : '')
  return (
    section(before) +
    '<details class="my-1 rounded-lg border border-indigo-200 px-2 py-1 dark:border-indigo-500/30" data-testid="auto-check-quote">' +
    '<summary class="cursor-pointer text-[11px] font-medium text-slate-600 dark:text-zinc-400">' +
    t('opmerking van kilo') +
    '</summary>' +
    '<div class="mt-1 border-l-2 border-slate-300 pl-2 dark:border-zinc-700" data-testid="auto-check-quote-body">' +
    section(quote) +
    '</div></details>' +
    section(after)
  )
}

// claudeQuestionOptions renders the up-to-3 choice buttons of a still-open
// question turn (kind 'question', no answer yet) — free text is simply the
// ordinary composer below, the implicit 4th option (see chat_workflow.go's
// maxChatQuestionOptions). Clicking an option sends it through the SAME
// onSend callback a typed reply uses — the backend just treats the next
// "message" Signal's body as the answer to the still-open question. Clicking
// one while an earlier turn is still running QUEUES it, exactly like a typed
// message (queueClaudeMessage in RelatedPanel.mjs) — which is why these
// buttons are no longer disabled while busy.
//
// `optionSel` is `view.claudeOptionSel` (a getter, see the file-level doc
// comment) — the ↑/↓ highlight cs.claudeOptionSel drives (RelatedPanel.mjs's
// handleRelatedKey 'claude' branch): 0 = nothing highlighted, 1..N = the
// N-th option counted from the BOTTOM of this list (mirrors claudePos'/
// threadPos' own "counted from the bottom" convention, since the option
// closest to the composer is reached first walking up from it). Highlight is
// a ring PLUS a leading glyph (›), never a colour/ring alone — the colorblind
// rule — so a keyboard-driven pick reads the same as reactionBubble's own
// active-turn marker elsewhere in this file.
function claudeQuestionOptions(msg, onSend, optionSel, onCleanup) {
  // 'directory_decision' (chat_checkout.go's KindDirectoryDecision — which
  // werkmap to use, or what to do with pre-existing changes in it) answers
  // through the exact same Options/click mechanism as an ordinary 'question'
  // turn. NOTHING creates such a turn any more — the choice moved out of the
  // chat into its own overlay (workDirOverlay.mjs, and the backend half in
  // .claude/docs/workflows-comments.md) — so this branch only ever renders
  // bubbles already in stored history.
  // 'cleanup_choice' (offerCancelCleanupIfDirty, chat_workflow.go — "what do
  // you want to do with what a cancelled turn left behind?") renders the
  // SAME chip row, but a click there must go through onCleanup (the
  // dedicated chatActionCleanup Signal), never onSend/the ordinary
  // answer/resume round trip — see resolveCancelCleanup's own doc comment
  // (RelatedPanel.mjs) for why.
  const isCleanup = msg.kind === 'cleanup_choice'
  if (
    (msg.kind !== 'question' && msg.kind !== 'directory_decision' && !isCleanup) ||
    msg.answer ||
    !msg.options ||
    !msg.options.length
  )
    return ''
  const total = msg.options.length
  return html`
    <div class="flex flex-wrap gap-1.5 pl-7" data-testid="claude-question-options">
      ${msg.options.map((opt, i) =>
        html`
          <button
            type="button"
            class="${() =>
              'rounded-full border px-2.5 py-1 text-left text-[11px] font-medium hover:bg-indigo-50 dark:hover:bg-indigo-500/15 ' +
              (optionSel() > 0 && total - optionSel() === i
                ? 'border-indigo-500 ring-2 ring-indigo-300 text-indigo-700 dark:border-indigo-400 dark:ring-indigo-500/40 dark:text-indigo-200'
                : 'border-indigo-300 dark:border-indigo-500/40 text-indigo-600 dark:text-indigo-300')}"
            data-testid="claude-question-option"
            data-active="${() => (optionSel() > 0 && total - optionSel() === i ? 'true' : 'false')}"
            @click="${() => (isCleanup ? onCleanup(opt) : onSend(opt))}"
          >
            ${() => (optionSel() > 0 && total - optionSel() === i ? '› ' : '')}${opt}
          </button>
        `.key('claude-opt:' + msg.id + ':' + i),
      )}
    </div>
  `
}

// PHASE_LABEL/TOOL_VERB turn the volatile progress snapshot (chat_progress.go)
// into one Dutch sentence — "wat is Claude nú aan het doen". Deliberately
// words, never a colour or a bare spinner: a long turn must say what it is
// busy with, and the meaning may not depend on colour (see the colourblind
// rule in .claude/rules/conventions.md).
const PHASE_LABEL = {
  // waiting: this turn asked for write access and is queued behind the one
  // code-turn slot (chat_write_gate.go) — a question-only turn never sees it.
  // Said in words, because a silent stall is indistinguishable from a hang.
  waiting: 'Wacht op een andere codewijziging…',
  // escalating: the read-only attempt said in prose that it cannot write, and
  // the turn is getting real write access anyway (looksLikeWriteRefusal,
  // chat_workflow.go). Momentary by design — the reviewer never sees the
  // detection itself, only this line on its way to waiting/starting.
  escalating: 'Schrijfrechten ophalen…',
  preparing: 'Werkmap klaarzetten…',
  starting: 'Claude start…',
  thinking: 'Claude denkt na…',
  writing: 'Claude schrijft…',
}
const TOOL_VERB = {
  Read: 'leest',
  Grep: 'zoekt in',
  Glob: 'zoekt bestanden',
  Edit: 'bewerkt',
  Write: 'schrijft',
  Bash: 'draait',
}

// LONG_WAIT_SECONDS/LONG_WAIT_SUFFIX: once the CLI session has started but not
// a single token has come back after this long, say so explicitly instead of
// silently repeating "Claude start…" — the CLI retries an API overload (HTTP
// 529) on its own, invisibly, and a reviewer watching the same word for
// minutes has no way to tell "still starting" from "stuck". Deliberately
// worded as a still-in-progress sentence, not an error ("nog geen antwoord"
// reads as something went wrong) — the request has not failed, it's just
// slow. Only for chatPhaseStarting (waiting on the CLI/API): chatPhasePreparing
// is local prep bounded to a few seconds and never needs this.
const LONG_WAIT_SECONDS = 30
const LONG_WAIT_SUFFIX = t('het is nu druk, hij blijft proberen')

// claudeStatusText — the one status line. `p` is null while a turn is in
// flight but no event has landed yet (the very first moment after sending),
// hence the plain fallback. Exported: this used to render inline below the
// message thread (a `claude-chat-thinking` paragraph); it now feeds the one
// shared comment+Claude footer instead (see CommentClaudeFooter in
// RelatedPanel.mjs) — same text/testid (`claude-chat-status`), just relocated.
export function claudeStatusText(p, elapsed) {
  if (!p) return t('Claude denkt…')
  let base
  if (p.phase === 'tool' && p.tool) {
    const verb = TOOL_VERB[p.tool] ? t(TOOL_VERB[p.tool]) : t('gebruikt {tool}', { tool: p.tool })
    base = t('Claude {verb}{detail}', { verb, detail: p.detail ? ' ' + p.detail : '' })
  } else {
    base = t(PHASE_LABEL[p.phase] || 'Claude denkt…')
  }
  if (!p.running) base = t('Claude is klaar — bezig met opslaan…')
  let text = elapsed > 0 ? base + ' · ' + elapsed + 's' : base
  if (p.running && p.phase === 'starting' && elapsed >= LONG_WAIT_SECONDS) {
    text += ' · ' + LONG_WAIT_SUFFIX
  }
  return text
}

// NEED_WRITE_PARTIAL_PREFIX mirrors the backend's own strict directive check
// (isNeedWriteDirective, chat_workflow.go) — the read-only first attempt's
// way of asking for Edit/Bash access. This directive is an internal signal,
// never reviewer-facing content, but it streams into the live partial answer
// like any other text; resetChatProgressPartial (chat_progress.go) clears it
// again once the second (shell) attempt starts, so this is normally visible
// only for the brief moment the first attempt is still forming it — a
// PREFIX match (not exact), since mid-stream the JSON may still be growing
// ('{"type":"need_w…') and should already read as the icon below rather than
// flashing raw JSON fragments.
const NEED_WRITE_PARTIAL_PREFIX = '{"type":"need_write"'
const NEED_WRITE_LABEL = t('Vraagt schrijftoegang')

// claudeNeedWritePill — shown INSTEAD of the raw directive JSON while the
// live partial answer is (still forming into, or already) the strict
// {"type":"need_write"} directive. A WORD ("Vraagt schrijftoegang"), not just
// an icon, plus a matching title/aria-label — the reviewer must be able to
// tell what's happening without relying on colour (colourblind rule), same
// shape as claudeNoShellPill below.
//
// `phase` is the SAME live progress phase claudeStatusText already turns into
// a status line (chat_progress.go's chatPhaseWaiting) — passed in here too
// because this pill is what the reviewer is actually looking at the moment a
// turn asks for write access, and reviewer feedback was that the wait itself
// needs to be visible RIGHT THERE, not only in a separate footer line further
// down. `p.partial` (hence this whole pill) is deliberately not cleared until
// the escalated attempt starts streaming (resetChatProgressPartial,
// chat_progress.go), so it stays mounted for the entire chatPhaseWaiting
// window — this turn's own wait for the checkout's write-slot
// (chat_write_gate.go), now per-checkout rather than process-wide. A word,
// not a colour, carries the extra meaning (colourblind rule).
function claudeNeedWritePill(phase) {
  return html`
    <div
      class="flex max-w-[92%] flex-col gap-1 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400"
      data-testid="claude-partial-need-write"
      title="${NEED_WRITE_LABEL}"
    >
      <div class="flex items-center gap-1.5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5 shrink-0"
          aria-label="${NEED_WRITE_LABEL}"
        >
          <rect x="3" y="11" width="18" height="10" rx="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <span>${NEED_WRITE_LABEL}</span>
      </div>
      <div class="contents">
        ${() =>
          phase === 'waiting'
            ? html`<span class="pl-5 text-[11px] italic text-slate-500 dark:text-zinc-500" data-testid="claude-partial-need-write-waiting">
                ${PHASE_LABEL.waiting}
              </span>`
            : ''}
      </div>
    </div>
  `
}

// GENERIC_DIRECTIVE_PARTIAL_PREFIX catches every OTHER internal JSON
// directive the backend can stream into the live partial answer besides
// need_write — currently {"type":"question",...} and
// {"type":"comment_action",...} (chat_workflow.go), and any future one added
// there. None of these are reviewer-facing content either (they get parsed
// server-side into a proper `kind`/options once the turn is stored — see
// claudeQuestionOptions above), but while still streaming they are just as
// visible as raw JSON as need_write briefly was before it got its own pill.
// Rather than adding a new named prefix/pill per directive, any partial that
// still LOOKS like a forming JSON object (starts with `{"`) is generic
// enough to assume "Claude is generating something, not writing prose yet"
// and gets a plain loading pill instead of a raw-JSON flash.
const GENERIC_DIRECTIVE_PARTIAL_PREFIX = '{"'
const GENERATING_LABEL = t('Bezig met genereren…')

// claudeGeneratingPill — the generic sibling of claudeNeedWritePill above,
// for a partial that is forming into ANY OTHER internal JSON directive. Same
// word-plus-icon shape (colourblind rule); the icon here is a spinner
// (mirrors sendStatusIcon's 'sending' spinner in RelatedPanel.mjs) since,
// unlike need_write, there is no single fixed label that fits every
// directive this can be.
function claudeGeneratingPill() {
  return html`
    <div
      class="flex max-w-[92%] items-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400"
      data-testid="claude-partial-generating"
      title="${GENERATING_LABEL}"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-3.5 w-3.5 shrink-0 animate-spin"
        aria-label="${GENERATING_LABEL}"
      ><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
      <span>${GENERATING_LABEL}</span>
    </div>
  `
}

// claudePartialBubble — the answer as it is still being written. A THROWAWAY
// render of throwaway data: it disappears the moment the real, stored message
// arrives (RelatedPanel.mjs clears the conversation's progress after refetching the
// transcript), so it deliberately carries no id/key of its own and is never
// part of the message list.
//
// Its mount site (below) wraps this call in a stable `<div class="contents">`
// root instead of interpolating `${() => claudePartialBubble(view)}` bare —
// this function's own body IS one toggling expression (`if (!p.partial)
// return ''`, else a template), exactly the "Never key a template whose
// entire body is one toggling expression" arrow.js pitfall
// (arrowjs-pitfalls.md). RelatedPanel.mjs's `recomputeCodePreviews`
// additionally excludes any fence found inside `[data-testid="claude-partial"]`
// outright: this bubble is deliberately kept mounted for a moment AFTER the
// real, complete message has already landed (see the "Keep the partial
// visible…" comment on the chat.progress handler), so a fence inside a
// still-streaming answer is, by definition, mid-sentence/truncated — it must
// never contribute its own code-preview card, which the real message's fence
// always supersedes anyway. Reviewer report: the code-preview column showed a
// card whose trailing text abruptly stopped ("Eén ding om te checken vo…")
// while the chat bubble right above it already showed the full, final
// answer. Regression test: tests/code-fence-preview.spec.mjs.
function claudePartialBubble(view) {
  const p = view.progress()
  if (!p || !p.partial) return ''
  const trimmed = p.partial.trim()
  const needWrite = trimmed.startsWith(NEED_WRITE_PARTIAL_PREFIX)
  const generating = !needWrite && trimmed.startsWith(GENERIC_DIRECTIVE_PARTIAL_PREFIX)
  return html`
    <div class="flex flex-col items-start gap-0.5" data-testid="claude-partial">
      <div class="flex items-center gap-2 py-0.5">
        ${avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')}
        <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
          ${CLAUDE_NAME}
        </span>
      </div>
      ${() =>
        needWrite
          ? claudeNeedWritePill(p.phase)
          : generating
            ? claudeGeneratingPill()
            : html`<div
                class="markdown-body max-w-[92%] rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-slate-700 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300"
                data-testid="claude-partial-body"
                .innerHTML="${() => renderMarkdown(p.partial, 0, true)}"
              ></div>`}
    </div>
  `
}

// claudeQueuedBubbles — the reviewer's own turns typed while an earlier one is
// still running ("doorpraten", see queueClaudeMessage in RelatedPanel.mjs).
// Shown immediately, in the same right-aligned place their real bubble will
// take, so nothing the reviewer typed ever seems to vanish; the dashed border
// plus the "wacht" pill (a WORD and a glyph, never colour alone — the
// colourblind rule in conventions.md) is what distinguishes "still waiting"
// from "sent". An entry disappears the moment its own turn starts, replaced by
// the ordinary user bubble the send itself produces.
//
// Always returns an ARRAY (empty when nothing is queued) — never a
// single↔array or template↔string slot, per the two matching pitfalls in
// arrowjs-pitfalls.md — and every entry is keyed on its stable queue id.
function claudeQueuedBubbles(view) {
  return view.queued().map((q) =>
    html`
      <div class="flex flex-col items-end gap-0.5" data-testid="claude-queued">
        <div class="flex items-center gap-2 py-0.5">
          <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
            ${t('Jij')}
          </span>
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
            data-testid="claude-queued-badge"
            >⏳ ${t('in de wachtrij')}</span
          >
        </div>
        <div
          class="markdown-body max-w-[92%] rounded-xl border border-dashed border-indigo-300 bg-indigo-50/50 px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-slate-600 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-zinc-300"
          data-testid="claude-queued-body"
          .innerHTML="${() => renderMarkdown(hardBreaks(q.body), 0, true)}"
        ></div>
      </div>
    `.key('claude-queued:' + q.id),
  )
}

// chatKindBadge marks a message whose `kind` carries meaning beyond an
// ordinary reply: 'action' (chat.KindAction — Claude resolved the comment
// thread this conversation hangs on, on the reviewer's request, see "Opt-in
// influence on the left comment thread (Phase 4)" in workflows-comments.md),
// 'draft_reply' (chat.KindDraftReply — Claude drafted a reply for that same
// thread, but it only landed in the comment composer for the reviewer to edit
// and send themselves; see RelatedPanel.mjs's applyPendingDraftReplies) or
// 'error' (chat.KindError — an attempted action/resolve failed, or a Claude
// call whose automatic retry ladder is exhausted) or 'retrying'
// (chat.KindRetrying — that same failure with another attempt still coming).
// Mirrors RelatedPanel.mjs's aiWarningBadge/staleAnchorBadge: a small pill
// carrying a WORD (+ a shape glyph), the tint decoration on top — never colour
// alone, per the colourblind rule. Returns '' for a plain turn.
//
// `kind` DOES change on an existing row: every attempt of one turn rewrites
// the same message id (chatMessageID, chat_workflow.go), walking
// 'retrying' → 'retrying' → 'error' or → a plain reply. The bubble's key is
// that id, so arrow.js reuses the node and only re-applies slots whose value
// is a function — which is why the call site wraps this in its own
// `${() => chatKindBadge(msg)}` binding (see the file-level doc comment).
// Same for claudeModelPill below.
function chatKindBadge(msg) {
  // chat.KindAutoCheck (chat_workflow.go's chatActionAutoCheck): the first
  // turn of a kilo-code review comment's automatic verification chat
  // (autoStartKiloCheck, workflows.go) — a "user"-role message the reviewer
  // never typed. The bubble otherwise renders exactly like any other own
  // message (tint, "Jij" label); this badge is the only thing that tells it
  // apart, per the colorblind rule (word + glyph, not colour alone).
  if (msg.kind === 'auto_check') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
      data-testid="claude-message-auto-check"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <circle cx="11" cy="11" r="7"></circle>
        <path d="m21 21-4.3-4.3"></path>
      </svg>
      ${t('automatische controle van kilo-opmerking')}</span
    >`
  }
  if (msg.kind === 'directory_decision') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-50 px-1.5 py-0.5 text-[9px] font-medium text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
      data-testid="claude-message-directory-decision"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
      </svg>
      ${t('keuze over werkmap nodig')}</span
    >`
  }
  if (msg.kind === 'action') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
      data-testid="claude-message-action"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M20 6 9 17l-5-5"></path>
      </svg>
      ${t('actie in commentthread')}</span
    >`
  }
  if (msg.kind === 'draft_reply') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
      data-testid="claude-message-draft-reply"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
      </svg>
      ${t('concept in comment-veld gezet')}</span
    >`
  }
  if (msg.kind === 'retrying') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
      data-testid="claude-message-retrying"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
        <path d="M21 3v5h-5"></path>
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
        <path d="M3 21v-5h5"></path>
      </svg>
      ${t('nieuwe poging')}</span
    >`
  }
  if (msg.kind === 'error') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
      data-testid="claude-message-error"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      ${t('foutmelding')}</span
    >`
  }
  if (msg.kind === 'cancelled') {
    // Deliberately its OWN, neutral tint — never rose (that already means
    // "foutmelding") or amber (that already means "nieuwe poging komt") —
    // per the reviewer's own request: nothing went wrong here, the reviewer
    // chose to stop it, so this must never read as a failure. The WORD
    // "afgebroken" carries the meaning; the glyph (a stop square) and the
    // tint are decoration on top, per the colourblind rule.
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-700/60 dark:text-zinc-300"
      data-testid="claude-message-cancelled"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <rect x="6" y="6" width="12" height="12" rx="1"></rect>
      </svg>
      ${t('afgebroken')}</span
    >`
  }
  if (msg.kind === 'cleanup_choice') {
    return html`<span
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-50 px-1.5 py-0.5 text-[9px] font-medium text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
      data-testid="claude-message-cleanup-choice"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-2.5 w-2.5"
      >
        <path d="M3 6h18"></path>
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
      </svg>
      ${t('opruimen na afbreken')}</span
    >`
  }
  return ''
}

// MODEL_LABEL — the short, reviewer-facing name of a model id, mirroring
// chatModelLabel in chat_workflow.go. DEFAULT_MODEL is the one this panel
// normally runs on; a turn answered by that model shows no pill at all, so
// the pill's presence itself already means "not the usual model".
const MODEL_LABEL = { 'claude-opus-5': 'Opus', 'claude-sonnet-5': 'Sonnet', 'claude-haiku-4-5': 'Haiku' }
const DEFAULT_MODEL = 'claude-opus-5'

// claudeModelPill names the model behind an assistant turn when it isn't the
// default one — which happens when the automatic retry ladder escalated to
// Sonnet (chatModelForAttempt, chat_workflow.go). A WORD, not a colour: the
// reviewer must be able to see that this answer came from a different model
// than the rest of the conversation.
function claudeModelPill(msg) {
  if (msg.role === 'user') return ''
  const model = msg.model || ''
  if (!model || model === DEFAULT_MODEL) return ''
  return html`<span
    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
    data-testid="claude-message-model"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-2.5 w-2.5"
    >
      <path d="M12 2 4 7v10l8 5 8-5V7Z"></path>
      <path d="M12 22V12"></path>
      <path d="m4 7 8 5 8-5"></path>
    </svg>
    ${MODEL_LABEL[model] || model}</span
  >`
}

// claudeNoShellPill flags an assistant turn that ran WITHOUT Read/Grep/Glob/
// Edit/Bash access to the conversation's shadow worktree (chat.Message.NoShell,
// set by runOneClaudeTurn when prepareChatShellWorkDir — chat_shadow.go —
// could not set one up: gh/git unreachable, or a git plumbing error). A WORD
// ("Geen bestandstoegang"), not a colour: the reviewer must be able to tell
// that this reply talks about the PR without having actually looked at the
// code. Same "presence itself is the signal" shape as claudeModelPill above —
// a normal turn WITH shell access shows nothing extra.
function claudeNoShellPill(msg) {
  if (msg.role === 'user' || !msg.noShell) return ''
  return html`<span
    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
    data-testid="claude-message-no-shell"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-2.5 w-2.5"
    >
      <circle cx="12" cy="12" r="10"></circle>
      <path d="m4.9 4.9 14.2 14.2"></path>
    </svg>
    ${t('Geen bestandstoegang')}</span
  >`
}

// claudeBubble — one turn. `claudePos` is a getter; `active` marks the
// bubble the cursor currently points at (mirrors reactionBubble's own
// active-highlight rule, counting from the bottom the same way). A `kind:
// 'error'` turn (a Claude call whose automatic retry ladder is exhausted, see
// chat_workflow.go's runChatTurnWithRetries) gets a rose tint, a `kind:
// 'retrying'` one (the same failure with another attempt still coming) an
// amber tint, instead of the ordinary assistant/own tint — always alongside
// chatKindBadge's word+glyph, since the tint alone never carries the meaning,
// per the colorblind rule.
//
// Only a finally-failed OR cancelled turn — and only the LAST message of the
// transcript, since that is the one whose input the workflow still holds —
// offers "Opnieuw proberen" (`onRetry`, the chatActionRetry Signal). A
// 'retrying' bubble deliberately does not: another attempt is already on its
// way. `readOnly` (see "Read-only, not a rail" in
// .claude/docs/comments-panel.md) drops the question-option buttons and the
// retry button entirely, and makes the message body's own links/mentions/
// images/code-fence triggers inert (pointer-events-none) — the click that
// reaches the card's OUTER root instead (claudeChatColumn below) is what
// hands the keyboard back.
function claudeBubble(
  msg,
  i,
  total,
  claudePos,
  optionSel,
  anchorHint,
  onSend,
  onRetry,
  busy,
  readOnly,
  onCleanup,
  onRetryAll,
  retryAllBusy,
) {
  const mine = msg.role === 'user'
  const isError = msg.kind === 'error'
  const isRetrying = msg.kind === 'retrying'
  // 'cancelled' (chat.KindCancelled — the reviewer's own "Stop", see
  // chat_cancel.go) is deliberately NOT tinted like isError/isRetrying: it is
  // its own, neutral state — nothing went wrong. Still offers "Opnieuw
  // proberen" (canRetry below), same as an exhausted ladder.
  const isCancelled = msg.kind === 'cancelled'
  const isCleanupChoice = msg.kind === 'cleanup_choice' && !msg.answer
  // A directory_decision turn gets its own, more forceful tint (purple,
  // matching chatKindBadge's own colour) — the reviewer's explicit request:
  // this is a consult about a real, possibly-in-use local checkout, not an
  // ordinary inline question, and must read as such even before the badge
  // text is parsed. cleanup_choice shares that same tint/purpose.
  const isDirectoryDecision = (msg.kind === 'directory_decision' || isCleanupChoice) && !msg.answer
  const canRetry = (isError || isCancelled) && i === total - 1
  // Only the conversation's very first turn ever carried the (invisible)
  // selection context (claudeContextBlock only attaches it on the first turn
  // — see RelatedPanel.mjs), so this is the one bubble a visible reminder of
  // that context belongs above. `i`/`mine` are fixed for a given message
  // (never change over its lifetime), so the plain JS condition here is
  // fine; only the hint TEXT itself is read through its own `${() => ...}`.
  const showAnchor = i === 0 && mine
  return html`
    <div
      class="${'flex flex-col gap-0.5 ' + (mine ? 'items-end' : 'items-start')}"
      data-testid="claude-message"
      data-message-id="${msg.id}"
    >
      ${() =>
        showAnchor && anchorHint()
          ? html`<span
              class="pr-1 text-[10px] text-slate-400 dark:text-zinc-500"
              data-testid="claude-message-anchor"
              >${anchorHint()}</span
            >`
          : ''}
      <div class="flex items-center gap-2 py-0.5">
        ${() =>
          // A `${() => ...}` FUNCTION binding, not a bare ternary: avatarHTML
          // returns an arrow template, so a bare `mine ? '' : avatarHTML(...)`
          // statically toggles template↔string — the "leaks the template
          // function as text" pitfall (arrowjs-pitfalls.md). Bit here once a
          // bubble chunk hydrated on the `mine` (string) branch and a later
          // reused chunk needed the assistant's avatar template: the minified
          // template function itself (`i=>je(n,i)`) got written as plain text
          // next to the "Claude" label instead of rendering the avatar.
          mine ? '' : avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')}
        <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
          ${mine ? t('Jij') : CLAUDE_NAME}
        </span>
        ${() => chatKindBadge(msg)} ${() => claudeModelPill(msg)} ${() => claudeNoShellPill(msg)}
      </div>
      <div
        class="${() => {
          const active = claudePos() === total - i
          return (
            'markdown-body max-w-[92%] rounded-xl border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] ' +
            (isError
              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300'
              : isRetrying
                ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300'
                : isDirectoryDecision
                  ? 'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-500/30 dark:bg-purple-500/15 dark:text-purple-200'
                  : isCancelled
                    ? 'border-slate-300 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400'
                    : mine
                      ? 'border-indigo-300 bg-indigo-50 text-slate-800 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-zinc-200'
                      : 'border-slate-300 bg-slate-100 text-slate-800 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300') +
            (active ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="claude-message-body"
        style="${() => (readOnly ? 'pointer-events:none' : '')}"
        .innerHTML="${claudeMessageBody(msg)}"
      ></div>
      ${() =>
        msg.answer
          ? html`<span class="pl-1 text-[11px] text-slate-500 dark:text-zinc-500" data-testid="claude-question-answer"
              >→ ${msg.answer}</span
            >`
          : readOnly
            ? ''
            : claudeQuestionOptions(msg, onSend, optionSel, onCleanup)}
      ${() =>
        canRetry && !readOnly
          ? html`<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
              <button
                class="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
                data-testid="claude-retry"
                disabled="${() => busy() || retryAllBusy()}"
                @click="${() => onRetry()}"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
                  <path d="M3 21v-5h5"></path>
                </svg>
                ${t('Opnieuw proberen')}
              </button>
              <button
                class="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
                data-testid="claude-retry-all"
                title="${t('Draai ook elke andere gefaalde Claude-chat van deze PR opnieuw')}"
                disabled="${() => busy() || retryAllBusy()}"
                @click="${() => onRetryAll()}"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
                  <path d="M21 3v5h-5"></path>
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
                  <path d="M3 21v-5h5"></path>
                  <circle cx="12" cy="12" r="2.5"></circle>
                </svg>
                ${() => (retryAllBusy() ? t('Bezig…') : t('Ook andere opnieuw proberen'))}
              </button>
            </div>`
          : ''}
    </div>
  `
}

// claudeSendError — the one line that says "your message never left the
// page". It sits directly above the composer (not in the thread): nothing was
// stored, so it is not a turn, and the reviewer's next action — reload,
// restart, wipe the conversation — is a composer-level one.
//
// Distinct from a kind:'error' BUBBLE, which means Claude was reached and the
// call itself failed. Without this the column stayed completely inert on a
// rejected Signal: no bubble, no status, nothing at all (see
// sendClaudeMessage/sendErrorText in RelatedPanel.mjs, and "A rejected Signal
// must not be silent" in .claude/docs/claude-chat-panel.md).
//
// A `${() => ...}` FUNCTION binding, per the "statically interpolated
// template↔string slot" pitfall — the slot toggles between a template and
// '', which only the reactive path handles correctly. The leading warning
// WORD carries the meaning; the rose tint is decoration only (colourblind
// rule).
// claudeScrollToRecentButton — the local (never imported from RelatedPanel.mjs,
// per this file's own no-circular-import rule) copy of the "you scrolled
// away, here's the newest turns" button, mirroring RelatedPanel.mjs's own
// scrollToRecentButton for comment-thread exactly: same round emerald pill
// with a chevron-down (shape carries the meaning, colorblind rule — no text
// label, but a title/aria-label names it), shown by claudeChatColumn while
// view.claudePos() === 0 && !view.pinned(). `onClick` is
// callbacks.onJumpToBottom (RelatedPanel.mjs's jumpToClaudeThreadBottom).
const CLAUDE_SCROLL_TO_BOTTOM_TITLE = t('Naar recente berichten')
function claudeScrollToRecentButton(onClick) {
  return html`
    <button
      type="button"
      class="absolute bottom-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-1 ring-black/5 hover:bg-emerald-600"
      data-testid="scroll-to-bottom-claude"
      title="${CLAUDE_SCROLL_TO_BOTTOM_TITLE}"
      aria-label="${CLAUDE_SCROLL_TO_BOTTOM_TITLE}"
      @click="${() => onClick()}"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M6 9l6 6 6-6"/></svg>
    </button>
  `.key('scroll-to-bottom-claude')
}

function claudeSendError(view) {
  const text = view.sendError()
  if (!text) return ''
  return html`
    <p
      class="flex items-start gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300"
      data-testid="claude-send-error"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mt-0.5 h-3 w-3 shrink-0"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
      <span><span class="font-semibold">${t('Niet verstuurd')}</span> — ${text}</span>
    </p>
  `
}

// claudeChatColumn is the exported render. `view` = { messages, status,
// busy, claudePos } — each a GETTER function (see the file-level doc
// comment); `callbacks.onSend(text)` posts a reviewer turn (free text OR a
// clicked question option, same Signal either way). `callbacks.onFocus()`
// fires on the composer's own `@focus` — see its doc comment
// (`claudeChatCallbacks`, RelatedPanel.mjs) for why a mouse click landing
// here must act like the keyboard's `→` into this column.
//
// The two agentic actions ("Bewerk code"/"Commit wijziging") that used to sit
// as their own buttons below the composer are GONE — every ordinary "Stuur"
// send now carries the same capability implicitly (see sendClaudeMessage's
// own doc comment in RelatedPanel.mjs): the reviewer just types the request
// ("pas de foutafhandeling aan", "commit dit") instead of picking a separate
// action first. See "Triggering agentic actions" in claude-chat-panel.md.
//
// No own bg/rounded of its own — the comment block and this Claude block
// merge into ONE visual card (that styling lives on the shared
// `comment-claude-row` wrapper in home.mjs instead), separated only by a
// vertical dashed line (`comment-claude-connector`). It used to also carry
// its own conditional focus border (indigo while `cs.focus === 'claude'`,
// mirroring `expandedConversation`'s identical rule in RelatedPanel.mjs) —
// REMOVED (reviewer request): now that both halves already sit inside one
// shared bordered card, an extra per-side focus border read as a doubled
// border rather than a useful cue, so neither side shows one any more,
// regardless of focus. See "No per-side focus border any more" in
// .claude/docs/comments-panel.md; `expandedConversation`'s OWN conditional
// border (a comment thread shown standalone, outside this merged row) is
// untouched. `flex-1` makes this
// column fill the full height of that shared row (`items-stretch`), so both
// blocks always end up exactly the same height. It DOES keep its own `p-3`:
// InlineComments' cards (compactConversation/expandedConversation/
// newCommentComposer) already carry that inset via their own borders, so
// without it this column's content sat flush against the shared card's
// edges — most noticeably the right edge, where "Stuur" ended up touching
// the border.
//
// `claude-chat-thread` carries `flex-1` so it absorbs whatever vertical
// space the (possibly taller, comment-driven) row leaves over — otherwise a
// short/empty conversation left the composer stranded right below the
// empty-state text instead of anchored to the bottom of the equal-height
// card. The composer row itself is `flex items-end gap-2` (textarea +
// button side by side, same as the comment thread's own `reaction-compose`/
// `reaction-send` pair) instead of a stacked column with the button
// `self-end` below the field.
//
// `max-h-[38vh] overflow-y-auto` caps that growth — a long conversation used
// to stretch this whole column (and, via <main>'s align-items:stretch, the
// merged comment-claude-row card and its sibling block-diff column too)
// without bound. The native scrollbar is hidden (`no-scrollbar`, like most
// other panels in this app) and replaced by the same green up/down
// `scrollHint` chevron pair Block.mjs's diff panes use (reviewer request —
// a visible scrollbar read as visual noise, but the cap still needs to be
// discoverable) — `data-scroll-body` + `updateScrollHints` (src/scrollFade.mjs)
// instead of the earlier `.scroll-fade-top` CSS mask, which only ever
// covered "more above". See "A capped, fading thread" in
// .claude/docs/comments-panel.md (the comment-thread pane in
// RelatedPanel.mjs mirrors this exactly) and the `scrollClaudeThreadToBottom`
// calls in RelatedPanel.mjs that keep the newest turn in view at the rest
// position.
//
// That scroll container carries a 2px `p-0.5` for ONE reason: the selected
// bubble's highlight is a Tailwind `ring-2` (claudeBubble below), and a ring
// is painted OUTSIDE the border box, so `overflow-y-auto` clipped it flush
// against the container's edges. On the last message that read as "the bottom
// border of my newest message is missing" (Reindert) — scrolling didn't help,
// because the ring was never inside the scrollable area to begin with. The
// padding gives the ring its 2px back on all four sides. Don't remove it, and
// keep it in sync with the comment thread's own container (RelatedPanel.mjs's
// `comment-thread`), which mirrors this pane and has the identical ring.
//
// `opts.inOverlay` (only `GeneralChatCard`, the general-chat overlay's own
// caller, passes it) drops the `max-h-[38vh]` cap: reviewer report was a big
// dead gap between the thread and the composer inside that overlay, because
// the `max-h` stopped the thread short of the height its own
// `relative min-h-0 flex-1` parent already grows to fill (the overlay, unlike
// the tree's narrow column, has a real, viewport-bounded height via
// `items-stretch`, so nothing needs the 38vh safety cap there). The overlay
// variant instead sizes the thread as `absolute inset-0` of that same
// `relative` parent — the same "fill the flex-grown box" trick the
// `scrollHint` chevrons below already use against that parent — so it fills
// exactly the available height and only grows its own scrollbar
// (`overflow-y-auto`, unchanged) once real content overflows it. The tree's
// own call site passes no `opts`, so its 38vh cap is untouched.
// claudeMenuButton — the mouse entry point into claudeChatCommandsFor()
// ("Wis Claude-gesprek", "Comment hiervan maken", "Probeer de mislukte turn
// opnieuw" — see claude-chat-panel.md), the same menu Enter already opens on
// this column. A sparkle glyph (Claude/AI-flavoured), distinct from the
// block/PR/comment menu icons elsewhere, so the four are visually told apart.
// `callbacks.onOpenMenu` is optional (defensive — every real caller wires it,
// see RelatedPanel.mjs's claudeChatCallbacks/prCommentClaudeView call sites),
// so a missing one renders nothing rather than a dead button.
function claudeMenuButton(onOpenMenu) {
  if (!onOpenMenu) return ''
  return html`
    <button
      type="button"
      title="${t('Claude-menu')}"
      data-testid="claude-chat-menu"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
      @click="${(e) => {
        e.stopPropagation()
        onOpenMenu()
      }}"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true">
        <path d="M8 1.2l1.1 3.3 3.3 1.1-3.3 1.1L8 9.9 6.9 6.6 3.6 5.5l3.3-1.1L8 1.2z"></path>
        <path d="M13 9.6l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8z"></path>
      </svg>
    </button>
  `
}

// `readOnly`/`onEnterReadOnly` implement "Read-only, not a rail" (see
// .claude/docs/comments-panel.md): while true, this whole card drops its
// composer, its top-right menu button, and every per-message control
// (claudeBubble's own readOnly branch) — the ONE thing it still reacts to is
// a click anywhere on the card, which hands the keyboard back
// (onEnterReadOnly, RelatedPanel.mjs's enterClaudeChat/enterClaudeChatFromNew
// — the same → hand-off the keyboard already uses). Scrolling the thread
// stays free and does NOT count as "entering" — only the click does.
export function claudeChatColumn(view, callbacks, readOnly, onEnterReadOnly, opts = {}) {
  return html`
    <div
      class="relative flex min-h-0 flex-1 flex-col gap-2 rounded-xl p-3"
      data-testid="claude-chat-card"
      data-readonly="${readOnly ? 'true' : 'false'}"
      @click="${() => {
        // The one gesture a read-only card reacts to (see this function's
        // own doc comment); a no-op otherwise — the composer/buttons already
        // handle their own clicks, and this must never steal focus from a
        // field the reviewer is actively using.
        if (readOnly) onEnterReadOnly()
      }}"
      @contextmenu="${(e) => {
        // Right-click anywhere on this card = the same click claudeMenuButton
        // already runs, native-styled at the cursor — except inside the
        // composer textarea itself, which keeps its native Cut/Copy/Paste/
        // spellcheck menu. See "The right-click context menu" in
        // command-palette.md. Suppressed entirely while read-only — there is
        // no menu button here to mirror, and "niets klikbaar" includes the
        // right-click menu.
        if (readOnly) return
        if (e.target.closest && e.target.closest('textarea, input')) return
        if (!callbacks.onOpenMenu) return
        e.preventDefault()
        callbacks.onOpenMenu({ native: true, x: e.clientX, y: e.clientY })
      }}"
    >

      <div class="absolute right-2 top-2 z-20">
        ${() => (readOnly ? '' : claudeMenuButton(callbacks.onOpenMenu))}
      </div>
      <div class="relative min-h-0 flex-1">
        <div
          class="${opts.inOverlay
            ? 'no-scrollbar absolute inset-0 flex min-h-0 flex-col gap-2 overflow-y-auto p-0.5'
            : 'no-scrollbar flex max-h-[38vh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5'}"
          data-testid="claude-chat-thread"
          data-scroll-body
          @scroll="${(e) => {
            updateScrollHints(e.target)
            callbacks.onThreadScroll(e.target)
          }}"
        >
        ${() => {
          const messages = view.messages()
          const total = messages.length
          if (view.status() === 'error') {
            return [
              html`<p class="text-xs text-rose-600 dark:text-rose-400" data-testid="claude-chat-error">
                ${t('Kon geen Claude-gesprek starten. Probeer het opnieuw.')}
              </p>`.key('claude:error'),
            ]
          }
          if (total === 0) {
            return [
              html`<p class="pr-7 text-xs text-slate-400 dark:text-zinc-500" data-testid="claude-chat-empty">
                ${t('Nog geen gesprek — typ hieronder een vraag voor {mention}.', { mention: claudeMention })}
              </p>`.key('claude:empty'),
            ]
          }
          return messages.map((m, i) =>
            claudeBubble(
              m,
              i,
              total,
              view.claudePos,
              view.claudeOptionSel,
              view.anchorHint,
              callbacks.onSend,
              callbacks.onRetry,
              view.busy,
              readOnly,
              callbacks.onCleanup,
              callbacks.onRetryAll,
              view.retryAllBusy,
            ).key(
              'claude-msg:' + m.id + ':' + (readOnly ? 'ro' : 'rw'),
            ),
          )
        }}
        <div class="contents">${() => claudePartialBubble(view)}</div>
        ${() => claudeQueuedBubbles(view)}
        </div>
        ${scrollHint('up')}
        ${scrollHint('down')}
        <div class="contents">
          ${() =>
            view.claudePos() === 0 && !view.pinned()
              ? claudeScrollToRecentButton(callbacks.onJumpToBottom)
              : ''}
        </div>
      </div>
      ${() =>
        readOnly
          ? ''
          : html`<div class="contents">
              ${() => claudeSendError(view)}
              ${() => dictationStatusPill()}
              <div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <textarea
          rows="1"
          class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2.5 py-1.5 text-xs leading-6 text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="${claudeMention + '…'}"
          title="${t('Enter verstuurt · Shift+Enter nieuwe regel')}"
          data-testid="claude-chat-compose"
          @focus="${() => callbacks.onFocus()}"
          @input="${(e) => {
            autoGrowTextarea(e.target)
            // Keeps the composer's own draft (RelatedPanel.mjs's claudeDrafts)
            // in sync per keystroke, so it survives a refresh — see
            // "als ik iets type in de comment/chat input, en ik refresh..."
            // in comments-panel.md.
            callbacks.onInput?.(e.target.value)
          }}"
          @keydown="${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // No view.busy() gate any more: a turn typed while an earlier one
              // still runs is QUEUED instead of dropped (queueClaudeMessage in
              // RelatedPanel.mjs), like the Claude CLI. Shift+Enter is left
              // untouched above so it inserts a newline.
              if (e.target.value.trim()) {
                callbacks.onSend(e.target.value)
                e.target.value = ''
                resetTextareaHeight(e.target)
                callbacks.onSent?.()
              } else {
                // A blank field has nothing to send — open the Claude-column
                // menu instead of the old silent no-op (reviewer request; see
                // "Comment hiervan maken' on an empty Claude input" in
                // .claude/docs/claude-chat-panel.md). Decided HERE, before
                // anything could mutate e.target.value, rather than home.mjs's
                // document-level onKeydown re-deriving "was it blank" from the
                // DOM after this handler already ran — see
                // openClaudeMenuFromComposer's own doc comment
                // (RelatedPanel.mjs) for exactly why that re-derivation races.
                // stopPropagation is load-bearing, not belt-and-braces: this
                // SAME event would otherwise still bubble into home.mjs's
                // window-level onKeydown right after openMenu() set menu.open
                // = true synchronously — which has its OWN early "the menu is
                // open, this Enter runs/enters the highlighted command"
                // handling, so the one keypress that opened the menu would
                // immediately also "press" its own default item.
                e.stopPropagation()
                callbacks.onEmptyEnter?.()
              }
            } else if (e.key === 'Escape' && view.active()) {
              // Reviewer request: cancel the running turn from right inside
              // the composer, without losing the field. stopPropagation()
              // FIRST, before triggering the cancel (see the nested-handler
              // ordering rule in .claude/rules/arrowjs-pitfalls.md) — this
              // SAME event would otherwise still bubble into home.mjs's
              // document-level onKeydown, whose isEditableFocused() fallback
              // treats a bare Escape as "leave the field" (leaveRelated()).
              // Deliberately only when view.active() is true (mirrors the
              // visible "Stop" button's own gate, hasActiveClaudeTurn — wider
              // than busy(), see claudeChatView in RelatedPanel.mjs): with no
              // turn running, Escape does nothing here and falls through to
              // that same existing "leave the field" behavior unchanged. The
              // composer stays focused and its text untouched — a SECOND
              // Escape (now with view.active() false) leaves the field as
              // before.
              e.preventDefault()
              e.stopPropagation()
              callbacks.onCancel?.()
            }
          }}"
        ></textarea>
        <button
          class="flex min-h-[2.25rem] shrink-0 items-center justify-center rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
          data-testid="claude-chat-send"
          @click="${() => {
            const el = document.querySelector('[data-testid=claude-chat-compose]')
            const text = el && el.value
            if (text && text.trim()) {
              callbacks.onSend(text)
              el.value = ''
              resetTextareaHeight(el)
              callbacks.onSent?.()
            }
          }}"
        >
          ${t('Stuur')}
        </button>
              </div>
            </div>`}
    </div>
  `
}
