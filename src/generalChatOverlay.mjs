// generalChatOverlay — the fullscreen overlay holding this PR's ONE general
// Claude conversation: a chat about the pull request as a whole, hanging on
// nothing in the code.
//
// Why an overlay instead of another column in the tree. Reviewer's own words:
// "ik wil in de tree een algemene chat kunnen starten, net zo werken als chat
// op regel … ik vind het mooi als die chat een overlay is over alles heen,
// rechts daarvan mag je gegeneerde blokken uit de chat tonen. esc moet alles
// weer hidden". A general chat has no unit to sit next to, and it is reachable
// from every stop (`/` always opens the PR menu now, see command-palette.md),
// so it gets a surface of its own instead of borrowing a column that only
// exists while some specific code/comment is selected.
//
// Precedent for the shape: src/workDirOverlay.mjs and src/imageLightbox.mjs —
// one top-level mounted host next to MenuHost, plus an isOpen/handleKeydown
// pair home.mjs's global onKeydown consults FIRST, so the review tree never
// navigates underneath it.
//
// Deliberately NOT a second chat implementation: the card is RelatedPanel's
// own GeneralChatCard (i.e. ClaudeChat.mjs's claudeChatColumn with the same
// view/callbacks/state the tree's Claude column uses) and the blocks to its
// right are the existing CodePreviewPanel — the very column that already
// renders the code fences of a Claude conversation full size. The live
// status line below the thread ("Claude denkt na… · Xs", Stop, "Ook bezig
// elders in deze PR") is the SAME shared CommentClaudeFooter the tree's own
// comment-claude-row renders below its columns (home.mjs) — it used to be
// missing here entirely, so a running turn in the overlay showed no progress
// at all where the per-line chat does. Nothing here knows anything about
// chatting; it only decides WHERE these pieces render.
import { html, reactive } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import {
  GeneralChatCard,
  CodePreviewPanel,
  CommentClaudeFooter,
  leaveRelated,
  setGeneralChatOverlayVisible,
} from './RelatedPanel.mjs'

// Ephemeral, like menu.open / the werkmap overlay's own dismissal: not in the
// URL (this is not a navigation position and not something to share) and not
// in localStorage. Escape simply hides it again; the conversation itself is
// durable server-side and stays reachable through its "Openstaande chats" row.
const gc = reactive({ open: false })

// st is injected once by home.mjs (initGeneralChatOverlay) so the exported
// hooks stay argument-free at their call sites, exactly like the other two
// overlays.
let st = null

export function initGeneralChatOverlay(state) {
  st = state
  // Escape is handled on the CAPTURE phase, not through home.mjs's own
  // window listener, because the reviewer's rule for it is absolute: "esc
  // moet alles weer hidden". The chat composer inside this overlay has its
  // own bubble-phase @keydown that swallows Escape while a turn is running
  // (it cancels that turn, see ClaudeChat.mjs / "Cancelling a running turn"
  // in claude-chat-panel.md) — so on the ordinary path the global listener
  // never even sees the key and the overlay stayed open exactly when the
  // reviewer most wants out of it. Capturing wins that race by construction.
  // Cancelling a turn from here stays available through the card's own
  // "Stop" button and the Claude menu.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!isGeneralChatOverlayOpen() || e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeGeneralChatOverlay()
    },
    true,
  )
}

export function isGeneralChatOverlayOpen() {
  return gc.open
}

export function openGeneralChatOverlay() {
  gc.open = true
  // Hide the tree's own Claude column while this one shows the same
  // conversation — see setGeneralChatOverlayVisible's own doc comment for why
  // this goes through that column's existing gate instead of its mount site.
  setGeneralChatOverlayVisible(true)
}

export function closeGeneralChatOverlay() {
  gc.open = false
  setGeneralChatOverlayVisible(false)
  // Release the panel focus startPrGeneralChat took (cs.focus = 'claude',
  // which also holds syncClaudeAnchorForSelection back while the overlay is
  // open, see its doc comment). Without this the tree's own keyboard stays
  // routed into the now-hidden chat: relatedActive() is checked before every
  // navigation branch in home.mjs's onKeydown, so even a plain `/` would
  // reach the invisible composer as a character instead of opening the menu.
  leaveRelated()
}

// handleGeneralChatOverlayKeydown owns the keyboard the same way the werkmap
// overlay does — but in the opposite direction: everything except Escape is
// left ALONE on purpose. The reviewer is typing in a real composer here
// (data-testid=claude-chat-compose holds DOM focus), so characters, Enter,
// Shift+Enter and caret movement must keep reaching that field and its own
// @keydown handler exactly as they do in the tree's Claude column. What this
// hook guarantees is only that home.mjs returns before ANY tree navigation
// branch runs, so ↑/↓/→ can never move the selection behind the overlay.
export function handleGeneralChatOverlayKeydown(e) {
  // Escape is already handled on the capture phase (initGeneralChatOverlay)
  // — this is only the defensive twin for a keydown that somehow reaches the
  // bubble phase unhandled.
  if (e.key === 'Escape') {
    e.preventDefault()
    closeGeneralChatOverlay() // leaveRelated() inside it also blurs the composer
  }
}

function overlayPanel() {
  return html`<div
    class="fixed inset-0 z-40 flex items-stretch justify-center bg-slate-900/40 p-4 backdrop-blur-sm dark:bg-black/60"
    data-testid="general-chat-overlay"
    @click="${(e) => {
      // Only a click on the backdrop itself closes — a click inside either
      // column is an ordinary interaction with the chat/preview card.
      if (e.target === e.currentTarget) closeGeneralChatOverlay()
    }}"
  >
    <div class="flex min-h-0 w-full max-w-[1600px] gap-3">
      <div
        class="flex min-h-0 w-[520px] max-w-full shrink-0 flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-200 dark:bg-zinc-900 dark:ring-zinc-700"
        data-testid="general-chat-card"
      >
        <div
          class="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-zinc-800"
        >
          <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400"
            >${() => t('Algemene chat · hele PR')}</span
          >
          <span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
            >esc</span
          >
        </div>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">${() => GeneralChatCard(st)}</div>
        ${() =>
          // Sits below the scrollable thread, outside it — same placement as
          // home.mjs's own comment-claude-row footer, so the status line stays
          // visible instead of scrolling away with the messages.
          CommentClaudeFooter()}
      </div>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="general-chat-previews">
        ${() => CodePreviewPanel(st, () => null, { inOverlay: true })}
      </div>
    </div>
  </div>`
}

export default function GeneralChatOverlayHost() {
  return html` <div>${() => (isGeneralChatOverlayOpen() ? overlayPanel().key('general-chat-overlay') : '')}</div> `
}
