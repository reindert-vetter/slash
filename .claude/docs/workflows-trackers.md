# Tracker & maintenance workflows

The long-lived per-PR/per-repo trackers (`pr_status`, `pr_inbox`, `approve`,
`ignore_comment`, `task_snooze`, `task_inbox`) plus the one-shot operational
workflows (`ingest`, `submit_review`, `ready_for_review`, `cleanup`) and how a
silent background failure still reaches the UI. Engine mechanics live in
`.claude/docs/tembed-workflows.md`, endpoints in
`.claude/docs/tembed-endpoints.md`.

## `pr_status` (per PR): metadata, merge detection, ingest refresh

One Execution per PR that receives `state` Signals from the pollers and
**completes** once the PR is merged/closed — the durable source of truth the
pollers read to stop. `ensurePRStatus(pr)` starts/reuses one per PR, also after
a restart.

**On start** it runs three Activities in sequence, each with its own targeted
read-model write, so the UI can render **progressively** instead of waiting for
everything (see "Progressive loading" in `.claude/docs/detail-layout.md`):

1. **`fetchPRBasics`** — `PRMeta` (title/URL/body/author/diff-stats/head-ref,
   best-effort), derives a Jira key from the title (`\b([A-Z][A-Z0-9]+-\d+)\b`,
   same regex as the frontend) and fetches that ticket (best-effort), then
   `prmeta.SaveBasics`.
2. **`generatePRSummary`** — prompts Haiku (context-only) with the stored basics
   + the distinct changed files from `blocks` + the Jira ticket for a 2-4
   sentence summary → `prmeta.SaveSummary`.
