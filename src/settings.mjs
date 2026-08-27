// settings.mjs — the ONE general settings page (`/settings`), reached via a
// gear-icon entry button placed next to the theme toggle on both /pr/<id>
// (prInfoCard's pr-info-theme-row, home.mjs) and /pr-overview (headerBlock,
// overview.mjs). Day one deliberately carries EVERYTHING that already existed
// scattered across those two pages — theme, Live AI assistent, the local
// checkout directory, praise-words, and "wie ben ik" — plus its own
// keyboard-navigable row list and a `?from=` round trip back to wherever the
// reviewer came from. See .claude/docs/settings-page.md for the full
// mechanism and the per-setting source/write-path table.
import { reactive, html } from './vendor/arrow.js'
import { initTheme, themeToggleButton, cycleTheme } from './theme.mjs'
import { ensureAutoWarn, autoWarnToggleButton, toggleAutoWarn } from './autowarn.mjs'
import { ensureAutoIngestPref, autoIngestPrefToggleButton, cycleAutoIngestPref } from './autoingestpref.mjs'
import { ensureMe, meLogin } from './avatar.mjs'
import { initDebugLog, debugModeToggleButton, toggleDebugMode, clearDebugLog, debugLogCount } from './debugLog.mjs'
import { ensureLangPref, langToggleButton, toggleLang } from './langpref.mjs'
import { t, syncUiLang } from './i18n.mjs'
import { originFrom, originPr } from './settingsLink.mjs'

initTheme()
initDebugLog()

function goBack() {
  location.href = originFrom
}

// ── page state ───────────────────────────────────────────────────────────

const state = reactive({
  loading: true,
  activeRow: 0, // index into ROWS
  editing: null, // null | 'aliases' | 'praisewords' — which row owns a focused text input
  aliases: [],
  praiseWords: [],
  appSettingsRunId: '',
  checkoutLoading: originPr != null,
  checkout: null, // the batch-fetched checkoutView for originPr, or null
  // `me` (avatar.mjs) is a plain, non-reactive object — reading it directly
  // from a template binding would freeze at whatever it held at mount time
  // (see "Timing is load-bearing" in conventions.md). Mirrored into this
  // reactive field once ensureMe() resolves, in init() below.
  githubLogin: '',
  // How many lines the debug recording currently holds (GET /api/debug/log) —
  // shown on the debug row so the reviewer can see it really is recording.
  debugCount: 0,
})

// Row order IS the ↑/↓ nav order, and IS the DOM order rendered below — kept
// as one array so the two can never drift apart.
const ROWS = [
  'theme',
  'langui',
  'langexplain',
  'langreply',
  'langcommit',
  'autowarn',
  'autoingestpref',
  'debug',
  'checkout',
  'aliases',
  'praisewords',
]

// ── data loading ─────────────────────────────────────────────────────────

async function ensureAppSettingsRun() {
  if (state.appSettingsRunId) return state.appSettingsRunId
  try {
    const res = await fetch('/api/workflows/app_settings', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      if (data.runId) state.appSettingsRunId = data.runId
    }
  } catch (err) {
    console.error('app_settings ensure failed:', err)
  }
  return state.appSettingsRunId
}

async function loadAliases() {
  try {
    const res = await fetch('/api/settings')
    if (res.ok) {
      const data = await res.json()
      state.aliases = (data.me && data.me.aliases) || []
    }
  } catch (err) {
    console.error('settings load failed:', err)
  }
}

async function loadPraiseWords() {
  try {
    const res = await fetch('/api/praisewords')
    if (res.ok) {
      const data = await res.json()
      state.praiseWords = data.words || []
    }
  } catch (err) {
    console.error('praisewords load failed:', err)
  }
}

async function loadCheckout() {
  if (originPr == null) return
  state.checkoutLoading = true
  try {
    const res = await fetch('/api/chat/checkout?prs=' + originPr)
    if (res.ok) {
      const data = await res.json()
      state.checkout = (data.checkout && data.checkout[String(originPr)]) || null
    }
  } catch (err) {
    console.error('checkout load failed:', err)
  } finally {
    state.checkoutLoading = false
  }
}

