# Pages & routing

The app has two pages, both static HTML shells with no build step; the Go
server (`api.go`, `routes`) decides which shell a route gets:

- **`/pr/<id>`** — the review page for a single PR (`index.html` → `home.mjs`).
  The PR id comes from the **path**, not the query string: `home.mjs` reads it
  with `prFromPath()` (regex `^/pr/(\d+)`) and sets it in `state.pr`. Without a
  valid id in the path, `home.mjs` does a `location.replace('/pr-overview')`.
- **`/pr-overview`** — the **PR inbox**: a live GitHub dashboard of PRs that
  need your attention (`overview.html` → `src/overview.mjs`). See the
  **PR inbox** section below. Every row opens the same popover menu on click;
  an ingested PR (`hasGraph`) reaches `/pr/<id>` via the menu choice "Open
  review tree". The read-only "recently generated" drawer still feeds from
  **`GET /api/prs`** (`handlePRs` → `listPRs`, block/file counts per PR from
  `PRSummary`).
- **`/`** redirects (302) to `/pr-overview`; every other path
  (`/src/*`, `/overview.html`, …) is served statically by the
  `http.FileServer`. The `/pr/` and `/pr-overview` routes serve their shell via
  `serveFile(staticDir, name)`.

## PR inbox (`/pr-overview`)

The landing page is a **GitHub inbox**, rebuilt on top of GitHub's own
`github.com/pulls` dashboard: the same sections and language ("Ready to merge",
"Needs your review", …), with per-row review status, CI checks, reviewers, and
diff stats. It is **fully read-only** in the sense that it never writes
directly to a module/table (per `workflows-write-boundary.md`). **Every row**
— ingested or not — opens the same popover menu on click (`prRow`/`popover(pr)`
in `src/overview.mjs`, `@click="${() => togglePopover(pr.number)}"` on the
whole row, a `role="button"` `<div>`, no `<a>`); only the menu's **content**
differs by `pr.hasGraph`:

- **`pr.hasGraph === false`** (not yet ingested, `generateAction(pr)`):
  as the **first** choice, **"Generate review tree"** (`data-testid=
  generate-page`) — this starts the existing **`POST /api/ingest {"pr":N}`**
  endpoint (see `.claude/rules/blocks-and-ingest.md`), the sanctioned write
  path (starting a Workflow Execution), not a direct module write. During
  generation, the button shows a spinner + the **actual pipeline stage**
  instead of static text — "Preparing worktrees…" / "Scanning blocks…" /
  "Building relations…" (`INGEST_STAGE_LABELS`, fallback "Generating…" as long
  as no stage is known yet) — and is `disabled` (`ui.ingesting`, against a
  double ingest). `generatePage` polls **`GET /api/ingest/progress?pr=N`**
  every 800ms for this (`ingest_progress.go`, a purely in-memory, ephemeral
  counter that the `prepareWorktrees`/`scanAndStoreBlocks`/`buildRelations`
  Activities in `workflows.go` update — no module/read model, so within the
  write-boundary exception for state-less pings, see
  `.claude/rules/workflows-write-boundary.md`) into `ui.ingestStage`. Both the
  busy text/icon and the `disabled`/`class` styling hang off their **own**
  nested `${() => …}` bindings (`ingestBusy`/`ingestLabel`/`ingestIcon`)
  instead of a plain-JS ternary on a once-captured `busy` variable —
  otherwise the button wouldn't update while the popover is already open (see
  the arrow.js pitfall in `conventions.md`). `handleIngest` (`api.go`)
  responds 200 only once the ingest pipeline **and** `EnsureRelations` have
  finished synchronously, so `generatePage` does a simple full
  `location.href = '/pr/<n>'` redirect on success — the fresh page load
  already has everything it needs by then. If generation fails, the popover
  stays open with the error message (`ui.ingestError`,
  `data-testid=generate-error`) and the row itself doesn't change (still
  `hasGraph:false`).
