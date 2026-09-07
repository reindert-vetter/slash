// settings.mjs — the ONE general settings page (`/settings`), reached via a
// gear-icon entry button placed next to the theme toggle on both /pr/<id>
// (prInfoCard's pr-info-theme-row, home.mjs) and /pr-overview (headerBlock,
// overview.mjs). Day one deliberately carries EVERYTHING that already existed
// scattered across those two pages — theme, Live AI assistent, the local
// checkout directory, praise-words, and "wie ben ik" — plus its own
// keyboard-navigable row list and a `?from=` round trip back to wherever the
// reviewer came from. See .claude/docs/settings-page.md for the full
// mechanism and the per-setting source/write-path table.
import { reactive, html, watch } from './vendor/arrow.js'
import { bindUrlState } from './urlState.mjs'
import { initTheme, themeToggleButton, cycleTheme } from './theme.mjs'
import { ensureAutoWarn, autoWarnToggleButton, toggleAutoWarn } from './autowarn.mjs'
import { keyboardHintsToggleButton, toggleKeyboardHints } from './keyboardHints.mjs'
import { ensureAutoIngestPref, autoIngestPrefToggleButton, cycleAutoIngestPref } from './autoingestpref.mjs'
import { ensureMe, meLogin } from './avatar.mjs'
import { initDebugLog, debugModeToggleButton, toggleDebugMode, clearDebugLog, debugLogCount } from './debugLog.mjs'
import { ensureLangPref, langToggleButton, toggleLang } from './langpref.mjs'
import { t, syncUiLang } from './i18n.mjs'
import { originFrom, originPr } from './settingsLink.mjs'
import FailedTasksHost, { initFailedTasksPopup, isFailedTasksOpen, handleFailedTasksKeydown } from './failedTasks.mjs'
// The auth row's data comes from the same shared store the global dialog uses
// — but the dialog itself is SUPPRESSED here (suppressPopup): a modal over the
// very form you are filling in would be absurd. See src/authStatus.mjs.
import {
  as as authState,
  initAuthStatusPopup,
  refreshAuthStatus,
  saveJiraCredentials,
  authCheckRow,
} from './authStatus.mjs'

initTheme()
initDebugLog()

function goBack() {
  location.href = originFrom
}

// ── page state ───────────────────────────────────────────────────────────

const state = reactive({
  loading: true,
  // Which tab is open — a navigation position, so it lives in the URL (see
  // bindUrlState below), not localStorage (that's for a preference like the
  // theme). Defaults to the first tab and falls out of the URL there, per the
  // project's "default value omitted" convention.
  activeTab: 'display',
  activeRow: 0, // index into the ACTIVE tab's own row list (TAB_DEFS[..].rows), not the flat ROWS list
  // True while the tab bar itself owns ↑/↓/←/→ instead of the row list — the
  // same "extra stop above the first row" idiom as Block.mjs's description
  // strip / stop 1's since-review cursor (see keyboard-navigation.md): ↑ off
  // the topmost row of a tab enters the tab bar, ←/→ switch tabs there, and
  // ↓/Enter hands the keyboard back to that tab's first row. Ephemeral, not
  // in the URL — a cursor position, like state.activeRow itself.
  tabFocused: false,
  editing: null, // null | 'aliases' | 'praisewords' | 'notifyfilters' — which row owns a focused text input
  aliases: [],
  praiseWords: [],
  // The reviewer's own Jira-notification noise filter (GET /api/notifyfilters,
  // notifyfilters.go). A list he adds to himself; an EMPTY list is a real
  // state here ("hide nothing"), unlike praiseWords.
  notifyFilters: [],
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
  // The Jira notification-feed credentials, prefilled once from
  // GET /api/auth/status (authState.jira). The TOKEN is never prefilled — the
  // server only ever reports a masked tail — so an empty token field means
  // "keep the stored one" (see JiraCredsSignal, workflows.go).
  jiraEmail: '',
  jiraSite: '',
  jiraToken: '',
})

// Prefill the credential form once the status has loaded, and never again —
// re-running it would overwrite what the reviewer is typing on the next poll.
// Deps are enumerated INLINE, per the watch rule in
// .claude/rules/arrowjs-pitfalls.md.
let jiraPrefilled = false
watch(
  () => [authState.loaded, authState.jira && authState.jira.email, authState.jira && authState.jira.site],
  () => {
    if (jiraPrefilled || !authState.loaded) return
    jiraPrefilled = true
    state.jiraEmail = (authState.jira && authState.jira.email) || ''
    state.jiraSite = (authState.jira && authState.jira.site) || ''
  },
)

