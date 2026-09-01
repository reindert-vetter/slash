# The PR overview page (`/pr-overview`)

The landing page: a **GitHub inbox**, rebuilt on top of GitHub's own
`github.com/pulls` dashboard — the same sections and language ("Ready to merge",
"Needs your review", …), with per-row review status, CI checks, reviewers and
diff stats. `overview.html` → `src/overview.mjs`. Routing/shells live in
`.claude/docs/pages-and-routing.md`.

It is **fully read-only** in the sense that it never writes directly to a
module/table (per `.claude/rules/workflows-write-boundary.md`).

## The general `/` command menu

`/` used to focus the search box. It now opens a **general command menu**
(`menu`/`omenu`/`MenuHost` in `src/overview.mjs`) built on the **shared
`CommandMenu.mjs` component** — the same palette `/pr/<id>` opens on every stop
(see "`/` always opens the PR menu" in
`.claude/docs/command-palette.md`), so `/` means the same thing on both pages.
The search box stays reachable with `↑` from the first row and with the mouse.

- **Deliberately almost empty for now** — a pinned **"Sluit menu"** (mirroring
  `withClose` in `home.mjs`) plus a free-text field, nothing else
  (`OVERVIEW_COMMANDS` is an empty array on purpose). Reviewer request: "in pr
  overview een geheel algemeen menu (nu zonder items behalve het typen en
  sluiten)". Real actions land here later; a query matching nothing shows
  `CommandMenu`'s own "Geen commando's." empty state.
- **Stable `menu` + disposable `omenu`**, replaced wholesale on every open —
  the exact split `home.mjs` uses, for the exact same reason (arrow.js doesn't
  fully clean up a dropped subtree, so a previous open's orphaned bindings must
  point at an object nothing touches again). See "Orphan bindings of a dropped
  subtree" in `.claude/rules/arrowjs-pitfalls.md`. **Don't collapse the two.**
- **The open menu owns the keyboard:** `kbHandler`'s very first branch, ahead
  of the popover branch, so no key reaches `move`/`activateSelected`.
- **Positioning** (`positionMenu`) anchors under the selected row, else under
  the search box, flipping above when it wouldn't fit — a deliberately much
  smaller version of `home.mjs`'s per-mode anchor/region table, since this page
  has exactly one menu.

**The per-row popover is deliberately NOT folded into this component** (asked
and confirmed): its reviewer picker and the ingest spinner/stage/error UI are
not command rows, and it keeps its own focus-based keyboard model — the
look-only-sharing note below still stands unchanged. Test:
`tests/overview-command-menu.spec.mjs`.

## The per-row popover

**Every row** — ingested or not — opens the same popover menu on click
(`prRow`/`popover(pr)`, `@click="${() => togglePopover(pr.number)}"` on the
whole row, a `role="button"` `<div>`, no `<a>`); only the menu's **content**
after the pinned close item differs by `pr.hasGraph`. Every popover opens with
a pinned **"Sluit menu"** as its literal first item (`data-testid=
close-popover`, mirrors `withClose` in `home.mjs`), but `togglePopover`
default-focuses the **2nd** item (`focusPopoverItem(1)`, the first real action)
so a stray Enter never merely closes the menu; `↑`/`↓` (`movePopover`) cycle
every item including the pinned one, wrapping at both ends.

**Shared LOOK with `CommandMenu.mjs`'s command palette — look only, never the
component or its keyboard model.** `popoverRowCls`/`POPOVER_ROW_SHAPE`/
`POPOVER_FOCUS_CLS` mirror `commandRow`'s row shape (`rounded-md`, `text-sm`,
`py-2`) and its indigo selected-row highlight (`bg-indigo-50`/
`ring-indigo-200`); the container uses the same `rounded-xl` + indigo
border/ring, at `w-64` (the larger `text-sm` labels need more room than the
original `w-56`). Since `movePopover`/`focusPopoverItem` already move real DOM
focus, `commandRow`'s `focus:` classes light that highlight up for free — no new
reactive state. "Sluit menu" is a plain row with a grey monospace "esc" hint
badge on the right. **Deliberately NOT shared:** its own focus-based keyboard
model (`handlePopoverKey`/`movePopover`/`focusPopoverItem`) — no `CommandMenu`
reuse, no search/filter, no fuzzy matching, no submenus, no shared `menu`/`ms`
state. No shared constant exists between the two files: keep the Tailwind values
in sync by hand.

### Generate / regenerate

