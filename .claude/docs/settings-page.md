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
`pages-and-routing.md` splits into `pr-overview.md`/`task-inbox-page.md`.

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

`src/settings.mjs`'s `ROWS = ['theme', 'autowarn', 'checkout', 'aliases',
'praisewords']` is simultaneously the `↑`/`↓` nav order and the DOM render
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
  aliases/praise-words text input. The checkout row is read-only here (see
  below), so its activation is a no-op.
- `←` calls the same `goBack()` the "← Terug" button's click runs.

## Per-setting source and write path

| Setting | Read from | Write path | Editable here? |
|---|---|---|---|
| Thema | `localStorage['theme']` (`theme.mjs`) | same, via `cycleTheme()` | Yes — reuses `themeToggleButton()` unchanged |
| Live AI assistent | `GET /api/autowarn` (`autowarn.mjs`) | `POST /api/workflows/auto_warn` + `.../signals/autowarn` (existing `auto_warn` tracker) | Yes — reuses `autoWarnToggleButton()` unchanged |
| Checkout-directory | `GET /api/chat/checkout?prs=<originPr>` | *(unchanged — see below)* | **Read-only on this page** |
| Wie ben ik — GitHub-login | `GET /api/me` (`avatar.mjs`'s `ensureMe`/`meLogin`) | — | No, by explicit reviewer decision: "wie ben ik moet uit GitHub komen" |
| Wie ben ik — extra @mention-aliassen | `GET /api/settings` (`me.aliases`) | new `app_settings` tracker, Kind `"aliases"` (see below) | Yes — new |
| Praise-woorden | `GET /api/praisewords` | new `app_settings` tracker, Kind `"praiseWords"` (see below) | Yes — new |

### Checkout-directory: read-only here, by design

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
`task_snooze`, …), there is no repo/PR to scope by, since there is exactly
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

## Tests

`tests/settings-page.spec.mjs` — both entry buttons + the `?from=` round trip
(including the open-redirect fallback), `↑`/`↓`/`Enter`/`Space` row
navigation, the checkout row's grey/inactive state without a PR origin, and
both write paths end-to-end (add/remove an alias across a reload; add a
praise word and confirm the last remaining one can't be removed). Backend:
`TestSaveMentionAliasesTakesEffectImmediately`/
`TestSaveMentionAliasesPreservesLoginAndRepos` (`settings_test.go`),
`TestSavePraiseWordsFileTakesEffectImmediately`/
`TestSavePraiseWordsFileEmptyFallsBackToDefaults` (`praisewords_test.go`).
