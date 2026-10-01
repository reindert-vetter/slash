// blankRows.mjs — the "show whitespace lines" display setting: whether a
// blank/whitespace-only CHANGED diff row is a real, selectable, approvable row
// (default ON) or diff noise that is skipped (Block.mjs rowHasContent).
//
// Stored server-side (<dataDir>/blank-rows.json) because the Go approve total
// (blockstats.go rowHasContent) must agree with the browser's. Read via
// GET /api/blankrows, written via the app_settings tracker Signal (Kind
// "blankRows") — never a direct write. See .claude/docs/settings-page.md.
import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

export const blankRows = reactive({ show: true })

// Plain (non-reactive) read for Block.mjs's row maths: rows are derived data,
// so the value must be known BEFORE any block renders — hence the top-level
// await below rather than a late-arriving reactive update.
export function blankRowsShown() {
  return blankRows.show
}

try {
  const res = await fetch('/api/blankrows')
  if (res.ok) blankRows.show = (await res.json()).show !== false
} catch (err) {
  console.error('blankrows load failed:', err)
}

let runId = null
async function ensureRun() {
  if (runId) return runId
  try {
    const res = await fetch('/api/workflows/app_settings', { method: 'POST' })
    if (res.ok) runId = (await res.json()).runId || null
  } catch (err) {
    console.error('app_settings ensure failed:', err)
  }
  return runId
}

// Only the settings page toggles this; the review tree reads the value at its
// own page load, so no live re-derivation is needed.
export async function toggleBlankRows() {
  const next = !blankRows.show
  const id = await ensureRun()
  if (!id) return
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(id) + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'blankRows', showBlankRows: next }),
    })
    if (res.ok) blankRows.show = next
  } catch (err) {
    console.error('save blank rows failed:', err)
  }
}

export function blankRowsToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="blank-rows-toggle"
      title="${() =>
        t('Witregels: {state} — lege regels in een diff zijn selecteerbaar en tellen mee (klik om te wisselen)', {
          state: t(blankRows.show ? 'aan' : 'uit'),
        })}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (blankRows.show
          ? 'text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30 hover:bg-sky-50 dark:hover:bg-sky-500/10'
          : 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800') +
        ' ' +
        cls}"
      @click="${toggleBlankRows}"
    >
      <span
        data-testid="blank-rows-toggle-dot"
        class="${() =>
          'inline-block h-2 w-2 shrink-0 rounded-full ' +
          (blankRows.show ? 'bg-sky-500' : 'border border-slate-400 dark:border-zinc-500')}"
      ></span>
      <span>${() => t(blankRows.show ? 'Witregels aan' : 'Witregels uit')}</span>
    </button>
  `
}