- **`pr.hasGraph === false`** (`generateAction(pr)`): the first **action** (2nd
  item overall) is **"Generate review tree"** (`data-testid=generate-page`),
  which POSTs **`/api/ingest {"pr":N}`** — the sanctioned write path (starting
  a Workflow Execution), see `.claude/docs/blocks-and-ingest.md`. While it
  runs, the button shows a spinner + the **actual pipeline stage** ("Preparing
  worktrees…" / "Scanning blocks…" / "Building relations…",
  `INGEST_STAGE_LABELS`, fallback "Generating…") and is `disabled`
  (`ui.ingestingByPr[prUid]`, against a double ingest of the SAME row).
  `generatePage` polls **`GET /api/ingest/progress?pr=N`** every 800ms into
  `ui.ingestStageByPr[prUid]` (`ingest_progress.go`, purely in-memory — within
  the write-boundary exception for stateless pings). The busy text/icon and the
  `disabled`/`class` styling each hang off their **own** nested `${() => …}`
  binding (`ingestBusy`/`ingestLabel`/`ingestIcon`), never a plain-JS ternary on
  a once-captured variable — otherwise the button never updates while the
  popover is already open (see `.claude/rules/arrowjs-pitfalls.md`). Its
  **idle** glyph is the `tree` icon (`ICON_PATHS`), the same one `graphChip`
  uses for a PR without a tree: this row *builds* the tree, so it shows what it
  produces, while `sparkles` stays the "there IS a tree" glyph ("Open review
  tree" and `graphChip`'s `hasGraph` branch). That `tree` path is Lucide's
  **`tree-deciduous`** — a rounded crown on a visible **trunk**; it replaced
  `tree-pine`, whose stacked triangles read as a Christmas tree rather than a
  review tree (Reindert). `handleIngest`
  (`api.go`) responds 200 only once the pipeline **and** `EnsureRelations`
  finished. It runs with **`{ redirect: false }`**: clicking this button
  deliberately does **not** navigate into the fresh tree — on success the
  reviewer stays in the overview, the popover stays open and focus moves to its
  pinned "Sluit menu" item (`focusCloseAfterGenerate`, one `requestAnimationFrame`
  later and guarded on `ui.openPopover` still being this row) so Enter/Escape
  immediately closes the menu instead of re-triggering the button just used
  (Reindert's explicit request — "generate" means build it and let me carry on
  triaging, not take me away). The row keeps showing `graphChip`'s "Op GitHub"
  until the next `refresh`/60s poll recomputes `hasGraph`; no extra
  `reloadSnapshot()` is fired, which would repaint the popover out from under
  that focus. The **only** remaining `redirect: true` caller is the `→` key
  (`openOrGenerate`), where "act now" explicitly means land in the tree. On
  failure the popover stays open with the message (`ui.ingestError`,
  `data-testid=generate-error`) and the row stays `hasGraph:false`.
- **`pr.hasGraph === true`** (`ingestedActions(pr)`): **"Open review tree"**
  (`data-testid=open-tree`, `location.href = '/pr/' + pr.number`) and
  **"Regenerate"** (`data-testid=regenerate-page`), the same
  `generatePage`/`ui.ingestingByPr`/`ui.ingestStageByPr` flow but with
  `{ redirect: false }` — regenerating must **not** navigate, the reviewer stays
  on the overview and only wants the data refreshed (`ui.ingestingByPr[prUid]`
  → `false` on success). A failure shows `data-testid=regenerate-error` in the
  same popover.

### Several rows can generate a review tree AT THE SAME TIME

Reviewer request: "ik wil in prs overview meerdere trees kunnen genereren door
meerdere achter elkaar aan te klikken" — click "Generate review tree" on one
row, move on, and click it on another row while the first is still running.

- **The Go side already supported this.** `POST /api/ingest` is an ordinary
  blocking handler; each request runs in its own goroutine and
  `engine.StartWorkflow` mints a fresh, non-deterministic Run ID per call, so
  two different PRs never collide on one Execution. `ingestMu`
  (`ingest.go`) already serializes the heavy git/worktree/scan steps between
  PRs at the process level (queued, not raced), so concurrent requests for
  different PRs are safe without any backend change.
- **The block was purely client-side.** `ui.ingestingByPr`/
  `ui.ingestStageByPr` are **prUid-keyed maps** (the same shape as
  `state.statuses`/`state.approvals`/`state.pendingPush`), not scalars — an
  earlier version used one shared `ui.ingesting`/`ui.ingestStage` for the whole
  page, so `generatePage`'s guard (`if (ui.ingesting) return`) silently no-opped
  a click on a second row's already-`disabled`-looking-enabled button while a
  first row was mid-ingest. `ingestPollTimers` is likewise a `Map<prUid,
  intervalId>`, not one shared timer — a shared timer would have one row's
  `stopIngestPoll()` kill a different row's poll. `resumeIngestIfActive`/
  `watchResumedIngest` gate on `ui.ingestingByPr[prUid(pr)]` only, so resuming
  (or reopening) one PR's popover is never blocked by another PR still being
  busy.
- **`ui.ingestError`/`ingestErrorFor` stay plain scalars, deliberately not
  per-PR** — only one popover is ever open at a time (`ui.openPopover`), and
  `togglePopover` always clears both on every open, so a stale error from a
  different row's earlier failure can never bleed into the one popover that's
  visible.
- Test: "generating two different rows at the same time" in
  `tests/overview.spec.mjs` — both rows' spinners stay independently busy while
  their (separately mocked/delayed) `/api/ingest` calls are in flight, and each
  resolves into its own "Open review tree" without disturbing the other.

### A page refresh mid-generate: the busy state resumes on the next popover open

`ui.ingestingByPr`/`ui.ingestStageByPr` are plain module state, wiped by a reload —
but the ingest itself is a real Workflow Execution
(`m.engine.StartWorkflow(WorkflowIngest, …)`, `workflows.go`) started from a
goroutine that takes **no request context**, so it keeps running to
completion server-side regardless of whether the tab/request that triggered
it is still around. `GET /api/ingest/progress` therefore still answers
correctly after a reload; only this tab's own memory of "I'm ingesting PR N"
was lost. Reviewer request: "als ik in een menu klik op genereer review, en
ik sluit het menu, dan wil ik als ik het menu weer open, daar weer het laad
icoontje zien … ook als je de pagina refresht."

`togglePopover` calls **`resumeIngestIfActive(pr)`** on every open (skipped
outright if this tab already tracks an ingest locally): one cheap
`GET /api/ingest/progress` ping — same write-boundary carve-out as the
button's own polling — and if it comes back with a non-empty stage, seeds
this PR's `ui.ingestingByPr`/`ui.ingestStageByPr` entry from it and hands off
to **`watchResumedIngest(pr)`**, which keeps polling (reusing this PR's own
entry in `ingestPollTimers`/`stopIngestPoll`) until the stage clears. Since
this tab
never awaited the original `POST /api/ingest` response, it has no success/
failure result to show — completion is confirmed the only other way
available: **`isNowIngested(pr)`**, a `GET /api/prs` lookup by
`{pr, repo}`. A resumed "Regenerate" that actually failed is
indistinguishable from one that succeeded this way (the PR already had a
graph before it started) — accepted, since there is no failure message to
recover either way; the tree itself is the ground truth. Applies to both the
fresh-ingest and the regenerate case identically, since they share one
progress key. Test: "a page refresh mid-generate still resumes the live
status on the next popover open" in `tests/overview.spec.mjs` — note its
`/api/ingest/progress` mock (like the two pre-existing busy-state tests it
sits next to) must gate the returned stage on the ingest having actually
started, or `resumeIngestIfActive`'s own ping on the FIRST popover open
(before the reviewer even clicked "Generate") falsely marks the row busy.

### Draft → "Klaar voor review" (reviewer picker)

For a **draft** PR (`pr.isDraft`) the popover also shows a **"Klaar voor
review"** section (`data-testid=ready-section`, drafts only). Clicking it
(`data-testid=ready-for-review`) fetches `GET /api/reviewers` and expands an
inline reviewer checklist (`data-testid=ready-picker`, repo collaborators sorted
**most-used-first** — one `data-testid=reviewer-<login>` button per candidate, a
`count×` hint on used ones), plus a confirm button
(`data-testid=ready-confirm`) that POSTs the **`ready_for_review`** workflow
(flips the draft to ready + requests the checked reviewers + bumps their local
usage count) and on success closes the popover and calls `reloadSnapshot()` so
the row leaves "Your drafts" without waiting for the 60s poll. The flow state
lives on `ui` (`readyFor`/`reviewers`/`selectedReviewers`/…, ephemeral) and
resets on every `togglePopover`/`closePopover`. See `ready_for_review` +
`modules/reviewerusage` in `.claude/docs/workflows-trackers.md`.

### The remaining items

*Open on GitHub* / *Open Jira ticket* (both `external-link` icon), then
**"Copy GitHub URL"** (`data-testid=copy-url`,
`navigator.clipboard.writeText(pr.url)` with brief "Gekopieerd!" feedback via
the ephemeral `ui.copiedFor`) — it gets its own **`copy`** icon
(`ICON_PATHS.copy`) since it navigates nowhere, and flips to a `check` once
copied, mirroring `ingestIcon`'s reactive icon swap.

### "Verwijder mij als reviewer" — the last item

The popover's **final** item (`data-testid=remove-reviewer`, `user-minus` icon)
takes me off the PR's requested reviewers. It only renders when `canRemoveSelf`
holds — i.e. `pr.author !== meLogin()`: dropping yourself from **your own** PR
makes no sense. An **unknown** local login (offline / `SLASH_GITHUB=off`, where
`GET /api/me` answers `{ok:false}`) hides it too, since "not my PR" cannot be
established then; that is why `tests/overview-remove-reviewer.spec.mjs` stubs
`/api/me`. `meLogin()` is primed by `ensureMe()`, which now rides along inside
`primeAuthorNames` — the one place every row-loading path already awaits before
pushing rows into reactive state (both caches are plain and non-reactive, so a
late arrival could never repaint a mounted row).

Clicking it POSTs the **`remove_reviewer`** workflow with **only** `{pr}` — who
gets removed is resolved server-side from the authenticated GitHub user, so the
endpoint can never remove somebody else — then closes the popover, drops the row
from the list **immediately** and selects the new top row (see below). While in
flight the button is really
`disabled` (the plain attribute, see `.claude/rules/arrowjs-pitfalls.md`) and
reads "Bezig…"; a failure shows `data-testid=remove-reviewer-error` inline. The
item is deliberately shown on every foreign PR, also one where I am no longer a
requested reviewer at all — GitHub treats that DELETE as a no-op, and gating on
the asynchronously backfilled `status.reviewers` would make the item appear
late. It sits above the draft-only ready-for-review section, which can never
co-occur with it (a draft is your own PR).

**The row goes at once, and the selection moves to the top row.** Waiting for
`reloadSnapshot()` would not do: `/api/inbox` serves the `pr_inbox` read-model,
which still lists the PR until a background refresh (and GitHub itself) catches
up — so the row would linger, then flicker away. Instead the PR number goes into
**`removedPrs`**, and `state.sections` is filtered right there in
`removeSelfAsReviewer`. `removedPrs` joins `approvedPr` behind the shared
**`isHiddenPr`** predicate that `normalizeSections`/`applyCached` apply to every
later snapshot, and — like `approvedPr` — is **never emptied**, otherwise the row
would pop back on the next poll. A real page load clears it, by which time the
server agrees. The repaint after the filter is **explicit** (`scheduleRepaint()`):
the nav watch keys on `state.sections.length`, which a row leaving a section does
not change.

Because the row the reviewer was standing on has just left, `reanchorSelection`
would otherwise release the selection entirely (no ring anywhere). So the flow
calls **`selectTopRow()`** — the first row of the whole overview, extracted from
`trySelectTopAfterApprove` and now shared with it, so "just approved" and "just
removed myself" behave identically. `reloadSnapshot()` still runs afterwards to
pull in everything else.

The row is never an `<a href="/pr/<id>">`, so the old hover-only
`regenerateButton` and the separate `data-row` wrapper were removed — they only
existed to avoid nesting an interactive element in an `<a>`.

## "Nieuw sinds jouw comment/review" (`newSinceKind`)

The "Bijgewerkt … geleden" line (`rowMeta`, `src/overview.mjs`) can carry one
extra word segment right after it: **"· nieuw sinds jouw comment"** or
**"· nieuw sinds jouw review"** (`newSinceMark`, `data-testid=new-since-mark`).
It answers "did anything happen on this PR after I last said something" —
comment or approve/request-changes — for **every** row, author or reviewer
alike, in every section.

- **The same signal, and the same moment, also feeds the review tree.**
  `prStatus` carries `newSinceAt` (the moment itself) and the PR's own
  `updatedAt` alongside the kind word, which `pr_status`' `fetchPRStatuses`
  stores in `prmeta` — that is what the "Sinds jouw laatste review" block in
  the PR-info column renders, repeating this exact line above its own content
  (see `.claude/docs/detail-layout.md`). The overview itself still only reads
  the kind; nothing here changed.
- **Only shown when something is genuinely new** — no "you were last, all
  quiet" affirmative state is rendered; silence covers both "nothing happened
  since" and "you never commented/reviewed this PR" (deliberate, per Reindert:
  this is a stand-out signal, not a status readout).
