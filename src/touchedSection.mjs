// touchedSection.mjs — whether /pr-overview has the "Migrations & API changes"
// section at all (default OFF). When off the server neither builds that list
// nor auto-generates review trees for its rows (touchedsection.go).
//
// Read via GET /api/touchedsection, written via the app_settings tracker
// Signal (Kind "touchedSection") — never a direct write. See
// .claude/docs/settings-page.md.
import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

export const touchedSection = reactive({ show: false })

try {
  const res = await fetch('/api/touchedsection')
  if (res.ok) touchedSection.show = (await res.json()).show === true
} catch (err) {
  console.error('touchedsection load failed:', err)
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

// Only the settings page toggles this; /pr-overview gets the effect from the
// server (the section is simply absent from /api/inbox while off).
export async function toggleTouchedSection() {
  const next = !touchedSection.show
  const id = await ensureRun()
  if (!id) return
  try {
    const res = await fetch('/api/workflows/' + encodeURIComponent(id) + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'touchedSection', showTouchedSection: next }),
    })
    if (res.ok) touchedSection.show = next
  } catch (err) {
    console.error('save touched section failed:', err)
  }
}

export function touchedSectionToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="touched-section-toggle"
      title="${() =>
        t('Migraties & API-lijst: {state} — de sectie "Migrations & API changes" op het PR-overzicht (klik om te wisselen)', {
          state: t(touchedSection.show ? 'aan' : 'uit'),
        })}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (touchedSection.show
          ? 'text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30 hover:bg-sky-50 dark:hover:bg-sky-500/10'
          : 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800') +
        ' ' +
        cls}"
      @click="${toggleTouchedSection}"
    >
      <span
        data-testid="touched-section-toggle-dot"
        class="${() =>
          'inline-block h-2 w-2 shrink-0 rounded-full ' +
          (touchedSection.show ? 'bg-sky-500' : 'border border-slate-400 dark:border-zinc-500')}"
      ></span>
      <span>${() => t(touchedSection.show ? 'Lijst aan' : 'Lijst uit')}</span>
    </button>
  `
}
