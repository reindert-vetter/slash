# Playwright test infra (per-worker isolated server)

Playwright (`@playwright/test`) is the only real npm dependency and lives in
`devDependencies` — tests only, never production. This file is the harness
contract: how a worker gets its own server/DB, which fixtures exist, and the
handful of rules that keep the suite from flaking.

## Build & per-worker server

- The Go binary is built **once** in `globalSetup` (`tests/_setup.mjs` →
  `go build -o tests/.tmp/slash .`), never per test.
- **No shared `webServer`.** Each worker gets its **own** seeded SQLite DB and
  its **own** server on **port `4200 + workerIndex`**, via the worker-scoped
  fixture in **`tests/_fixtures.mjs`**. Because `newTasks` places **all** module
  DBs (comments/workflows/relations/callresolve/inbox/prmeta) **next to** the
  `-db` path (`filepath.Dir`), one `-db tests/.tmp/w<n>/test.db` isolates all
  write state per worker. That removed both the cross-worker write races
  (SQLite contention previously yielded an empty `runId`) and the page-load
  contention that made the suite flaky.
- The read-only base/head worktrees live under **`tests/.tmp/data`**
  (`TEST_DATA_DIR` in `tests/_setup.mjs`) and stay shared across workers; every
  worker server starts with **`-data tests/.tmp/data`**, so **a test run never
  touches the live `data/` tree**. Hence the data dir is configurable at all:
  `-data` flag / `SLASH_DATA` env, default `"data"` (`dataDirPath` in
  `main.go`, mirroring `dbPath`/`-db`/`SLASH_DB`).
- **Spec imports:** every spec imports `{ test, expect }` from
  **`./_fixtures.mjs`** (not `@playwright/test`), so `page.goto('/pr/…')` hits
  its own worker server (the fixture overrides `baseURL`).
- **Workers = 4** on this 8-core box: each worker runs a Go server **plus** a
  Chromium, so 6+ saturates the machine and gives flaky assertion timeouts. The
  `expect` timeout is **15s** (room for a slow render during a startup spike;
  passing tests stay under 1s) and `retries: 1` catches the remaining cold-start
  mount race. A real failure fails both attempts.
- **The harness always forces offline, regardless of the shell environment:**
  the worker fixture starts every server with **both `SLASH_GITHUB=off` and
  `SLASH_CLAUDE=off`** hardcoded in the `spawn` `env` (the rest of
  `process.env` is spread, these two are fixed). Without the hardcoded
  `SLASH_CLAUDE=off` a worker started from a shell lacking it would really shell
  out to the `claude` CLI for the automatic call-resolution search
  (`resolve_call`), which stalls and made comment-flow specs (e.g.
  `repro-live-comment.spec.mjs`) fail non-deterministically. No spec expects a
  non-Fake `claude` client — the LLM-resolved paths are tested via seed fixtures
  (`tests/fixtures/callresolve.json`). **So never run the suite with loose
  `SLASH_GITHUB`/`SLASH_CLAUDE` env vars to get it offline**; those vars only
  still matter for `go run .`/`slash` outside Playwright.

## Fixture data: hand-written worktrees, never real ingests

- **Never anchor a test on real, ingested `gh`/`git` data.** All diff content
  (`/api/code`, `/api/blockstats`, `/api/langsiblings`) comes from the
  `materialize*Worktrees` functions in `tests/_setup.mjs`, which write
  `tests/.tmp/data/worktrees/pr-<n>-{base,head}` before the workers start
  (shared + read-only, rebuilt every run — `tests/.tmp` is gitignored, so the
  fixture *content* is committed as code in `_setup.mjs` while the materialized
  tree is a build artifact, exactly like `tests/.tmp/slash`). Use
  `worktreeWriter(pr)` for a new one.
- **Why:** the main anchor fixture (PR 12903) used to be a real ingest sitting
  in the live `data/` tree — unreproducible on a fresh checkout/CI, drifted away
  from the PR's real base/head SHAs, and **deletable out from under the suite**
  (the daily `cleanup` workflow purges PRs merged over a week ago, which wiped
  it and failed 54 specs at once). The fixture PR numbers are still real,
  long-merged numbers; the `-data` split above — not renaming them — is what
  keeps `cleanup` away.
