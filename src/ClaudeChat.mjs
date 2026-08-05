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
import { updateScrollFade } from './scrollFade.mjs'

// Claude has no GitHub login/avatar of its own — a fixed, non-photo identity
// (avatarHTML's own initials-circle fallback, since avatarUrl is empty). Kept
// fixed on purpose: it names the actual speaker in every chat bubble
// (claudeBubble), so it must stay recognizable — unlike CLAUDE_MENTIONS
// below, which only varies the column's own "announcement" copy.
const CLAUDE_NAME = 'Claude'

// CLAUDE_MENTIONS — 30 pre-written, informal ways to refer to Claude in the
// column's own announcement copy (the header label, the empty-state
// sentence, the composer placeholder — never the per-message author name
// above, see CLAUDE_NAME). One is picked at random ONCE per page load
// (claudeMention below) and reused across all three spots so a single
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
const claudeMention = CLAUDE_MENTIONS[Math.floor(Math.random() * CLAUDE_MENTIONS.length)]

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
  const body = msg.role === 'user' ? hardBreaks(msg.body || '') : msg.body || ''
  return () => renderMarkdown(body)
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
function claudeQuestionOptions(msg, onSend) {
  if (msg.kind !== 'question' || msg.answer || !msg.options || !msg.options.length) return ''
  return html`
    <div class="flex flex-wrap gap-1.5 pl-7" data-testid="claude-question-options">
      ${msg.options.map((opt, i) =>
        html`
          <button
            type="button"
            class="rounded-full border border-indigo-300 dark:border-indigo-500/40 px-2.5 py-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/15"
            data-testid="claude-question-option"
            @click="${() => onSend(opt)}"
          >
            ${opt}
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
const LONG_WAIT_SUFFIX = 'het is nu druk, hij blijft proberen'

// claudeStatusText — the one status line. `p` is null while a turn is in
// flight but no event has landed yet (the very first moment after sending),
// hence the plain fallback. Exported: this used to render inline below the
// message thread (a `claude-chat-thinking` paragraph); it now feeds the one
// shared comment+Claude footer instead (see CommentClaudeFooter in
// RelatedPanel.mjs) — same text/testid (`claude-chat-status`), just relocated.
export function claudeStatusText(p, elapsed) {
  if (!p) return 'Claude denkt…'
  let base
  if (p.phase === 'tool' && p.tool) {
    const verb = TOOL_VERB[p.tool] || ('gebruikt ' + p.tool)
    base = 'Claude ' + verb + (p.detail ? ' ' + p.detail : '')
  } else {
    base = PHASE_LABEL[p.phase] || 'Claude denkt…'
  }
  if (!p.running) base = 'Claude is klaar — bezig met opslaan…'
  let text = elapsed > 0 ? base + ' · ' + elapsed + 's' : base
  if (p.running && p.phase === 'starting' && elapsed >= LONG_WAIT_SECONDS) {
    text += ' · ' + LONG_WAIT_SUFFIX
  }
  return text
}

// claudePartialBubble — the answer as it is still being written. A THROWAWAY
// render of throwaway data: it disappears the moment the real, stored message
// arrives (RelatedPanel.mjs clears cc.progress after refetching the
// transcript), so it deliberately carries no id/key of its own and is never
// part of the message list.
function claudePartialBubble(view) {
  const p = view.progress()
  if (!p || !p.partial) return ''
  return html`
    <div class="flex flex-col items-start gap-0.5" data-testid="claude-partial">
      <div class="flex items-center gap-2 py-0.5">
        ${avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')}
        <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
          ${CLAUDE_NAME}
        </span>
      </div>
      <div
        class="markdown-body max-w-[92%] rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-slate-700 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300"
        data-testid="claude-partial-body"
        .innerHTML="${() => renderMarkdown(p.partial)}"
      ></div>
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
            Jij
          </span>
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
            data-testid="claude-queued-badge"
            >⏳ in de wachtrij</span
          >
        </div>
        <div
          class="markdown-body max-w-[92%] rounded-xl border border-dashed border-indigo-300 bg-indigo-50/50 px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] text-slate-600 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-zinc-300"
          data-testid="claude-queued-body"
          .innerHTML="${() => renderMarkdown(hardBreaks(q.body))}"
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
      actie in commentthread</span
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
      concept in comment-veld gezet</span
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
      nieuwe poging</span
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
      foutmelding</span
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
    Geen bestandstoegang</span
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
// Only a finally-failed turn — and only the LAST message of the transcript,
// since that is the one whose input the workflow still holds — offers
// "Opnieuw proberen" (`onRetry`, the chatActionRetry Signal). A 'retrying'
// bubble deliberately does not: another attempt is already on its way.
function claudeBubble(msg, i, total, claudePos, onSend, onRetry, busy) {
  const mine = msg.role === 'user'
  const isError = msg.kind === 'error'
  const isRetrying = msg.kind === 'retrying'
  const canRetry = isError && i === total - 1
  return html`
    <div class="${'flex flex-col gap-0.5 ' + (mine ? 'items-end' : 'items-start')}" data-testid="claude-message">
      <div class="flex items-center gap-2 py-0.5">
        ${mine ? '' : avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')}
        <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
          ${mine ? 'Jij' : CLAUDE_NAME}
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
                : mine
                ? 'border-indigo-300 bg-indigo-50 text-slate-800 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-zinc-200'
                : 'border-slate-300 bg-slate-100 text-slate-800 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300') +
            (active ? ' ring-2 ring-indigo-400' : '')
          )
        }}"
        data-testid="claude-message-body"
        .innerHTML="${claudeMessageBody(msg)}"
      ></div>
      ${() =>
        msg.answer
          ? html`<span class="pl-1 text-[11px] text-slate-500 dark:text-zinc-500" data-testid="claude-question-answer"
              >→ ${msg.answer}</span
            >`
          : claudeQuestionOptions(msg, onSend)}
      ${() =>
        canRetry
          ? html`<button
              class="mt-0.5 inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
              data-testid="claude-retry"
              disabled="${() => busy()}"
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
              Opnieuw proberen
            </button>`
          : ''}
    </div>
  `
}

// claudeChatColumn is the exported render. `view` = { messages, status,
// busy, claudePos } — each a GETTER function (see the file-level doc
// comment); `callbacks.onSend(text)` posts a reviewer turn (free text OR a
// clicked question option, same Signal either way).
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
// vertical dashed line (`comment-claude-connector`). It DOES carry its own
// conditional focus border (`view.focused()`, mirrors expandedConversation's
// identical rule in RelatedPanel.mjs): indigo while the keyboard is actually
// in this column (`cs.focus === 'claude'`), `border-transparent` — never a
// neutral gray — the rest of the time, so exactly one side of the merged
// card ever shows a border, following cs.focus rather than which side merely
// happens to be visible. `flex-1` makes this
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
// without bound. A VISIBLE native scrollbar (no `no-scrollbar` here, unlike
// most other panels in this app) plus the `@scroll`-driven `.scroll-fade-top`
// class (src/scrollFade.mjs) make the cap discoverable instead of silently
// truncating. See "A capped, fading thread" in .claude/docs/comments-panel.md
// (the comment-thread pane in RelatedPanel.mjs mirrors this exactly) and the
// `scrollClaudeThreadToBottom` calls in RelatedPanel.mjs that keep the newest
// turn in view at the rest position.
export function claudeChatColumn(view, callbacks) {
  return html`
    <div
      class="${() =>
        'flex min-h-0 flex-1 flex-col gap-2 rounded-xl border p-3 ' +
        (view.focused() ? 'border-indigo-300 dark:border-indigo-500/40' : 'border-transparent')}"
      data-testid="claude-chat-card"
    >

      <p class="text-[11px] font-medium text-slate-500 dark:text-zinc-500" data-testid="claude-chat-header">
        ${claudeMention}
      </p>
      <div
        class="flex max-h-[38vh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
        data-testid="claude-chat-thread"
        @scroll="${(e) => updateScrollFade(e.target)}"
      >
        ${() => {
          const messages = view.messages()
          const total = messages.length
          if (view.status() === 'error') {
            return [
              html`<p class="text-xs text-rose-600 dark:text-rose-400" data-testid="claude-chat-error">
                Kon geen Claude-gesprek starten. Probeer het opnieuw.
              </p>`.key('claude:error'),
            ]
          }
          if (total === 0) {
            return [
              html`<p class="text-xs text-slate-400 dark:text-zinc-500" data-testid="claude-chat-empty">
                Nog geen gesprek — typ hieronder een vraag voor ${claudeMention}.
              </p>`.key('claude:empty'),
            ]
          }
          return messages.map((m, i) =>
            claudeBubble(m, i, total, view.claudePos, callbacks.onSend, callbacks.onRetry, view.busy).key(
              'claude-msg:' + m.id,
            ),
          )
        }}
        ${() => claudePartialBubble(view)}
        ${() => claudeQueuedBubbles(view)}
      </div>
      <div class="flex items-end gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <textarea
          rows="1"
          class="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2.5 py-1.5 text-xs leading-6 text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="${claudeMention + '…'}"
          title="Enter verstuurt · Shift+Enter nieuwe regel"
          data-testid="claude-chat-compose"
          @input="${(e) => autoGrowTextarea(e.target)}"
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
              }
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
            }
          }}"
        >
          Stuur
        </button>
      </div>
    </div>
  `
}