- **The word distinguishes comment vs. review**, never colour
  (`newSinceMark` uses no colour class at all) — the colourblind rule.
- Computed server-side in `myLastActivity`/`statusFromNode` (`inbox.go`): the
  later of the logged-in reviewer's (`ghLogin`) own last **review submission**
  (`reviews[].submittedAt`, any state — APPROVED/CHANGES_REQUESTED/COMMENTED
  all count) and own last **conversation comment** (`comments[].createdAt`,
  capped at `myCommentsCap`), compared against the PR's own `updatedAt`
  (`afterRFC3339`). The result (`prStatus.NewSinceKind`, `"comment"|"review"`,
  omitted when empty) rides the existing heavy status backfill —
  `GET /api/inbox/status` — no new endpoint.
- **On your own PR, that GitHub-derived moment is folded together with the
  reviewer's own in-app "approved everything per line" moment**
  (`combineSinceMoment`, `statusFromNode`) — whichever of the two is later
  wins. GitHub never carries a review submission *from* the author on their
  own PR, so without this a reviewer who fully approved their own PR in the
  review tree kept seeing a stale "nieuw sinds jouw review" here and on
  `/pr/<id>` (PPTD-948). Full mechanism, including where the local moment is
  written: "A third variant of the same Signal" in `.claude/docs/approval.md`
  and "`pr_status` (per PR)" stage 3 in `.claude/docs/workflows-trackers.md`.
- **Inline review comments are NOT separately queried.** A single inline
  comment (with or without "start a review") is always submitted as part of a
  review in GitHub's data model, so its timestamp already surfaces via
  `reviews[].submittedAt` — querying it a second time (a `comments`
  sub-connection per review) would multiply real query cost across
  `reviewsPerPRCap` reviews × however many PRs are visible in one
  `statusesFor` batch, for a timestamp already in hand. The one narrow gap
  this leaves: a reviewer whose own last **conversation** comment is older
  than the last `myCommentsCap` (20) comments on a busy PR won't trigger the
  "comment" variant from that comment alone — the PR's `updatedAt` already
  implies something happened regardless, so the fallback is simply no signal
  shown, never a wrong one.
- `statusFromNode`/`mapPRNode` now take the reviewer's `login` (from
  `ghLogin(ctx)`) as a parameter — computed once per query (`runPRSearch`,
  `statusesFor`) rather than threading `context.Context` further down.
- Test: `TestMyLastActivity` (`inbox_test.go`), same style as
  `TestMergeReviewersDecisiveFold`.

## Filter drawer (preset filters, live gh search)

Next to "Recently generated" sits a second expandable button **"Filters"**
(`filterDrawer`, `data-testid=filter-drawer`, modeled on `recentDrawer` —
`state.filterOpen` toggles, a keyed-array slot with its own key per branch
`filter:closed`/`filter:open`, per the single↔array pitfall in
`.claude/rules/arrowjs-pitfalls.md`). Expanded it shows **four preset
filters**; each runs a live gh search via `GET /api/prs/filter?preset=<key>`
(`runPreset` → `state.presetResults`/`state.activePreset`, sequence-guarded like
`runSearch`). Results **temporarily replace the main sections** (`currentView`
routes: query > preset > inbox), with a "← Back to inbox" bar
(`data-testid=back-to-inbox`, `clearPresetView`).

The whole drawer is **hidden while a search query is active** (see "Searching
drops EVERY category" below) — as are the two blocks after it.

The queries are **server-side allow-listed** (`filterPresets` in
`inbox_api.go`) — the UI only sends a fixed `key`, never raw search text to gh
(`exec` input validation). The four keys: `updated-oud` (`sort:created-asc`),
`alle-open`, `alle-draft`, and **`ouder-3-dagen`**, for which `handleFilter`
computes the boundary **dynamically** (`created:<{today−3d}`, `YYYY-MM-DD`; a
read handler, so `time.Now()` is fine — the determinism rule only binds workflow
bodies). `searchPRsExpr`/`runPRSearch` (`inbox.go`) prepend `repo:<slug>` but
respect the preset's own `sort:`/`draft:` (unlike `searchPRs`, which always
appends `sort:updated-desc`). `ouder-3-dagen` results are **grouped by author**
on the frontend (`authorGroups`/`authorGroupBlock`,
`data-testid=author-group`); the other three are flat. Offline
(`SLASH_GITHUB=off`) `handleFilter` only honors the fixture rows' `draft:`
qualifier. Test: `tests/overview-filter-presets.spec.mjs`.

## "Mislukte taken" block (failures that would otherwise only reach the log)

Below `recentDrawer` sits a third expandable block, **"Mislukte taken"**
(`problemsDrawer`, `data-testid=problems-drawer`, mould of `recentDrawer`), fed
by the read-only **`GET /api/problems`** (`handleProblems` → `run_errors.go`).
Background work can fail without the reviewer noticing — those failures used to
be visible only in the terminal the server was started from. Two categories,
deliberately both shown:

- **A workflow run that ended in `failed`** (`data-testid=problem-run`) —
  durable, so `TaskManager.FailedRuns(limit)` is a pure read of
  `engine.Runs()`/`Input()`/`Result()` (a failed run's recorded error message
  is only reachable *as* the error `Result` returns). Deliberately
  **repo-wide**, which is why `RunsForPR`/`GET /api/workflows?pr=N` couldn't be
  reused: that filters on the run input's `pr`, so a per-repo tracker
  (`pr_inbox`/`auto_warn`) structurally never appears there;
  here it shows with `pr: 0`.
  **Superseded failures are filtered out** (`supersededRuns`/`runIdentity`, see
  the section below) so a task that later succeeded stops showing.
- **An error that only ever reached the log** (`data-testid=problem-log`) —
  poller/startup glue that is no workflow run at all. See "Surfacing failures"
  in `.claude/docs/workflows-trackers.md` for the in-memory ring buffer and
  why it may live outside a workflow.

Load-bearing frontend properties:

- **Always present, collapsed, with the count in the button**
  (`data-testid=problems-count`: "Mislukte taken · 2" / "· geen") — except
  while a search query is active, when this block is hidden along with the two
  drawers above it (see "Searching drops EVERY category" below). A block that
  only appears when something is wrong isn't findable when you want to confirm
  nothing *is* wrong — hence also loaded on page load (`loadProblems()` next to
  `loadInbox()`), not lazily on open like "Recent gegenereerd".
- **`loadProblems` is its own fetch**, deliberately not folded into
  `loadInbox`/`applyLive`/`applyCached`/`reloadSnapshot`: those `await`
  `primeAuthorNames` before pushing rows into state, and a failure list has no
  author names to resolve. It rides the existing `RELOAD_MS` interval — no timer
  of its own.
- **The rows carry no `data-nav-row`**, so they never join the keyboard
  navigation (`paintSelection()` iterates every `[data-nav-row]` and would
  otherwise ring a failure line). Expanding the drawer *is* in the row-set
  `watch` that drives `scheduleRepaint()` though — it changes document height,
  the exact scroll-clamp case where a row slides under a parked cursor (see the
  `hoverEnabled` gate below).
- **A row names the PR and the comment, not just numbers.**
  `problemPrChip(pr)` renders `#13098 · <PR title>` (both row kinds), fed by the
  response's `prTitles` map — a `{"<pr>": "<title>"}` side map the handler fills
  from `prmeta.Get` per referenced PR. Deliberately a map instead of a `title`
  field on both structs: it serves `failedRuns` and `logErrors` alike, and
  `LogProblem` is built at record time when no lookup is possible; an unknown PR
  is simply absent and the chip falls back to the bare number. A failed
  `task_code_comment` run additionally gets a middle line
  (`data-testid=problem-run-comment`, `problemCommentLine`): `<basename>:<line>`
  plus a snippet of the body, from the `comment` field — the same `CommentRef`
  the "Taken" column uses, parsed in `FailedRuns` from the run's own immutable
  input. Without it, a PR with a dozen broken comment threads is a wall of
  identical rows. Both of that line's slots are precomputed **strings**: a
  conditionally interpolated `html` template in a static slot renders as the
  template function's source text (see `.claude/rules/arrowjs-pitfalls.md`).
- **The failure is carried by a word + a `⚠` glyph** (`problemMark`: "mislukt"
  for a failed run, "overgeslagen" for a mirrored log line, since every `logf`
  call site reports work that was skipped) — the rose tint is decoration only
  (colourblind rule).
- Every branch of the content slot returns a **keyed array with its own key**
  (`problems:closed`/`:loading`/`:empty`/`:list`), the same single↔array +
  reused-keyed-node discipline as `recentDrawer`.
- The Workflow-Type → Dutch label map lives in shared
  **`src/workflowLabels.mjs`** (`WORKFLOW_LABELS`/`labelForWorkflow`), imported
  by both this page and `RelatedPanel.mjs`'s "Taken" card — the overview must
  **not** import `RelatedPanel.mjs` itself (that module carries the whole
  review-tree state: comment cursors, url-state bindings, watches).
  `STATUS_BADGES`/`WORKFLOW_STATUS_NOTE` stayed behind: they describe runs still
  in progress, this block only shows runs that already failed.
- **The row renderers themselves now live in `src/problems.mjs`**
  (`fetchProblems`/`problemMark`/`PROBLEM_ROW_CLASS`/`problemPrChip`/
  `problemCommentLine`/`baseName`/`problemRunRow`/`problemLogRow`), not this
  file — extracted so the review tree (`/pr/<id>`) can reuse the exact same
  rows, filtered to the open PR, instead of a second implementation. See
  "'Mislukte taken' also reaches the review tree" in
  `.claude/docs/detail-layout.md`. `overview.mjs` still owns everything
  page-specific (`state.failedRuns`/`logErrors`/`problemsOpen`/`problemsLoaded`,
  `problemCount`/`problemsToggleText`/`problemsDrawer`) — this page's own
  behaviour is unchanged, only the row-building code moved.

### A failure that was later retried successfully drops out of the list

A tembed run can never leave `failed` (`SignalWorkflow`/`advance` refuse a
terminal run, `Recover()` only picks up `running`/`waiting`), and nothing
deletes it except the `cleanup` workflow — and only once its PR is merged and
older than `cleanupMergedAge`. So the list used to keep showing failures whose
work had long since succeeded: `ensurePRStatus`/`findPRStatusLocked` look for a
`running`/`waiting` tracker only, so after a failure they simply start a **new**
run, and the daily `cleanup` pass does the same. It saturated at the cap
(50 runs + 100 log lines) with mostly stale rows.

`FailedRuns` therefore drops a failed run that a **later attempt at the same
task** took over — read-time only: nothing is deleted, `FailedRuns` stays a pure
read (the run itself is still in the tembed store, and still purged by
`cleanup`).

- **Identity** (`runIdentity`) is ordinarily `workflow + "#" + pr` — exactly what
  the app itself already treats as one task. `pr: 0` covers the repo-wide
  trackers and the `cleanup` pass.
- **Superseded** means a run with that identity exists with a **later
  `CreatedAt`** and status `completed`, `running`, **or** `waiting`.
  `waiting` is load-bearing: a `pr_status` tracker stays `waiting` forever and
  never reaches `completed`, so without it the most common case would never
  clear. Another `failed` run supersedes nothing. `CreatedAt`, not `UpdatedAt`:
  a long-lived tracker's `UpdatedAt` keeps moving and would hide a failure that
  happened *after* that tracker started.
- **Exception — a per-item deterministic Run ID never gets superseded**
  (`perItemRunID`: `task_code_comment`, `resolve_call`, `explain_code`,
  `claude_chat`, `chat_merge`; identity is the Run ID itself). Two reasons, both
  required: a PR has many comment threads, so a succeeded one must not hide a
  failed sibling on the same PR; and `startWorkflowID` is **idempotent**, so a
  retry is a no-op returning that same failed run — such a failure is
  permanently open work and *must* keep showing. Hand-maintained list, like
  `retiredWorkflowTypes`: extend it when a new workflow adopts a deterministic
  Run ID.

Not covered by this: the `logErrors` half. Those are no runs, have no status and
no identity, so there is nothing to supersede them with; they still only clear
on a restart or by ageing out of the ring buffer. Tests:
`TestFailedRunsHidesSupersededRun`, `TestFailedRunsCarriesCommentRef`
(`run_errors_test.go`).