// TAB_DEFS is simultaneously the tab bar's own order, each tab's ↑/↓ nav
// order, and each tab's DOM render order — kept as one structure so none of
// the three can drift apart (same reasoning as the old flat ROWS array).
// The grouping follows the settings that already existed, not an invented
// taxonomy: display/keyboard-hints/debug are all "how the app looks and what
// it records locally"; the three language rows plus the fixed commit-language
// row are "translate per output type"; autowarn/autoingestpref/praisewords
// all steer what the built-in AI assistant does automatically; auth/
// checkout/aliases/notifyfilters are all "who I am and which outside
// services this install talks to" (gh/acli/Jira credentials, the PR-scoped
// checkout dir, GitHub identity, Jira notification noise). See
// .claude/docs/settings-page.md for the full table.
const TAB_DEFS = [
  { id: 'display', label: 'Weergave', rows: ['theme', 'keyboardhints', 'debug'] },
  { id: 'language', label: 'Taal', rows: ['langui', 'langexplain', 'langreply', 'langcommit'] },
  { id: 'assistant', label: 'AI-assistent', rows: ['autowarn', 'autoingestpref', 'praisewords'] },
  { id: 'account', label: 'Account & Jira', rows: ['auth', 'checkout', 'aliases', 'notifyfilters'] },
]
const ROWS = TAB_DEFS.flatMap((tab) => tab.rows) // flat lookup, e.g. for input-focus targeting by row name

function currentTab() {
  return TAB_DEFS.find((tab) => tab.id === state.activeTab) || TAB_DEFS[0]
}
function currentRows() {
  return currentTab().rows
}

// The open tab is a navigation position (which "page" of settings you're
// looking at), so it belongs in the query string, exactly like `gran`/`mode`
// on /pr/<id> — never localStorage. Bound right after the state is created,
// before the first render reads it. Doesn't collide with the pre-existing
// `?from=` param (settingsLink.mjs reads that one directly, outside
// bindUrlState).
bindUrlState(state, [{ key: 'activeTab', param: 'tab', default: 'display', parse: (raw) => (TAB_DEFS.some((t) => t.id === raw) ? raw : undefined) }])

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

async function loadNotifyFilters() {
  try {
    const res = await fetch('/api/notifyfilters')
    if (res.ok) {
      const data = await res.json()
      state.notifyFilters = data.filters || []
    }
  } catch (err) {
    console.error('notifyfilters load failed:', err)
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
  await Promise.all([
    loadAliases(),
    loadPraiseWords(),
    loadNotifyFilters(),
    loadCheckout(),
    refreshDebugCount(),
  ])
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

// saveNotifyFilters mirrors savePraiseWords, on the same app_settings tracker
// with its own Kind. An empty list is deliberately allowed all the way through
// (the handler accepts it, notify-filters.json stores it) — that is the
// reviewer saying "show me every notification again".
async function saveNotifyFilters(next) {
  state.notifyFilters = next
  const runId = await ensureAppSettingsRun()
  if (!runId) return
  try {
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/app_settings_update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'notifyFilters', notifyFilters: next }),
    })
  } catch (err) {
    console.error('save notify filters failed:', err)
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

function addNotifyFilter(inputEl) {
  const v = (inputEl.value || '').trim()
  inputEl.value = ''
  if (!v) return
  saveNotifyFilters([...state.notifyFilters, v])
}

// Unlike removePraiseWord there is no "at least one" floor: removing the last
// filter text is a legitimate, supported state (see notifyfilters.go).
function removeNotifyFilter(idx) {
  saveNotifyFilters(state.notifyFilters.filter((_, i) => i !== idx))
}

// ── keyboard: ↑/↓ over the row list, Enter/Space runs that row's primary
// action (exactly what a click on it runs — mouse-navigation.md), ←/Escape
// both go back to originFrom (goBack) — reviewer report: only the visible
// "← Terug" button worked, Escape did nothing (it only blurred a focused text
// input, see the input-focus guard right below, mirrored from home.mjs).
// Escape, while a text input owns focus, still blurs back to row navigation
// instead of leaving the page outright — the same "Escape closes the
// nearest thing, not the whole page" precedent as everywhere else Escape
// appears in this app (a menu/popover/overlay). ─────────────

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
  } else if (row === 'keyboardhints') {
    toggleKeyboardHints()
  } else if (row === 'autowarn') {
    toggleAutoWarn()
  } else if (row === 'autoingestpref') {
    cycleAutoIngestPref()
  } else if (row === 'debug') {
    // Same function a click on debugModeToggleButton runs.
    toggleDebugMode()
  } else if (row === 'auth') {
    // Same function a click on the row's own "Opnieuw controleren" runs.
    refreshAuthStatus(true)
  } else if (row === 'aliases') {
    state.editing = 'aliases'
    requestAnimationFrame(() => focusRowInput('aliases'))
  } else if (row === 'praisewords') {
    state.editing = 'praisewords'
    requestAnimationFrame(() => focusRowInput('praisewords'))
  } else if (row === 'notifyfilters') {
    state.editing = 'notifyfilters'
    requestAnimationFrame(() => focusRowInput('notifyfilters'))
  }
  // 'checkout' is read-only on this page (see checkoutRow) — no action, and
  // neither is 'langcommit': code/commits are always English by rule, so that
  // row has nothing to toggle (see langCommitRow).
}