- `materializeMainWorktrees` (PR 12903) is the one to read first: its own
  comment spells out the diff shape the specs depend on (exactly two blocks with
  one single-row change group each, the changed line at absolute line 67,
  everything else byte-identical between base and head) and why each property is
  load-bearing. Small per-feature fixture PRs (90/91/92/93/94) deliberately have
  **no** worktree — their specs only exercise child-listing/drill mechanics.

## Shared state is reset per test, not per worker

`_cleanApprovals` (an auto fixture in `tests/_fixtures.mjs`) wipes, before each
test, the stored approvals of every fixture PR a spec approves
(`APPROVAL_RESET_PRS`) plus the anchor PR's comments — through the sanctioned
write paths (the approve workflow's `set` Signal with an empty set; a comment's
own `delete` Signal). A worker's DB lives for the whole worker, so a durable
approval or a PR-wide comment written by one spec otherwise leaks into every
later spec on that worker, and both change what the sidebar renders (a fully
approved top-level block is hidden; a PR-wide comment adds a synthetic "Start"
row) — whichever spec then clicked `[data-idx="1"]` or counted rows failed
depending on the scheduler.

**Add a PR to `APPROVAL_RESET_PRS` as soon as a new spec approves anything on
it.**

## A spec that SEEDS data takes its PR number from `seededPr(testInfo)`

Never a hand-picked literal — and there is a guard spec that enforces it.
Comments have no reset hook in `_cleanApprovals` (it only wipes the shared
anchor `12903`, see its own comment for why), so a number typed into two spec
files silently leaks one spec's comments into the other's exact count
assertions, visible only when the scheduler puts both on the same worker. This
used to be a rule of thumb here and got broken twice anyway (`970010` shared by
`comment-author-avatar.spec.mjs` and a `navigate.spec.mjs` test, `970011` by
`comment-author-avatar.spec.mjs` and `comment-last-reply.spec.mjs`), because
nothing about a hand-picked number tells you it is already taken. So it is an
allocator plus a check rather than a convention:

- **`seededPr(testInfo, slot = 0)`** (`tests/_fixtures.mjs`) hands out
  `971000 + n` from a module-level counter keyed on `testId + retry + slot`.
  Module-level means **per worker process**, exactly the scope that matters — a
  worker owns its own DB and server, so two workers handing out the same number
  can never see each other's rows, and within a worker tests run sequentially,
  so a plain insertion counter is already collision-free (no hashing, no
  registry). The **retry** is in the key because a retry reuses the same worker
  DB, so reusing the number would leave the second attempt looking at the
  first's leftovers. `slot` is only for a single test that genuinely needs two
  isolated PRs at once. Replaces the local `prFor` helper that lived in
  `comment-ignore-persists.spec.mjs`.
- **`tests/seeded-pr-literals.spec.mjs`** fails the run on any `97xxxx+`
  literal in a spec file outside a small `ALLOWED` map. It reads sources off
  disk and opens no page, so it is the one spec importing from
  `@playwright/test` instead of `./_fixtures.mjs` — the worker fixture would
  boot a server for nothing. Deliberately scoped to the synthetic range only:
  several specs legitimately read the same pre-seeded, read-only worktree
  fixture (90-112, 12903) without writing, which is no collision and must not
  be flagged. `ALLOWED` is for a number naming data that exists *before* any
  test runs (a `tests/fixtures/*.json` PR, currently `970500`/`970600`) or no
  data at all (`970099`, a mocked `/api/problems` payload) — never to silence a
  spec that seeds at runtime.

A block-fixture-backed PR is the one case that cannot use `seededPr` (the number
is baked into the JSON): such a spec must clean up after itself in-test, the way
`underlying-comment-activity.spec.mjs` resolves the comments it places.

## Reserved PR numbers, and `slash seed` requires `-db`

- **The `97xxxx` range (and the small single-digit/90-109 fixture numbers) is
  reserved for Playwright fixtures — never reuse one for manual/ad-hoc testing
  against the live server** (`./slash-bin`/`.claude/scripts/restart-server.sh`
  deliberately run with no `-db`/`-data` override and therefore read/write the
  real `data/` tree). Two synthetic PRs (`970099`, `970001`) once ended up
  there: one via real `POST /api/workflows/...` calls straight against the live
  server, one via a bare `slash seed -comments <fixture>` from the repo root.
  Neither exists on GitHub, so every subsequent server start logged
  `gh api .../pulls/970099/comments: exit status 1`-style noise from
  `pr_status`'s ingest-refresh check and the comment importer, forever. Cleaned
  up with `slash cleanup -force 970099,970001` (see "Daily data cleanup" in
  `.claude/rules/workflows-trackers.md`). A manual `curl`/browser session
  against the live server can still start a real workflow for any number you
  type, so **use a number nobody depends on and that is obviously not a real
  PR** when reproducing something by hand.