⚠ **Deliberately not in v1: the rows aren't clickable** — a click target would
make them navigation elements, with the keyboard/popover consequences above. No
dismiss/retry either (a restart already clears the buffer; "retry" means
something different per workflow type). Test:
`tests/overview-problems.spec.mjs`, whose populated rendering is driven through
`page.route`: every real failure path is best-effort or needs a live gh hiccup,
so it isn't deterministic in a worker (backend side: `run_errors_test.go`).

## GitHub access runs through a workflow (never direct)

**The page never calls GitHub itself.** The PR list is fetched and managed by
the **`pr_inbox` workflow** (one Execution per repo, see
`.claude/docs/workflows-trackers.md`), which writes into the **`inbox`
module** (a read model); the HTTP handlers only read that. Canonical
write-boundary shape: only a workflow talks to GitHub and mutates state.

- **`pr_inbox` workflow** (`workflows.go`): a `for` loop on a `refresh`
  **Signal** → one `refreshInbox` **Activity**, which runs
  `buildInboxSnapshot` (fetch + `statusesFor`), stores it in the module, and
  returns only a small `{updatedAt, prs}` summary — so the endlessly
  refreshing history stays compact.
- **Poller cadence (heartbeat-driven, like the comment poller):** `pollInbox`
  signals `refresh` on the **fast** cadence (`pollInterval`, 1 min) as long as
  a heartbeat arrived within `heartbeatWindow`, otherwise on the **slow**
  cadence (`idlePollInterval`, 10 min). At startup `EnsureInbox` sends one
  **synchronous** refresh, so the read model is filled before the server
  serves; after a restart it reuses the existing Execution (`findInboxRun`).
- **The UI drives the cadence:** on load `overview.mjs` sends a `refresh`
  Signal plus a **heartbeat** (`POST …/heartbeat`) — but only while the tab is
  visible and focused (`activeTab()`), so a parked tab naturally drops to the
  slow cadence. It then polls the read model periodically
  (`reloadSnapshot`). The heartbeat mutates no durable state and thus falls
  outside the write boundary.

The actual fetch (`inbox.go`): `gh api graphql` `search` calls (no new
dependency). `lightFields` renders the row, `heavyFields` (`mergeable
reviewDecision`, `reviewRequests`, `latestReviews`, `statusCheckRollup`) fills
the pills. `hasGraph` is overlaid from the `blocks` table (`ingestedSet`).
`inboxSections` mirror `/pulls` (qualifiers 1-to-1 from dash's
`INBOX_SECTIONS`, incl. `archived:false`, the copilot query and the
**COMMENTED-catch** `keep` filter); queries run in parallel and are recombined
deterministically. `mergeReviewers` and `statusesFor` (one aliased call) as
before.

**The "💬 n" comment badge** (`commentsBit`) reads `row.comments`, which is
**not** GitHub's raw `PullRequest.comments.totalCount` (issue-conversation
comments, a different category): the `refreshInbox` Activity overwrites it per
row with the count of slash's own open, **GitHub-imported** comments —
`comments.List(pr)` filtered to `status not in {resolved, deleting, deleted}`
**and** `source == "github"`, so resolving an imported comment in slash lowers
the badge directly. A **local** (`source: ""`/`"ui"`) comment — e.g. the
auto-created Claude-chat anchor comment (`ensureClaudeAnchorForNew`,
`RelatedPanel.mjs`, see `.claude/docs/claude-chat-panel.md`) — was never
posted to GitHub and must never inflate a count meant to mirror the real
GitHub comment count; this was
reversed from an earlier version that counted both sources, which made the
badge diverge from GitHub's own comment count the moment a reviewer started a
Claude conversation before typing an actual comment. The comment(s) themselves
are unaffected — they still show/work exactly as before in the review tree;
only this badge's tally changed. Read-only enrichment inside the Activity — no
new write path. Test: `TestPRInboxBadgeCountsOpenSlashComments`
(`workflows_test.go`).

**The "Ongepusht N" badge** (`unpushedPill`, backfilled by
`kickOffPendingPush` from `GET /api/pending-push` exactly like the approval
badge, scoped to `hasGraph` rows — only an ingested PR can have chat edits at
all) says this PR has Claude commits that landed on its branch **locally** but
are not on GitHub yet. It belongs here because this is where the reviewer picks
his next PR: "this one still has something of mine waiting" must be visible
without opening the review tree first. A word plus an arrow glyph, never colour
alone; `Push mislukt` (rose) when the last attempt was refused. Full mechanism:
`.claude/docs/pending-push.md`.

**The checkout badge** (`checkoutPill`, backfilled by `kickOffCheckout` from
`GET /api/chat/checkout`, same `hasGraph`-scoped shape as the two badges
above) shows the last path segment of the PR's shared local checkout
(`chat_checkout.go`), if one is assigned — a plain, neutral fact (sky tint,
folder glyph), not a warning like the unpushed badge. Sits next to it in the
row. Full mechanism (the chip this mirrors, the checkout-menu Actions):
`.claude/docs/claude-chat-panel.md`'s "Every turn gets a real shell by
default" section.

## Endpoints

| Endpoint | Does |
|---|---|
| `GET /api/inbox` | Reads the read model → `{ok,live,repo,generatedFor,updatedAt,runId,sections}`. `runId` = the `pr_inbox` Run ID (for refresh/heartbeat). No snapshot yet → `{ok:false}`. |
| `GET /api/inbox/status?prs=12,13` | The pills, also from the read-model snapshot (no GitHub call). |
| `GET /api/pending-push?prs=12,13` | The "Ongepusht" badge — landed-but-unpushed chat edits per PR, read straight from local git refs. See `.claude/docs/pending-push.md`. |
| `GET /api/chat/checkout?prs=12,13` | The checkout badge — this PR's shared local checkout (dir/branch), a plain in-memory read. See `.claude/docs/claude-chat-panel.md`. |
| `POST /api/workflows/{runID}/signals/refresh` | Refresh Signal (UI on load). Only starts the fetch Activity. |
| `POST /api/workflows/{runID}/heartbeat` | Operational ping (poll cadence), no state write. |
| `GET /api/prs/search?q=…` | **Still a direct** live gh `search` (`inbox_api.go`) — an ephemeral, parameterized read, not a persistent list. Open **and** closed/merged PRs, ranked by `sortSearchRows`; a bare number is an exact `pullRequestByNumber` lookup (plus `<n> in:title`). Also matches by **author name** (not just title/number/login), see below. |
| `GET /api/prs/filter?preset=<key>` | Live gh `search` for a **fixed, allow-listed** preset query (`filterPresets`) — never raw UI text to gh. See "Filter drawer". |
| `GET /api/reviewers` | Read-only candidate reviewers → `{ok, reviewers:[{login,avatarUrl,count}]}`, most-used-first. |
| `GET /api/names?logins=a,b` | Login → real name + avatar. See "Real names instead of logins" in `.claude/docs/pages-and-routing.md`. |
| `POST /api/workflows/ready_for_review` | `{pr, reviewers?}` → flip a draft to ready + request reviewers. 400 on an invalid pr/login. |
| `POST /api/workflows/remove_reviewer` | `{pr}` → drop **myself** from that PR's requested reviewers. No login in the request (resolved server-side). 400 on a non-positive pr. |
| `GET /api/problems` | Read-only → `{ok, failedRuns:[{runId,workflow,pr,updatedAt,error,comment?}], logErrors:[{at,scope,pr,message}], prTitles:{"<pr>":"<title>"}}`. Feeds "Mislukte taken"; superseded failures are already filtered out. |
| `GET /api/prs` | (existing) ingested PRs + counts, for the recent drawer. |