- **`pr.hasGraph === true`** (already ingested, `ingestedActions(pr)`): two
  choices — **"Open review tree"** (`data-testid=open-tree`, navigates
  directly to `location.href = '/pr/' + pr.number`) and **"Regenerate"**
  (`data-testid=regenerate-page`) which reuses the same
  `generatePage`/`ui.ingesting`/`ui.ingestStage` flow as the not-yet-ingested
  branch, but with `{ redirect: false }` (`generatePage(pr, { redirect })` —
  default `true` for the "Generate" branch; "Regenerate" must **not**
  navigate, the reviewer stays on the overview and just wants the
  underlying data refreshed; `ui.ingesting` itself goes back to `null` on
  success). A failed regeneration shows the error message under the button,
  within the same popover (`data-testid=regenerate-error`).

For a **draft** PR (`pr.isDraft`), the popover also shows a **"Klaar voor
review"** section (`data-testid=ready-section`, only rendered for drafts).
Clicking it (`data-testid=ready-for-review`) fetches `GET /api/reviewers` and
expands an inline reviewer checklist (`data-testid=ready-picker`, repo
collaborators sorted **most-used-first** — one `data-testid=reviewer-<login>`
button per candidate, a `count×` hint on used ones), plus a confirm button
(`data-testid=ready-confirm`) that POSTs the **`ready_for_review`** workflow
(the sanctioned write path — flips the draft to ready + requests the checked
reviewers + bumps their local usage count) and, on success, closes the popover
and calls `reloadSnapshot()` so the row leaves "Your drafts" without waiting
for the 60s poll. The ready-flow state lives on `ui` (`readyFor`/`reviewers`/
`selectedReviewers`/…, all ephemeral) and resets on every
`togglePopover`/`closePopover`. See the `ready_for_review` workflow +
`modules/reviewerusage` in `.claude/rules/tembed-workflows.md`.

Below both branches sit, unchanged, *Open on GitHub* / *Open Jira ticket*,
followed by **"Copy GitHub URL"** (`data-testid=copy-url`,
`navigator.clipboard.writeText(pr.url)` with brief "Copied!" feedback via the
ephemeral `ui.copiedFor`) and the **ignore section** (see below).
Because there's now never an `<a href="/pr/<id>">` in the row anymore — the
navigation to the tree always runs through the menu choice "Open review
tree" — there's also no separate hover-only regenerate button
(`regenerateButton`) or separate `data-row` wrapper needed anymore; those
have been removed (they were previously needed to avoid nesting an
interactive element inside an `<a>`, which no longer applies).

### Filter drawer (preset filters, live gh search)

Next to "Recently generated" sits a second expandable button **"Filters"**
(`filterDrawer`, `data-testid=filter-drawer`, modeled on `recentDrawer` —
`state.filterOpen` toggles, a keyed-array slot with its own key per branch
`filter:closed`/`filter:open`, per the single↔array pitfall in
`conventions.md`). Expanded, it shows a menu with **four preset filters** +
**"Show all hidden pull requests"** (`data-testid=show-hidden`). Each preset
runs a **live gh search** via `GET /api/prs/filter?preset=<key>`
(`runPreset` → `state.presetResults`/`state.activePreset`, sequence-guarded
like `runSearch`); the results **temporarily replace the main sections**
(`currentView` in `overview.mjs` routes: query > hidden > preset > inbox),
with a "← Back to inbox" bar (`data-testid=back-to-inbox`,
`clearPresetView`).