async function refreshDebugCount() {
  state.debugCount = await debugLogCount()
}

async function init() {
  await ensureMe()
  state.githubLogin = meLogin()
  await Promise.all([loadAliases(), loadPraiseWords(), loadCheckout(), refreshDebugCount()])
  state.loading = false
}

// clearLog empties the recording through the same one-shot debug_log workflow
// the recording itself uses — never a direct write. Awaits the count refresh so
// the row reflects the truth rather than an optimistic 0.
async function clearLog() {
  await clearDebugLog()
  await refreshDebugCount()
}

// ── write paths ───────────────────────────────────────────────────────────
// Both go through the sanctioned app_settings tracker Signal — never a direct
// write — per .claude/rules/workflows-write-boundary.md. See
// .claude/docs/settings-page.md for why aliases/praise-words needed a new
// write path at all (settings.json/praise-words.json used to be read-only,
// hand-edited files).

async function saveAliases(next) {
  state.aliases = next // optimistic, mirrors autowarn.mjs's toggleAutoWarn
  const runId = await ensureAppSettingsRun()
  if (!runId) return
  try {
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'aliases', aliases: next }),
    })
  } catch (err) {
    console.error('save aliases failed:', err)
  }
}

async function savePraiseWords(next) {
  state.praiseWords = next
  const runId = await ensureAppSettingsRun()
  if (!runId) return
  try {
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'praiseWords', praiseWords: next }),
    })
  } catch (err) {
    console.error('save praise words failed:', err)
  }
}

// addAlias/addPraiseWord read the input's DOM value directly and clear it
// imperatively (`el.value = ''`) rather than a reactive `.value="${...}"`
// binding — deliberately, the same uncontrolled-input shape
// RelatedPanel.mjs's composer uses (see its comment on prefillField): a
// reactive value binding here would re-run on ANY unrelated rerender of this
// page (e.g. the theme/auto-warn toggle, an alias chip being added) and could
// reset the caret mid-typing.
function addAlias(inputEl) {
  const v = (inputEl.value || '').trim()
  inputEl.value = ''
  if (!v) return
  saveAliases([...state.aliases, v])
}

function removeAlias(idx) {
  saveAliases(state.aliases.filter((_, i) => i !== idx))
}

function addPraiseWord(inputEl) {
  const v = (inputEl.value || '').trim()
  inputEl.value = ''
  if (!v) return
  savePraiseWords([...state.praiseWords, v])
}

// A praise word may never be removed down to zero — the server would just
// silently fall back to the built-in defaults (savePraiseWordsFile,
// praisewords.go), and the HTTP handler rejects an empty submission outright.
// Blocking it here (rather than surfacing that 400) keeps the UI honest about
// what will actually happen.
function removePraiseWord(idx) {
  if (state.praiseWords.length <= 1) return
  savePraiseWords(state.praiseWords.filter((_, i) => i !== idx))
}

// ── keyboard: ↑/↓ over the row list, Enter/Space runs that row's primary
// action (exactly what a click on it runs — mouse-navigation.md), ← goes
// back to originFrom. Escape, while a text input owns focus, blurs back to
// row navigation (mirrors home.mjs's own input-focus guard). ─────────────

function focusRowInput(row) {
  const el = document.querySelector('[data-testid="settings-' + row + '-input"]')
  if (el) el.focus()
}