3. **`fetchPRStatuses`** — reuses the inbox status query (`statusesFor`) for
   this one PR → `prmeta.SaveStatuses`. GitHub's rollup gives only a total + an
   overall state, so `checksPassed` is `checksTotal` on `SUCCESS` and otherwise
   0 — enough for a pill, not an exact count.

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
- **An approval stores no text**, only indices — which is why the pass needs the
  PREVIOUS sides. `refreshIngestDelta` therefore reports
  `PrevBaseSHA`/`PrevHeadSHA`/`ChangedFiles` on its result (reading them back
  afterwards is impossible — the refresh has overwritten `pr_ingest` — and
  wouldn't be replay-safe), and `planReanchor` materialises those two revisions
  of just the touched paths into a throwaway **shadow worktree pair**
  (`git show <sha>:<path>`, stdout only — `runGit`'s `CombinedOutput` would
  splice stderr into the file content) so `blockAlignedRows` can be reused
  verbatim on a historical revision. The real head worktree is no help: it has
  already been checked out to the new SHA.
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
stays compact. `EnsureInbox` starts/reuses one per repo and does a synchronous
first refresh at startup. See `.claude/docs/pr-overview.md`.

## Persisting reviewer approval (`approve` + `modules/approvals`)

One Execution per PR, making approval durable across a refresh.

- **`modules/approvals`** (`data/approvals.db`):
  `approvals(pr, block_id, rows, calls)` with the arrays as JSON — the
  client-side `b.approvedRows`/`b.approvedCalls`. `Replace` is a full swap per
  block and an **empty** set removes the row → replay-safe.
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
  ignored comment of every purged PR with no way to find it again. This is the
  one deliberate difference from the otherwise identical `task_snooze` mould,
  which has no such hook.
- **A plain on/off flag, no expiry** — unlike `task_snooze`'s `Until`.
  "Ignored" belongs with "resolved"/"approved" (reviewer decisions that never
  lapse by themselves), not with "snoozed", which is temporary by definition.
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

## Snoozing a task (`task_snooze` + `modules/tasksnooze`)

One Execution per **repo** (mould of `approve`), making "hide this **task** from
`/inbox`" durable. Purely local — no network, so no `SLASH_*=off` gating. Unlike
the removed per-PR `ignore` feature this is keyed on a generic **task id**
(`pr:<n>`/`comment:<runId>`/`jira:<KEY>`), since a task isn't always a PR.

- **`modules/tasksnooze`** (`data/tasksnooze.db`, `snoozes(task_id, until)`):
  `until` is an **absolute Unix-ms expiry** (`0` = forever). `Set` upserts, or —
  when **`until < 0`** — deletes the row (un-snooze). `List` does **not** filter
  on expiry: "is it still snoozed?" is checked at **read time** in the UI
  (`until === 0 || until > Date.now()`).
- **Workflow:** a loop on `snooze` (`SnoozeSignal{TaskID, Until, Clear}`), one
  `saveTaskSnooze` Activity per signal. **Deterministic without a clock:** the
  UI computes the absolute `Until` (browser-local) and sends it, so the body
  never reads `w.Now()`. Never completes. `EnsureTaskSnooze()` starts/reuses it
  at startup; unlike the inbox trackers it has **no poller** — it only ever
  reacts to UI signals.
- **Frontend:** see `.claude/docs/task-inbox-page.md`.
- Tests: `modules/tasksnooze/tasksnooze_test.go`, `task_snooze_test.go`.

## The task inbox: `task_inbox` + `modules/taskinbox` (aggregation)

A "task" is **derived, not stored** — it has no table of its own. Three
independent sources yield candidates; `buildTaskInbox`
(`taskinbox_analysis.go`) merges and scores them into one flat list, which the
`task_inbox` workflow (exact mirror of `pr_inbox`: one Execution per repo, a
`refresh` Signal drives one Activity, never completes) full-swaps into the
`taskinbox` read model. The `/inbox` page combines that with the `task_snooze`
read model to hide snoozed tasks.

- **Source A — `pr_review`** (id `pr:<n>`): open PRs where you're a reviewer.
  Reuses `pr_inbox`'s existing "Needs your review" section — no separate GitHub
  query.
- **Source B — `comment_unread`** (id `comment:<commentID>`): for every
  **other** open PR you authored (the remaining `author:@me state:open`
  sections, named in `myOpenPRSectionTitles` — together with source A's they
  exhaust that query, since `buildInbox`'s cross-section de-dupe puts a PR in
  only its first matching section), every thread whose **last message** isn't
  yours and whose status isn't `resolved`. A `comments.Comment` **is** the
  thread root and its `Reactions` are the replies, so `unreadCommentCandidates`
  compares the root's author/time against the last reaction's.
- **Source C — `jira`** (id `jira:<KEY>`): every issue assigned to you,
  regardless of status, via `jira.AssignedToMe`.
- **Scoring** (pure, table-driven): each kind has a `baseScore` (pr_review 20,
  comment_unread 20, jira 10) plus `pointRules` — small
  `{ID, Kind, Eval(taskSignals)}` entries summed by `computeTaskPoints` into a
  total + a `[]PointNote` breakdown that always starts with a `"basis"` note, so
  the base score is never silently hidden. Adding a rule is one table entry.
  Current rules: `ci_failing` (+10), `pr_aging` (+10, open > 3 days — the same
  threshold as the `ouder-3-dagen` preset, read from a plain `createdAt` field
  rather than a gh search qualifier), `changes_requested` (+10),
  `comment_aging` (+10/day unanswered, capped +30 — day 0 doesn't count, it only
  just became unread), `jira_active` (+10, status not Backlog/To Do —
  `isJiraActive` matches on the status **name**, case-insensitively, not the
  statusCategory key, since that taxonomy differs per project).
- **`modules/taskinbox`** (`data/taskinbox.db`): `tasks(id, kind, title,
  subtitle, points, point_notes, pr, url, detail, updated_at)` —
  `point_notes`/`detail` are opaque JSON whose shape the main package owns per
  `kind`. `Replace` is a full swap (a derived list, no incremental
  maintenance); sorting is left to the frontend.
- **Best-effort per source:** a failed `buildInboxSnapshot` skips A+B for that
  round (C still runs), a failed Jira/comments read is swallowed — "skip only
  the failing source" rather than the whole refresh.
- **Login resolution reuses `snap.GeneratedFor`, never `ghLogin` directly:**
  `ghLogin` always shells out to the real `gh`, so reading the already-resolved
  login off the snapshot keeps a `SLASH_GITHUB=off` test from touching `gh` even
  indirectly.
- **Open point:** the `acli jira workitem search` invocation was verified
  interactively against a real, authenticated `acli` (see `AssignedToMe`'s doc
  comment for the exact call + sample output), so it's confirmed, not guessed.
  Still open for a differently-configured `acli`: whether the default
  `order by updated desc` and the `--limit 100` cap need tuning. No test depends
  on live `acli`.
- **Frontend:** see `.claude/docs/task-inbox-page.md`.
- Tests: `modules/jira/jira_test.go`, `modules/taskinbox/taskinbox_test.go`,
  `taskinbox_analysis_test.go`, `workflows_test.go`'s
  `TestTaskInboxRefreshPopulatesReadModel`, `tests/inbox-tasks.spec.mjs` — all
  offline.

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
  it shows with `pr: 0`. Capped at 50, newest-updated first.
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
     explanations). There is no `ignore` module any more (replaced by
     `task_snooze`), so nothing to purge there.
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
  `ignore`), any still-`running`/`waiting` run becomes a permanent orphan that
  logs `uses unregistered workflow` on **every** start, forever.
  `retiredWorkflowTypes` is a small, **hand-maintained** map of names known to
  be gone — deliberately **not** "whatever is currently unregistered": the
  headless CLI registers only a subset on purpose, so that inference could
  delete a perfectly legitimate run just because the invoking binary doesn't
  register its type. A name belongs in the map only once its registering code is
  deleted. Since cleanup itself only runs in the server, the CLI never runs this
  purge either.
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
  force, full purge, idempotency, retired-run purge) — offline.