The queries are **server-side allow-listed** (`filterPresets` in
`inbox_api.go`) — the UI only sends a fixed `key`, never raw search text to
gh (`exec` input validation). The four keys: `updated-oud`
(`sort:created-asc`, oldest first), `alle-open`, `alle-draft`, and
**`ouder-3-dagen`** — for that last one, `handleFilter` computes the date
boundary **dynamically** (`created:<{today−3d}`, `YYYY-MM-DD`; a read
handler, so `time.Now()` is allowed here — the determinism rule only applies
in workflow bodies). `searchPRsExpr`/`runPRSearch` (`inbox.go`) prepend
`repo:<slug>` but respect the preset's own `sort:`/`draft:` (unlike
`searchPRs`, which always appends `sort:updated-desc`). The
`ouder-3-dagen` results are **grouped by author** on the frontend
(`authorGroups`/`authorGroupBlock`, `data-testid=author-group`); the other
three are a flat list. Offline (`SLASH_GITHUB=off`), `handleFilter` only
honors the `draft:` qualifier of the fixture rows. Test:
`tests/overview-filter-presets.spec.mjs`.

### Ignore / hide from the inbox

A PR can be **ignored** from the per-row popover ("Ignore PR", a divider with
one button per duration: **Always / Tomorrow 08:00 / Next Monday 08:00 /
7 days / 14 days**, `data-testid=ignore-<kind>`). `ignoreUntil(kind)` computes
the **absolute expiry timestamp** in browser-local time ("always" = `0`) and
`ignorePr` sends it as `IgnoreSignal{pr, until}` to the per-repo `ignore`
tracker (`POST /api/workflows/<ignoreRunId>/signals/ignore`, the sanctioned
write path — see `.claude/rules/tembed-workflows.md`). The UI updates
`state.ignores` **optimistically** (wholesale reassign, so the row disappears
immediately) and reconciles on the next `reloadIgnores`. An already-ignored
PR shows one **"Stop ignoring"** button instead of the duration options
(`unignorePr` → `clear:true` → the workflow does `Set(..., -1)`, a DELETE).

Hiding happens **client-side at read time** (`isIgnored(n)` = `until === 0 ||
until > Date.now()`): `mainContent` (sections + stacks) filters out ignored
PRs; presets/search results deliberately remain unfiltered (explicit views).
The menu item **"Show all hidden pull requests"** opens the `hiddenBlock`
view (`data-testid=hidden-view`): one row per valid (unexpired) ignore with
the title from the already-loaded inbox data (or a minimal `#number` row for
a PR that fell out of the inbox query), an **"ignored until \<date\>"** note
(`formatIgnoreUntil`, `until 0` → "always"), and an un-ignore button
(`data-testid=hidden-unignore`). `state.ignores` is filled on load by
`loadIgnore` (`POST /api/workflows/ignore` → `runId`, then
`GET /api/ignore`); `state.ignoreRunId`/`state.ignores`/`state.filterOpen`/
`state.activePreset`/`state.showHidden` live **outside** the URL (ephemeral,
mirroring `ui.openPopover`/`recentOpen`). Test:
`tests/overview-ignore.spec.mjs`.

### GitHub access runs through a workflow (never direct)

**The page never calls GitHub itself.** The PR list is fetched and managed by
the **`pr_inbox` workflow** (one Execution per repo, see
`.claude/rules/tembed-workflows.md`); that writes the latest state into the
**`inbox` module** (a read model), and the HTTP handlers only read that read
model. This is the canonical write-boundary shape: only a workflow talks to
GitHub and mutates state.

- **`pr_inbox` workflow** (`workflows.go`): a `for` loop on a `refresh`
  **Signal** → one `refreshInbox` **Activity**. The Activity runs
  `buildInboxSnapshot` (fetch + `statusesFor`), stores it in the `inbox`
  module, and returns only a small `{updatedAt, prs}` summary — the data
  itself lives in the module, so the event history stays compact even though
  the workflow refreshes endlessly.
- **Poller cadence (heartbeat-driven, like the comment poller):** `pollInbox`
  sends a `refresh` Signal on the **fast** cadence (`pollInterval`, 1 min) as
  long as a heartbeat arrived within `heartbeatWindow`, otherwise on the
  **slow** cadence (`idlePollInterval`, 10 min). At startup, `EnsureInbox`
  sends one **synchronous** refresh, so the read model is filled before the
  server serves; after a restart, `EnsureInbox` reuses the existing
  Execution (`findInboxRun`).
