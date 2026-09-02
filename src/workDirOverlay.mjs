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
import { cancelClaudeTurn, hasActiveClaudeTurn } from './RelatedPanel.mjs'

// state/sendAction are injected once by home.mjs (initWorkDirOverlay) so the
// exported isOpen/handleKeydown hooks stay argument-free at the call site,
// exactly like initImageLightbox's own listener.
let st = null
let sendAction = null

// dismissed holds the fingerprint of the choice the reviewer pressed Escape
// on; busyKey holds the key (see rows() below) of the row currently running,
// '' while idle — used both to lock the rest of the list and to say WHICH
// option is in flight, not just a bare "Bezig…". steps mirrors the real git
// commands that option is running server-side (checkout_progress.go),
// polled while busyKey is set. Deliberately NOT persisted anywhere: not in
// localStorage, not in the URL (see openness rules below).
const wd = reactive({ dismissed: '', busyKey: '', steps: [], sel: 0 })

// progressTimer drives the poll loop below — a plain module variable, not
// reactive state, exactly like the other timer/handle module lets in this
// codebase (e.g. RelatedPanel.mjs's refreshTimer).
let progressTimer = null

// startProgressPolling/stopProgressPolling: GET /api/chat/checkout/progress
// is a plain in-memory read (see checkout_progress.go) of the real `git`
// commands the in-flight checkout-menu Activity is running — polled only
// while an answer is actually in flight, stopped the moment it settles (act()
// below), so this never runs idly while the overlay is just sitting open.
function stopProgressPolling() {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

function startProgressPolling() {
  stopProgressPolling()
  wd.steps = []
  const pr = st && st.pr
  if (!pr) return
  const repoParam = st && st.repo ? '&repo=' + encodeURIComponent(st.repo) : ''
  const poll = async () => {
    try {
      const res = await fetch(`/api/chat/checkout/progress?pr=${pr}${repoParam}`)
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.steps)) wd.steps = data.steps
    } catch (_) {
      /* best-effort, same as every other poll in this app */
    }
  }
  poll()
  progressTimer = setInterval(poll, 350)
}

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
    d.options.forEach((opt) => {
      const key = 'opt:' + opt
      out.push({ key, label: opt, run: () => act('checkoutAnswer', opt, key) })
    })
  }
  if (st && st.checkout && st.checkout.stashPending) {
    out.push({
      key: 'restore',
      label: t('Nu terugzetten (eerder opgeslagen wijziging)'),
      run: () => act('checkoutRestoreStash', undefined, 'restore'),
    })
  }
  out.push({ key: 'choose', label: t('Andere werkmap kiezen'), run: () => act('checkoutRelist', undefined, 'choose') })
  out.push({ key: 'off', label: t('Uit (geen werkmap koppelen)'), run: () => act('checkoutOff', undefined, 'off') })
  // "Chat pauzeren" — deliberately last, and deliberately NOT one of the
  // options above: it does not answer the werkmap question at all, it just
  // stops the currently anchored conversation's own running turn (the same
  // cancelClaudeTurn()/POST /api/chat/cancel the "Stop"-button and "Stop deze
  // Claude-beurt" palette item already call, see .claude/docs/claude-chat-panel.md),
  // so it never goes through act()/sendAction and never locks/dismisses this
  // overlay. hasActiveClaudeTurn() is per the currently ANCHORED conversation
  // (RelatedPanel.mjs), so this can legitimately be a no-op most of the time
  // — the werkmap question is PR-wide and can arrive while the visible
  // conversation's own turn already finished (see the "Ik kan nu geen code
  // aanpassen" dead-end reply). The colourblind rule applies here too: the
  // "nothing to stop" state is carried by the LABEL WORDING and the real
  // `disabled` attribute/dimmed shape (see rowClass below), never by colour
  // alone.
  const pauseActive = hasActiveClaudeTurn()
  out.push({
    key: 'pauseChat',
    label: pauseActive ? t('Chat pauzeren (stopt de lopende beurt)') : t('Chat pauzeren (er loopt nu niets)'),
    disabled: !pauseActive,
    run: () => {
      if (pauseActive) cancelClaudeTurn()
    },
  })
  return out
}

