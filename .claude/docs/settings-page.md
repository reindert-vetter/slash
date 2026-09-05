# The settings page (`/settings`)

One general, keyboard-navigable settings page (`settings.html` →
`src/settings.mjs`), day-one carrying EVERYTHING that already existed
scattered across `/pr/<id>` and `/pr-overview`: theme, "Live AI assistent",
the checkout-directory chip, praise-words, and "wie ben ik" — plus the two
extra @mention alias spellings and the praise-word list becoming genuinely
editable from the page, which they never were before.

## Split out of this file

Nothing yet — this is the only doc for the page. If it grows a second
distinct concern (e.g. a repo registry editor), split it the way
`pages-and-routing.md` splits out `pr-overview.md`.

## Entry points and the `?from=` round trip

Two gear-icon buttons, both rendered by the same shared, side-effect-free
component `settingsButton(cls)` in `src/settingsLink.mjs` — imported by
`src/home.mjs` (`prInfoCard`'s `pr-info-theme-row`, right after
`themeToggleButton`) and `src/overview.mjs` (`headerBlock`, right after its own
`themeToggleButton`). A single tandwiel icon, no label text — the reviewer's
own choice, since this is a plain navigation link rather than a toggle (the
colourblind rule about colour-only state therefore doesn't apply to it the way
it does to the toggles beside it).

**Why `settingsButton` lives in its own module, not in `settings.mjs`
itself:** `settings.mjs` is a PAGE module — like `inbox.mjs`, it mounts
`App()` into `#app` and registers its own `window` keydown listener at
load. Importing it from `home.mjs`/`overview.mjs` just to reuse the button
would run all of that top-level code on `/pr/<id>` and `/pr-overview` too
(a second `App()` fighting over `#app`, a stray global keydown listener
hijacking arrow keys, extra `ensureAutoWarn()`/`init()` network calls).
`settingsLink.mjs` has no top-level side effect at all — the same shape as
`theme.mjs`/`autowarn.mjs` — and both the buttons and `settings.mjs` itself
import from it.

A click builds `/settings?from=<encodeURIComponent(location.pathname +
location.search)>` and navigates there with a plain `location.href` (a real
document navigation between two static shells, not an SPA route — the two
pages don't share a module graph at runtime, so this is the simplest correct
thing). `settingsLink.mjs` reads `?from=` **once**, into two never-nulled
module `const`s (mirrors `originPr`/`originSel` in `overview.mjs`):

- **`originFrom`** — validated against an open redirect: only a same-origin,
  ABSOLUTE path (`raw.startsWith('/') && !raw.startsWith('//')`) is honoured;
  anything else (missing, external, protocol-relative) falls back to
  `/pr-overview`. `←` and the visible "← Terug" button both do
  `location.href = originFrom` — the same function a click on either one
  runs, per the mouse-navigation convention.
- **`originPr`** — `/^\/pr\/(\d+)(?:[/?#]|$)/.exec(originFrom)`, so the
  checkout-directory row (below) knows which PR's checkout state to show, or
  that there is none.

## Row list and keyboard