function activateRow(row) {
  if (row === 'theme') {
    // Same function a click on themeToggleButton runs.
    cycleTheme()
  } else if (row === 'langui') {
    toggleLang('ui')
  } else if (row === 'langexplain') {
    toggleLang('explain')
  } else if (row === 'langreply') {
    toggleLang('reply')
  } else if (row === 'autowarn') {
    toggleAutoWarn()
  } else if (row === 'autoingestpref') {
    cycleAutoIngestPref()
  } else if (row === 'debug') {
    // Same function a click on debugModeToggleButton runs.
    toggleDebugMode()
  } else if (row === 'aliases') {
    state.editing = 'aliases'
    requestAnimationFrame(() => focusRowInput('aliases'))
  } else if (row === 'praisewords') {
    state.editing = 'praisewords'
    requestAnimationFrame(() => focusRowInput('praisewords'))
  }
  // 'checkout' is read-only on this page (see checkoutRow) — no action, and
  // neither is 'langcommit': code/commits are always English by rule, so that
  // row has nothing to toggle (see langCommitRow).
}

function moveRow(delta) {
  state.activeRow = Math.max(0, Math.min(ROWS.length - 1, state.activeRow + delta))
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="settings-row-' + ROWS[state.activeRow] + '"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

window.addEventListener('keydown', (e) => {
  const active = document.activeElement
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    if (e.key === 'Escape') {
      active.blur()
      state.editing = null
    }
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveRow(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveRow(-1)
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activateRow(ROWS[state.activeRow])
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    goBack()
  }
})

// ── rendering ─────────────────────────────────────────────────────────────

function rowCls(row) {
  const base = 'rounded-xl border p-4 transition-colors '
  return (
    base +
    (state.activeRow === ROWS.indexOf(row)
      ? 'border-indigo-300 dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30 bg-white dark:bg-zinc-900'
      : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900')
  )
}

function rowLabel(title, sub) {
  return html`<div class="mb-2">
    <div class="text-sm font-semibold text-slate-900 dark:text-zinc-100">${title}</div>
    ${sub ? html`<div class="mt-0.5 text-[12px] text-slate-500 dark:text-zinc-500">${sub}</div>` : ''}
  </div>`
}

function themeRow() {
  return html`<div data-testid="settings-row-theme" class="${() => rowCls('theme')}" @click="${() => (state.activeRow = ROWS.indexOf('theme'))}">
    ${rowLabel(t('Thema'), t('Systeem / licht / donker — opgeslagen in deze browser.'))}
    <div class="flex items-center gap-2">${themeToggleButton('h-8 w-8 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}</div>
  </div>`
}

// One row per translatable output type — the reviewer's "je moet per type
// kunnen vertalen". Each row's Enter/Space runs exactly the function its own
// button's click runs (see activateRow), per the mouse-navigation convention.
function langRow(row, kind, title, sub) {
  return html`<div data-testid="${'settings-row-' + row}" class="${() => rowCls(row)}" @click="${() => (state.activeRow = ROWS.indexOf(row))}">
    ${rowLabel(t(title), t(sub))} ${langToggleButton(kind)}
  </div>`
}

// The commit language is deliberately NOT a setting: code, identifiers, code
// comments and commit messages are always English, enforced in the prompts
// (modules/claude/prompts/chat_shell.md, comment_batch.md). The row exists so
// the reviewer can SEE that rule next to the three that are choices — same
// reasoning as the read-only werkmap row below.
function langCommitRow() {
  return html`<div
    data-testid="settings-row-langcommit"
    class="${() => rowCls('langcommit')}"
    @click="${() => (state.activeRow = ROWS.indexOf('langcommit'))}"
  >
    ${rowLabel(
      t('Taal van code en commits'),
      t(
        'Altijd Engels, dit is geen keuze: code, identifiers, code-comments en commitberichten. Alleen de inhoud van een vertaalbestand (lang/<taal>/) houdt zijn eigen taal.',
      ),
    )}
    <span
      data-testid="lang-commit-fixed"
      class="inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 ring-1 ring-inset ring-slate-200 dark:ring-zinc-700"
      >${() => t('Altijd Engels')}</span
    >
  </div>`
}

function autoWarnRow() {
  return html`<div data-testid="settings-row-autowarn" class="${() => rowCls('autowarn')}" @click="${() => (state.activeRow = ROWS.indexOf('autowarn'))}">
    ${rowLabel(t('Live AI assistent'), t('Automatische risicocontrole en AI-beschrijvingen aan/uit — geldt voor alle PR’s.'))}
    ${autoWarnToggleButton()}
  </div>`
}

function autoIngestPrefRow() {
  return html`<div
    data-testid="settings-row-autoingestpref"
    class="${() => rowCls('autoingestpref')}"
    @click="${() => (state.activeRow = ROWS.indexOf('autoingestpref'))}"
  >
    ${rowLabel(
      t('Automatisch review-boom genereren'),
      t('Uit — nooit; Mijn PR’s — alleen je eigen PR’s (behalve "Ready to merge"); Alle PR’s — ook die van anderen.'),
    )}
    ${autoIngestPrefToggleButton()}
  </div>`
}

function debugRow() {
  return html`<div data-testid="settings-row-debug" class="${() => rowCls('debug')}" @click="${() => (state.activeRow = ROWS.indexOf('debug'))}">
    ${rowLabel(
      t('Debug mode'),
      t(
        'Legt je navigatie en acties vast in data/debug-log.jsonl, zodat Claude een bug kan naspelen. Elke sessie begint met de pagina die je opent.',
      ),
    )}
    <div class="flex flex-wrap items-center gap-2">
      ${debugModeToggleButton()}
      <button
        type="button"
        data-testid="settings-debug-clear"
        title="${t('Wis de opgenomen log')}"
        class="rounded-full px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-zinc-300 ring-1 ring-inset ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800"
        @click="${(e) => {
          e.stopPropagation()
          clearLog()
        }}"
      >
        ${t('Log wissen')}
      </button>
      <span class="text-[12px] text-slate-500 dark:text-zinc-500" data-testid="settings-debug-count">
        ${() => t('{n} gebeurtenissen opgenomen', { n: state.debugCount })}
      </span>
    </div>
  </div>`
}

function checkoutStatusText() {
  const c = state.checkout
  if (!c) return t('Geen werkmap gekoppeld.')
  if (c.decision) return t('Keuze nodig — open dit vanuit de PR-pagina.')
  if (c.dirName) {
    return c.branch
      ? t('Actief: {dir} (branch {branch})', { dir: c.dirName, branch: c.branch })
      : t('Actief: {dir}', { dir: c.dirName })
  }
  return t('Geen werkmap gekoppeld.')
}

function checkoutRow() {
  return html`<div
    data-testid="settings-row-checkout"
    class="${() => rowCls('checkout') + (originPr == null ? ' opacity-50' : '')}"
    @click="${() => (state.activeRow = ROWS.indexOf('checkout'))}"
  >
    ${rowLabel(t('Werkmap'), t('Welke lokale werkmap Claude voor deze PR gebruikt — alleen te wijzigen vanuit een PR-pagina.'))}
    <div class="text-[13px] text-slate-600 dark:text-zinc-400" data-testid="settings-checkout-status">
      ${() =>
        originPr == null
          ? t('Open deze pagina vanuit een PR om de werkmap te zien/wijzigen.')
          : state.checkoutLoading
            ? t('Laden…')
            : checkoutStatusText()}
    </div>
  </div>`
}

function chip(text, onRemove, disabled) {
  return html`<span
    class="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-zinc-800 px-2 py-1 text-[12px] text-slate-700 dark:text-zinc-300"
  >
    <span>${text}</span>
    <button
      type="button"
      title="${disabled ? t('Minstens één woord vereist') : t('Verwijderen')}"
      disabled="${() => !!disabled}"
      class="${disabled ? 'text-slate-300 dark:text-zinc-600' : 'text-slate-400 hover:text-rose-600 dark:text-zinc-500 dark:hover:text-rose-400'}"
      @click="${onRemove}"
    >
      ×
    </button>
  </span>`
}

function aliasesRow() {
  return html`<div data-testid="settings-row-aliases" class="${() => rowCls('aliases')}" @click="${() => (state.activeRow = ROWS.indexOf('aliases'))}">
    ${rowLabel(t('Wie ben ik'), t('De login komt uit GitHub; alleen de extra @mention-spellingen hieronder zijn aanpasbaar.'))}
    <div class="mb-2 text-[13px] text-slate-600 dark:text-zinc-400" data-testid="settings-github-login">
      ${() => t('GitHub-login: {login}', { login: state.githubLogin || '…' })}
    </div>
    <div class="mb-2 flex flex-wrap gap-1.5" data-testid="settings-alias-chips">
      ${() => state.aliases.map((a, i) => chip(a, () => removeAlias(i), false))}
    </div>
    <input
      type="text"
      data-testid="settings-aliases-input"
      placeholder="${t('Extra @mention-spelling toevoegen…')}"
      class="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-[13px] text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
      @keydown="${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          addAlias(e.target)
        }
      }}"
      @focus="${() => (state.editing = 'aliases')}"
    />
  </div>`
}

function praiseWordsRow() {
  return html`<div
    data-testid="settings-row-praisewords"
    class="${() => rowCls('praisewords')}"
    @click="${() => (state.activeRow = ROWS.indexOf('praisewords'))}"
  >
    ${rowLabel(t('Praise-woorden'), t('Woorden die de review-samenvatting niet als open punt telt (bv. "nice", "top").'))}
    <div class="mb-2 flex flex-wrap gap-1.5" data-testid="settings-praise-chips">
      ${() => state.praiseWords.map((w, i) => chip(w, () => removePraiseWord(i), state.praiseWords.length <= 1))}
    </div>
    <input
      type="text"
      data-testid="settings-praisewords-input"
      placeholder="${t('Woord toevoegen…')}"
      class="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-[13px] text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
      @keydown="${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          addPraiseWord(e.target)
        }
      }}"
      @focus="${() => (state.editing = 'praisewords')}"
    />
  </div>`
}

function App() {
  return html`
    <div class="flex h-screen flex-col overflow-hidden">
      <header class="flex shrink-0 items-center gap-3 border-b border-slate-200 dark:border-zinc-800 px-6 py-4">
        <button
          type="button"
          data-testid="settings-back"
          title="${t('Terug')}"
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
          @click="${goBack}"
        >
          ← ${t('Terug')}
        </button>
        <h1 class="text-lg font-semibold text-slate-900 dark:text-zinc-100">${t('Instellingen')}</h1>
      </header>
      <div class="flex-1 overflow-auto px-6 py-5">
        <div class="mx-auto max-w-xl space-y-3" data-testid="settings-rows">
          ${themeRow()}
          ${langRow(
            'langui',
            'ui',
            'Taal van de interface',
            'Alle titels, omschrijvingen en labels in deze app. Wisselen herlaadt de pagina.',
          )}
          ${langRow(
            'langexplain',
            'explain',
            'Taal van AI-uitleg',
            'De AI-omschrijving, de risicocheck, de PR-samenvatting, comment-titels en het testrapport. Een antwoord in een gesprek volgt altijd de taal van je eigen bericht.',
          )}
          ${langRow(
            'langreply',
            'reply',
            'Taal van reacties op GitHub',
            'De tekst die Claude voor je opschrijft als reactie op een reviewopmerking, en die onder jouw naam op GitHub komt.',
          )}
          ${langCommitRow()} ${autoWarnRow()} ${autoIngestPrefRow()} ${debugRow()} ${checkoutRow()} ${aliasesRow()}
          ${praiseWordsRow()}
        </div>
        <p class="mx-auto mt-4 max-w-xl text-[12px] text-slate-400 dark:text-zinc-500">
          ${t('↑/↓ om te navigeren, Enter/Space om te wisselen of te bewerken, ← om terug te gaan.')}
        </p>
      </div>
    </div>
  `
}

// The shell's own <title> is Dutch (settings.html), so translate it here — a
// static HTML file cannot call t().
document.title = t('Instellingen') + ' — PR Review Tree'

App()(document.getElementById('app'))
ensureAutoWarn()
ensureAutoIngestPref()
ensureLangPref()
syncUiLang()
init()