// busyRow/busyLabel — the ONE row currently in flight, if any. Read by both
// the footer status and the row template below, so they never name two
// different actions.
function busyRow() {
  if (!wd.busyKey) return null
  return rows().find((row) => row.key === wd.busyKey) || null
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

// act does NOT close the overlay itself. The answer's real outcome arrives as
// checkout.changed -> loadCheckout -> no decision left -> isOpen() false, so
// what the reviewer sees always matches what the server actually stored; an
// optimistic close would hide a failed answer until the next refresh.
//
// key identifies WHICH row this call is for (rows() above always passes its
// own key) — recorded on wd.busyKey so the template can single out that one
// row instead of a generic "something is happening" state, and used to poll
// GET /api/chat/checkout/progress for that same action's real git commands
// (checkout_progress.go) for the duration of the request.
async function act(action, reply, key) {
  if (!sendAction || wd.busyKey) return
  wd.busyKey = key || action
  startProgressPolling()
  try {
    await sendAction(action, reply)
  } finally {
    stopProgressPolling()
    wd.busyKey = ''
    wd.steps = []
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
  // While an answer is in flight the list is locked (see the busyKey guard in
  // act() above) — swallow navigation/confirm too, so ↑/↓/Enter can't queue
  // up a second row against a menu that visually shows only one is running.
  if (wd.busyKey) {
    e.preventDefault()
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

// rowClass — the whole class-attribute value for one option button, computed
// outside the template (the arrow.js "an attribute value with ANY ${...}
// must be the whole value" rule, .claude/rules/arrowjs-pitfalls.md): the busy
// row itself keeps the normal "selected" look (plus its own spinner/label
// suffix in the template below), every OTHER row visibly dims and stops
// accepting clicks while something is running, and the ordinary
// selected/unselected split applies only while idle.
function rowClass(row, i) {
  const base = 'flex w-full items-start gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] '
  if (wd.busyKey === row.key) {
    return base + 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-200 ring-1 ring-indigo-300 dark:ring-indigo-500/40'
  }
  if (wd.busyKey) {
    return base + 'opacity-40 text-slate-400 dark:text-zinc-600'
  }
  // row.disabled — currently only the "Chat pauzeren" row, when there is no
  // running turn to stop. Same dimmed look as the busyKey-locked branch above
  // (shape, not colour, carries the "cannot interact" meaning), plus the
  // wording change in rows() above.
  if (row.disabled) {
    return base + 'opacity-40 text-slate-400 dark:text-zinc-600 cursor-not-allowed'
  }
  return (
    base +
    (selIndex() === i
      ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-200 ring-1 ring-indigo-300 dark:ring-indigo-500/40'
      : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800')
  )
}

// progressPanel — the live log of real git commands the in-flight action is
// running (checkout_progress.go via GET /api/chat/checkout/progress), the
// answer to "laten zien wat het echt doet": not just a label repeated, the
// actual `git stash push …`/`git add -A`/… lines and whether each one
// succeeded. Rendered only while there is at least one step (see its stable
// `<div class="contents">` wrapper below — the toggling-template pitfall in
// .claude/rules/arrowjs-pitfalls.md), most recent last, capped to the last 6
// so a long-running relist doesn't grow the overlay unbounded. Keyed by each
// step's own position in the FULL log (assigned before slicing) rather than
// its timestamp — two git calls can legitimately land in the same
// millisecond.
function progressPanel() {
  const recent = wd.steps.map((step, i) => ({ step, i })).slice(-6)
  return html`
    <div class="border-t border-slate-100 dark:border-zinc-800 px-4 py-2" data-testid="workdir-overlay-progress">
      <ul class="max-h-28 overflow-y-auto space-y-0.5 font-mono text-[11px] text-slate-500 dark:text-zinc-400">
        ${recent.map(
          ({ step, i }) =>
            html`<li
              data-testid="workdir-overlay-progress-step"
              data-ok="${step.ok ? 'true' : 'false'}"
              class="${step.ok ? 'truncate' : 'truncate text-rose-600 dark:text-rose-400'}"
            >
              <span aria-hidden="true">${step.ok ? '✓' : '✗'}</span> ${step.cmd}
            </li>`.key('workdir-step:' + i),
        )}
      </ul>
    </div>
  `
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
                  data-busy="${() => (wd.busyKey === row.key ? 'true' : 'false')}"
                  disabled="${() => wd.busyKey !== '' || !!row.disabled}"
                  class="${() => rowClass(row, i)}"
                  @click="${(e) => {
                    if (e) e.stopPropagation()
                    wd.sel = i
                    row.run()
                  }}"
                >
                  <span class="w-3 shrink-0" aria-hidden="true">${() => (wd.busyKey === row.key ? '⟳' : selIndex() === i ? '›' : '')}</span>
                  <span>${() => (wd.busyKey === row.key ? row.label + '…' : row.label)}</span>
                </button>
              </li>`.key('workdir-row:' + row.key),
            )}
        </ul>
        <div class="contents">${() => (wd.steps.length ? progressPanel().key('workdir-progress') : '')}</div>
        <div class="flex items-center justify-between border-t border-slate-100 dark:border-zinc-800 px-4 py-2 text-[11px] text-slate-500 dark:text-zinc-400">
          <span data-testid="workdir-overlay-hint">${t('↑↓ kiezen · Enter bevestigen · Esc sluiten')}</span>
          <span data-testid="workdir-overlay-status">${() => (busyRow() ? t('Bezig: {label}…', { label: busyRow().label }) : '')}</span>
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