- **The UI drives the cadence:** on load, `overview.mjs` sends a `refresh`
  Signal (`POST /api/workflows/{runID}/signals/refresh`) so the workflow
  checks again immediately, plus a **heartbeat** (`POST …/heartbeat`) — but
  **only if the tab is visible and focused** (`activeTab()`), so a parked tab
  naturally drops to the slow cadence. The UI then polls the read model
  periodically (`reloadSnapshot`) to show the latest snapshot. The heartbeat
  doesn't mutate durable state (only in-memory poll timing) and thus falls
  outside the write boundary — exactly as with comments.

The actual GitHub fetch (`inbox.go`): `gh api graphql` `search` calls (no new
dependency). `lightFields` renders the row, `heavyFields` (`mergeable
reviewDecision`, `reviewRequests`, `latestReviews`, `statusCheckRollup`) fills
the pills. `hasGraph` is overlaid from the `blocks` table (`ingestedSet`).
`inboxSections` mirror `/pulls` (qualifiers 1-to-1 from dash's
`INBOX_SECTIONS`, incl. `archived:false`, the copilot query, and the
**COMMENTED-catch** `keep` filter); queries run in parallel and are
recombined deterministically. `mergeReviewers` and `statusesFor` (one aliased
call) as before.

**Endpoints:**

| Endpoint | Does |
|---|---|
| `GET /api/inbox` | Reads the read model → `{ok,live,repo,generatedFor,updatedAt,runId,sections}`. `runId` = the `pr_inbox` Run ID (for refresh/heartbeat). No snapshot yet → `{ok:false}`. |
| `GET /api/inbox/status?prs=12,13` | The pills, also from the read-model snapshot (no GitHub call). |
| `POST /api/workflows/{runID}/signals/refresh` | Refresh Signal (UI on load). Only starts the fetch Activity. |
| `POST /api/workflows/{runID}/heartbeat` | Operational ping (poll cadence), no state write. |
| `GET /api/prs/search?q=…` | **Still a direct** live gh `search` (`inbox_api.go`) — an ephemeral, parameterized read, not a persistent list. A bare number → `<n> in:title`. |
| `GET /api/prs/filter?preset=<key>` | Live gh `search` for a **fixed, allow-listed** preset query (`filterPresets` in `inbox_api.go`) — never raw UI text to gh (`exec` input validation). See "Filter drawer" below. |
| `POST /api/workflows/ignore` | Ensures the per-repo `ignore` tracker → `{runId}` (the UI signals ignore/un-ignore to it). See `.claude/rules/tembed-workflows.md`. |
| `GET /api/ignore` | Read-only ignore read model → `{ok,ignores:[{pr,until}]}`. Expiry check happens client-side at read time. |
| `GET /api/reviewers` | Read-only candidate reviewers → `{ok, reviewers:[{login,avatarUrl,count}]}` — repo collaborators sorted most-used-first (local usage counts). |
| `POST /api/workflows/ready_for_review` | `{pr, reviewers?}` → flip a draft PR to ready + request reviewers (the sanctioned write path). 400 on an invalid pr/login. |
| `GET /api/prs` | (existing) ingested PRs + counts, for the recent drawer. |

### Offline / test mode

Under **`SLASH_GITHUB=off`** nothing touches the network:
`buildInboxSnapshot` (the Activity) serves the **fixture** from `SLASH_INBOX`
(`tests/fixtures/inbox.json`, shape `{repo,generatedFor,sections,statuses}`).
At startup, the synchronous refresh fills the read model, so `GET /api/inbox`
has data right away (no race in tests). `hasGraph` comes from the DB, so the
seeded PR (12903) shows "Open review tree" in its popover, pointing to
`/pr/12903`. If the first fetch fails (no fixture, no snapshot) →
`/api/inbox` `{ok:false}` → the client falls back to `GET /data/inbox.json`
(label "cached").