### "Recent gegenereerd" rows are enriched from the SAME local prmeta read, no extra request

`recentItem` used to be much sparser than an inbox row: a bare sparkle glyph,
title, `#pr · N blokken · N bestanden`, and a right-hand "open boom" chip — no
author, no diffstat, no branch, no "Bijgewerkt … geleden". Reindert asked for
the same look as "Needs your review" **without slowing the page down**, so the
extra fields ride an already-made read instead of a new one:

- `PRSummary` (`db.go`) gained `Author`/`Additions`/`Deletions`/`ChangedFiles`/
  `HeadRefName`/`UpdatedAt` (all `omitempty`), filled by `handlePRs` from the
  **same** `prmeta.Get(pr)` call it already made just for `Title` — a local
  SQLite read, no GitHub call, no second query. A PR whose `pr_status` tracker
  never ran (never opened via `/pr/<id>`) simply keeps these empty/zero — the
  frontend degrades gracefully for it (see below), never a blank/broken row.
  **`UpdatedAt` maps from `prmeta.Meta.GhUpdatedAt`, not from that struct's own
  `UpdatedAt`** — the latter is the LOCAL write time of the prmeta row, so the
  drawer used to say "Bijgewerkt 17 seconden geleden" (the moment a `pr_meta`
  upsert last ran) for a PR the inbox section right above it correctly called
  4 hours old: the same PR with two different "bijgewerkt" texts on one screen.
  A row stored before `GhUpdatedAt` existed falls back to the local time rather
  than showing nothing.
- `recentItem` (`src/overview.mjs`) reuses the inbox row's own building blocks
  instead of inventing new ones: `authorMark(r)` (avatar + first name),
  `diffStatFragment(r)` / `branchFragment(r)` (+N −M · files, branch name) and
  `relativeTime(r.updatedAt)` all read the same field names `PRSummary` now
  emits, so no adapter layer was needed. **Not** reused: `rowMeta` itself
  (hardcodes `#${pr.number}` + a reactive `state.repo` prefix that don't apply
  here) and `newSinceMark` (depends on the live inbox status backfill —
  `state.statuses[pr.number]` — which this drawer never fetches; adding that
  fetch for every recent PR would be exactly the slow-down Reindert asked to
  avoid). No review/checks chip either, on the same reasoning plus: a stale
  review decision on a PR nobody's actively looking at anymore would read as
  current when it might not be.
- **Graceful fallback per field, not per row:** `recentAvatarMark(r)` shows
  `authorMark(r)` only when `r.author` is present, otherwise the original bare
  sparkle glyph (same `w-20` column width either way, so mixed enriched/
  un-enriched rows still line up); the diffstat/branch line and the
  "Bijgewerkt …" fragment likewise only render when their fields are present
  (`diffStatFragment`/`branchFragment` already do this; the updated-at
  fragment is a small inline ternary in `recentItemMeta`). A PR can end up
  partially enriched (e.g. `updated_at` set by a later `pr_meta` upsert while
  `title`/`author` stayed empty because `fetchPRBasics`'s `gh.PRMeta` call
  failed) — every field decides independently, so that shows exactly what's
  known instead of an all-or-nothing card.
- **Names/avatars are the one part that still costs a request**, and it stays
  lazy: `ensureRecentPrs` (only called from `toggleRecent`/
  `trySelectPendingPr`, i.e. once the drawer is actually opened) awaits
  `primeAuthorNames(rows)` — the same batched `ensureNames` call/timing
  discipline as the inbox sections (see "Timing is load-bearing" in
  `.claude/rules/conventions.md`) — before caching `state.recentPrs`, so a
  late name arrival can never leave a keyed row stuck on a bare login. Nothing
  here touches the initial page load.

### Search also matches the author's NAME, not just their login

GitHub's own free-text PR search (the plain `q` term `handleSearch` passes to
`gh`) matches title/body/comments — never the author's real name, only their
exact login as it happens to appear in that text. So typing a colleague's name
("Dennis") found nothing unless it literally occurred in a PR title.

`handleSearch` (`inbox_api.go`) now also runs the query against every known
login/name via `matchingLogins` (`usernames.go`): a substring, case-insensitive
match against the `names.json` override and whatever `DisplayNames` has cached
in `userNameCache` (capped at `matchingLoginsCap`, so a broad query can't fan
out into unbounded extra `gh` calls). For each matching login it runs one more
`author:<login>` search and merges the rows in (`dedupeRowsByNumber`, keyed on
PR number). `ensureCollaboratorsLoaded` (`usernames.go`) warms `userNameCache`
with **every repo collaborator's** name once per process lifetime (one
`ListCollaborators` + one batched `DisplayNames` call, same
restart-to-refresh trade-off as `namesFileOverride`) — so a colleague's PR is
findable by name right away, not only once their name has separately surfaced
somewhere else in this run (e.g. as a visible PR author). The offline
(`SLASH_GITHUB=off`) fixture path has no name resolution to warm, but matches
the author **login** substring directly against `inboxRow.Author`.

### Closed PRs are searched too, ranked below the open ones — and a bare number is an exact lookup

Reviewer request: "ik wil hier ook kunnen zoeken op closed prs en prs van
andere (wel in een lagere volgorde)", reported against a search for `12112`
that returned **0** results. Two independent causes, both fixed:

- **`is:open` excluded every closed/merged PR.** `handleSearch` now runs a
  second search, `is:pr is:closed archived:false <term>` (`is:closed` covers
  merged and plain-closed alike), merged in through the existing
  `dedupeRowsByNumber`. A failure of that call is **not** fatal — the open
  results are still served.
- **A bare number was searched as TITLE TEXT.** GitHub's search API has no
  `number:` qualifier, so `isAllDigits(q)` used to become `<n> in:title`, which
  finds PR #12112 only if "12112" happens to occur in some PR's *title*, and
  never finds the PR itself. **`pullRequestByNumber`** (`inbox.go`) now does a
  direct `repository(owner,name){ pullRequest(number:) }` GraphQL lookup per
  `allRepos()`, state-agnostic, mapped through the same `mapPRNode`. One `gh`
  call per configured repo (normally one); a repo without that PR contributes
  nothing and an error on one repo never fails the others. The `in:title` text
  search stays alongside it — a number can be a genuine title match.

**"PR's van anderen" was never about widening**: the search has always been
repo-wide and author-agnostic (`repoSearchScope()`), unlike the `@me`-scoped
inbox sections. What was missing is the **ranking**, which `sortSearchRows`
(`inbox_api.go`, a plain `sort.SliceStable` over `searchRank`) now applies:

| rank | rows |
|---|---|
| 0 | open, mine (`author == ghLogin(ctx)`) |
| 1 | open, someone else's |
| 2 | closed/merged, mine |
| 3 | closed/merged, someone else's |

**Stable** on purpose, so gh's own `sort:updated-desc` ordering survives inside
each rank. An unknown login (offline, `gh` unauthenticated) collapses 0/1 and
2/3 into each other and leaves the open-before-closed half intact; a row with
no `state` at all — every inbox row, every pre-existing fixture/snapshot —
ranks as **open**.

