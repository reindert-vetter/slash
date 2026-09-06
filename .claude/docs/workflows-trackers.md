# Tracker & maintenance workflows

The long-lived per-PR/per-repo trackers (`pr_status`, `pr_inbox`, `approve`,
`ignore_comment`) plus the one-shot operational
workflows (`ingest`, `submit_review`, `ready_for_review`, `cleanup`) and how a
silent background failure still reaches the UI. Engine mechanics live in
`.claude/docs/tembed-workflows.md`, endpoints in
`.claude/docs/tembed-endpoints.md`.

## `pr_status` (per PR): metadata, merge detection, ingest refresh

One Execution per PR that receives `state` Signals from the pollers and
**completes** once the PR is merged/closed — the durable source of truth the
pollers read to stop. `ensurePRStatus(pr)` starts/reuses one per PR, also after
a restart.

`ensurePRStatus` caches PR → Run ID in `m.prRuns`; a cache miss falls back to
`findPRStatusLocked`, which does its own full `engine.Runs()`/`ListRuns()`
scan to find the tracker. That cache starts **cold** after a restart — it is
only bulk-filled by `ResumePRStatusPolling`, which runs strictly **after**
`ResumePolling` (see `newTasks`, `tasks_api.go`) — so `ResumePolling`'s own
loop over every waiting `task_code_comment` run used to call `ensurePRStatus`
per run, and thus `findPRStatusLocked`'s full scan once per **distinct PR** it
encountered: O(waiting runs × total runs), the dominant stack in a profile
with hundreds of waiting comment threads spread over many PRs.
**Don't reintroduce this:** `ResumePolling` already has the one `runs` slice
it needs in hand, so it primes `m.prRuns` from that single slice
(`primePRRunsLocked`, `workflows.go`) **before** its loop starts, so every
`ensurePRStatus` call inside that loop hits the cache and the whole pass costs
exactly one `ListRuns` call. Test: `TestResumePollingDoesNotRescanRunsPerPR`
(`resume_polling_scale_test.go`) asserts this count directly via a counting
`Store` wrapper.

**On start** it runs four Activities in sequence, each with its own targeted
read-model write, so the UI can render **progressively** instead of waiting for
everything (see "Progressive loading" in `.claude/docs/detail-layout.md`):

