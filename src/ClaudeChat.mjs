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
import { renderMarkdown } from './markdown.mjs'
import { autoGrowTextarea, resetTextareaHeight } from './textareaAutoGrow.mjs'

// Claude has no GitHub login/avatar of its own — a fixed, non-photo identity
// (avatarHTML's own initials-circle fallback, since avatarUrl is empty).
const CLAUDE_NAME = 'Claude'

// claudeMessageBody mirrors RelatedPanel.mjs's commentBody: a getter of a
// safe HTML string (via the same renderMarkdown used for comment bodies/the
// PR summary), meant for an `.innerHTML` binding — never a plain-text slot.
function claudeMessageBody(msg) {
  return () => renderMarkdown(msg.body || '')
}

// claudeQuestionOptions renders the up-to-3 choice buttons of a still-open
// question turn (kind 'question', no answer yet) — free text is simply the
// ordinary composer below, the implicit 4th option (see chat_workflow.go's
// maxChatQuestionOptions). Clicking an option sends it through the SAME
// onSend callback a typed reply uses — the backend just treats the next
// "message" Signal's body as the answer to the still-open question. `busy`
// is a getter (see the file-level doc comment).
function claudeQuestionOptions(msg, onSend, busy) {
  if (msg.kind !== 'question' || msg.answer || !msg.options || !msg.options.length) return ''
  return html`
    <div class="flex flex-wrap gap-1.5 pl-7" data-testid="claude-question-options">
      ${msg.options.map((opt, i) =>
        html`
          <button
            type="button"
            class="${() =>
              'rounded-full border border-indigo-300 dark:border-indigo-500/40 px-2.5 py-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-300 ' +
              (busy() ? 'cursor-not-allowed opacity-50' : 'hover:bg-indigo-50 dark:hover:bg-indigo-500/15')}"
            data-testid="claude-question-option"
            disabled="${() => busy()}"
            @click="${() => !busy() && onSend(opt)}"
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

// claudeStatusText — the one status line. `p` is null while a turn is in
// flight but no event has landed yet (the very first moment after sending),
// hence the plain fallback.
function claudeStatusText(p, elapsed) {
  if (!p) return 'Claude denkt…'
  let base
  if (p.phase === 'tool' && p.tool) {
    const verb = TOOL_VERB[p.tool] || ('gebruikt ' + p.tool)
    base = 'Claude ' + verb + (p.detail ? ' ' + p.detail : '')
  } else {
    base = PHASE_LABEL[p.phase] || 'Claude denkt…'
  }
  if (!p.running) base = 'Claude is klaar — bezig met opslaan…'
  return elapsed > 0 ? base + ' · ' + elapsed + 's' : base
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

// chatKindBadge marks a message whose `kind` carries meaning beyond an
// ordinary reply: 'action' (chat.KindAction — Claude placed/resolved a
// comment on the left thread on the reviewer's request, see "Opt-in
// influence on the left comment thread (Phase 4)" in workflows-comments.md)
// or 'error' (chat.KindError — that same attempt failed). Mirrors
// RelatedPanel.mjs's aiWarningBadge/staleAnchorBadge: a small pill carrying a
// WORD (+ a shape glyph), the tint decoration on top — never colour alone,
// per the colourblind rule. `kind` is set once at message creation and never
// mutated afterward (unlike `answer`), so — like `mine`/`isError` below — this
// needs no `${() => ...}` getter wrapper of its own; it can't go stale on a
// later re-render of the same keyed bubble. Returns '' for a plain turn.
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

// claudeBubble — one turn. `claudePos`/`busy` are getters; `active` marks the
// bubble the cursor currently points at (mirrors reactionBubble's own
// active-highlight rule, counting from the bottom the same way). A `kind:
// 'error'` turn (a failed Claude call, see chat_workflow.go's
// runOneClaudeTurn) gets a rose tint instead of the ordinary assistant/own
// tint, plus chatKindBadge's word+glyph — the tint alone never carries the
// meaning, per the colorblind rule.
function claudeBubble(msg, i, total, claudePos, onSend, busy) {
  const mine = msg.role === 'user'
  const isError = msg.kind === 'error'
  return html`
    <div class="${'flex flex-col gap-0.5 ' + (mine ? 'items-end' : 'items-start')}" data-testid="claude-message">
      <div class="flex items-center gap-2 py-0.5">
        ${mine ? '' : avatarHTML(CLAUDE_NAME, '', 'h-5 w-5')}
        <span class="whitespace-nowrap text-[11px] font-medium leading-5 text-slate-600 dark:text-zinc-400">
          ${mine ? 'Jij' : CLAUDE_NAME}
        </span>
        ${chatKindBadge(msg)}
      </div>
      <div
        class="${() => {
          const active = claudePos() === total - i
          return (
            'markdown-body max-w-[92%] rounded-xl border px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere] ' +
            (isError
              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300'
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
          : claudeQuestionOptions(msg, onSend, busy)}
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
export function claudeChatColumn(view, callbacks) {
  return html`
    <div
      class="flex min-h-0 flex-col gap-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 ring-1 ring-black/5"
      data-testid="claude-chat-card"
    >
      <p class="text-[11px] font-medium text-slate-500 dark:text-zinc-500">Claude</p>
      <div class="flex min-h-0 flex-col gap-2 overflow-auto no-scrollbar" data-testid="claude-chat-thread">
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
                Nog geen gesprek — typ hieronder een vraag voor Claude.
              </p>`.key('claude:empty'),
            ]
          }
          return messages.map((m, i) =>
            claudeBubble(m, i, total, view.claudePos, callbacks.onSend, view.busy).key('claude-msg:' + m.id),
          )
        }}
        ${() => claudePartialBubble(view)}
      </div>
      ${() =>
        view.busy() || view.progress()
          ? html`<p
              class="flex items-center gap-1.5 text-[11px] italic text-slate-500 dark:text-zinc-500"
              data-testid="claude-chat-thinking"
            >
              <span class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"></span>
              <span class="truncate" data-testid="claude-chat-status">
                ${() => claudeStatusText(view.progress(), view.elapsed())}
              </span>
            </p>`
          : ''}
      <div class="flex flex-col gap-2 border-t border-slate-100 dark:border-zinc-800/60 pt-2">
        <textarea
          rows="1"
          class="w-full resize-none rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/60 px-2.5 py-1.5 text-xs text-slate-700 dark:text-zinc-300 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
          placeholder="Typ een bericht voor Claude…"
          data-testid="claude-chat-compose"
          @input="${(e) => autoGrowTextarea(e.target)}"
          @keydown="${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!view.busy() && e.target.value.trim()) {
                callbacks.onSend(e.target.value)
                e.target.value = ''
                resetTextareaHeight(e.target)
              }
            }
          }}"
        ></textarea>
        <button
          class="${() =>
            'self-end shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
            (view.busy() ? 'cursor-not-allowed opacity-60' : 'hover:bg-indigo-600')}"
          data-testid="claude-chat-send"
          disabled="${() => view.busy()}"
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