`src/settings.mjs`'s `ROWS = ['theme', 'keyboardhints', 'langui', 'langexplain',
'langreply', 'langcommit', 'autowarn', 'autoingestpref', 'debug', 'auth', 'checkout',
'aliases', 'praisewords']` is simultaneously the `↑`/`↓` nav order and the DOM render
order, kept as one array so the two can never drift apart. A platt
`window.addEventListener('keydown', …)` (mirrors `inbox.mjs`, not the
`/pr/<id>` nav chain's `Cmd+[`/`Cmd+]` remap — this page has no per-stop
granularity to remap onto):

- input-focus guard first: while a `TEXTAREA`/`INPUT` owns focus, every key
  is a no-op except `Escape`, which blurs it back to row navigation.
- `↑`/`↓` move `state.activeRow`, scrolling the new active row into view
  (`scrollIntoView({block:'nearest'})` — no horizontal-scroll concern here,
  unlike `<main>`'s column flow on `/pr/<id>`, see
  `.claude/rules/arrowjs-pitfalls.md`'s `scrollIntoView` note).
- `Enter`/`Space` run `activateRow(ROWS[activeRow])` — **exactly the same
  function a click on that row's own control runs** (mouse-navigation
  convention): `cycleTheme()`, `toggleAutoWarn()`, or focusing the
  aliases/praise-words text input, or `toggleLang('ui'|'explain'|'reply')`.
  The checkout row is read-only here (see below), so its activation is a
  no-op, and so is the `langcommit` row (always English, by rule).
- `←` **and `Escape`** both call the same `goBack()` the "← Terug" button's
  click runs (only reached while no text input owns focus — see the guard
  above, which lets Escape blur an open aliases/praise-words input instead).
  Reviewer report: only the visible button worked, Escape did nothing. Test:
  `tests/settings-page.spec.mjs` ("Escape also returns from /settings, same
  as ←").

## Per-setting source and write path

| Setting | Read from | Write path | Editable here? |
|---|---|---|---|
| Thema | `localStorage['theme']` (`theme.mjs`) | same, via `cycleTheme()` | Yes — reuses `themeToggleButton()` unchanged |
| Keyboard hints (de contextuele hintregel met sneltoetsen onder elke kaart, `src/shortcutHints.mjs`) | `localStorage['keyboardHints']` (`keyboardHints.mjs`, default on) | same, via `toggleKeyboardHints()` | Yes — reuses `keyboardHintsToggleButton()` unchanged |
| Live AI assistent | `GET /api/autowarn` (`autowarn.mjs`) | `POST /api/workflows/auto_warn` + `.../signals/autowarn` (existing `auto_warn` tracker) | Yes — reuses `autoWarnToggleButton()` unchanged |
| Automatisch review-boom genereren (off/own/all) | `GET /api/autoingestpref` (`autoingestpref.mjs`) | `POST /api/workflows/auto_ingest_pref` + `.../signals/auto_ingest_pref` (new `auto_ingest_pref` tracker) | Yes — reuses `autoIngestPrefToggleButton()` unchanged, also shown next to the gear icon in `/pr-overview`'s header |
| Taal van de interface (`settings-row-langui`) | `GET /api/langpref` (`ui`) + the `uiLang` localStorage paint cache (`i18n.mjs`) | `POST /api/workflows/lang_pref` + `.../signals/lang_pref` (new `lang_pref` tracker) | Yes — `langToggleButton('ui')`, and applying it reloads the page |
| Taal van AI-uitleg (`settings-row-langexplain`) | `GET /api/langpref` (`explain`) | same Signal, `kind:"explain"` | Yes |
| Taal van reacties op GitHub (`settings-row-langreply`) | `GET /api/langpref` (`reply`) | same Signal, `kind:"reply"` | Yes |
| Taal van code en commits (`settings-row-langcommit`) | — (a fixed rule in the prompts) | — | **No, by design** — always English, see below |
| Debug mode (`settings-row-debug`) | `localStorage['debugMode']` (`debugLog.mjs`) | same, via `toggleDebugMode()`; the recorded log itself is written by the one-shot `debug_log` workflow — see `.claude/docs/debug-mode.md` | Yes — plus a "Log wissen" button and a recorded-event counter (`GET /api/debug/log`) |
| Inloggegevens (`settings-row-auth`) | `GET /api/auth/status` (`authStatus.mjs`'s shared `as` store) | `POST /api/workflows/app_settings` + `.../signals/app_settings_update` with Kind `"jiraCreds"` → `.env` (see below) | Yes, for the Jira API token trio; `gh`/`acli` are repaired in a terminal |
| Werkmap (row label "Werkmap", `settings-row-checkout`) | `GET /api/chat/checkout?prs=<originPr>` | *(unchanged — see below)* | **Read-only on this page** |
| Wie ben ik — GitHub-login | `GET /api/me` (`avatar.mjs`'s `ensureMe`/`meLogin`) | — | No, by explicit reviewer decision: "wie ben ik moet uit GitHub komen" |
| Wie ben ik — extra @mention-aliassen | `GET /api/settings` (`me.aliases`) | new `app_settings` tracker, Kind `"aliases"` (see below) | Yes — new |
| Praise-woorden | `GET /api/praisewords` | new `app_settings` tracker, Kind `"praiseWords"` (see below) | Yes — new |

### Werkmap: read-only here, by design

`checkoutChip`/`checkoutChipCommandsFor` (`home.mjs`) are inherently
**PR-scoped** and driven by a whole command-menu subsystem (`openMenu`,
`ms`, `menuAnchor`) that only exists on `/pr/<id>`'s own runtime — porting
the actual chooser UI to a page that may not even have a PR in scope would be
a broad refactor for a day-one feature. The settings page therefore only
**shows** the current state (`checkoutStatusText()`, batch-fetched the same
way the chip itself does) and greys the row out (`opacity-50`) with an
explanation when there is no `originPr` at all — the reviewer's own decision:
"rij blijft staan maar grijs/inactief, met de uitleg dat je dit vanuit een PR
moet openen." Changing the checkout directory still happens on the PR page
itself, via the existing chip.

### Inloggegevens: one row, one shared store, one global popup

Reviewer request: "ik wil een popup als er iets groots fout gaat (waar ik een
knop in kan drukken om te re-checken), betreft acli jira auth status, maar ook
andere auth dingen — laat in de config page zien hoe ik eraan kom, met een link
en input velden enzo (het is toch allemaal local, dus encrypten heeft geen
zin)".

Three credentials, checked by `GET /api/auth/status` (`auth_status.go`, a
read-only operational carve-out): `gh auth status`, `acli jira auth status`,
and one minimal live feed call with the Jira API token. `claude` is
deliberately NOT checked — it has no queryable auth-status command, so the only
way to know would be a real billable call, and a failing Claude call already
shows up as a genuinely failed run in the failed-tasks popup.

`src/authStatus.mjs` owns both surfaces from ONE reactive store (`as`), so the
row and the popup can never disagree:

- **The global popup** — same contract as `failedTasks.mjs` (a real modal
  owning the keyboard, checked FIRST in every page's own keydown handler,
  Escape = a 5-minute localStorage snooze), mounted on all three pages and
  **suppressed on `/settings` itself** (`initAuthStatusPopup({suppressPopup:
  true})`), where the same rows are already on screen. It **outranks** the
  failed-tasks dialog (`isFailedTasksOpen` checks `isAuthProblemOpen` first):
  an expired credential is usually why those tasks failed, and two stacked
  modals help nobody.
- **It only fires on state `"error"`** — a credential that WAS configured and
  is now rejected. `"missing"` (the optional Jira feed was never set up) and
  `"skipped"` (`SLASH_GITHUB=off`/`SLASH_JIRA=off`, i.e. an offline or
  Playwright run) never open it; both are still shown on the settings row.
  Without that rule every test run would sit behind a keyboard-owning modal.
- Every state carries a WORD plus a glyph (`✓ Werkt`, `✕ Niet ingelogd`,
  `✕ Afgekeurd` for a rejected token, `○ Niet ingesteld`, `– Uitgeschakeld`);
  colour is decoration only, per the colourblind rule.

**The Jira token is write-only from the browser's point of view.**
`/api/auth/status` reports `tokenSet` plus a masked tail (`••••abcd`), never
the value — `GET /api/settings` is served verbatim to the browser, which is
also why these credentials live in `.env` and not in `settings.json`. An EMPTY
token field therefore means "keep the stored one", so correcting only the
e-mail address never wipes the token the page could not send back. Not
encrypted, by explicit reviewer decision: it is a local file on a local
machine.

### The new write path: `app_settings` tracker

`settings.json`'s `me` block and `praise-words.json` used to be **read-only**
from the app's own point of view — hand-maintained files, read once per data
dir and cached for the process lifetime (`settings.go`, `praisewords.go`).
The settings page needed a real write path for two of their fields (mention
aliases, the whole praise-word list) without breaking either file's other
properties:

- `settings.json` is **gitignored**, per-reviewer, and also holds `Repos`
  (`repos.go`'s registry) and `Me.Login` (an optional hand-set override of
  `/api/me` — still supported, just not exposed on this page, see "Wie ben
  ik" above) — fields this UI must never clobber.
- `praise-words.json` is likewise gitignored and per-reviewer (added to
  `.gitignore` alongside `settings.json` as part of this feature — it never
  existed on disk before a reviewer's first write, so nothing had listed it).
- Neither read side may keep caching a STALE value once a write has
  happened: a UI toggle that only "works after a restart" is not
  acceptable (unlike a hand edit to either file, which still does require a
  restart — that asymmetry is intentional, see below).

**Mechanism** (`workflows.go`, `WorkflowAppSettings = "app_settings"`,
`SignalAppSettings = "app_settings_update"`): ONE global tracker Execution
for the whole process — unlike every other tracker (`auto_warn`,
`ignore_comment`, …), there is no repo/PR to scope by, since there is exactly
one data dir per running server. `appSettingsWorkflow` mirrors
`autoWarnPrefWorkflow`'s infinite `WaitSignal` loop; `AppSettingsSignal`
carries a `Kind` discriminator (`"aliases"` | `"praiseWords"`) because **a
workflow can only `WaitSignal` on one signal name at a time** — the same
one-signal-many-kinds shape as `PRStateSignal`/`ReactionSignal.Action` (see
their own doc comments in `workflows.go`). Each `Kind` runs its own Activity:

- **`saveMentionAliases`** (Activity) → `saveMentionAliases(dataDir,
  aliases)` (`settings.go`, the file's only writer of `me.aliases`):
  re-reads `settings.json` **fresh from disk** (not the cache) right before
  writing, so a hand edit to `Me.Login`/`Repos` made after this process
  started is never clobbered — only `Me.Aliases` is replaced. Writes
  atomically (temp file + `os.Rename` in the same directory, so a crash
  mid-write can never leave a half-written file for a hand edit to trip
  over), then updates `settingsByDir` in the SAME locked section as the disk
  write — so the very next `GET /api/settings` already reflects the change,
  no restart needed. A HAND edit to the file still only takes effect after a
  restart, exactly as before (`TestSettingsCachedPerDataDir`) — that
  asymmetry is intentional: only a write through the sanctioned Signal path
  gets the immediate-cache-refresh treatment.
- **`savePraiseWords`** (Activity) → `savePraiseWordsFile(dataDir, words)`
  (`praisewords.go`, the file's only writer): the whole file IS the word
  list (no sibling field to preserve), normalized the same way the read side
  does (trim, lowercase, drop empty — no dedup, since a duplicate word is
  harmless and dedup would silently reorder a hand-maintained list), written
  atomically, cache updated in the same locked section. **Never persists an
  empty list** — falls back to the built-in defaults rather than writing
  something that would just read back as the defaults anyway — but the HTTP
  handler (`tasks_api.go`, the `SignalAppSettings` branch) rejects an empty
  submission outright (400) BEFORE the Signal is even sent, so the reviewer
  sees why instead of a silent "changed to defaults". The frontend mirrors
  this: `removePraiseWord` (`settings.mjs`) refuses to remove the last
  remaining chip, disabling its own remove button instead.

- **`saveJiraCredentials`** (Activity, Kind `"jiraCreds"`) → `saveEnvValues`
  (`env.go`, the only programmatic writer of `.env`): a MERGE, never a
  rewrite — an existing key is replaced in place, a commented-out
  `# SLASH_JIRA_EMAIL=…` template line is replaced rather than duplicated, every
  other line and comment survives, and the file is written atomically (temp +
  rename) like `settings.json`. It then `os.Setenv`s the values, so the change
  is live without a restart (every reader — `notifyConfig`, `auth_status.go` —
  reads `os.Getenv` lazily on each call), and drops the auth-status cache so
  the page does not keep showing the old verdict for up to a minute. The HTTP
  handler validates first (an e-mail is required; a token is required unless
  one is already stored). Tests: `env_save_test.go`.

