// workDirOverlay — the fullscreen overlay in which the reviewer answers this
// PR's one open WERKMAP choice: which local directory Claude may edit for a
// write turn, and what to do with changes already sitting in it
// (chat_checkout.go's chatCheckoutDecision).
//
// Why it exists at all. That choice used to be asked as a chat bubble inside
// whichever conversation happened to trigger it, which made a PR-wide setting
// look like a question about that one conversation — and a SECOND conversation
// that needed write access got an unanswerable "een andere Claude-conversatie
// wacht nog op een keuze" bubble pointing at a chat nothing in the UI can even
// find. Reviewer's decision (his own words): "het gebruik maken van een
// directory is een algemene instellingen en mag als een popup overlay (nieuw
// iets) worden getoond. dat moet met keys te bedienen zijn." See
// ".claude/docs/command-palette.md" and the backend half in
// ".claude/docs/workflows-comments.md".
//
// Naming: everything the reviewer READS here says "werkmap", never "checkout"
// — the word this UI already used for it (ClaudeChat.mjs's PHASE_LABEL). The
// identifiers behind it keep their checkout* names (stored kinds, Actions, the
// checkout.changed event), see the naming rule in workflows-comments.md.
//
// Precedent for the shape: src/imageLightbox.mjs — one top-level mounted host
// next to MenuHost, its own isOpen/handleKeydown pair that home.mjs's global
// onKeydown consults FIRST, so the overlay owns the keyboard completely while
// it is open.
import { reactive, html, watch } from './vendor/arrow.js'
import { t } from './i18n.mjs'

// state/sendAction are injected once by home.mjs (initWorkDirOverlay) so the
// exported isOpen/handleKeydown hooks stay argument-free at the call site,
// exactly like initImageLightbox's own listener.
let st = null
let sendAction = null

// dismissed holds the fingerprint of the choice the reviewer pressed Escape
// on; busy is true while an answer is in flight. Deliberately NOT persisted
// anywhere: not in localStorage, not in the URL (see openness rules below).
const wd = reactive({ dismissed: '', busy: false, sel: 0 })

export function initWorkDirOverlay(state, sendCheckoutAction) {
  st = state
  sendAction = sendCheckoutAction
  // This overlay never puts DOM focus on itself (no element in it is ever
  // .focus()'d), so without this watch a still-focused element from BEFORE
  // the overlay opened — most commonly the empty Claude-chat composer
  // (ClaudeChat.mjs, data-testid=claude-chat-compose) — keeps real DOM
  // focus while the overlay sits visually on top. A keydown always reaches
  // that element's OWN `@keydown` handler first (normal DOM bubbling, before
  // the document-level `onKeydown` in home.mjs), and the empty composer's own
  // Enter handling calls `e.stopPropagation()` before opening the Claude
  // command palette (see its own doc comment) — so the SAME Enter that was
  // meant to confirm the highlighted werkmap option never reaches
  // handleWorkDirOverlayKeydown at all: the palette pops up instead, behind
  // the still-open overlay, and the overlay's own selection is silently
  // never confirmed. Reviewer-reported bug, reproduced by tracing exactly
  // that chain (ClaudeChat.mjs:986-1016 -> home.mjs's window keydown
  // listener never seeing the event).
  //
  // Fix: steal focus back the moment a choice becomes open, so no other
  // element's own keydown handler can compete with the global listener —
  // matching this overlay's own "owns the keyboard completely" contract
  // (see handleWorkDirOverlayKeydown's trailing comment). `watch` fires once
  // immediately on registration (covers "already open on load/reload") and
  // again whenever the decision object itself changes (covers a NEW choice
  // arriving while something else already holds focus).
  watch(
    () => state.checkout && state.checkout.decision,
    () => {
      if (!isWorkDirOverlayOpen()) return
      const el = document.activeElement
      if (el && el !== document.body && typeof el.blur === 'function') el.blur()
    },
  )
}

function decision() {
  const c = st && st.checkout
  return c && c.decision ? c.decision : null
}

// choiceFingerprint identifies WHICH choice is open — stage plus its own
// options. A brand-new choice therefore reopens the overlay even if the
// reviewer dismissed the previous one, while a mere read-model refetch of the
// SAME choice does not.
function choiceFingerprint() {
  const d = decision()
  if (!d) return ''
  return (d.stage || '') + '|' + (Array.isArray(d.options) ? d.options.join('|') : '')
}

// isWorkDirOverlayOpen: purely DERIVED from the read model
// (GET /api/chat/checkout via home.mjs's loadCheckout, refetched on the
// checkout.changed event). There is no "open" flag anywhere, and deliberately
// no URL param either: this is not a navigation position and not something to
// share, and the server-side assignment is the only source of truth — a param
// could show an overlay for a choice that no longer exists, or hide one that
// is genuinely open. Same reasoning as state.showApproved/autowarn in
// CLAUDE.md's URL-state section.
//
// Consequence, chosen deliberately by the reviewer (no `/`-menu entry was
// wanted): Escape's dismissal lasts until the page is reloaded or a DIFFERENT
// choice arrives, and until then the overlay itself cannot be reopened. The
// choice stays reachable through the checkout chip on nav stop 1
// (prInfoCard), which is unchanged.
export function isWorkDirOverlayOpen() {
  const fp = choiceFingerprint()
  return fp !== '' && wd.dismissed !== fp
}