### `?pr=<id>` auto-selects the row you came from

From `/pr/<id>`, both the **`←` nav-chain exit** (stop 1,
`state.showDescription`, see `.claude/rules/keyboard-navigation.md`) and the
**`/`-menu item "To PR overview"** (`PR_COMMANDS` in `home.mjs`) link to
`/pr-overview?pr=<state.pr>` — not the bare `/pr-overview`. `overview.mjs`
reads that param **once** at module load
(`new URLSearchParams(location.search).get('pr')` → `pendingSelectPr`,
mirroring `home.mjs`'s `prFromPath()` — no `bindUrlState`, this is a
one-way consume-on-load, not a navigation position that needs to be written
back) and applies it once the data has arrived, via **`trySelectPendingPr()`**,
called at the end of both `applyLive` and `applyCached` (mirroring
`applyRelRestore`/`applyBlockRefRestore`'s restore-then-clear pattern):

- If the PR is in `state.sections` (the main list) → set the module-level
  `selKey` to `'row:' + pr` (the same identity `paintSelection`/
  `reanchorSelection` already use, see above) and `pendingSelectPr = null`.
  The existing `sections.length` watch automatically triggers the next
  `scheduleRepaint()`, which sets the ring + scrolls.
- If the PR is **not** in there, the "Recently generated" drawer is checked:
  `ensureRecentPrs()` (the same `GET /api/prs` fetch as `toggleRecent()` —
  now a shared helper, with the same `recentLoading` guard) fetches the
  list; if the PR is in it, `state.recentOpen = true` (the drawer opens on
  its own) + `selKey = 'recent:' + pr`. Here too the existing
  `recentOpen`/`recentPrs.length` watch triggers the repaint.
- If the PR is **nowhere** (merged/dropped out of the inbox query, or never
  ingested) → a silent no-op, just like a not-found `sel` restore on
  `/pr/<id>`. `pendingSelectPr` is cleared once **either way** after the
  recent check, regardless of outcome — a later background reload
  (`reloadSnapshot`, every 60s) must not force the selection again.
- `hoverEnabled = false` is set alongside (like `move`/`moveTo` already do)
  so a stray mouse hover doesn't immediately override the auto-selection.
- The `?pr=` param is deliberately **not** cleaned up (no
  `history.replaceState`) — harmless on a refresh, which then simply selects
  the same PR again.

Test: `tests/overview-pr-select.spec.mjs` (in-sections, drawer-only, and
the silent no-op).

### `?sel=` travels along on the same round trip: the same block stays selected

Alongside `?pr=` (which **row** to select in the overview), the same round
trip also carries `?sel=<file:line>` — which **block** you should get back
once you re-enter the review tree from the overview. This is a pure
extension of the existing `sel` mechanism (`bindUrlState`/`state.blockRef`/
`applyBlockRefRestore`, see the URL-state section in `CLAUDE.md`) — no new
storage mechanism, no localStorage: `sel` was already the canonical,
shareable navigation position for a refresh/shared link, this simply reuses
it across the round trip via `/pr-overview`.

- **Outgoing (`home.mjs`):** `overviewExitUrl()` builds the destination for
  **both** exits to `/pr-overview` (the `←` nav-chain exit at stop 1, and the
  `/`-menu item "To PR overview") — `/pr-overview?pr=<state.pr>`, plus
  `&sel=<encodeURIComponent(state.blockRef)>` whenever there's a selection
  (`state.blockRef` empty → no `sel` param, e.g. right after loading).
- **Incoming (`overview.mjs`):** two **never-nulled** module `let`s,
  `originPr`/`originSel`, read `pr`/`sel` **once** on load — deliberately
  **separate** from the existing, one-shot `pendingSelectPr` (which gets
  cleared within milliseconds of load once the row is found/not-found);
  `originPr`/`originSel`, in contrast, need to stay alive until the reviewer
  actually clicks back into the tree minutes later. `treeUrl(pr)` — used by
  **all three** navigation points to `/pr/<n>` (`generatePage`'s redirect
  after a successful (re)ingest, "Open review tree", and the `→` forward nav
  in `openOrGenerate`) — only adds `?sel=<originSel>` if
  `pr.number === originPr`: if you click a **different** PR in the overview
  than the one you came from, it never gets a sel from an unrelated PR
  attached.
- **Block no longer found** (removed, or meanwhile fully approved and thus
  hidden) relies on the **existing** `applyBlockRefRestore` fallback (clamp
  to the ordinary default) — no new edge-case code needed, exactly the same
  behavior as an expired/shared `?sel=` link.
- **`?drill=`/`?dgran=`/`?dchg=` travel along alongside `?sel=`** — an open
  drilled Underlying-code column (see "Drilling" in
  `.claude/rules/detail-layout.md`) is also a navigation position, so
  `overviewExitUrl()` appends them whenever `state.drillRef` isn't empty
  (only together with `sel`, never alone — drilling has no meaning without a
  selected block). `overview.mjs` reads them in the same step as `originSel`
  (`originDrill`/`originDrillGran`/`originDrillChange`, three extra
  never-nulled module `let`s) and `treeUrl(pr)` only adds them when `sel` is
  also added (`pr.number === originPr`). Back in `/pr/<n>`,
  `applyDrillRefRestore`/`applyDrillCursorRestore` (`home.mjs`) resolve them
  into real drilled columns — see `.claude/rules/detail-layout.md`. Not
  found (relation gone, resolver rerun) → the same silent not-found fallback
  as `sel` itself.

Test: `tests/overview-pr-select-block.spec.mjs`.

### Client (`src/overview.mjs`, arrow.js, dark zinc)

Two-phase render via a reactive `state.statuses` (skeleton → pills, no
layout shift). Features: sectioned list, debounced search (separate results
region, sequence guard), **stacks** (each PR whose `baseRefName` equals an
in-view PR's `headRefName` → an indented group at the top), reviewer
avatars, review/CI chips, "recently generated" drawer (lazy
`GET /api/prs`), and keyboard nav (↑/↓/Home/End/Enter/`/`/→, with the
hover-vs-keyboard flag so `scrollIntoView` doesn't hijack the selection). The
GitHub section titles stay in English.

**Stacks are a TREE, not a linear chain (`computeStacks`, `src/overview.mjs`,
exported purely for testability).** One PR can be the direct base for
**multiple** sibling PRs at once — e.g. five separate feature branches all
branched directly off the same, not-yet-merged branch (a "fan-out"), rather
than each off the previous one. That's just as valid a stack relationship as
a linear chain (after all, each sibling PR's `baseRefName` points to an
in-view PR's `headRefName`), but an earlier version modeled this as a strict
list (`childOf: Map<parentNum, PR>`, with a guard that only remembered the
first-processed child candidate per parent) — so on such a fan-out, only the
first sibling got lifted and the rest stayed unnoticed in their normal
section. `computeStacks` now builds `childrenOf: Map<parentNum, PR[]>` (all
matches, not just the first, sorted by ascending PR number) and flattens
each tree via a depth-first walk into `[{pr, depth}, …]`: the root at
`depth 0`, and **all sibling PRs stacking on the same parent share the same
`depth`** (rather than each one level deeper than the previous, as a linear
chain would suggest) — only a *real* chain (A→B→C, each step one new branch
deeper) still yields increasing depths.
`stackGroup`/`listBox`/`connectorMark` (unchanged, generic on `opts.depth`)
thus simply render siblings at the same depth one after another, with
identical indentation/connector. Only trees with ≥ 2 nodes count as a stack.
Test: `tests/overview-stack-fanout.spec.mjs` (fixture
`tests/fixtures/inbox-fanout.json`, a literal reproduction of a real
fan-out — 1 base PR + 5 sibling PRs all branching directly off it — fed as
synthetic data directly into `computeStacks`, not via `SLASH_INBOX`: the
`/api/inbox` snapshot is one shared, worker-wide read model that several
other overview tests hold exact row counts against, so a second inbox
fixture can't coexist there; mirrors the "import an already-loaded page
module, call its exported pure function with synthetic data" pattern from
`navigate.spec.mjs`'s `changeGroups` test).

**The hover-vs-keyboard flag (`hoverEnabled`) gates on an actual cursor
position change, not the `mousemove` event itself.** Every keyboard step
(`move`/`moveTo` in `overview.mjs`) sets `hoverEnabled = false` before
`paintSelection()` — which always calls `scrollIntoView` — precisely to
prevent the following scroll from triggering a `mouseenter` that hijacks the
keyboard selection. Browsers (Chromium by name) however synthesize a
`mousemove` DOM event at the **unchanged** cursor position to resync `:hover`
after such a scroll/layout change — a bare
`addEventListener('mousemove', () => hoverEnabled = true)` can't tell that
apart from a real mouse move and would thus immediately turn the flag back
on, after which the row that happened to sit under the stationary cursor
would pull the selection back (the reported "the PR items shift along"
during arrow-key navigation). The listener therefore stores the last-seen
`clientX`/`clientY` and only turns `hoverEnabled` on for an actual delta.
Tested in `tests/overview-hover-gate.spec.mjs`: it dispatches its own
`mousemove`/`mouseenter` DOM events (the browser-native scroll-triggered
case turned out not to reproduce deterministically under Playwright, see
also the `selectRowByKeyboard` note in `overview.spec.mjs`) to prove the
gate itself: identical coordinates never hijack the selection, a real
position delta does so again normally.

**Keyboard selection follows identity (`selKey`/`data-nav-key`), not just an
array position (`selIndex`).** Every navigable row (`prRow` and
`recentItem`) carries, alongside `data-nav-row`/`data-pr`, a stable
`data-nav-key` (the same string as that row's arrow.js `.key(...)`, e.g.
`"row:12903"`/`"recent:12903"`). `move`/`moveTo` set both `selIndex` and
`selKey` on every step; `paintSelection()` always first calls
`reanchorSelection(rows)` before painting, which **derives `selIndex` from
`selKey`** against the `currentRows()` present at that moment — if that row
still exists, the ring follows it to its (possibly shifted) position; if
it's truly gone, the selection is **released** (`selIndex = -1`, no ring)
instead of landing on some arbitrary other row. This was needed because the
underlying row list can change without the reviewer pressing an arrow key
themselves: typing/clearing a search (replaces the whole row set with
another, possibly shorter/differently ordered one), a background snapshot
reload (`reloadSnapshot`, every 60s), or opening/closing the "Recently
generated" drawer (see below) — with a bare positional `selIndex` the ring
would then stick to "whatever happens to be in that spot", almost always a
different PR than the one the reviewer had selected. Tested in
`tests/overview-selection-identity.spec.mjs` (searching for a short,
differently ordered result set never lands the ring on the only remaining,
non-selected row; collapsing the drawer with a selection in it releases the
selection instead of letting it land on a pr-row).

**`→` and `Enter` deliberately mean different things on the selected row.**
`Enter` (`activateSelected`) stays unchanged: click the row, which opens the
popover menu (or, for a "Recently generated" item, navigates directly —
that's already an `<a href>`). `→` (`activateSelectedForward`) is the "go
straight ahead" key, analogous to the `→` convention on `/pr/<id>` (see
`keyboard-navigation.md`: `→` steps one stop further, `Enter` opens a
menu): on a `hasGraph` row, `→` navigates **directly** to `/pr/<n>`
(identical to "Open review tree", no popover shown); on a not-yet-ingested
row, `→` (`openOrGenerate`) opens the same popover `Enter` would — needed to
show the existing busy spinner/stage text/error message during generation,
no new UI — and immediately fires `generatePage(pr)` (default
`redirect:true`), so the tree opens automatically on success. If it fails,
the popover stays open with the same inline error message as a
mouse-driven attempt. `findPrByNumber` looks up the `pr` object (with
`hasGraph`) via `data-pr` in `state.sections` (also covers stacked rows —
the same object references) and `state.searchResults`; no match
(defensive) falls back to the existing `activateSelected()`.
`handlePopoverKey` keeps intercepting `→` as long as a popover is already
open, so a second `→` press on a freshly opened generate popover does
nothing extra.

**The "Recently generated" drawer joins the `↓` navigation once it's
open** — a deliberate choice: `currentRows()` simply remains all
`[data-nav-row]` elements (both `pr-row` and `recent-item`), so once the
drawer is open, `↓` from the last PR row simply flows on into the drawer
items, in DOM order. Closed, the drawer is empty (no `recent-item`s in the
DOM), so then it doesn't participate — and if you close it while the
selection sits on a drawer item, the identity re-anchoring above releases
that selection (no ring) instead of pasting it onto a leftover pr-row.

Also: **`Escape` in the search box blurs the field** (besides clearing
`state.query`) — otherwise `document.activeElement` would stay on the (now
empty) input and `kbHandler`'s `typing` guard (`active.tagName === 'INPUT'`)
would eat *every* subsequent arrow key, which felt like "the arrows just
stopped working" until the reviewer manually clicked away/tabbed out.

And conversely: **`↑` past the first row jumps to the search bar at the
top** (`kbHandler`'s ArrowUp branch: at `selIndex <= 0` it calls
`focusSearch()` instead of clamping at row 0) — that search bar already
searches across **all** open PRs of the repo (`/api/prs/search`), so going
from the list up to search is one keystroke. `focusSearch` focuses the
field and releases the row selection (`selKey = null`, no ring). Test:
`tests/overview-ignore.spec.mjs`.

**And the symmetric way back: `↓` in the search box jumps back to the row
list** (`onSearchKeydown`'s `ArrowDown` branch, next to the existing
`Escape` branch in the same function). Without this, landing in the search
box — via a click, via backspacing the query down to empty (no `Escape`, so
the existing blur-on-Escape fix doesn't trigger), or via the `↑` jump above
(which already fires at `selIndex <= 0`, so also right after page load) —
was a **one-way trap**: every following `↓` kept hitting `kbHandler`'s
`typing` guard and did nothing, which read as "arrow-down doesn't work"
without the reviewer realizing focus was secretly sitting in the search
field. `onSearchKeydown` blurs the field and calls `moveTo(0)` — landing on
the first visible row (of whichever `currentView()` is currently active),
or a safe no-op with zero rows (existing guard in `moveTo`). Test:
`tests/overview-search-arrowdown.spec.mjs`.

**Once a popover is open, it owns the keyboard — the list navigation above
is suspended.** `togglePopover` focuses, on open (via
`requestAnimationFrame`, after the arrow.js paint), the **first** item in
the menu (`focusPopoverItem(0)`); `kbHandler` branches, as the **very
first** check, on `ui.openPopover != null` into `handlePopoverKey(e)` —
before even the `/` search-box shortcut — so that no key ever reaches
`move`/`moveTo`/`activateSelected` while the menu is open. Within that
branch: `↑`/`↓` cycle (wrapping at both ends) through the menu's own
`<button>`/`<a href>` items (`movePopover`, focus-based — no separate
selection state, the browser's own `:focus` is the source of truth),
`Enter`/`Space` let the **native** button/link activation run on the
focused element (deliberately no `preventDefault` — exactly the same
behavior as a mouse click on that item), `Escape` closes the menu
(`closePopover`, also reused by the existing click-outside-the-popover-
closes listener), and `←`/`→`/`Home`/`End`/`/` are swallowed
(`preventDefault`, no action) so they don't leak through to the row list;
every other key (notably `Tab`) is left alone.
