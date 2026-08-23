# Pages & routing

The three routes, their static shells, and the state that travels between the
review tree and the PR overview.

## Split out of this file

- `.claude/docs/pr-overview.md` — the whole `/pr-overview` page: inbox
  sections, the per-row popover (generate/regenerate, the draft reviewer
  picker, copy URL), the filter drawer, the "Mislukte taken" block, the
  workflow-backed GitHub access, its endpoint table, offline/test mode, and the
  client (`src/overview.mjs`: stacks, the `hoverEnabled` gate, selection
  identity, keyboard).
- `.claude/docs/task-inbox-page.md` — the `/inbox` page in full.

## The routes

Every route is a static HTML shell with no build step; the Go server
(`api.go`, `routes`) decides which shell a route gets, via
`serveFile(staticDir, name)`.

- **`/pr/<id>`** — the review page for a single PR (`index.html` →
  `home.mjs`). The PR id comes from the **path**, not the query string:
  `prFromPath()` (regex `^/pr/(\d+)`) sets `state.pr`. Without a valid id,
  `home.mjs` does a `location.replace('/pr-overview')`.
- **`/pr-overview`** — the **PR inbox**: a live GitHub dashboard of PRs that
  need your attention (`overview.html` → `src/overview.mjs`), see
  `.claude/docs/pr-overview.md`. Every row opens a popover menu on click; an
  ingested PR (`hasGraph`) reaches `/pr/<id>` via the menu choice "Open review
  tree". The read-only "recently generated" drawer feeds from
  **`GET /api/prs`** (`handlePRs` → `listPRs`, block/file counts per PR from
  `PRSummary`).
- **`/inbox`** — the **task inbox**: a personal, scored to-do list across PR
  reviews, unread comments on your own PRs, and Jira tickets assigned to you
  (`inbox.html` → `src/inbox.mjs`), see
  `.claude/docs/task-inbox-page.md`.
- **`/`** redirects (302) to `/pr-overview`; every other path (`/src/*`,
  `/overview.html`, …) is served statically by the `http.FileServer`.

## A fresh `/pr/<id>` open lands on the PR-description column

A genuinely fresh open — **no `?sel=` at all**: a bare `/pr/<id>` link, "Open
review tree"/"Generate" from the PR overview without a remembered position, a
just-generated PR — lands the reviewer on stop 1 (`prInfoCard`/
`state.showDescription`, see `.claude/docs/keyboard-navigation.md`) instead of
the block-index: `loadBlocks` (`home.mjs`) sets `state.showDescription = true`
whenever `!hadSelParam` (the same flag that gates
`applyDefaultUnapprovedSelection` below it), set eagerly — before the
approvals/blockstats await — so it takes effect immediately rather than once
loading finishes. → still unconditionally steps from stop 1 into the
block-index regardless of load state, so this doesn't newly depend on the
tree having finished loading. A **restored** `?sel=` (a refresh, a shared
link, or the `/pr-overview` round trip described below) is entirely
unaffected and keeps landing straight on the restored block, as before — the
reviewer only sees the summary first on a PR they haven't navigated in yet.

Test harness note: this changed the default nearly every existing Playwright
spec assumed (`page.goto('/pr/<id>')` with no `sel`, then driving the
keyboard as if the block-index already owned it) — see the `page.goto`
wrapper in `.claude/docs/testing-playwright.md`.

## `?pr=<id>` auto-selects the row you came from

From `/pr/<id>`, the **`←` nav-chain exit** (stop 1, `state.showDescription`,
see `.claude/docs/keyboard-navigation.md`) links to
`/pr-overview?pr=<state.pr>`, not the bare `/pr-overview`. (An earlier `/`-menu
item "To PR overview" was removed — the `←` exit covers the same destination.)
`overview.mjs` reads the param **once** at module load
(`new URLSearchParams(location.search).get('pr')` → `pendingSelectPr`; no
`bindUrlState` — this is a one-way consume-on-load, not a navigation position
that needs writing back) and applies it once the data has arrived, via
**`trySelectPendingPr()`**, called at the end of both `applyLive` and
`applyCached` (mirroring `applyRelRestore`/`applyBlockRefRestore`'s
restore-then-clear pattern):