// rows: the option list, plus the two always-available escapes. Deliberately
// parallel to home.mjs's checkoutChipCommandsFor (the chip's own small command
// menu) rather than shared with it: that one builds palette commands
// (withClose, hints, ids) for a different container, and both are three lines
// over the same read model.
function rows() {
  const d = decision()
  const out = []
  if (d && Array.isArray(d.options)) {
    d.options.forEach((opt) => out.push({ key: 'opt:' + opt, label: opt, run: () => answer(opt) }))
  }
  if (st && st.checkout && st.checkout.stashPending) {
    out.push({
      key: 'restore',
      label: t('Nu terugzetten (eerder opgeslagen wijziging)'),
      run: () => act('checkoutRestoreStash'),
    })
  }
  out.push({ key: 'choose', label: t('Andere werkmap kiezen'), run: () => act('checkoutRelist') })
  out.push({ key: 'off', label: t('Uit (geen werkmap koppelen)'), run: () => act('checkoutOff') })
  return out
}

// selIndex clamps rather than resetting on every change: a new choice can have
// a shorter option list than the one it replaced, and clamping keeps that
// correct without a watch (and without writing reactive state from inside a
// reactive read).
function selIndex() {
  const n = rows().length
  if (n === 0) return 0
  return Math.min(Math.max(wd.sel, 0), n - 1)
}

async function answer(opt) {
  await act('checkoutAnswer', opt)
}

// act does NOT close the overlay itself. The answer's real outcome arrives as
// checkout.changed -> loadCheckout -> no decision left -> isOpen() false, so
// what the reviewer sees always matches what the server actually stored; an
// optimistic close would hide a failed answer until the next refresh.
async function act(action, reply) {
  if (!sendAction || wd.busy) return
  wd.busy = true
  try {
    await sendAction(action, reply)
  } finally {
    wd.busy = false
  }
}

function dismiss() {
  wd.dismissed = choiceFingerprint()
}

export function handleWorkDirOverlayKeydown(e) {
  const list = rows()
  if (e.key === 'Escape') {
    e.preventDefault()
    dismiss()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    wd.sel = Math.min(selIndex() + 1, Math.max(list.length - 1, 0))
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    wd.sel = Math.max(selIndex() - 1, 0)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const row = list[selIndex()]
    if (row) row.run()
    return
  }
  // Every other key is swallowed on purpose: while this overlay is open it
  // owns the keyboard, so the review tree's own navigation never sees it.
}

// currentDirLine — what Claude uses right now, so the reviewer can tell
// "nothing assigned yet" from "assigned, but this choice is about something
// else". Always a string (never a template), so the slot's shape is stable.
function currentDirLine() {
  const c = st && st.checkout
  if (!c || !c.dir) return t('Nog geen werkmap gekoppeld.')
  return c.branch
    ? t('Nu: {dir} (branch {branch})', { dir: c.dir, branch: c.branch })
    : t('Nu: {dir}', { dir: c.dir })
}

function overlayPanel() {
  return html`
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 dark:bg-black/70 p-4"
      data-testid="workdir-overlay"
      @click="${() => dismiss()}"
    >
      <div
        class="w-full max-w-xl rounded-xl bg-white dark:bg-zinc-900 ring-1 ring-slate-200 dark:ring-zinc-700 shadow-xl"
        @click="${(e) => e && e.stopPropagation()}"
      >
        <div class="border-b border-slate-100 dark:border-zinc-800 px-4 py-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Werkmap voor deze PR')}</p>
          <p class="mt-1 text-[13px] text-slate-700 dark:text-zinc-300" data-testid="workdir-overlay-body">
            ${() => (decision() ? decision().body || '' : '')}
          </p>
          <p class="mt-1 text-[11px] text-slate-500 dark:text-zinc-400" data-testid="workdir-overlay-current">${() => currentDirLine()}</p>
        </div>
        <ul class="max-h-[60vh] overflow-y-auto p-2" data-testid="workdir-overlay-options">
          ${() =>
            rows().map((row, i) =>
              html`<li>
                <button
                  type="button"
                  data-testid="workdir-overlay-option"
                  data-active="${() => (selIndex() === i ? 'true' : 'false')}"
                  class="${() =>
                    'flex w-full items-start gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] ' +
                    (selIndex() === i
                      ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-200 ring-1 ring-indigo-300 dark:ring-indigo-500/40'
                      : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800')}"
                  @click="${(e) => {
                    if (e) e.stopPropagation()
                    wd.sel = i
                    row.run()
                  }}"
                >
                  <span class="w-3 shrink-0" aria-hidden="true">${() => (selIndex() === i ? '›' : '')}</span>
                  <span>${row.label}</span>
                </button>
              </li>`.key('workdir-row:' + row.key),
            )}
        </ul>
        <div class="flex items-center justify-between border-t border-slate-100 dark:border-zinc-800 px-4 py-2 text-[11px] text-slate-500 dark:text-zinc-400">
          <span data-testid="workdir-overlay-hint">${t('↑↓ kiezen · Enter bevestigen · Esc sluiten')}</span>
          <span data-testid="workdir-overlay-status">${() => (wd.busy ? t('Bezig…') : '')}</span>
        </div>
      </div>
    </div>
  `
}

// WorkDirOverlayHost — the top-level mount, sibling of MenuHost/
// ImageLightboxHost in home.mjs. Toggled inside a stable <div> root, per the
// "never key a template whose entire body is one toggling expression" pitfall
// in .claude/rules/arrowjs-pitfalls.md.
export default function WorkDirOverlayHost() {
  return html` <div>${() => (isWorkDirOverlayOpen() ? overlayPanel().key('workdir-overlay') : '')}</div> `
}
