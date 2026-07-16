// CommandMenu — a searchable command palette. Shown as an overlay on the
// next-block preview slot when the reviewer presses `/` (see home.mjs). It's a
// pure presentational component: it takes the shared `menu` reactive
// ({ open, query, sel }), the list of commands, and an `onRun` callback, and
// renders a filtered, keyboard-navigable list. It owns no navigation logic of
// its own — home.mjs builds the commands (they close over its nav functions) and
// drives selection from the global keydown handler, so this stays generic.

import { html } from './vendor/arrow.js'

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

// commandRow — one entry. Clicking runs it; hovering moves the selection so
// mouse and keyboard share one highlighted row.
function commandRow(c, i, menu, onRun) {
  return html`
    <button
      class="${() =>
        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition ' +
        (menu.sel === i
          ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-1 ring-indigo-200 dark:ring-indigo-500/30'
          : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800/60')}"
      data-testid="command-row"
      @click="${() => onRun(c)}"
      @mousemove="${() => (menu.sel = i)}"
    >
      <span class="flex-1 truncate">${() => labelOf(c)}</span>
      ${() =>
        c.hint
          ? html`<span
              class="shrink-0 rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 dark:text-zinc-500"
              >${c.hint}</span
            >`
          : ''}
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
export default function CommandMenu(menu, resolve, onRun) {
  return html`
    <div
      class="flex max-h-72 min-h-0 w-full flex-col overflow-hidden rounded-xl border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-zinc-900 shadow-2xl ring-1 ring-indigo-500/20"
      data-testid="command-menu"
    >
      <div class="flex items-start gap-2 border-b border-slate-100 dark:border-zinc-800/60 px-3 py-2">
        <span class="mt-1.5 font-mono text-sm font-bold text-indigo-400">/</span>
        <textarea
          class="min-h-[1.8rem] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-slate-800 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none"
          rows="1"
          placeholder="Zoek een commando of schrijf direct een comment…"
          data-testid="command-input"
          value="${() => menu.query}"
          @input="${(e) => {
            menu.query = e.target.value
            menu.sel = 0
          }}"
        ></textarea>
        <span class="mt-1 shrink-0 rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 dark:text-zinc-500"
          >esc</span
        >
      </div>
      <div
        class="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5"
        data-testid="command-list"
      >
        ${() => {
          const list = resolve(menu.query)
          if (list.length === 0) {
            return html`<p class="px-2.5 py-3 text-[11px] text-slate-400 dark:text-zinc-500">Geen commando's.</p>`
          }
          return list.map((c, i) => commandRow(c, i, menu, onRun).key('cmd:' + c.id))
        }}
      </div>
    </div>
  `
}