**`TaskManager.dataDir` is NOT the settings/praise-words directory** — a real
bug caught and fixed while building this: `dataDir` on `TaskManager` is the
workflow-store/worktree directory (next to the DB, threaded through
`newTasks`), while `server.dataDir` (`api.go`) is the directory
`/api/settings`/`/api/names`/`/api/praisewords` actually read from
(`-data`/`SLASH_DATA`). The two only coincide by **default** — `runServe`
(`main.go`) normally passes `filepath.Dir(resolvedDB)` as the workflow-store
dir and `resolvedData` as `server.dataDir`, and those happen to be the same
path unless `-db`/`-data` (or `SLASH_DB`/`SLASH_DATA`) point at different
trees — which the Playwright harness does on purpose (`tests/_setup.mjs`'s
`TEST_DATA_DIR` vs. each worker's own `-db`). Registering the two new
Activities against `m.dataDir` therefore silently wrote to (and read from)
the wrong directory under exactly that harness, while still looking correct
against a plain `./slash serve` with default flags — caught by an end-to-end
Playwright run, not by `go test` alone. Fixed with a THIRD, explicit field,
`TaskManager.appDataDir` (set via `SetAppDataDir`, read via
`appDataDirOrDefault()`, falling back to `dataDir` when never set — so every
other, pre-existing `NewTaskManager` call site needs no change): `runServe`
calls `tk.manager.SetAppDataDir(resolvedData)` right after constructing `tk`,
the one place that has both directories in hand. **Any future Activity that
needs to read/write `settings.json`/`praise-words.json`/`names.json` must go
through `appDataDirOrDefault()`, never `m.dataDir` directly** — this is easy
to get wrong again in exactly the same way.

### Language per output type: the `lang_pref` tracker

"Je moet per type kunnen vertalen" — so the language is not one global switch
but one setting per KIND of output, stored in `modules/langpref`
(`lang_pref(repo, kind, lang)`, default `nl` for every kind) behind the same
per-repo-tracker write path as `autowarn`/`autoingestpref`:
`WorkflowLangPref`/`SignalLangPref` (`workflows.go`) → the `saveLangPref`
Activity → `POST /api/workflows/lang_pref` + `.../signals/lang_pref
{kind, lang}` (`tasks_api.go`), read back through the read-only
`GET /api/langpref`. One signal name with a `Kind` discriminator, exactly like
`SignalAppSettings` — a workflow can only `WaitSignal` on one name at a time.

Four types, and the two that are deliberately NOT settings matter as much as
the two that are:

- **`ui`** — every static interface string, through `t()` (see below).
- **`explain`** — the AI prose the reviewer reads ABOUT the code:
  `explain_code`, `code_warning`, `pr_summary`, `since_review`,
  `chat_summary`, `comment_titles`, `test_run`, `comment_batch`.
- **`reply`** — only the `body` of a drafted `comment_action` reply, i.e. the
  text that lands on GitHub under the reviewer's own name (see "A `reply`
  directive only drafts, never posts" in `.claude/docs/claude-chat-panel.md`).
  Its own setting because its audience is the PR's other readers, not the
  reviewer.
- **A chat ANSWER has no setting at all** — it mirrors the language the
  reviewer typed in ("antwoorden moet reageren in dezelfde taal als de
  vraag"), which is now what `prompts/chat.md`/`chat_readonly.md`/
  `chat_shell.md` say in their first paragraph, replacing the older
  "Nederlands tenzij…" framing.
- **Code, identifiers, code comments and commit messages are ALWAYS English**,
  never a choice. Fixed in `prompts/chat_shell.md` and
  `prompts/comment_batch.md`, with the one exception the reviewer named: the
  CONTENTS of a translation file (`lang/<taal>/…`, the same `TRANSLATION`
  notion `classify.go` already uses) keep their own language. The settings
  page shows this as a read-only row (`lang-commit-fixed`) so the rule is
  visible next to the choices.

**How a language reaches Claude: one appended tail, never a translated prompt
file** (`langdirective.go`). `explainLangTail(lang)` returns **the empty
string for `nl`**, so an install that never touched the setting sends
byte-identical prompts — which is also why every existing test keying
`claude.Fake` on `model+SystemPrompt` (e.g. `comment_titles_test.go`) still
matches. For `en` it appends a short LANGUAGE OVERRIDE block after the Dutch
instruction block. `chatLangTail(replyLang)` is appended in BOTH languages,
because it says two different things at once (answer = the reviewer's
language, `comment_action` body = the `reply` setting). The preference is read
**inside the Activity** that builds the prompt (`m.LangFor` /
`langFor(ctx, tm, kind)`, and `warningReviewArg.Lang` for `code_warning`),
never in a workflow body — reading a store is a side effect, see
`.claude/rules/workflow-determinism.md`.

Deliberately untranslated: the machine-read prompts whose answer nobody reads
as prose (`resolve_call`, `comment_removal`, `chat_conflict`).

### The interface language: `t()` over a Dutch-keyed dictionary

`src/i18n.mjs` is the whole frontend layer: `t(dutchText, vars?)` looks the
Dutch source string up in `src/i18n/en.mjs`'s `EN` map and falls back to the
key itself. Three consequences worth keeping:

- **The Dutch text IS the key**, so there is no key catalogue to invent or
  keep in sync, the templates stay readable, and every Playwright spec
  asserting Dutch copy keeps passing untouched (Dutch is the default and
  returns the key verbatim). Never "fix" a Dutch source string without
  updating its dictionary entry — they are one unit.
- **`t()` is synchronous and the language is fixed for the page's lifetime.**
  The choice is mirrored into `localStorage['uiLang']` exactly like the
  theme's anti-flash script, so the first paint already has it; switching
  language **reloads** (`setUiLang`) instead of re-rendering, because arrow.js
  reuses a keyed node without re-running its bindings (see
  `.claude/rules/arrowjs-pitfalls.md`) — a live swap would mean turning every
  label into a reactive binding. `syncUiLang()` reconciles the cache with
  `GET /api/langpref` once per page load and reloads if they disagree (another
  tab/browser changed it).
- **A fixed Dutch phrase that arrives from Go is translated at its RENDER
  site** through the same dictionary (`t(backendMessage)` is a pass-through
  when the phrase is unknown), which is why no Go-side i18n exists. Accepted
  limitation: a Go message that interpolates a value (`fmt.Sprintf`) has no
  stable key and therefore stays Dutch.

A sentence with a number/name stays ONE translatable unit via placeholders —
`t('{n} gebeurtenissen opgenomen', { n })` — never concatenated fragments.

## Tests

The debug row has its own spec (`tests/debug-mode.spec.mjs`), not this one.

`tests/langpref.spec.mjs` — the three language rows and the read-only commit
row, plus a `ui` switch reloading into English. Backend:
`modules/langpref/langpref_test.go` (defaults, per-kind/per-repo isolation,
`All`) and `langdirective_test.go` (the empty tail for Dutch, the override for
English, the chat tail naming both rules).

The auth row/popup have no Playwright spec of their own: under the harness's
`SLASH_GITHUB=off`/`SLASH_JIRA=off` every check reports `skipped`, so there is
nothing to assert without faking the endpoint. The regression-sensitive half —
the `.env` merge, the "empty token keeps the stored one" rule, and the CLI
output parsing — is covered by `env_save_test.go` instead. Verified by hand
against a real, genuinely expired `acli` session.

`tests/settings-page.spec.mjs` — both entry buttons + the `?from=` round trip
(including the open-redirect fallback), `↑`/`↓`/`Enter`/`Space` row
navigation, the checkout row's grey/inactive state without a PR origin, and
both write paths end-to-end (add/remove an alias across a reload; add a
praise word and confirm the last remaining one can't be removed). Backend:
`TestSaveMentionAliasesTakesEffectImmediately`/
`TestSaveMentionAliasesPreservesLoginAndRepos` (`settings_test.go`),
`TestSavePraiseWordsFileTakesEffectImmediately`/
`TestSavePraiseWordsFileEmptyFallsBackToDefaults` (`praisewords_test.go`).