- PR in `state.sections` → set the module-level `selKey` to `'row:' + pr` (the
  same identity `paintSelection`/`reanchorSelection` use, see "Selection
  identity" in `.claude/docs/pr-overview.md`); the existing `sections.length`
  watch triggers the next `scheduleRepaint()`, which sets the ring + scrolls.
- Otherwise the "Recently generated" drawer is checked: `ensureRecentPrs()`
  (the shared `GET /api/prs` fetch, same `recentLoading` guard as
  `toggleRecent()`); a hit sets `state.recentOpen = true` (the drawer opens on
  its own) + `selKey = 'recent:' + pr`, and the existing
  `recentOpen`/`recentPrs.length` watch triggers the repaint.
- PR **nowhere** (merged/dropped out of the inbox query, or never ingested) → a
  silent no-op, like a not-found `sel` restore on `/pr/<id>`.
- `pendingSelectPr` is cleared **either way** after the recent check, so a later
  background `reloadSnapshot` (every 60s) can't force the selection again.
- `hoverEnabled = false` is set alongside (like `move`/`moveTo` do) so a stray
  hover doesn't immediately override the auto-selection.
- The `?pr=` param is deliberately **not** cleaned up (no `history.replaceState`)
  — harmless on a refresh, which simply selects the same PR again.

Test: `tests/overview-pr-select.spec.mjs` (in-sections, drawer-only, and the
silent no-op).

## `?approved=<id>` — the opposite of `?pr=`: hide the row, select the top one

"Goedkeuren en ga naar overzicht" (the confirm step that submits a real
`APPROVE` review for the WHOLE PR, see `REVIEW_APPROVE_CONFIRM_COMMANDS` in
`.claude/docs/command-palette.md`) links to
**`overviewExitUrlAfterApprove()`** (`home.mjs`) — `/pr-overview?approved=<pr>`
— deliberately **not** `overviewExitUrl()`/its `?pr=`/`?sel=` round trip:
there's nothing left to return to once the whole PR is approved, and the
reviewer asked for the opposite of "select the row I came from" — that row
must already be gone by the time the page renders, with the new top row of
the list selected instead. Reported as: "als ik een gehele PR goedkeur … wil
ik dat het al uit het overzicht is, en selecteer dan de bovenste item".

- `overview.mjs` reads `?approved=` once, into a plain, **never-nulled**
  module const `approvedPr` (unlike `pendingSelectPr` above, it must keep
  applying on every later `reloadSnapshot` poll too, not just the first
  paint).
- `normalizeSections` filters `approvedPr` out of every section's `prs`
  **before** `state.sections` is ever assigned — so the very first render
  already excludes it; there is no flash of the just-approved row followed by
  it disappearing once a background refresh catches up. `applyCached`'s
  fallback path (the offline/cached snapshot) filters its own flat `prs` array
  the same way.
- **`trySelectTopAfterApprove()`** (mirroring `trySelectPendingPr`'s
  restore-then-clear shape, called right after it in both `applyLive` and
  `applyCached`): while `pendingSelectTop` (one-shot, set iff `approvedPr !=
  null`), sets `selKey` to `'row:' + ` the first PR across
  `state.sections.flatMap(...)` — i.e. whatever is now the top row of the
  (already filtered) list — and clears the flag. Same `hoverEnabled = false`
  discipline as every other programmatic selection.
- Like `?pr=`, `?approved=` is **not** cleaned up from the URL — harmless on a
  refresh, which simply keeps filtering the same (by then long-gone) PR
  number.

Test: `tests/review-submit-menu.spec.mjs` ("submits, then lands on
/pr-overview with that PR already gone and the top row selected").

## `?sel=` (+ `?drill=`) travels along on the same round trip

Alongside `?pr=` (which **row** to select in the overview), the same round trip
carries `?sel=<file:line>` — which **block** you get back once you re-enter the
review tree. A pure extension of the existing `sel` mechanism
(`bindUrlState`/`state.blockRef`/`applyBlockRefRestore`, see the URL-state
section in `CLAUDE.md`): no new storage, no localStorage — `sel` was already
the canonical shareable navigation position.

- **Outgoing (`home.mjs`):** `overviewExitUrl()` builds the `←`-exit
  destination — `/pr-overview?pr=<state.pr>` plus
  `&sel=<encodeURIComponent(state.blockRef)>` whenever there is a selection
  (empty `state.blockRef` → no `sel` param, e.g. right after loading).
- **Incoming (`overview.mjs`):** two **never-nulled** module `let`s,
  `originPr`/`originSel`, read `pr`/`sel` once on load — deliberately separate
  from the one-shot `pendingSelectPr` (cleared within milliseconds of load),
  because these must stay alive until the reviewer clicks back into the tree
  minutes later. `treeUrl(pr)` — used by **all three** navigation points to
  `/pr/<n>` (`generatePage`'s redirect after a successful (re)ingest, "Open
  review tree", and the `→` forward nav in `openOrGenerate`) — only adds
  `?sel=<originSel>` when `pr.number === originPr`, so clicking a *different*
  PR never inherits an unrelated PR's sel.
- **Block no longer found** (removed, or fully approved and thus hidden) relies
  on the existing `applyBlockRefRestore` fallback (clamp to the default) — same
  behaviour as an expired/shared `?sel=` link, no extra edge-case code.
- **`?drill=`/`?dgran=`/`?dchg=`/`?dcur=` travel along with `?sel=`** — an open
  drilled Underlying-code column is also a navigation position (see
  `.claude/docs/drilling.md`), so `overviewExitUrl()` appends them whenever
  `state.drillRef` isn't empty, **only together with `sel`** (drilling has no
  meaning without a selected block). `dcur` carries EVERY level's own
  `{gran, change}` cursor (not just the deepest, which `dgran`/`dchg` alone
  cover) — needed so an ancestor column's exact position also survives the
  round trip, not just resets to `{group, 0}`. `overview.mjs` reads them in
  the same step as `originSel` (`originDrill`/`originDrillGran`/
  `originDrillChange`/`originDrillCursorRef`, four more never-nulled module
  `let`s) and `treeUrl(pr)` only adds them when `sel` is also added. Back in
  `/pr/<n>`, `applyDrillRefRestore`/`applyDrillCursorRestoreAt` (`home.mjs`)
  resolve them into real drilled columns; not found (relation gone, resolver
  rerun) → the same silent fallback as `sel` itself.

Test: `tests/overview-pr-select-block.spec.mjs`.

## Real names instead of logins (`/api/names` + the row's author column)

Every inbox row **starts** with who wrote the PR: the author's avatar with
their **first name** under it (`authorMark`, `data-testid=row-author`,
`data-author` = the login). That replaced a `git-pull-request` glyph which
distinguished draft from open **by colour only** — meaningless for a colourblind
reviewer; draft is still spelled out in words by `statusArea`'s "Concept" chip
and the "Your drafts" section heading, so **no draft marker was added in its
place** (deliberate). The login is no longer repeated in `rowMeta`. The same
first name feeds the reviewer-avatar tooltips and the per-author group headers
of the "ouder dan 3 dagen" preset (whose `data-author` stays the **login** —
that is its grouping identity).

The name comes from read-only **`GET /api/names?logins=a,b`** (`handleNames` →
`TaskManager.DisplayNames`, `usernames.go`), with this precedence:

1. **`<dataDir>/names.json`** — a hand-maintained `{"login": "Full Name"}` map.
   It wins, because a GitHub profile name is freely editable, often empty, and
   sometimes just the username again; this file is where a team corrects that
   without touching code. Missing or unparsable → empty map (never an error),
   read once per data dir, so editing it takes a restart. The repo **ships**
   this file (`data/names.json`, committed — only `data/*.db*` is gitignored):
   it covers every `plug-and-pay/plug-and-pay` collaborator whose GitHub
   profile `name` is empty, which is the only thing that makes the UI fall back
   to the bare lowercase login. Names in it are hand-supplied by the team;
   never guess one.
2. The **GitHub profile `name`**, via one batched `gh api graphql` call
   (`github.Client.UsersByLogin`: one aliased `user(login:)` field per login,
   logins validated + passed as `-f` variables, a non-resolving login parsed out
   of the partial response rather than failing the batch).
3. Neither → the name stays **empty** and the frontend shows the **bare login**,
   unmodified (no forced capitalisation).

The **read-model stores the full name**; cutting it to the first token happens
in the frontend (`firstNameOf`/`displayNameOf`, `src/avatar.mjs`), so a later
caller can show the full name with no backend change. Casing is whatever
GitHub/`names.json` gives.

**Two more local override files follow this same pattern.**
`<dataDir>/settings.json` (`settings.go`, read-once-per-data-dir,
missing/unparsable → empty settings, served by read-only `GET /api/settings`)
holds the per-reviewer settings — today only "who am I" for `@mention` detection
(`{"me": {"login": …, "aliases": […]}}`), which **wins over `GET /api/me`**; see
"Who am I" in `.claude/rules/conventions.md` and the "Mentioned" section in
`.claude/docs/comments-panel.md`. It is **gitignored** (it names one person) with
a committed `data/settings.example.json` as the template. New **per-user**
settings belong in this file rather than in a fourth one.

The other:
`<dataDir>/praise-words.json` (read-once-per-data-dir, missing/unparsable →
built-in defaults, served by read-only `GET /api/praisewords`) holds the
"meaningless praise" words that the review clipboard summary does not count as
open points — see "A thread ending in 'just praise' is not an open point" in
`.claude/docs/command-palette.md`. Unlike `data/names.json` that one is
deliberately **not** committed: it is personal, not team-wide.

**Write boundary:** a pure read plus a **process-lifetime, in-memory** cache
(including negative caching, so a bot/deleted login is never re-queried), so it
is allowed outside a workflow — the same operational carve-out as `/api/me`'s
`CurrentUser` and the avatar image cache (see
`.claude/rules/workflows-write-boundary.md`). The cache is deliberately
package-level rather than a `TaskManager` field, mirroring
`ingest_progress.go`. Skip-list, never sent to GitHub: the empty string, the
`reviewer` sentinel the UI stores as its own comments' author, and any `[bot]`
login (`user(login:)` only resolves Users).

**Frontend timing rule:** `ensureNames(logins)` must be **awaited before** the
rows that render those names are pushed into reactive state
(`primeAuthorNames`/`primeSectionNames` in `overview.mjs`, and before
`state.statuses` for the reviewer strip) — `names` is a plain non-reactive `Map`
and arrow.js reuses a keyed row without re-running its bindings, so a late
arrival could never repaint it (the same reason `loadComments` awaits
`ensureMe`). Because this sits on the inbox's first paint, `ensureNames` races
its own fetch against a short `NAMES_WAIT_MS` deadline: past that the rows
render with logins and the response still lands in the `Map` for the next
render (the overview re-polls its snapshot anyway). Test:
`tests/overview-author-name.spec.mjs`.

The same resolver also feeds the **review tree** and the **task inbox** via
`identityOf` — see the "Shared avatar helper" bullet in
`.claude/rules/conventions.md` for which call sites that covers automatically
and which read a raw `author` field and had to be pointed at `identityOf`.
Test: the last case in `tests/comment-author-avatar.spec.mjs`.
