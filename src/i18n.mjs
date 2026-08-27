// i18n.mjs — the interface language ("nl" | "en") for every user-visible string
// in the frontend. One tiny layer, deliberately not a framework:
//
//   t('Onderliggende code')        → 'Onderliggende code' (nl) | 'Underlying code' (en)
//   t('{n} regels', { n: 12 })     → '12 regels'          | '12 lines'
//
// Three deliberate choices, each of which keeps this small:
//
//  1. THE DUTCH TEXT IS THE KEY. There is no key catalogue to invent, keep in
//     sync, or look up while reading a template — the source stays readable as
//     Dutch, and a string that has no entry in the dictionary simply renders as
//     itself. That also means every Playwright spec asserting Dutch copy keeps
//     passing untouched, because Dutch is the default and returns the key.
//  2. t() IS SYNCHRONOUS AND THE LANGUAGE IS FIXED FOR THE PAGE'S LIFETIME.
//     The chosen language is mirrored into localStorage exactly like the theme's
//     anti-flash script (see theme.mjs), so the very first paint already has it
//     without awaiting a fetch. Switching language RELOADS the page
//     (setUiLang) instead of re-rendering: arrow.js reuses a keyed node without
//     re-running its bindings (see .claude/rules/arrowjs-pitfalls.md), so a
//     live language swap would need every label to become a reactive binding —
//     a far bigger change than the one thing a reviewer does once.
//  3. THE SERVER IS THE SOURCE OF TRUTH, localStorage is only the paint cache.
//     The stored preference lives in modules/langpref (GET /api/langpref, one
//     row per output type), so it is not per-browser and so the language also
//     governs the backend's own AI output. syncUiLang() reconciles the cache
//     with the server once per page load and reloads if they disagree.
//
// A fixed Dutch phrase that reaches the UI from the Go side (a progress or
// failure message) is translated at its RENDER site through this very same
// dictionary: t(someBackendMessage) is a harmless pass-through when the exact
// phrase is not in the dictionary. A Go message with interpolated values is
// therefore NOT translated — an accepted limitation, noted in
// .claude/docs/settings-page.md.
import { EN } from './i18n/en.mjs'

const LANGS = ['nl', 'en']
const STORE_KEY = 'uiLang'

function readCached() {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return LANGS.includes(v) ? v : 'nl'
  } catch (err) {
    return 'nl'
  }
}

// Read ONCE at module load: t() must be synchronous, and a language that
// changed under a rendered page would only be half applied anyway (see the
// reload in setUiLang).
let current = readCached()

export function uiLang() {
  return current
}

// t translates one Dutch source string. `vars` fills `{name}` placeholders in
// the (translated) result, so a sentence with a number/name stays one
// translatable unit instead of being concatenated from fragments.
export function t(text, vars) {
  let out = current === 'en' && Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] : text
  if (vars) {
    for (const key of Object.keys(vars)) {
      out = out.split('{' + key + '}').join(String(vars[key]))
    }
  }
  return out
}

// setUiLang caches the language and reloads, so the whole page renders in it.
// It does NOT write to the server — that is the settings page's own job, via
// the sanctioned workflow-Signal path (see langpref.mjs); this function is what
// applies the result locally.
export function setUiLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return
  try {
    localStorage.setItem(STORE_KEY, lang)
  } catch (err) {
    console.error('uiLang store failed:', err)
  }
  location.reload()
}

// syncUiLang reconciles the paint cache with the server (GET /api/langpref).
// Called once per page load, fire-and-forget: it only ever acts when the two
// really disagree (another browser/tab changed the setting), in which case the
// page reloads once into the right language. A failed fetch leaves the cached
// language in place — offline is not a reason to flip languages.
export async function syncUiLang() {
  try {
    const res = await fetch('/api/langpref')
    if (!res.ok) return
    const data = await res.json()
    if (!LANGS.includes(data.ui) || data.ui === current) return
    setUiLang(data.ui)
  } catch (err) {
    console.error('uiLang sync failed:', err)
  }
}