1. **`fetchPRBasics`** — `PRMeta` (title/URL/body/author/diff-stats/head-ref,
   best-effort), derives a Jira key from the title (`\b([A-Z][A-Z0-9]+-\d+)\b`,
   same regex as the frontend) and fetches that ticket (best-effort), then
   `prmeta.SaveBasics`. A failed Jira fetch (e.g. `acli` not logged in, or the
   issue key doesn't exist) never fails the tracker — it only `m.logf`s
   `"pr_status: fetch jira %s pr=%d skipped: %v"` and moves on with no
   `JiraKey`/`JiraTitle` on the stored basics. **The `pr=%d` is load-bearing**:
   `GET /api/problems` mirrors every `m.logf` line into a ring buffer
   (`run_errors.go`), and the review tree's own "Taken" block
   (`pollProblems`, `home.mjs`) filters that list to `e.pr === state.pr` since
   the endpoint itself is repo-wide — a line missing `pr=<n>` silently stays
   PR 0 forever and never reaches that per-PR block, even though it still
   shows up in the repo-wide `/pr-overview` "Mislukte taken" drawer. Every
   other `pr_status` log line already carried `pr=%d`; this was the one that
   didn't. `modules/jira/jira.go`'s `Issue` also surfaces `acli`'s own stderr
   in the wrapped error (mirroring `modules/github`'s `api`), so that log line
   names the real reason instead of a bare `exit status 1`. Test:
   `TestPRStatusJiraFailureLogsPR` (`workflows_test.go`).
2. **`generatePRSummary`** — prompts Haiku (context-only) with the stored basics
   + the distinct changed files from `blocks` + the Jira ticket for a 2-4
   sentence summary → `prmeta.SaveSummary`.
3. **`fetchPRStatuses`** — reuses the inbox status query (`statusesFor`) for
   this one PR → `prmeta.SaveStatuses`. GitHub's rollup gives only a total + an
   overall state, so `checksPassed` is `checksTotal` on `SUCCESS` and otherwise
   0 — enough for a pill, not an exact count. It **also** stores that same
   query's "nieuw sinds jouw review|comment" signal via `prmeta.SaveSinceMark`
   — the kind word, the moment it refers to (`myLastActivity`'s timestamp,
   `inbox.go`) and the PR's own GitHub `updatedAt`. The overview only ever
   needed the word; the review tree needs the moment too, and it must be the
   SAME moment, not a second approximation beside it.
   **That moment is not purely GitHub-derived**: `statusFromNode`
   (`inbox.go`) folds in `prmeta`'s own `FullyApprovedAt` via
   `combineSinceMoment(ghAt, ghKind, fullyApprovedAt)` — whichever of the two
   is LATER wins, always reported as kind `"review"` when the local one wins.
   This is what makes the badge correct on **your own PR** (PPTD-948): GitHub
   never carries a review FROM the author on their own PR, so `ghAt` is often
   empty/stale, while the reviewer may well have approved every line in the
   tree itself. `FullyApprovedAt` is written by a **separate** path, not this
   Activity: `home.mjs`'s `state.approvalTotal` watch fires a `fullyApproved:
   true` Signal on the `approve` tracker (same "set" Signal channel as the
   file-viewed request, see `.claude/docs/approval.md`) the moment
   `done===total>0` transitions to true, driving the `saveFullyApprovedAt`
   Activity → `prmeta.SaveFullyApprovedAt`. It is a fixed historical moment,
   never adjusted with hindsight — a later commit moves the PR's own
   `updatedAt` past it, so the badge reappears on its own once there is
   something new to see, without any special-casing here.
   `statusesFor`/`buildInboxSnapshot` take a `*prmeta.Module` (may be `nil`)
   purely to look this moment up per PR — the same fold applies to
   `/pr-overview`, not only the review tree, since both funnel through
   `statusFromNode`.
4. **`generateSinceReviewSummary`** — what changed since that moment, for the
   review tree's sky "Sinds jouw laatste review" block (see
   `.claude/docs/detail-layout.md`). Runs after stage 3 because it reads the
   moment stage 3 stored. Two layers, both on explicit request:
   `github.ChangesSince` lists the commits that landed after it plus the files
   they touched (at most two `gh api` calls: the PR's commit list, then a
   compare of the last-seen commit against the newest), `sinceReviewFacts`
   renders that as a capped Markdown list, and Haiku
   (`SinceReviewSystemPrompt`) explains those same facts in a couple of
   sentences. The AI half is **best-effort** — a Claude hiccup leaves the facts
   standing alone — and the facts are the AI's entire prompt, so it can never
   assert something the reviewer can't check right below it. Only new **code**
   counts: comments and other people's reviews are deliberately out of scope
   for this block. Nothing new, or a reviewer who never reviewed this PR, is
   stored as an empty pair, which is what makes a stale block disappear rather
   than linger.

**Stages 3+4 also re-run on demand** — they have to, because "on start" means
once ever: one tracker serves a PR for its whole lifetime (reused across
restarts, see `ensurePRStatus`), so the since-review block used to freeze on
whatever was true when the tracker happened to start, and typically stayed empty
while `/pr-overview` — which recomputes the same signal LIVE on every poll
(`myLastActivity`, `inbox.go`) — did show "nieuw sinds jouw review" on the same
row. `PRStateSignal.RefreshSince` re-runs both stages, in that order; the review
tree sends it once per page load (`refreshSinceReview`, `src/home.mjs`, via the
generic `.../signals/state` route, which accepts **only** that half of the
signal — a lifecycle `State` or an ingest-refresh SHA pair from the outside is a
400, those belong to the server's own pollers).

Two details keep that cheap and safe:

- **It is its own branch in the loop, deliberately not folded into the
  `HeadSHA` branch.** tembed matches an activity against the history purely by
  POSITION (`nthOf(actIdx)`, no name check), so adding activities to a branch an
  existing Execution already took would silently misalign every later step of
  that history. A branch no past signal could take (`refreshSince` absent →
  `false`) replays as the empty branch it always was.
- **`generateSinceReviewSummary` skips the LLM when nothing moved.**
  `sinceReviewFacts` is a pure function of the commits + files, so an identical
  rendering means an identical answer: the Activity returns before the Haiku
  call and writes nothing. One `gh` query per page load, an LLM call only when
  there is genuinely something new. When it does write, it publishes
  `prmeta.changed` (`.claude/docs/server-events.md`) — `pollPRMeta` stops as
  soon as the statuses stage lands, so a block finished seconds later would
  otherwise wait for a manual reload.

Test: `TestRefreshSinceSignalRerunsStagesThreeAndFour` (`workflows_test.go`).

### Ingest refresh (pulling in new commits automatically)

The same `state`-Signal loop also processes **new commits**, so a reviewer
needn't re-ingest by hand after every push. `PRStateSignal` carries
`BaseSHA`/`HeadSHA` besides `State` (both variants ride on the one signal name):
`State` set = a lifecycle observation; `State` empty + `HeadSHA` set = a refresh
request.

- **`pollIngestRefresh`** (its own loop, same heartbeat cadence) compares the
  live `headRefOid` against the stored `pr_ingest` row and signals when they
  differ **and** the stored head does not already contain the remote tip
  (`ingestRefreshNeeded`). That second condition exists for the landed-but-
  unpushed chat edit: the tree is then ingested at a LOCAL commit GitHub has
  never seen, so a bare inequality check would rewind it to the older remote
  tip on every tick. Someone else pushing on top makes the remote tip
  uncontained again, and the tree deliberately follows GitHub — see
  `.claude/docs/pending-push.md`. The per-thread comment heartbeat only fires with a thread open, so
  `home.mjs` separately pings the `pr_status` Run ID every 60s while the PR page
  is visible+focused (operational, no state).
  - **The check itself is shared, not duplicated.** `pollIngestRefresh`'s
    per-tick body is `checkIngestRefreshOnce(ctx, prRunID, repo, pr)` — read the
    meta, load the stored SHAs, decide via `ingestRefreshNeeded`, signal if
    needed. `TriggerIngestRefreshCheck(prRunID, repo, pr)` runs that exact same
    check **once, in the background**, and `handlePRStatusStart` (the endpoint
    `home.mjs`'s `loadPRMeta()` hits on every page load) calls it right after
    `EnsurePRStatus` — so **opening the review tree** surfaces a PR whose head
    already moved immediately, instead of waiting for `pollIngestRefresh`'s next
    tick (up to `m.interval`/`m.idle` after its last one). Same `runtimeReady`
    gate as `pollIngestRefresh`'s own spawn (a no-op for a one-shot CLI caller).
    A stray double-check this way (the ticker and the on-open trigger landing
    close together) is harmless for the same reason a duplicate Signal already
    was — see the "stray/duplicate signal" note two paragraphs down. Test:
    `TestTriggerIngestRefreshCheckFiresImmediately` (`workflows_test.go`).
- **`refreshIngestDelta` Activity** (`ingest.go`) diffs the **previously
  stored** head SHA against the new one (`changedFileNames`) and rescans only
  those files, writing via **`upsertPRFileBlocks`** (a DELETE+INSERT scoped to
  those paths) so every other file's blocks — and everything hanging off their
  **stable** block id in the separate comments/approvals/callresolve stores —
  stays untouched. The head worktree is updated **in place**
  (`git checkout --detach`, falling back to the hard rebuild) instead of
  remove+recreate, which was too heavy for a per-minute cadence.
  - **`--no-renames` is load-bearing:** with rename detection on, `--name-only`
    reports only the **new** path, so the old path drops out of the delta and
    `upsertPRFileBlocks`' `DELETE … WHERE file IN (…)` can never reach it —
    seen in practice as permanently orphaned blocks for a directory renamed
    mid-PR. With `--no-renames` a rename yields both paths and the old one is
    cleaned up like any other removal.
  - **A landed chat edit signals this same branch itself**
    (`refreshTreeAfterLanding`, `chat_merge.go`) with the pending ref's commit
    as the head SHA and the already-stored base SHA, which is what makes such
    an edit visible in the review tree immediately. Nothing here cares whether
    that commit is on GitHub — only that it is locally reachable.
  - **Base SHA changed** (e.g. a rebase) makes an incremental diff unsafe → it
    falls back to the **full** pipeline, marked `FullFallback` in the history.
  - **`pr_ingest` table** (`pr → base_sha, head_sha`) is updated by both a full
    ingest and a delta refresh. No row = never ingested → the poller/Activity do
    nothing (a refresh requires a prior full ingest).
- **An already-open review tree is told, but not refreshed.** A non-`Skipped`
  refresh publishes `blocks.changed` (`publishBlocksChanged`), which raises a
  "Nieuwe commits — herlaad de boom" notice at the top of the block index. It
  deliberately does not refetch on its own; `home.mjs` loads the blocks exactly
  once per page load, and swapping them under an active cursor would reset a
  half-finished approve pass. See `.claude/docs/server-events.md`.
- **Relations/callresolve keep being recomputed "in full", not delta-scoped:**
  after a non-skipped refresh the workflow simply calls the existing
  `buildRelations` Activity over the PR's **full current** block list. Chosen
  because `resolveCalls` builds a whole-worktree symbol index regardless of how
  many blocks it is fed, so delta-scoping saves little — while a relation
  between two unrelated files (dispatcher in A, listener in B) makes a partial
  keep-set an actual risk of stale/vanished rows. With the full block list as
  keep-set, `Replace`/`Prune`/`UpsertGo` can never prune a valid row of an
  unchanged file.

### Comment/approval anchors are RE-ANCHORED on every refresh

A comment's `row_start`/`row_end` and an approval's row indices are positions in
a block's **aligned-row space** (`blockAlignedRows`), and a refresh rewrites
exactly that space for the files it re-scanned. Leaving the read models
untouched preserved the *rows* but not their *meaning*: a comment's 💬 landed on
the wrong line, and a line inserted above an approved one silently inherited its
✓ — neither repairable by hand. Hence `reanchorAfterRefresh` + `reanchor.go`,
run **before** the relations rebuild.

- **A comment carries its own code snapshot** (`comments.Code`, built from whole
  aligned rows), so re-anchoring is a search for that snippet in the new rows,
  **whitespace-insensitively** (`wsKey`, the same way `diffLines` pairs lines,
  so a pure re-indent still matches). Blank/filler rows are skipped inside a
  multi-line match.
- **An approval carries its own per-row anchors** (`approvals.RowAnchor`: the
  row's displayed text plus its two neighbours, written by the UI at approve
  time — see "An approval carries the CODE it approved" in
  `.claude/docs/approval.md`), so it re-anchors from data it holds itself:
  unique text wins, several candidates must be singled out by their neighbours,
  a tie is dropped (`remapFromAnchors`/`anchorContextMatches`). That is what
  makes it survive the cases the fallback below cannot handle at all — the base
  branch moving (a rebase/merge of main re-diffs the whole PR), a force-push, or
  a full re-ingest.
- **An approval stored BEFORE those anchors existed** has only indices, and
  falls back to the PREVIOUS sides. `refreshIngestDelta` therefore reports
  `PrevBaseSHA`/`PrevHeadSHA`/`ChangedFiles` on its result (reading them back
  afterwards is impossible — the refresh has overwritten `pr_ingest` — and
  wouldn't be replay-safe), and `planReanchor` materialises those two revisions
  of just the touched paths into a throwaway **shadow worktree pair**
  (`git show <sha>:<path>`, stdout only — `runGit`'s `CombinedOutput` would
  splice stderr into the file content) so `blockAlignedRows` can be reused
  verbatim on a historical revision. The real head worktree is no help: it has
  already been checked out to the new SHA. Every remap — from either source —
  emits **fresh** anchors for the rows that survived, so a legacy approval
  upgrades itself on the first refresh and never needs this fallback again.
- **It degrades instead of guessing.** No match, or several (a snippet like a
  bare `}` recurs) → the comment **unpins** to `row_start -1`, so it shows
  anywhere in its block and claims no 💬 row. Symbol gone entirely →
  **`AnchorOrphan`**, keeping the old rows as a record. An approved row whose
  text can't be found unambiguously is **dropped** — the reviewer did not
  approve what replaced it, and "unapproved again" needs no new state.
- **A narrower second pass, `contextRemap`, recovers a subset of those dropped
  approval rows:** a row whose text repeats within the block but whose immediate
  neighbour(s) still corroborate it (a try/catch block with two near-identical
  `return [...]` arrays otherwise lost over half its rows on every refresh).
  - Interior row: both the previous and next row's text must agree (`wsKey`).
    **Edge** row (block's first/last): only its one neighbour. A **single-row**
    block has neither and stays dropped.
  - A required neighbour that doesn't exist on the **candidate's** side counts
    as a mismatch, not a pass — that asymmetry is itself evidence.
  - A **blank source line** compares like any other text (`"" == ""` agrees) — a
    documented residual weak spot rather than a special case: the repeated-
    boilerplate shapes this targets (`}`/`];`/mirrored literals) always have
    real code next to them in practice.
  - Only a **unique** surviving candidate is accepted; rows resolve in ascending
    old-row order and a claimed target is removed for later rows, so two
    duplicates can never collapse onto one row.
  - **Deliberately NOT a full LCS/positional diff** between old and new row
    texts, and don't turn it into one: an LCS resolves duplicates by relative
    **order**, so a genuine reordering looks exactly like "Nth maps to Nth" and
    would silently reattach an approval to code the reviewer never reviewed in
    its new place. A dropped approval they redo is better than a wrong ✓.
- **A `'call'` anchor** addresses character offsets *within* its row, so it only
  survives while that row is byte-identical; otherwise it degrades to
  `gran:'line'` without a segment — still the line they picked, one granularity
  coarser. (`dedent4` is computed over the old/new pair, so the shared indent
  can shift between refreshes and shows up as a non-identical row.)
- **An anchor that still resolves to the same rows produces no update at all**
  (the plan compares against what's stored), so a commit touching files nobody
  commented on costs no Signals and no writes.
- **Write path:** planning is all reads; applying goes only through sanctioned
  paths — a **`reanchor` action on the existing `reply` Signal** per comment →
  `saveCommentAnchor` → `comments.SetAnchor`, and the approve tracker's existing
  `set` Signal per remapped block. `SetAnchor` also rewrites the `codeRef`
  segment of the comment's `Path` (rebuilt via `commentPath`, not string-patched,
  so the two can't drift) — otherwise a prefix `Search` would address rows the
  anchor no longer sits on.
- **Plan and apply share ONE Activity**, mirroring `supersedeFileWarnings`:
  returning the plan and looping in the workflow body would put a variable
  number of Signal sends in the body; one Activity is simply a fixed history
  position. Best-effort per anchor — a comment whose Execution already completed
  can't be signalled, and that must not sink the rest of the pass.
- **Every path that swaps blocks runs the pass, not just the delta refresh.**
  `scanAndStoreIngestBlocksLocked` reads the pre-swap SHAs itself and reports
  them with `ChangedFiles` = every path of the PR, and `ingestWorkflow` calls
  `reanchorAfterRefresh` after storing. That covers the base-SHA-moved fallback
  **and** a manual full re-ingest ("Regenereren", `slash ingest`), neither of
  which goes through `prStatusWorkflow`. Load-bearing, not symmetry: a manual
  re-ingest after new commits used to break every anchor of a changed file **and
  close the repair window**, because it records the new SHAs and the poller then
  reports `Skipped`. As a side effect one re-ingest also repairs anchors that
  went stale before this pass existed. A first ingest is a cheap no-op.
- Both call sites invoke the Activity **by name**, and neither has a test that
  runs without git/gh, so a typo would only surface on a real PR —
  `TestReanchorActivityIsRegistered` pins the name.
- **`comments.anchor_state`** (`''`|`'unpinned'`|`'orphan'`) carries the outcome
  to the frontend. Deliberately separate from `Kind`: an orphan is still a
  block-scoped review comment, and flipping its `Kind` would change how its
  replies mirror to GitHub (`isPRWide`). See "Comment-index items" in
  `.claude/docs/comments-panel.md` for how an orphan stays reachable.
- Tests: `reanchor_test.go`, `blockstats_test.go`'s
  `TestRowForLineSharesRowSpaceWithApproveTotal`,
  `tests/comment-orphan-anchor.spec.mjs`.

## `pr_inbox` (per repo)

The **only** workflow that reads GitHub for the overview: a `refresh` Signal
(from the UI on load and from `pollInbox` on the heartbeat cadence) drives the
`refreshInbox` Activity, which fetches the inbox and writes it into the `inbox`
read model, returning only a small summary so the endlessly-refreshing history
stays compact. `EnsureInbox` starts/reuses one per repo (a fast, DB-only step) and then, once
the `TaskManager`'s ready gate opens, runs the first refresh and starts
`pollInbox` — deferred past the HTTP listener binding (see "Serialized +
deferred past server startup" in `.claude/docs/workflows-analysis.md`'s
`code_warning` section for the full gate mechanism), traded off against the
read-model having a snapshot the instant the server starts serving. See
`.claude/docs/pr-overview.md`.

### Automatic review-tree generation (`auto_ingest_pref` + `modules/autoingestpref`)

Reviewer request: "mijn eigen prs, daarvan mogen de trees automatisch worden
gegenereerd" — the reviewer's own PRs (and, on request, everyone else's too)
should not need a manual "Generate review tree" click at all.

- **`modules/autoingestpref`** (`data/autoingestpref.db`,
  `auto_ingest_pref(repo, mode)`) is a 3-state repo-wide preference —
  `"off"`/`"own"`/`"all"` — the same per-repo-tracker mould as `auto_warn`
  (mirrors its Module shape, `Mode`/`SetMode` instead of `Enabled`/
  `SetEnabled`). Default `"own"` when nothing was ever saved: auto-generate
  the reviewer's own PRs, opt-out rather than opt-in.
- **Workflow (`WorkflowAutoIngestPref = "auto_ingest_pref"`):** a loop on the
  `auto_ingest_pref` Signal, one `saveAutoIngestPrefMode` Activity per Signal
  — deterministic, never completes. `EnsureAutoIngestPref` starts/reuses one
  per repo, also after a restart, exactly like `EnsureAutoWarn`.
- **The trigger itself lives inside the `refreshInbox` Activity**, not a
  separate poller: after building/storing the snapshot, it reads the current
  mode (`AutoIngestPrefMode`) and — unless `"off"` — calls
  `eligibleAutoIngestPRs(mode, myLogin, sections)` (`inbox.go`), a pure,
  side-effect-free selection function (directly unit-testable without gh):
  - `"own"` — PRs authored by `myLogin`, but **only** from
    `autoIngestOwnSections` — a deliberate, confirmed subset of the
    `author:@me` sections: **"Needs action"**, **"Waiting for review or
    checks"** and **"Your drafts"** (drafts included, on explicit reviewer
    request) — **not** "Ready to merge", since nothing is left to review
    there. "Needs your team's review"/"Needs your review" are never
    `author:@me` sections at all, so they never match in `"own"` mode.
  - `"all"` — every PR in every section, regardless of author, so a PR the
    reviewer must review (e.g. "Needs your review") also gets a tree before
    they open it.
  - Either mode skips a PR that already `hasGraph`.
  - `myLogin` is `snap.GeneratedFor` (`ghLogin(ctx)`), with
    `settings(dataDir).Me.Login` as an override when set — the same
    precedence `/api/me` vs. `settings.json` documented in
    `.claude/rules/conventions.md`.
- **Fire-and-forget per eligible PR** (`autoIngestOwnPRs`/`autoIngestOne`,
  mirrors `TriggerIngestRefreshCheck`): `refreshInbox` must stay fast — a page
  load awaits the `refresh` Signal synchronously (`SignalWorkflow` runs the
  whole Activity inline) — so each PR is handed to its own goroutine under
  `m.baseCtx`, gated on `m.runtimeReady`, running the exact same pipeline
  `handleIngest`/the CLI already run: `StartIngest` → `EnsureRelations` →
  `EnsurePRStatus`.
- **Dedup is a plain in-memory `map[prKey]bool`** (`m.autoIngestTried`, same
  operational shape as `lastBeat`/`polling`) so the poll cadence (1-10 min)
  never starts a second Execution for a PR still mid-ingest; never cleared on
  failure (a persistently broken PR does not retry every poll — it stays
  reachable via the manual button, and a failure still surfaces through
  `GET /api/problems`), and clearing on success would be a no-op anyway since
  `hasGraph` then excludes it.
- **A no-op under `SLASH_GITHUB=off`** (`ghDisabled()`): the offline fixture
  path's `GeneratedFor`/rows are synthetic and must never trigger a real
  `StartIngest` during a test run — this is also what keeps every existing
  `tests/fixtures/inbox.json`-based Playwright/Go test unaffected, even though
  that fixture itself has two `reindert-vetter`-authored, not-yet-ingested
  rows.
- **UI: one shared toggle, two homes** (`src/autoingestpref.mjs`, mirrors
  `autowarn.mjs`'s write path — `POST /api/workflows/auto_ingest_pref` then
  `.../signals/auto_ingest_pref`; read via `GET /api/autoingestpref`): a row
  on `/settings` (`ROWS`, right after `autowarn`) and a button next to the
  gear icon in `/pr-overview`'s header — the reviewer's own explicit request
  for both, since this preference is both a general setting and something
  worth seeing while triaging the inbox it affects. Cycle order
  `own → all → off → own`; word + icon shape both carry the state (never
  colour alone, per the colourblind rule), same 3-state pattern as
  `theme.mjs`'s system/light/dark — content unrelated.
- Tests: `modules/autoingestpref/autoingestpref_test.go`,
  `TestEligibleAutoIngestPRs*` (`autoingest_pref_test.go`),
  `tests/auto-ingest-pref.spec.mjs`.

## `jira_inbox` (one per process)

The reviewer's own **Jira notification feed** — the bell menu — as the first
block of `/pr-overview` (see `.claude/docs/pr-overview.md`). One Execution for
the whole process, not one per repo: that feed is per-**user**, and a Jira
notification has no PR at all.

- **One Signal, `jira_notify`, carries both actions**, distinguished by its
  payload's `kind`: `{"kind":"refresh"}` (the 5-minute poller and the UI on
  load) drives `refreshJiraNotifications`, `{"kind":"read","id":…}` drives
  `markJiraNotificationRead`. One name because tembed's `WaitSignal` takes
  exactly one; branching on a payload that comes straight out of the recorded
  history stays deterministic.
- **A fetch failure is a RESULT, not an error.** `refreshJiraNotifications`
  returns `{configured, stored, error}` rather than failing the Activity: no
  API token, or a change in the undocumented endpoint it reads
  (`modules/jira/notifications.go`), must not fail the tracker permanently —
  it would then never poll again until a restart. The last outcome is kept
  in-memory only (`TaskManager.jiraStatus`) so `GET /api/jira/notifications`
  can say "not configured" instead of silently showing an empty list.
- **Why not fold this into the comment/task workflows**, as asked: those are
  per-PR, per-comment task state keyed by (repo, pr, comment) and started from
  a reviewer action on a block. This is a polled, user-wide feed — exactly the
  mould `pr_inbox` above already provides, so it mirrors that and leaves the
  comment workflows untouched.
- **Retention: 30 days**, Reindert's own cap. The `cleanup` workflow gained a
  `purgeJiraNotifications` Activity (`jiraNotifyRetention`), an age-based sweep
  next to the `test_run` residue one — unconditional and PR-independent, since
  a notification belongs to a Jira issue, never to a PR.
- **`modules/jiranotify`** is the read-model: one row per notification with
  both the feed's own `feed_unread` and a local `read_at` (set when the
  reviewer opened it here). Effective unread = both. The local column exists
  because this app never marks anything read in Jira — without it every row the
  reviewer opened would come back unread on the very next poll.

## `plan` (one per Jira ticket)

One long-lived Execution per ticket (Run ID `plan-<KEY>`, so a repeated start is
an idempotent reuse) behind the `/plan/<JIRA-KEY>` page: it reads the ticket,
asks Claude for the clarifying questions + the task list, stores the whole
document in `modules/plan`, and then waits on the `plan_answer` Signal to fold
in a reviewer's choice and regenerate the tasks. Documented in full — the
document shape, the prompt, the save-before-regenerate ordering and the page
itself — in `.claude/docs/plan-page.md`.

## Persisting reviewer approval (`approve` + `modules/approvals`)

One Execution per PR, making approval durable across a refresh.

- **`modules/approvals`** (`data/approvals.db`):
  `approvals(pr, block_id, rows, calls, anchors)` with the arrays as JSON — the
  client-side `b.approvedRows`/`b.approvedCalls`, plus the **code each approved
  row pointed at** (`RowAnchor{row,text,prev,next}`), which is what makes an
  approval survive new commits (see "An approval carries the CODE it approved"
  in `.claude/docs/approval.md`). `Replace` is a full swap per block and an
  **empty** set removes the row → replay-safe; a `nil` anchor list means "keep
  the stored anchors" so a caller that can't describe the rows never erases
  them.
- **Workflow:** a loop on **`set`** Signals; each runs one `saveApproval`
  Activity. Deterministic (the Activity count equals the Signal count; no clock,
  no live state). Never completes — a long-lived per-PR tracker.
  `EnsureApprovals(pr)` starts/reuses it, also after a restart.
- **Frontend:** `loadApprovals` ensures the tracker and restores per block id;
  every mutation sends the **complete** set for that block as a `set` Signal
  (`persistApproval`). The UI never writes directly. See
  `.claude/docs/approval.md`.
- **Keeping the GitHub "Viewed" checkbox in sync:** a viewed request rides along
  on the same `set` Signal (`ApprovalSignal.File` + `Viewed *bool`; `nil` = a
  normal approval set, non-`nil` = mark/unmark, with `BlockID`/`Rows`/`Calls`
  ignored). The workflow branches to **`setFileViewed`** → `MarkFileViewed`. The
  UI detects the transition itself (`syncViewedFiles`: all blocks of a file
  fully approved + code loaded vs. `state.viewedFiles`) and only signals on a
  change — called from `persistApproval` and from `ensureCode`, for the case
  where a file's last code fetch only lands after a refresh.
- Tests: `approvals_test.go`.

## Ignoring a PR-wide comment (`ignore_comment` + `modules/commentignore`)

One Execution per **PR** (mould of `approve`), making "hide this PR-wide
comment from the block index" durable across a refresh. Purely local — no
network, so no `SLASH_*=off` gating.

- **`modules/commentignore`** (`data/commentignore.db`,
  `comment_ignores(pr, comment_id)`): `Set(ctx, pr, commentID, ignored)` is an
  `INSERT OR IGNORE` / `DELETE`, idempotent in both directions so replay is
  safe; `List(ctx, pr)` backs the UI; `Purge(ctx, pr)` is the `cleanup` hook.
- **Keyed per PR, not per repo** — a comment id is globally unique, so either
  would work, but `cleanup` purges a long-merged PR by calling `Purge(ctx, pr)`
  on every module with a `pr` column. A repo-wide key would strand every
  ignored comment of every purged PR with no way to find it again. A per-repo
  tracker (e.g. `auto_warn`) has no such hook, since it carries no `pr` field.
- **A plain on/off flag, no expiry**: "ignored" belongs with
  "resolved"/"approved" — reviewer decisions that never lapse by themselves.
- **Workflow:** a loop on **`ignore`** (`IgnoreCommentSignal{CommentID,
  Ignored}`), one `saveCommentIgnore` Activity per signal. Deterministic — no
  clock, no live state, and the Activity count equals the Signal count. Never
  completes. `EnsureIgnoreComment(pr)` starts/reuses it, also after a restart.
- **Frontend:** `loadIgnoredComments` (`home.mjs`, called from `loadBlocks`
  alongside `loadApprovals`) ensures the tracker and restores
  `state.ignoredComments` from `GET /api/commentignores?pr=N`;
  `toggleIgnoreComment` reassigns that map first (optimistic, so the row
  disappears instantly) and then fires the Signal fire-and-forget via
  `persistIgnoredComment`. Offline (no `ignoreRunId`) the Signal is a no-op and
  ignoring degrades to the session-only behaviour this replaced. The stored ids
  are raw comment ids; the `comment:` prefix is the frontend's own index-item
  id shape (`commentBlockItem`) and is added on read. See "Comment-index items"
  in `.claude/docs/comments-panel.md`.
- **Known, accepted gap:** ignoring a comment that is deleted afterwards leaves
  an orphan row until the PR is purged. It is invisible (the frontend only
  matches these ids against comments it actually loaded), and cleaning it up
  eagerly would give the comment-delete path a dependency on this module for no
  visible gain. See `Set`'s own doc comment.
- Tests: `modules/commentignore/commentignore_test.go`,
  `ignore_comment_test.go`, `cleanup_test.go` (the purge sweep), and
  `tests/comment-ignore-persists.spec.mjs`.

## Ingest pipeline as a workflow (`ingest`)

Brings the PR→blocks pipeline inside the write boundary: before this, `ingestPR`
wrote the `blocks` table and the git worktrees straight from an HTTP handler and
the CLI — the one real breach of the rule. One Execution per request, no Signal,
so it runs its two Activities and completes.

- **`prepareWorktrees`** — gh fetch + `ensureCommits` + the two `ensureWorktree`
  calls; returns only the small `worktreeSHAs` summary (base/head SHA + changed
  paths), not the worktree contents, which stay on disk at their deterministic
  path.
- **`scanAndStoreBlocks`** — `git diff` + PHP scan/classification +
  `replacePRBlocks`, the only place that still writes `blocks`. Returns only the
  small `ingestResult` summary, so the history stays compact.
- Both Activity bodies stay ordinary, directly testable functions
  (`prepareIngestWorktrees`/`scanAndStoreIngestBlocks`); they are simply only
  called from these Activities now. `StartIngest` starts the Execution and reads
  the result back.
- **CLI (`slash ingest <pr>`)** builds its own engine via
  `newTasks(…, resumeRuntime=false)` — that flag skips
  `ResumePolling`/`EnsureInbox`, server-only runtime a one-shot headless ingest
  shouldn't start — then calls `StartIngest` + `EnsureRelations`, like the HTTP
  flow.
- **Both `handleIngest` and the CLI also call `EnsurePRStatus(pr)`** right after
  `EnsureRelations`, so an ingest triggered purely via the API/CLI (no browser
  tab ever opened on that PR) still gets a `pr_status` tracker. That matters
  beyond the PR summary/CI card: `ensurePRStatus` only spawns
  `pollIngestRefresh`/`pollImportComments` for a **genuinely new** run — without
  this call, such a PR would never auto-refresh on later commits or import
  GitHub comments until someone happened to open it in the browser (which is
  what previously called `POST /api/workflows/pr_status` on page load).
  `EnsurePRStatus` is idempotent (reuses an existing tracker) and non-blocking
  (`StartWorkflowDeferLow`), so calling it on every ingest/"Regenereren" costs
  nothing extra. The CLI path skips the pollers themselves (`resumeRuntime`
  false), but the tracker it creates is picked up by `ResumePRStatusPolling`
  next time the server runs. Test: `TestIngestEnsuresPRStatus`
  (`ingest_test.go`).
- `ingestMu` still serialises concurrent ingests of the same PR at the worktree
  level, now inside each Activity instead of around the old unsplit `ingestPR`.
- See `.claude/docs/blocks-and-ingest.md`; `ingest_test.go` skips itself when
  gh is unreachable.

## Actually approving/rejecting a PR on GitHub (`submit_review`)

Submits a **real GitHub PR-level review**, for the menu after approving the last
blocks (see `.claude/docs/command-palette.md`). Signal-less, one Execution per
request.

- **`Module.SubmitReview`** validates `event` against a fixed allowlist before
  the `gh api` call (per the validate-before-`exec` rule). `github.Fake` records
  `event`/`body` unconditionally — the allowlist lives only in the real module.
- **Body required when rejecting:** GitHub refuses a bodyless
  `REQUEST_CHANGES`. Deliberate choice: **hard reject** (400), no auto-generated
  body — the reviewer must justify it, and the frontend can enforce a required
  field. Validated by the pure `validateSubmitReview` **before** the workflow
  starts, so `gh` is never touched for an invalid request.
- **No best-effort swallow** here, unlike `postGithubComment`: a failed submit
  must reach the reviewer, so Activity failures propagate and
  `StartSubmitReview` turns a failed run into an error.
- Tests: `submit_review_test.go`.

## Draft → ready for review + reviewer picker (`ready_for_review` + `modules/reviewerusage`)

Flips a **draft** PR to ready and optionally requests reviewers, driven from the
PR-overview popover (see `.claude/docs/pr-overview.md`). Signal-less.

- **`modules/github`** got `ListCollaborators` (the candidate reviewers),
  `MarkReadyForReview` (GraphQL, via the existing `prNodeID`) and
  `RequestReviewers` (each login validated against `reReviewerLogin` before
  `exec`).
- **`modules/reviewerusage`** (`data/reviewerusage.db`,
  `reviewer_usage(repo, login, count)`) is the local "personal" usage store —
  nothing else writes it, so it only ever reflects reviewers assigned through
  this feature. `Bump` dedups a login within one call. Set on the manager
  **post-construction** (`mgr.reviewerusage = ru`) rather than as a
  `NewTaskManager` param, to avoid churning every existing test call site; a nil
  store makes the Activity a no-op, like the other module-guarded activities.
- **Workflow:** `markReadyForReview` → (only with reviewers) `requestReviewers`
  → `bumpReviewerUsage`. Deterministic — the Activity count is a function of the
  input's reviewer list.
- **`TaskManager.Reviewers`** merges collaborators with the usage counts and
  sorts most-used-first (ties + never-used fall back to alphabetical).
- Tests: `ready_for_review_test.go`,
  `modules/reviewerusage/reviewerusage_test.go`.

## Take myself off a PR (`remove_reviewer`)

Removes the **local** reviewer from a PR's requested reviewers, driven from the
last item of the PR-overview row popover ("Verwijder mij als reviewer", see
`.claude/docs/pr-overview.md`). Signal-less, one Activity, so replay is
trivially deterministic.

- **`modules/github.RemoveReviewer(pr, login)`** is the mirror image of
  `RequestReviewers`: the same `requested_reviewers` endpoint with `DELETE`
  instead of `POST`, login validated against `reReviewerLogin` before `exec`.
  Removing somebody who is not (or no longer) a requested reviewer is a no-op on
  GitHub's side.
- **`removeSelfAsReviewer`** resolves **who** to remove itself, from
  `TaskManager.CurrentUser` (the cached `gh api user`), and fails loudly when
  that login is unknown (offline / `SLASH_GITHUB=off`) rather than silently
  removing nobody. `RemoveReviewerInput` therefore carries only `PR` — a request
  can never name a different reviewer.
- Tests: `remove_reviewer_test.go`,
  `tests/overview-remove-reviewer.spec.mjs`.

## Surfacing failures (`run_errors.go` + `GET /api/problems`)

Background work here fails quietly by design: nearly every Activity talking to
GitHub/Claude/Jira is **best-effort** (it logs "skipped" and carries on, so a
transient hiccup never sinks a long-lived tracker), and the pollers/startup glue
aren't workflow runs at all. Both used to be visible only in the terminal the
server was started from. Two categories, both surfaced:

- **A workflow run that ended in `failed`** — durable, so `FailedRuns(limit)` is
  a pure read of `Runs()`/`Input()`/`Result()`. Note `Engine.Result` reports a
  failed run's recorded message **as its returned error**, which is the only
  readable form, so the row keeps `err.Error()` as its text. Deliberately
  **repo-wide**, which is why `RunsForPR` couldn't be reused: that filters on
  the input's `pr`, so a per-repo tracker structurally never appears there; here
  it shows with `pr: 0`. Capped at 50, newest-updated first, and limited to the
  last `problemWindow` (**four days**) — everything older is dropped from both
  halves, see "The global failed-tasks dialog (every page), and the four-day
  window" in `.claude/docs/pr-overview.md`. A failure that a
  **later attempt at the same task** took over is filtered out first
  (`supersededRuns`/`runIdentity`) — a tracker that failed and was replaced by a
  fresh `running`/`waiting` one is no longer news. Exception: a per-item
  deterministic Run ID (`perItemRunID`) is never superseded, because
  `startWorkflowID` is idempotent so a succeeded sibling must not hide it. (Such
  a run CAN be retried — a retry resumes it in place rather than starting a new
  Execution, see `Engine.ResumeFailed` in
  `.claude/docs/tembed-workflows.md`.) Full rules:
  "A failure that was later retried successfully drops out of the list" in
  `.claude/docs/pr-overview.md`.
  Historically the single most common entry here was
  `database is locked (5) (SQLITE_BUSY)` out of a module write (`save
  reaction`, `mark searching`, …). That was not contention worth reporting but
  a plain configuration bug: only `tembed`'s own store opened its DB with
  `busy_timeout`, while all 15 module stores used a bare
  `sql.Open("sqlite", path)` and therefore gave up on a locked DB
  **immediately** instead of waiting. Since a failed run is terminal
  (`SignalWorkflow` refuses one, so its thread can never accept a reply again),
  one unlucky poll landing on top of a reviewer's own write permanently broke
  that thread. Every module store now opens through **`modules/sqlitedsn`**
  (`sqlitedsn.DSN(path)` → `_pragma=busy_timeout(5000)`, matching tembed);
  a **new module must too** — the `add-module` template does it by default.
  The **blocks DB** (`openDB`, `db.go`) opens the same way for the same reason:
  an ingest/refresh Activity writes to it while a request reads. The only bare
  `sql.Open("sqlite", path)` calls left are two test helpers
  (`classify_test.go`, `warndismiss_test.go`), which build their own fixture DB
  rather than a production store.
- **The log mirror** — an in-memory **ring buffer** (100 lines) fed by wrapping
  **`TaskManager.logf`**, the single funnel every glue-level error already goes
  through, so one wrapper covers them all and a future call site is free.
  `problemMirrorLogger()` does the same for the engine's own lines via
  `tembed.WithLogger` (e.g. `run X uses unregistered workflow`, which only
  appears during `Recover`). Each entry keeps the full line plus two parsed
  hints: the subsystem prefix before the first `:` and the PR number from a
  `pr=<n>` fragment.
- **It is a log MIRROR, not a classifier.** Every `logf` site reports something
  skipped, so all of them go in and none is ranked — a severity filter would be
  guessing which failure the reviewer cares about.
- **Write boundary:** the buffer touches no module/read model/history and is
  lost on restart, so it falls under the same operational carve-out as the
  heartbeat map and `ingest_progress.go`. Anything that should survive a restart
  would have to be written by a workflow — a deliberate boundary, not an
  oversight.
- Tests: `run_errors_test.go`; rendering in `tests/overview-problems.spec.mjs`
  (see "Mislukte taken" in `.claude/docs/pr-overview.md`).

## Daily data cleanup (`cleanup` + per-module `Purge`)

Purges **all** data of a PR once it has been merged for more than 7 days.
`data/` is ~99.6% git worktrees (~300 MB per checkout), and a long-merged PR has
no reason to keep that disk, its workflow runs, or its read-model rows.
Signal-less, one Execution per run.

- **`cleanupMergedAge`** (7 days) is the retention window. The cutoff is
  computed **once** via `w.Now()` recorded through `SideEffect` (so replay
  reuses it) unless the input carries an explicit `Cutoff` — tests pin one that
  way instead of depending on wall-clock timing.
- **`resolveCleanupTargets`** (read-only):
  - **Candidates** are the **union** of `DISTINCT pr` from `blocks`, from
    `pr_ingest`, and any PR number found in a `worktrees/pr-<n>-…` directory
    name — not just the blocks table. That makes a half-finished previous pass
    (worktree gone but a stray row left, or vice versa) self-healing; it also
    covers a leftover `pr-<n>-chatshadow-<conversationId>` directory (see
    "claude_chat" in `.claude/docs/workflows-comments.md`) via the same
    `reWorktreeDir` regex.
  - **Eligibility** uses `PRMeta`'s **`MergedAt`** (empty when not merged): a PR
    is a target only if that is non-empty **and** parses **and** falls before
    the cutoff. A closed-without-merging PR is **never** touched. A gh hiccup,
    an unparsable timestamp, or a too-recent merge simply leaves it out —
    cleanup only removes data it's certain about.
- **`purgePR`**, called once per resolved target (so the call count is a
  function of the stored target list), removes for that PR:
  1. **Worktrees** — deregister via `git worktree remove --force` (best-effort,
     an already-broken directory just falls through) then `os.RemoveAll`, with a
     final best-effort `prune` sweep. By far the biggest disk win. Besides the
     fixed base/head pair, `removePRWorktrees` also prefix-scans for any
     `pr-<n>-chatshadow-*` directories of this PR (one per claude_chat
     conversation that used the Edit tool and never committed/pushed — normally
     already reclaimed right after a successful push, see
     `commitChatShadowEditsAt`) and removes each one the same way, plus its own
     dangling local `chat/<conversationId>` branch.
  2. **Workflow runs** — `deletePRWorkflowRuns` parses each run's stored input
     for a `"pr"` field, **exactly** as `RunsForPR` does, and calls
     `Engine.DeleteRun`. A per-repo tracker has no such field and is never
     touched.
  3. **Read-model rows** — `purgePRBlocks` (`blocks` + `pr_ingest` in one tx)
     plus `Purge(ctx, pr)` on every other store with a `pr` column (comments —
     one `DELETE`, relying on the same `reactions` cascade `Delete` already
     trusts —, approvals, relations, callresolve, testcovers, prmeta,
     explanations). There is no `ignore` module any more (removed), so
     nothing to purge there.
  Every dependency may be `nil` (a caller that doesn't wire a store skips it),
  and every delete is unconditional on `pr`/the path, so **re-running cleanup on
  the same PR is always a no-op** — the idempotency the daily trigger relies on.
- **Triggered two ways:** manually via its endpoint, and **once a day** by
  `StartCleanupScheduler(ctx)` (gated by `resumeRuntime`, so a CLI caller never
  starts it): a plain background goroutine with a 24h ticker — an immediate
  pass, then one per interval. **Deliberately NOT a durable `w.Sleep` loop
  inside the workflow** — don't convert it: (1) it's the shape every other
  periodic trigger here already uses; (2) cleanup has no reviewer heartbeat to
  piggyback on — it's unconditional maintenance, so the fast/slow cadence
  machinery doesn't apply; (3) it keeps the Workflow Type itself short and
  one-shot instead of an infinite-loop workflow sitting permanently `waiting` in
  `GET /api/workflows`.
- **Also purges orphaned runs of a permanently retired Workflow Type**
  (`purgeRetiredWorkflowRuns` + `retiredWorkflowTypes`), unconditionally, once
  per pass. When a type's registering code is removed (e.g. the old per-PR
  `ignore`, or `task_inbox`/`task_snooze` when the task-inbox page was removed
  outright), any still-`running`/`waiting` run becomes a permanent orphan that
  logs `uses unregistered workflow` on **every** start, forever.
  `retiredWorkflowTypes` is a small, **hand-maintained** map of names known to
  be gone — deliberately **not** "whatever is currently unregistered": the
  headless CLI registers only a subset on purpose, so that inference could
  delete a perfectly legitimate run just because the invoking binary doesn't
  register its type. A name belongs in the map only once its registering code is
  deleted. Since cleanup itself only runs in the server, the CLI never runs this
  purge either.
- **Also deletes the completed one-shots whose whole effect lives elsewhere**
  (`sweepDebugLogRuns` over `sweptOneShotTypes`, `cleanup.go`),
  unconditionally, once per pass and older than `debugLogRunAge` (1 hour).
  Two types are in that set: `debug_log` — debug mode starts one Execution per
  flushed batch of recorded events, so a debugging session leaves hundreds of
  run rows whose content is worthless the moment the lines are on disk — and
  `ignore_runs`, whose effect is the failed run it deleted (see
  `.claude/docs/tembed-endpoints.md`). The log FILE is deliberately never
  touched, and a **failed** run of either type is left in place so it stays
  visible in "Mislukte taken". See `.claude/docs/debug-mode.md`.
- **Also purges orphaned `task_code_comment` runs whose own comment is gone**
  (`purgeOrphanCommentRuns`, `cleanup.go`), unconditionally, once per pass —
  not scoped to the merged/age gate above or to any resolved PR target,
  mirroring the retired-workflow-run purge. Motivating case: 272 of 553
  waiting `task_code_comment` runs pointed at a comment that no longer existed
  in `comments.db` (deleted by some path other than this workflow's own
  `"delete"` Action, which deletes the comment AND completes the run in one
  step) — left alone, every server (re)start's `ResumePolling` walks every
  waiting run and spawns a `poll()` goroutine per thread that polls GitHub
  forever for a comment nobody can ever act on again.
  - **Detection reuses an existing identity, not a new field:** a
    `task_code_comment` run's own Run ID **is** its comment's `id` (every
    write path already keys a comment mutation as `{"id": runID}` — see
    `deleteComment`/`markCommentDeleting`/`editCommentBody`), so "is this run's
    comment gone" is exactly `comments.Get(ctx, r.ID)` returning `ok == false`.
    A `comments.Get` **error** (a DB hiccup, not "not found") leaves the run
    alone — same "only remove what's certain" spirit as
    `resolveCleanupTargets`.
  - **`StatusWaiting` is purged unconditionally, any age** — parked on
    `WaitSignal`, by definition not mid-flight, so there's no race to protect
    against.
  - **`StatusRunning` is purged only once stale** (`UpdatedAt` older than
    `orphanRunningAge`, 24h): a run can be transiently `running` at the exact
    moment this pass ticks, so an unconditional purge here could race a
    genuinely in-flight comment. Requiring staleness first turns that race
    into "can only ever purge a run that's clearly stuck", at the cost of a
    real such orphan surviving up to a day before it's swept — an accepted
    trade. Uses the real wall clock (`time.Now()`), which is fine: this
    function only ever runs inside an Activity body, never inside the
    Workflow function itself, so it's exempt from
    `.claude/rules/workflow-determinism.md`.
  - Runs of any other status (`completed`/`failed`) are left alone — already
    terminal, nothing to clean up.
  - `DeleteRun` (not a Signal): there is nothing left to signal about once the
    comment is already gone, so removing the run entirely (history + meta) is
    the sanctioned close, mirroring `purgeRetiredWorkflowRuns`.
  - `CleanupResult.OrphanCommentRunsDeleted` reports the count, alongside
    `RetiredRunsDeleted`.
- **`CleanupInput.ForcePRs` — a deliberate, CLI-only override** to purge
  specific PR numbers unconditionally, bypassing the merged/age gate, for a PR
  that can never pass the gate at all (no real GitHub PR to look up, e.g. a
  synthetic test number that landed in the live tree via an ad-hoc write — see
  "Playwright test infra" in `.claude/docs/testing-playwright.md`). Forced PRs
  are added straight to the target list without calling `PRMeta`, and skipped in
  the ordinary candidate walk so they're never added twice. Set only via
  `StartCleanupForce` → `slash cleanup -force <pr1,pr2>` — **deliberately not
  exposed over HTTP**, so there is no standing endpoint that can force-purge an
  arbitrary PR's data.
- Tests: `cleanup_test.go` (candidate discovery, all eligibility branches,
  force, full purge, idempotency, retired-run purge, orphan-comment-run purge
  incl. the `running`-status age threshold) — offline.