`inboxRow.State` (GitHub's `OPEN|MERGED|CLOSED`) carries this to the frontend.
`lightFields` already requested `state` and `ghPRNode.State` already existed;
only `mapPRNode` dropped it. `json:"state,omitempty"` keeps an inbox row
byte-identical to what a pre-state build produced.

**Two deliberate limits.** The `matchingLogins` author-name loop stays
**open-only**: running it against `is:closed` too would double up to
`matchingLoginsCap` extra `gh` calls per search for little gain, and a closed PR
is still findable by title, number or author *login*. And searching does not
clear an active preset filter — `currentView()` simply lets the query win, so
emptying the box returns to the preset view; pre-existing behaviour, left as is.

Tests: `TestSortSearchRowsRanking` + the two siblings next to it
(`search_rank_test.go`, pure, no `gh`, no fixture) for the ranking;
`tests/overview-search-flat.spec.mjs` for the view below.

### Searching drops EVERY category: one flat list

"als je zoekt, wil ik alle categorieen weg hebben". While a query is active the
content region is **one flat, heading-less list** of rows:

- **The result heading and its count pill are gone** from
  `searchResultsBlock()` (it used to render `Alle open PR's — "q"` + a count).
  The zero case is covered by the existing "Geen resultaten voor …" line, so
  no count was reinstated (agreed explicitly).
- **The three drawers below it are hidden too** — `filterDrawer()` /
  `recentDrawer()` / `problemsDrawer()` are *siblings* of `currentView()` in
  `App()`, so routing alone never hid them (they were visible in the reported
  screenshot). They now sit in **`drawersSlot()`**, which returns an empty
  **array** while `state.query.trim()` is truthy. Three things make that
  arrow.js-safe (see `.claude/rules/arrowjs-pitfalls.md`): a stable wrapper
  element with a **static** `contents` class (never a keyed template whose
  whole body *is* the toggling expression), always the same **kind** of
  returned value (an empty array, not `''` — the single↔array rule), and an own
  `.key()` per drawer. Their open/closed state lives in
  `state.filterOpen`/`recentOpen`/`problemsOpen` and survives the unmount;
  `loadProblems()` keeps running on its own interval regardless.
- **The inbox sections were already gone** — `currentView()` has always routed
  a non-empty query away from `mainContent()`. Nothing changed there.
- The row-set `watch` already lists `state.query` as a dep, so
  `scheduleRepaint()` fires as these blocks come and go — exactly the
  scroll-clamp case its `hoverEnabled` disarming exists for (the document
  height changes without the pointer moving). `currentRows()` reads
  `[data-nav-row]` from the DOM, so the recent-drawer rows leave the `↓` chain
  by themselves and `reanchorSelection` releases a selection that stood in one.

**With no headings left, a per-row word marker is load-bearing:**
`rowStateMark(pr)` (`rowMeta`, `data-testid=row-state-mark`) renders
**"Samengevoegd"** / **"Gesloten"** plus a glyph on a row whose `state` is not
`OPEN` — the *only* thing distinguishing a closed hit from an open one now, so
it is a **word**, never the tint alone (colourblind rule). It uses the same
static `<span class="contents">` + `${() => …}` shape as its neighbour
`newSinceMark`: `rowMeta` is one template shape shared by every row and only
some rows carry a mark, so a statically interpolated template↔`null` slot would
eventually render the template *function* as text in a reused chunk. A row
without a `state` field renders nothing, exactly as before.

## Offline / test mode

Under **`SLASH_GITHUB=off`** nothing touches the network: `buildInboxSnapshot`
serves the **fixture** from `SLASH_INBOX` (`tests/fixtures/inbox.json`, shape
`{repo,generatedFor,sections,statuses}`). The synchronous startup refresh fills
the read model, so `GET /api/inbox` has data right away (no race in tests).
`hasGraph` comes from the DB, so the seeded PR (12903) shows "Open review tree"
pointing at `/pr/12903`. If the first fetch fails (no fixture, no snapshot) →
`/api/inbox` `{ok:false}` → the client falls back to `GET /data/inbox.json`
(label "cached").

## Client (`src/overview.mjs`, arrow.js, dark zinc)

Two-phase render via a reactive `state.statuses` (skeleton → pills, no layout
shift). Sectioned list, debounced search (separate results region, sequence
guard), stacks, reviewer avatars, review/CI chips, the "recently generated"
drawer (lazy `GET /api/prs`), keyboard nav (↑/↓/Home/End/Enter/`/`/→). The GitHub
section titles stay in English.

### Stacks are a TREE, not a linear chain

`computeStacks` (exported purely for testability). A PR whose `baseRefName`
equals an in-view PR's `headRefName` is stacked on it and lifts into an indented
group at the top. One PR can be the direct base for **multiple** siblings at
once — several feature branches off the same not-yet-merged branch (a "fan-out")
— which is just as valid as a chain. ⚠ An earlier version modeled this as a
strict list (`childOf: Map<parentNum, PR>`, keeping only the first child
candidate per parent), so on a fan-out only the first sibling got lifted; don't
reintroduce that. `computeStacks` builds `childrenOf: Map<parentNum, PR[]>` (all
matches, sorted by ascending PR number) and flattens each tree depth-first into
`[{pr, depth}, …]`: root at `depth 0`, and **all siblings on the same parent
share the same `depth`** — only a real chain (A→B→C) yields increasing depths.
`stackGroup`/`listBox`/`connectorMark` (generic on `opts.depth`) then render
same-depth siblings one after another with identical indentation/connector. Only
trees with ≥ 2 nodes count as a stack. Test:
`tests/overview-stack-fanout.spec.mjs` — its fixture
(`tests/fixtures/inbox-fanout.json`) is fed as synthetic data straight into
`computeStacks`, **not** via `SLASH_INBOX`: the `/api/inbox` snapshot is one
shared, worker-wide read model several other overview tests hold exact row
counts against, so a second inbox fixture can't coexist there.

### The hover-vs-keyboard gate (`hoverEnabled`)

Every keyboard step (`move`/`moveTo`) sets `hoverEnabled = false` before
`paintSelection()` — which always calls `scrollIntoView` — precisely so the
following scroll can't fire a `mouseenter` that hijacks the keyboard
selection. Two distinct cases have to be caught, and each needs its own half:

1. **A synthetic `mousemove` at an unchanged cursor position.** Browsers
   (Chromium) synthesize one to resync `:hover` after a scroll/layout change, so
   a bare `addEventListener('mousemove', () => hoverEnabled = true)` can't tell
   it from a real move and re-arms hover immediately — after which the row under
   the stationary cursor pulls the selection back. The listener therefore stores
   the last-seen `clientX`/`clientY` and only re-arms on an actual delta.
2. **A row sliding under a stationary pointer.** The coordinate delta only
   proves *the pointer* moved; the hijack also happens with the pointer parked
   while the **content** moves under it (closing the recent drawer shrinks the
   document, the browser clamps `scrollTop`, and whatever row lands under the
   idle cursor fires a perfectly **genuine** `mouseenter` — no coordinate is
   stale). What distinguishes it is that no real mouse movement happened *since
   the row set changed*, so `scheduleRepaint` — which only ever runs from the
   row-set `watch`, never from a keypress or from `onmouseenter`'s own
   `paintSelection()` — sets `hoverEnabled = false` both synchronously **and**
   again inside its `rAF`, so an event on either side of that frame is ignored.
   A genuine `mousemove` re-arms hover immediately; hovering is unchanged apart
   from needing one pixel of movement after the list changed.

Both halves are covered by `tests/overview-hover-gate.spec.mjs`, which dispatches
its own `mousemove`/`mouseenter` DOM events — the browser-native
scroll-triggered case does not reproduce deterministically under Playwright (see
also the `selectRowByKeyboard` note in `overview.spec.mjs`). Half 2 was a real
source of flakiness in `tests/overview-selection-identity.spec.mjs`'s drawer
case.

### Selection identity (`selKey`/`data-nav-key`), not an array position

Every navigable row (`prRow` and `recentItem`) carries, alongside
`data-nav-row`/`data-pr`, a stable `data-nav-key` — the same string as that row's
arrow.js `.key(...)` (`"row:12903"`/`"recent:12903"`). `move`/`moveTo` set both
`selIndex` and `selKey`; **so does `togglePopover` on every OPEN** (mouse click
or `Enter`, not just keyboard stepping) — a MOUSE-opened popover used to leave
`selKey` untouched, so the ring never appeared for a mouse-driven "Genereer
review-boom", during the busy state or after it finished (reviewer: "laat item
tijdens en na genereren geselecteerd, maar als ik iets anders wil doen niet").
`togglePopover` now claims the ring for the row it opens
(`selKey = 'row:' + uid`), which then simply persists through the async
`generatePage` — nothing in the generate/ingest-poll path touches `selKey` — and
is released again for free by the SAME mechanisms that already reassign it: a
`mouseenter` on a different row, clicking a different row (this same branch
moves the ring there instead), a keyboard step, or focusing the search box. No
new "release" logic was needed — only the "claim on open" half was missing.
Test: `tests/overview-selection-identity.spec.mjs` ("clicking a row's popover
open claims the selection ring").
`paintSelection()` always first calls
`reanchorSelection(rows)`, which **derives `selIndex` from `selKey`** against the
`currentRows()` present at that moment: still there → the ring follows it to its
(possibly shifted) position; genuinely gone → the selection is **released**
(`selIndex = -1`, no ring) instead of landing on an arbitrary other row. Needed
because the row list changes without the reviewer pressing anything:
typing/clearing a search, a background `reloadSnapshot` (60s), or opening/closing
the recent drawer — with a bare positional `selIndex` the ring would stick to
"whatever is in that spot". Test:
`tests/overview-selection-identity.spec.mjs`.

### The selected-row highlight

Matches `/pr/<id>`'s app-wide indigo selected/focused convention (see "Focus
highlight per stop" in `.claude/docs/keyboard-navigation.md`), replacing an
earlier unrelated emerald tone. `paintSelection()` toggles the ring/bg purely
**imperatively** (`classList.add`/`remove` on the mounted `[data-nav-row]`, via
the shared `SELECT_RING_CLS` array) and stays that way on purpose: selection here
isn't driven by `state` or a reactive template binding at all (the row's `class`
is a static string set once at mount), so no arrow.js keyed-node/whole-value
pitfall applies. Deliberately **no** separate `dark:` ring/bg variant — a
semi-transparent indigo ring/tint reads fine on both white and `zinc-900`.
Applies identically to `prRow` and `recentItem` (both carry `data-nav-row`, both
painted by the same `rows.forEach` loop). Hover is unaffected: the
`hoverEnabled` gate only decides whether a `mouseenter` may call
`paintSelection()`; the CSS-only `hover:bg-slate-100 …` tint on `ROW_CLASS` is a
separate, always-active affordance.

⚠ **The `›` selection-mark glyph (`selectMark()`,
`SELECT_MARK_ON`/`SELECT_MARK_OFF`, `data-testid=row-select-mark`) was REMOVED on
Reindert's own explicit request.** Consequence, stated so it stays a conscious
trade-off and not a silent regression: the selected row on `/pr-overview` now has
**only** the indigo ring/background tint (`SELECT_RING_CLS`) as its selection
signal — no non-colour shape cue remains on this page. That is a deliberate
choice by the colourblind user himself; `/pr/<id>`'s own sidebar `›` marker
(`BlockList.mjs`) is untouched. Do not reintroduce it here without asking.

### Search box

`searchBox()` gets the same indigo `focus:` treatment (`focus:border-indigo-300
dark:focus:border-indigo-500 focus:ring-1 focus:ring-indigo-200
dark:focus:ring-indigo-500/30`, plus `hover:border-slate-400
dark:hover:border-zinc-600` and a base `border-slate-300 dark:border-zinc-700`)
— purely native `:focus`/`:hover` CSS on an already static class string, so no JS
state: unlike `BlockList.mjs`'s search field, this box is never "active" without
holding real DOM focus.

### Keyboard

- **`→` and `Enter` deliberately differ on the selected row.** `Enter`
  (`activateSelected`) clicks the row, opening the popover (a "Recently
  generated" item navigates directly — it's already an `<a href>`). `→`
  (`activateSelectedForward`) is "go straight ahead", analogous to `→` on
  `/pr/<id>`: on a `hasGraph` row it navigates **directly** to `/pr/<n>` (no
  popover); on a not-yet-ingested row `openOrGenerate` opens the same popover
  `Enter` would — needed for the existing busy spinner/stage/error UI — and
  immediately fires `generatePage(pr)` (default `redirect:true`), so the tree
  opens on success. `findPrByNumber` resolves the `pr` object (with
  `hasGraph`) via `data-pr` in `state.sections` (also covers stacked rows, same
  object references) and `state.searchResults`; no match falls back to
  `activateSelected()`. `handlePopoverKey` keeps intercepting `→` while a
  popover is open, so a second `→` does nothing extra.
- **The "Recently generated" drawer joins `↓` once open** — `currentRows()` is
  simply all `[data-nav-row]` elements, so `↓` from the last PR row flows into
  the drawer items in DOM order. Closed, the drawer has no rows in the DOM;
  closing it with the selection inside releases that selection (identity
  re-anchoring above) instead of pasting it onto a leftover pr-row.
- **`/` opens the general command menu** (above) instead of focusing the
  search box, and is swallowed while a popover is open, as before.
- **`Escape` in the search box blurs the field** besides clearing
  `state.query` — otherwise `document.activeElement` stays on the input and
  `kbHandler`'s `typing` guard (`active.tagName === 'INPUT'`) eats every later
  arrow key.
- **`↑` past the first row jumps to the search bar** (`kbHandler`'s ArrowUp
  branch calls `focusSearch()` at `selIndex <= 0` instead of clamping) — that
  bar searches all open PRs of the repo, so it's one keystroke away.
  `focusSearch` focuses the field and releases the selection
  (`selKey = null`). Test: `tests/overview.spec.mjs`.
- **`↓` in the search box jumps back to the row list**
  (`onSearchKeydown`'s ArrowDown branch): blur + `moveTo(0)`, landing on the
  first visible row of whichever `currentView()` is active (a safe no-op with
  zero rows). Without it, landing in the box — by click, by backspacing the
  query empty, or via the `↑` jump above (which also fires right after page
  load) — was a one-way trap where every `↓` hit the `typing` guard. Test:
  `tests/overview-search-arrowdown.spec.mjs`.
- **An open popover owns the keyboard; list navigation is suspended.**
  `togglePopover` focuses the first item on open (via `requestAnimationFrame`,
  after the arrow.js paint); `kbHandler` branches on `ui.openPopover != null`
  into `handlePopoverKey(e)` as its **very first** check — before even the `/`
  shortcut — so no key reaches `move`/`moveTo`/`activateSelected`. There:
  `↑`/`↓` cycle the menu's own `<button>`/`<a href>` items (`movePopover`,
  focus-based — the browser's `:focus` is the source of truth),
  `Enter`/`Space` let the **native** activation run (deliberately no
  `preventDefault`, identical to a mouse click), `Escape` closes
  (`closePopover`, shared with the click-outside listener), and
  `←`/`→`/`Home`/`End`/`/` are swallowed so they don't leak to the row list;
  every other key (notably `Tab`) is left alone.
