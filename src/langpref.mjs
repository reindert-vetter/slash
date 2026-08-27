// langpref.mjs — the reviewer's LANGUAGE preference per output type, the write
// side of what src/i18n.mjs reads for the interface itself. Three kinds, two
// languages, Dutch by default:
//
//   - 'ui'      — the static interface copy (t(), src/i18n.mjs).
//   - 'explain' — the AI prose the reviewer reads about the code: the footer
//                 description, the risk check, the PR summary, "since last
//                 review", comment titles, the chat summary, the test report.
//   - 'reply'   — the body of a reply Claude drafts for a review comment, i.e.
//                 the text that ends up on GitHub under the reviewer's own
//                 name.
//
// Deliberately NOT a fourth kind for code/commits: those are always English
// (only the contents of a translation file keep their own language), a fixed
// rule in the prompts rather than a setting — the settings page shows it as a
// read-only row.
//
// A chat ANSWER also has no setting: it follows the language the reviewer typed
// in. See modules/langpref (Go) for the store and .claude/docs/settings-page.md
// for the whole mechanism.
//
// Same shape as autoingestpref.mjs: the value gates BACKEND behaviour (the
// language directive appended to a Claude call's system prompt), so it rides
// the sanctioned workflow-Signal write path — POST /api/workflows/lang_pref to
// ensure the one per-repo tracker exists, then
// POST .../signals/lang_pref {kind, lang} — never a direct write from here.
// Read side: GET /api/langpref.
import { reactive, html } from './vendor/arrow.js'
import { t, setUiLang } from './i18n.mjs'

export const langPref = reactive({ ui: 'nl', explain: 'nl', reply: 'nl', runId: null })

const LANGS = ['nl', 'en']

// Word, never colour alone (the reviewer is colourblind): the button's label IS
// the language name, and the flag-free glyph is a plain globe for both states.
const LANG_LABEL = { nl: 'Nederlands', en: 'Engels' }
const GLOBE_PATH = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c3 3 3 17 0 20m0-20c-3 3-3 17 0 20M2 12h20M3.5 7h17M3.5 17h17'

let ensured = null

// ensureLangPref ensures the tracker Execution exists (POST, idempotent) and
// loads the current preferences (GET) — called once per page load on
// /settings. Safe to call more than once (dedup via `ensured`).
export function ensureLangPref() {
  if (ensured) return ensured
  ensured = (async () => {
    try {
      const res = await fetch('/api/workflows/lang_pref', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.runId) langPref.runId = data.runId
      }
    } catch (err) {
      console.error('lang_pref ensure failed:', err)
    }
    await refreshLangPref()
  })()
  return ensured
}

async function refreshLangPref() {
  try {
    const res = await fetch('/api/langpref')
    if (!res.ok) return
    const data = await res.json()
    for (const kind of ['ui', 'explain', 'reply']) {
      if (LANGS.includes(data[kind])) langPref[kind] = data[kind]
    }
  } catch (err) {
    console.error('lang_pref refresh failed:', err)
  }
}

// toggleLang flips one kind between Dutch and English and persists it via the
// sanctioned Signal write path. Optimistic, mirroring cycleAutoIngestPref. For
// the 'ui' kind it then applies the new language locally — which reloads the
// page, see setUiLang — but only AFTER the Signal was accepted, so a failed
// write never leaves the interface in a language the server does not know
// about.
export async function toggleLang(kind) {
  const next = langPref[kind] === 'en' ? 'nl' : 'en'
  langPref[kind] = next
  if (!langPref.runId) await ensureLangPref()
  if (!langPref.runId) return
  try {
    const res = await fetch(`/api/workflows/${langPref.runId}/signals/lang_pref`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, lang: next }),
    })
    if (res.ok && kind === 'ui') setUiLang(next)
  } catch (err) {
    console.error('lang_pref toggle failed:', err)
  }
}

// langToggleButton renders one kind's Dutch/English switch, in the same pill
// shape as the theme/auto-ingest toggles it sits next to on the settings page.
export function langToggleButton(kind) {
  return html`
    <button
      type="button"
      data-testid="${'lang-toggle-' + kind}"
      title="${() =>
        langPref[kind] === 'en'
          ? t('Taal: Engels (klik voor Nederlands)')
          : t('Taal: Nederlands (klik voor Engels)')}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (langPref[kind] === 'en'
          ? 'text-indigo-700 dark:text-indigo-400 ring-indigo-200 dark:ring-indigo-500/30 hover:bg-indigo-50 dark:hover:bg-indigo-500/10'
          : 'text-slate-600 dark:text-zinc-300 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800')}"
      @click="${(e) => {
        if (e) e.stopPropagation()
        toggleLang(kind)
      }}"
    >
      <svg
        class="h-3 w-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="${GLOBE_PATH}"></path>
      </svg>
      <span>${() => t(LANG_LABEL[langPref[kind]])}</span>
    </button>
  `
}
