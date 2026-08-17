// CommandMenu — a searchable command palette. Shown as an overlay on the
// next-block preview slot when the reviewer presses `/` (see home.mjs). It's a
// pure presentational component: it takes the shared `menu` reactive
// ({ open, query, sel }), the list of commands, and an `onRun` callback, and
// renders a filtered, keyboard-navigable list. It owns no navigation logic of
// its own — home.mjs builds the commands (they close over its nav functions) and
// drives selection from the global keydown handler, so this stays generic.

import { html, watch } from './vendor/arrow.js'

// labelOf resolves a command's label, which may be a plain string or a function
// (so a toggle command like approve can show a live label).
function labelOf(c) {
  return typeof c.label === 'function' ? c.label() : c.label
}

// fuzzy reports whether `q` is a subsequence of `text` (chars in order, gaps
// allowed) — the classic command-palette match, so "opgh" finds "Open op GitHub".
function fuzzy(q, text) {
  if (!q) return true
  let i = 0
  for (const ch of text) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

// filterCommands returns the commands matching `query` (order preserved). Exported
// so home.mjs's keyboard handler walks the exact same list the menu renders, keeping
// menu.sel and the visible rows in lockstep.
export function filterCommands(commands, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => fuzzy(q, (labelOf(c) + ' ' + (c.hint || '')).toLowerCase()))
}

// commandIcon renders a small inline icon before a command's label, keyed on
// c.icon (a plain string tag — 'approve-pr' or 'reject-pr'). Colorblind rule:
// the SHAPE is what carries the meaning here — a check mark inside a circle
// for approve, an X inside a circle for reject — the emerald/rose color is
// decoration on top of it — never the sole carrier — mirroring the existing
// warning-triangle + text convention (aiWarningBadge/related-covers-warning
// in RelatedPanel.mjs). Returns '' for no/unknown icon, same shape as the
// existing c.hint slot below.
function commandIcon(icon) {
  if (icon === 'approve-pr') {
    return html`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      data-testid="command-icon-approve-pr"
    >
      <circle cx="12" cy="12" r="9"></circle>
      <path d="m8 12 3 3 5-6"></path>
    </svg>`
  }
  if (icon === 'reject-pr') {
    return html`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400"
      data-testid="command-icon-reject-pr"
    >
      <circle cx="12" cy="12" r="9"></circle>
      <path d="m9 9 6 6"></path>
      <path d="m15 9-6 6"></path>
    </svg>`
  }
  return ''
}

// commandRow — one entry. Clicking runs it; hovering moves the selection so
// mouse and keyboard share one highlighted row. data-cmd-idx (static — `i`
// never changes for a given row) is only read by scrollSelectedRowIntoView
// below, to find the currently highlighted row after a keyboard step.
// `native` (only true for the right-click context menu, see the default
// export below) shrinks the row's vertical padding AND swaps the highlight
// color to a macOS/Chrome-style solid blue (bg-blue-500 text-white) instead
// of the keyboard palette's indigo tint — see CommandMenu's own doc comment
// for why this variant exists at all. The right-hand hint badge (c.hint —
// "approve"/"task"/"claude"/"github", styled like the header's "esc" badge)
// is dropped entirely, in both variants: reviewer request, it named nothing a
// mouse or keyboard user needed to read to use the row. A `native` row with
// `c.children` gets a trailing `›` chevron — the standard macOS submenu
// affordance — the real palette has no equivalent (its own submenu still
// just replaces the list in place, see enterSubmenu in home.mjs).
function commandRow(c, i, menu, onRun, native) {
  return html`
    <button
      class="${() =>
        'flex w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition ' +
        (native ? 'py-1' : 'py-2') +
        ' ' +
        (menu.sel === i
          ? native
            ? 'bg-blue-500 text-white'
            : 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      data-testid="command-row"
      data-cmd-idx="${i}"
      @click="${() => onRun(c)}"
      @mousemove="${() => (menu.sel = i)}"
    >
      ${() => (c.icon ? commandIcon(c.icon) : '')}
      <span class="flex-1 truncate">${() => labelOf(c)}</span>
      ${() => (native && c.children ? html`<span class="shrink-0 text-xs opacity-70">›</span>` : '')}
    </button>
  `
}

/**
 * @param {object} menu - shared reactive { open, query, sel } owned by home.mjs.
 * @param {(query:string)=>Array} resolve - returns the commands to show for the
 *   current query (filtering + any fallback lives in the caller, so this component
 *   stays generic). Each command is { id, label, hint, run }; label may be a function.
 * @param {(cmd:object)=>void} onRun - runs a command (closes the menu, then acts).
 * @returns arrow.js template.
 */