// moveRow walks the ACTIVE tab's own rows. ↑ off the topmost row hands the
// keyboard to the tab bar instead of clamping — the "extra stop above the
// first row" idiom (see state.tabFocused's own comment above).
function moveRow(delta) {
  const rows = currentRows()
  const next = state.activeRow + delta
  if (next < 0) {
    state.tabFocused = true
    return
  }
  state.activeRow = Math.max(0, Math.min(rows.length - 1, next))
  requestAnimationFrame(() => {
    const el = document.querySelector('[data-testid="settings-row-' + rows[state.activeRow] + '"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

// selectRow — the same function a click on a row runs (mouse-navigation
// convention): picks it as the active row and, since a mouse click always
// lands inside the currently visible tab's own row list, also makes sure the
// tab bar isn't left holding keyboard focus from an earlier ↑ press.
function selectRow(row) {
  state.tabFocused = false
  state.activeRow = currentRows().indexOf(row)
}

// selectTab switches the open tab — the same function a click on a tab
// button runs (mouse-navigation convention) and what ←/→ run while the tab
// bar owns the keyboard. Always resets the row cursor to the top of the
// newly active tab, mirroring how selecting a fresh block resets its cursor
// elsewhere in the app.
function selectTab(id) {
  if (state.activeTab === id) return
  state.activeTab = id
  state.activeRow = 0
}

// moveTabFocus is only called while state.tabFocused is true — ←/→ there
// switch tabs directly (no separate "highlight then confirm" step, same as a
// toggle row's own Enter/click doing its action immediately).
function moveTabFocus(delta) {
  const idx = Math.max(0, Math.min(TAB_DEFS.length - 1, TAB_DEFS.findIndex((t) => t.id === state.activeTab) + delta))
  selectTab(TAB_DEFS[idx].id)
}

// enterActiveTabRows hands the keyboard from the tab bar back to that tab's
// row list — ↓ or Enter/Space while state.tabFocused.
function enterActiveTabRows() {
  state.tabFocused = false
  state.activeRow = 0
}

window.addEventListener('keydown', (e) => {
  // The global failed-tasks dialog owns the keyboard while it is up — same
  // "checked first" contract as home.mjs's own guard (failedTasks.mjs).
  if (isFailedTasksOpen()) return handleFailedTasksKeydown(e)
  const active = document.activeElement
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    if (e.key === 'Escape') {
      active.blur()
      state.editing = null
    }
    return
  }
  if (state.tabFocused) {
    // The tab bar owns ↑/↓/←/→/Enter/Escape while focused: ←/→ switch tabs,
    // ↓/Enter hand the keyboard to the row list, ↑ is a no-op (already at the
    // top), ←/Escape still leave the page like everywhere else on this page.
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      moveTabFocus(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      moveTabFocus(1)
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      enterActiveTabRows()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      goBack()
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
    activateRow(currentRows()[state.activeRow])
  } else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
    e.preventDefault()
    goBack()
  }
})

// ── rendering ─────────────────────────────────────────────────────────────

// FIELD_CLS is the one text-input look this page uses; a static string, so it
// stays out of arrow.js's reactive attribute path (see the whole-value
// attribute rule in .claude/rules/arrowjs-pitfalls.md).
const FIELD_CLS =
  'w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-[13px] text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500/40'

// Where an Atlassian API token comes from — the same page auth_status.go names
// in its own fixUrl, kept here too so the row can link to it before any check
// has loaded.
const JIRA_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens'

function rowCls(row) {
  const base = 'rounded-xl border p-4 transition-colors '
  return (
    base +
    (state.activeRow === currentRows().indexOf(row)
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
  return html`<div data-testid="settings-row-theme" class="${() => rowCls('theme')}" @click="${() => selectRow('theme')}">
    ${rowLabel(t('Thema'), t('Systeem / licht / donker — opgeslagen in deze browser.'))}
    <div class="flex items-center gap-2">${themeToggleButton('h-8 w-8 bg-slate-50 dark:bg-zinc-800 ring-1 ring-slate-200 dark:ring-zinc-700')}</div>
  </div>`
}

function keyboardHintsRow() {
  return html`<div
    data-testid="settings-row-keyboardhints"
    class="${() => rowCls('keyboardhints')}"
    @click="${() => selectRow('keyboardhints')}"
  >
    ${rowLabel(t('Keyboard hints'), t('De hintregel met sneltoetsen onder elke kaart, aan/uit — standaard aan.'))}
    ${keyboardHintsToggleButton()}
  </div>`
}

// One row per translatable output type — the reviewer's "je moet per type
// kunnen vertalen". Each row's Enter/Space runs exactly the function its own
// button's click runs (see activateRow), per the mouse-navigation convention.
function langRow(row, kind, title, sub) {
  return html`<div data-testid="${'settings-row-' + row}" class="${() => rowCls(row)}" @click="${() => selectRow(row)}">
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
    @click="${() => selectRow('langcommit')}"
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
  return html`<div data-testid="settings-row-autowarn" class="${() => rowCls('autowarn')}" @click="${() => selectRow('autowarn')}">
    ${rowLabel(t('Live AI assistent'), t('Automatische risicocontrole en AI-beschrijvingen aan/uit — geldt voor alle PR’s.'))}
    ${autoWarnToggleButton()}
  </div>`
}

function autoIngestPrefRow() {
  return html`<div
    data-testid="settings-row-autoingestpref"
    class="${() => rowCls('autoingestpref')}"
    @click="${() => selectRow('autoingestpref')}"
  >
    ${rowLabel(
      t('Automatisch review-boom genereren'),
      t('Uit — nooit; Mijn PR’s — alleen je eigen PR’s (behalve "Ready to merge"); Alle PR’s — ook die van anderen.'),
    )}
    ${autoIngestPrefToggleButton()}
  </div>`
}

function debugRow() {
  return html`<div data-testid="settings-row-debug" class="${() => rowCls('debug')}" @click="${() => selectRow('debug')}">
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

// authRow — every credential slash runs on, its state in WORDS (never colour
// alone), how to repair it, and — for the one credential that is a plain
// token rather than a CLI login — the fields to fill it in right here. The
// rows themselves are authStatus.mjs's own authCheckRow, the same component
// the global dialog renders, so the two can never disagree about a state.
function authRow() {
  return html`<div data-testid="settings-row-auth" class="${() => rowCls('auth')}" @click="${() => selectRow('auth')}">
    ${rowLabel(
      t('Inloggegevens'),
      t('gh, acli en het Jira API-token. Werkt er één niet, dan slaat slash het werk dat daarop leunt stilzwijgend over.'),
    )}
    <div
      data-testid="settings-auth-checks"
      class="mb-3 overflow-hidden rounded-lg border border-slate-200 dark:border-zinc-800"
    >
      ${() =>
        authState.loaded
          ? (authState.checks || []).map((c) => authCheckRow(c).key('authrow:' + c.id))
          : [html`<p class="px-4 py-3 text-[12px] text-slate-500 dark:text-zinc-500">${t('Bezig met controleren…')}</p>`.key('authrow:loading')]}
    </div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="settings-auth-recheck"
        disabled="${() => authState.checking}"
        class="${() =>
          'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ' +
          (authState.checking ? 'bg-slate-400 dark:bg-zinc-700' : 'bg-indigo-600 hover:bg-indigo-500')}"
        @click="${(e) => {
          if (e) e.stopPropagation()
          refreshAuthStatus(true)
        }}"
      >
        ${() => (authState.checking ? t('Bezig met controleren…') : t('Opnieuw controleren'))}
      </button>
      <span data-testid="settings-auth-note" class="min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-zinc-500"
        >${() => authState.note}</span
      >
    </div>
    <div class="rounded-lg border border-slate-200 p-3 dark:border-zinc-800">
      <p class="text-[13px] font-semibold text-slate-800 dark:text-zinc-100">${t('Jira API-token')}</p>
      <p class="mt-0.5 text-[12px] text-slate-500 dark:text-zinc-500">
        ${t('Nodig voor de notificatiefeed bovenaan het PR-overzicht. Maak een token aan en plak hem hieronder.')}
      </p>
      <p class="mt-1 text-[12px]">
        <a
          href="${JIRA_TOKEN_URL}"
          target="_blank"
          rel="noopener"
          data-testid="settings-auth-token-link"
          class="font-semibold text-indigo-600 underline dark:text-indigo-300"
          >${t('Token aanmaken op id.atlassian.com')}</a
        >
      </p>
      <div class="mt-2 space-y-2">
        <input
          type="email"
          data-testid="settings-auth-email-input"
          placeholder="${t('Je Atlassian-e-mailadres')}"
          value="${() => state.jiraEmail}"
          class="${FIELD_CLS}"
          @input="${(e) => (state.jiraEmail = e.target.value)}"
          @focus="${() => (state.editing = 'auth')}"
        />
        <input
          type="text"
          data-testid="settings-auth-site-input"
          placeholder="plugandpaybv.atlassian.net"
          value="${() => state.jiraSite}"
          class="${FIELD_CLS}"
          @input="${(e) => (state.jiraSite = e.target.value)}"
          @focus="${() => (state.editing = 'auth')}"
        />
        <input
          type="password"
          data-testid="settings-auth-token-input"
          placeholder="${() =>
            authState.jira && authState.jira.tokenSet
              ? t('Opgeslagen: {masked} — laat leeg om te behouden', { masked: authState.jira.tokenMasked || '••••' })
              : t('Plak hier je API-token')}"
          class="${FIELD_CLS}"
          @input="${(e) => (state.jiraToken = e.target.value)}"
          @focus="${() => (state.editing = 'auth')}"
        />
      </div>
      <button
        type="button"
        data-testid="settings-auth-save"
        disabled="${() => authState.saving}"
        class="${() =>
          'mt-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ' +
          (authState.saving ? 'bg-slate-400 dark:bg-zinc-700' : 'bg-emerald-600 hover:bg-emerald-500')}"
        @click="${(e) => {
          if (e) e.stopPropagation()
          saveJiraCredentials({ email: state.jiraEmail, site: state.jiraSite, token: state.jiraToken }).then((ok) => {
            if (ok) state.jiraToken = ''
          })
        }}"
      >
        ${() => (authState.saving ? t('Bezig met opslaan…') : t('Opslaan'))}
      </button>
      <p class="mt-2 text-[12px] text-slate-400 dark:text-zinc-500">
        ${t('Wordt lokaal opgeslagen in .env (niet in git, niet versleuteld) en is direct actief.')}
      </p>
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
    @click="${() => selectRow('checkout')}"
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
  return html`<div data-testid="settings-row-aliases" class="${() => rowCls('aliases')}" @click="${() => selectRow('aliases')}">
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
    @click="${() => selectRow('praisewords')}"
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

// The Jira-notification noise filter — a list the reviewer adds to himself,
// same chips+input shape as praiseWordsRow. Its own remove button is never
// disabled: an empty list means "hide nothing".
function notifyFiltersRow() {
  return html`<div
    data-testid="settings-row-notifyfilters"
    class="${() => rowCls('notifyfilters')}"
    @click="${() => selectRow('notifyfilters')}"
  >
    ${rowLabel(
      t('Jira-notificaties verbergen'),
      t(
        'Notificaties waarvan de titel een van deze teksten bevat, verdwijnen uit het belletje en tellen niet mee als ongelezen. Zonder teksten wordt niets verborgen.',
      ),
    )}
    <div class="mb-2 flex flex-wrap gap-1.5" data-testid="settings-notifyfilters-chips">
      ${() => state.notifyFilters.map((f, i) => chip(f, () => removeNotifyFilter(i), false))}
    </div>
    <input
      type="text"
      data-testid="settings-notifyfilters-input"
      placeholder="${t('Tekst toevoegen, bv. assigned a work item to you…')}"
      class="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2.5 py-1.5 text-[13px] text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-500/40"
      @keydown="${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          addNotifyFilter(e.target)
        }
      }}"
      @focus="${() => (state.editing = 'notifyfilters')}"
    />
  </div>`
}

// The tab bar. Which tab is active is shown by shape/position (a bold label
// plus a bottom underline that shifts, `aria-selected`), never by colour
// alone (Reindert is colourblind, see .claude/rules and MEMORY.md). Each
// button is `.key(id)`ed — a plain always-rendered ${() => TAB_DEFS.map(...)}
// binding, not a static value inside a conditionally (re)built template, per
// .claude/rules/arrowjs-pitfalls.md.
function tabButtonCls(id) {
  return () =>
    'border-b-2 -mb-px px-3 py-2 text-[13px] transition-colors ' +
    (state.activeTab === id
      ? 'border-indigo-500 dark:border-indigo-400 font-semibold text-indigo-700 dark:text-indigo-300'
      : 'border-transparent font-medium text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200')
}

function tabButton(tab) {
  return html`<button
    type="button"
    data-testid="${'settings-tab-' + tab.id}"
    aria-selected="${() => String(state.activeTab === tab.id)}"
    class="${tabButtonCls(tab.id)}"
    @click="${() => selectTab(tab.id)}"
  >
    ${() => t(tab.label)}
  </button>`.key(tab.id)
}

function tabBar() {
  return html`<div
    data-testid="settings-tabs"
    class="${() =>
      'mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-zinc-800 ' +
      (state.tabFocused ? 'ring-1 ring-inset ring-indigo-200 dark:ring-indigo-500/30' : '')}"
  >
    ${() => TAB_DEFS.map((tab) => tabButton(tab))}
  </div>`
}

// A tab's rows stay MOUNTED at all times and only toggle visibility via a
// static Tailwind class — never a conditionally (re)built template — so every
// binding inside keeps reacting regardless of which tab is on screen (see the
// "toggling expression"/"single↔array" pitfalls in
// .claude/rules/arrowjs-pitfalls.md, which this sidesteps entirely rather
// than working around).
function tabPanelCls(id) {
  return () => (state.activeTab === id ? 'space-y-3' : 'hidden')
}

function tabPanel(id, testid, rows) {
  return html`<div data-testid="${testid}" class="${tabPanelCls(id)}">${rows}</div>`
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
        <div class="mx-auto max-w-xl" data-testid="settings-rows">
          ${tabBar()}
          ${tabPanel('display', 'settings-tab-panel-display', [themeRow(), keyboardHintsRow(), debugRow()])}
          ${tabPanel('language', 'settings-tab-panel-language', [
            langRow(
              'langui',
              'ui',
              'Taal van de interface',
              'Alle titels, omschrijvingen en labels in deze app. Wisselen herlaadt de pagina.',
            ),
            langRow(
              'langexplain',
              'explain',
              'Taal van AI-uitleg',
              'De AI-omschrijving, de risicocheck, de PR-samenvatting, comment-titels en het testrapport. Een antwoord in een gesprek volgt altijd de taal van je eigen bericht.',
            ),
            langRow(
              'langreply',
              'reply',
              'Taal van reacties op GitHub',
              'De tekst die Claude voor je opschrijft als reactie op een reviewopmerking, en die onder jouw naam op GitHub komt.',
            ),
            langCommitRow(),
          ])}
          ${tabPanel('assistant', 'settings-tab-panel-assistant', [autoWarnRow(), autoIngestPrefRow(), praiseWordsRow()])}
          ${tabPanel('account', 'settings-tab-panel-account', [authRow(), checkoutRow(), aliasesRow(), notifyFiltersRow()])}
        </div>
        <p class="mx-auto mt-4 max-w-xl text-[12px] text-slate-400 dark:text-zinc-500">
          ${t('←/→ wisselt tabblad (druk ↑ op de bovenste rij om de tabbalk te bereiken), ↑/↓ navigeert rijen, Enter/Space wisselt of bewerkt, ← om terug te gaan.')}
        </p>
      </div>
    </div>
  `
}

// The shell's own <title> is Dutch (settings.html), so translate it here — a
// static HTML file cannot call t().
document.title = t('Instellingen') + ' — PR Review Tree'

App()(document.getElementById('app'))
FailedTasksHost()(document.getElementById('app'))
initFailedTasksPopup()
initAuthStatusPopup({ suppressPopup: true })
ensureAutoWarn()
ensureAutoIngestPref()
ensureLangPref()
syncUiLang()
init()