- **`slash seed` requires `-db` explicitly** — no silent fallback to
  `SLASH_DB`/`data/graph.db`. `seed` is a fixture-only tool and every legitimate
  call site (`tests/_fixtures.mjs`) already passes `-db <worker-db>`. `slash
  ingest`/`slash relations`/the server keep their `-db`-optional-with-a-default
  behaviour — only `seed` was tightened, since defaulting to live data is never
  intended there.

## Spec-writing rules

- **Mount a component through `evaluateSettled`** (exported from
  `tests/_fixtures.mjs`), never a bare `page.evaluate`. ~14 specs mount a
  component by dynamically importing a module *inside* `page.evaluate()` against
  the live app page (they need `index.html`'s Tailwind/Prism CSS for
  computed-style and geometry assertions). Two load-timing errors hit that
  pattern: `home.mjs`'s `bindUrlState` watches fire a burst of
  `history.replaceState` during load that can tear down the execution context
  ("Execution context was destroyed"), and under 4 workers the dynamic import
  can lose its race with a briefly saturated server ("Failed to fetch
  dynamically imported module"). `waitForLoadState('networkidle')` does **not**
  guarantee the burst is over. `evaluateSettled` retries the whole evaluate (up
  to 4 attempts) on exactly those two messages, waiting for idle in between — a
  targeted retry instead of leaning on `retries: 1`, which would also hand a
  free retry to a genuine unrelated failure and hide how often the race fires.
  **Requirement:** put the `await import(...)` calls **first** in the body,
  before creating the host element — a context torn down at the import hasn't
  mounted anything yet, so a retry can't leave a duplicate host behind (which
  would trip strict-mode locators).
- **Open a `/pr/<id>` spec with `await leaveSearchBox(page)`** (exported from
  `tests/_fixtures.mjs`), never a bare `page.keyboard.press('Escape')`.
  `home.mjs` focuses the sidebar search box from a
  `requestAnimationFrame(focusSearchBox)` on load. A bare `Escape` sent before
  that frame runs is handled with nothing focused, and the rAF then focuses the
  box **anyway** — after which every later key goes through `onKeydown`'s
  `searchActive` branch, which behaves differently from the nothing-focused path
  (`ArrowRight` there means "step into the diff"). The helper waits for the
  load-time focus, presses `Escape`, and asserts the box released focus. ~70
  sites used the bare form; it flaked `comment-index-items.spec.mjs`.
- **Never assert a TRANSIENT intermediate state — assert the end state.** An
  assertion polls, so it can only observe a state that lasts long enough to be
  sampled. `tests/range-select.spec.mjs` clicked the palette's approve item and
  then asserted `expect(menu).not.toBeVisible()`; `runCommand` (`home.mjs`) does
  close the menu first, but that approve finishes the block so
  `afterApproveAction` immediately reopens it as the postApprove follow-up menu
  (see "Enter — command palette" in `.claude/rules/command-palette.md`). How
  long the closed frame lasts is just how fast `findNextUnapproved`'s awaited
  `ensureCode` resolves, and the reopen regularly won. Fix: wait for the
  follow-up menu's own content ("Ga door"). Rule of thumb — before asserting
  something is gone/closed/absent, check whether the same action starts an async
  follow-up that brings it back; if so, assert what distinguishes the follow-up.
- **A test that drives the UI with the MOUSE parks a pointer, and a later layout
  change can then fire a genuine `mouseenter` from it.** A `.click()` moves the
  real pointer and leaves it there, so any later DOM/scroll change that slides a
  hoverable element under it behaves exactly like a real hover — which bit
  `tests/overview-selection-identity.spec.mjs` (see the
  `scheduleRepaint`/`hoverEnabled` paragraphs in
  `.claude/rules/pr-overview.md` for the app-side fix). Whether it triggers
  depends on scroll position, so it presents as order-dependent flakiness. When
  a spec's subject is *not* hover, prefer `dispatchEvent('click')` (drives the
  handler without moving the pointer) over `.click()`.