export default function CommandMenu(menu, resolve, onRun, opts = {}) {
  // `native` is the right-click context-menu variant (home.mjs's
  // handleContextMenu family) — see the file-level rewrite of "A mouse
  // selection shows the palette passively" into "The right-click context
  // menu" in command-palette.md. It replaced the earlier mouse-selection
  // `passive` preview outright (removed, not renamed alongside — that
  // feature no longer exists at all), but keeps the exact same shape: a
  // second, purely presentational mode of the same keyboard-owning
  // `CommandMenu`/`openMenu`, never a second implementation.
  const native = !!opts.native
  // Keyboard ↑/↓ (menu.sel, home.mjs's onKeydown) never used to scroll the
  // highlighted row into view — command-list is a fixed max-h-72 box with its
  // scrollbar hidden (no-scrollbar), so arrowing past the visible rows left
  // the reviewer's own selection invisible below the card's rounded bottom
  // edge (reported: "menu is niet volledig zichtbaar"). CommandMenu() runs
  // fresh on every open (a toggling template↔'' slot, see menuOverlay in
  // home.mjs, never a reused chunk), so this watch is set up once per open and
  // left dormant — never disposed — once the menu closes, same accepted shape
  // as the `ms` swap documented in command-palette.md (it only ever reads
  // this open's own `menu.sel`, never touched again after close, so it can't
  // become an actively-growing leak like an orphan binding on global state
  // would). command-list is its own vertical-only scrolling box (not nested in
  // <main>'s horizontal scroller), so a plain scrollIntoView({block:'nearest'})
  // is safe here — see the scrollIntoView axis rule in arrowjs-pitfalls.md.
  watch(
    () => menu.sel,
    (sel) => {
      const list = document.querySelector('[data-testid="command-list"]')
      const el = list && list.querySelector(`[data-cmd-idx="${sel}"]`)
      if (el) el.scrollIntoView({ block: 'nearest' })
    },
  )
  // The search field stays present in the `native` variant too (reviewer:
  // "direct input selecteren", typing must work immediately on open) — this
  // is a styling/positioning variant of the SAME searchable palette, not a
  // second, input-less implementation. What `native` actually changes: the
  // box's width/row padding/highlight colour (macOS blue vs. the palette's
  // indigo), the position (the cursor point vs. an anchored diff-row/region,
  // see positionNativeMenu in home.mjs), and — like the removed passive
  // preview before it — no pinned "Sluit menu" row (reviewer: "niet nodig als
  // ik met rechtermuisknop open doe"; Esc/an outside click still close it).
  return html`
    <div
      class="${() =>
        native
          ? 'flex max-h-72 min-h-0 min-w-[220px] max-w-xs flex-col overflow-hidden rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-800 py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10'
          : 'flex max-h-72 min-h-0 w-full flex-col overflow-hidden rounded-xl border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-zinc-900 shadow-2xl ring-1 ring-indigo-500/20'}"
      data-testid="command-menu"
    >
      <div class="flex items-start gap-2 border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2">
        <span class="mt-1.5 font-mono text-sm font-bold text-indigo-400">/</span>
        <textarea
          class="no-scrollbar min-h-[1.8rem] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-slate-800 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
          rows="1"
          placeholder="${() =>
            // The compose-kind menu anchors on the (narrow) comment pane, where
            // the generic placeholder gets cut off mid-sentence without an
            // ellipsis (a textarea placeholder wraps out of view instead of
            // truncating) — so that mode gets a shorter prompt that fits.
            menu.mode === 'compose'
              ? 'Kies wat er met je comment gebeurt…'
              : // reviewReject (home.mjs) has no static command list — the
                // textarea itself IS the rejection-reason input, and
                // resolveCommands only offers a "submit" row once it's
                // non-blank (GitHub/the backend reject an empty
                // REQUEST_CHANGES body). The placeholder doubles as the
                // instruction, since there's no other label for this step.
                menu.mode === 'reviewReject'
                ? 'Typ de reden voor afwijzing (verplicht)…'
                : 'Zoek een commando of schrijf direct een comment…'}"
          data-testid="command-input"
          value="${() => menu.query}"
          @input="${(e) => {
            menu.query = e.target.value
            menu.sel = 0
          }}"
        ></textarea>
        <span
          class="mt-1 shrink-0 rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 dark:text-zinc-500"
          >esc</span
        >
      </div>
      <div
        class="${() =>
          'no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto ' + (native ? 'px-1 py-0.5' : 'p-1.5')}"
        data-testid="command-list"
      >
        ${() => {
          // `resolve` (home.mjs's resolveCommands) already drops the pinned
          // "Sluit menu" row for a native menu — see its own doc comment for
          // why that filter lives there and not here: onKeydown's ↑/↓/Enter
          // index into the exact same list this renders, so there must be
          // only one place that decides which rows exist at all.
          const list = resolve(menu.query)
          if (list.length === 0) {
            // A keyed array-of-one, not a single bare element — see "A slot
            // that switches between a single element and a keyed array
            // freezes" in arrowjs-pitfalls.md.
            return [
              html`<p class="px-2.5 py-3 text-[11px] text-slate-400 dark:text-zinc-500">Geen commando's.</p>`.key(
                'no-commands',
              ),
            ]
          }
          return list.map((c, i) => commandRow(c, i, menu, onRun, native).key('cmd:' + c.id))
        }}
      </div>
    </div>
  `
}
