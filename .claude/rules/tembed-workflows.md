# Tembed: durable workflows (`tembed/`)

`tembed/` is an **embeddable durable-workflow engine** — "Temporal, but a Go
package". It lives as a **git subtree** (prefix `tembed/`) and is at the same
time its own module (`github.com/reindert-vetter/tembed`), so other projects can
import it standalone. **`tembed/` is deliberately abstract** — it knows nothing
about PRs, blocks, or gh; keep it that way.

- **Subtree flow:** `git subtree add --prefix=tembed <url> main --squash`, push
  back with `git subtree push`, update with `git subtree pull`. slash imports it
  via a `replace … => ./tembed` in `go.mod`.
- **Core:** append-only event history per run; the workflow function is re-run
  **from the beginning** against that history. An activity whose result is
  already recorded returns the stored value (so it runs once); a `WaitSignal`
  without its signal yields, is persisted as `waiting`, and is driven again when
  the signal/timer arrives. Hence **workflow code must be deterministic** — all
  non-determinism goes through the `*Workflow` handle (`ExecuteActivity`,
  `WaitSignal`, `Sleep`, `SideEffect`, `Now`). See
  `.claude/rules/workflow-determinism.md`.
- **Signals** are buffered (one arriving before its `WaitSignal` waits);
  **timers** (`Sleep`) are durable and rescheduled on `Recover`.
- **`StartWorkflowID(id, name, input)`** takes the Run ID from the caller and is
  **idempotent**: an existing run with that `id` is a no-op reuse (existing
  input untouched), checked under the run lock. This lets glue derive a
  deterministic Run ID from an external key (`gh-<commentID>`, `explainRunID`,
  `resolveCallRunID`) so a repeated poll or a restart never creates a second
  Execution. The id comes from glue, not from the workflow body, so the body
  stays deterministic.
- **`Engine.DeleteRun(runID)`** removes a run (events + meta) from every store;
  deleting an unknown id is a **no-op, not an error** — the idempotency the
  `cleanup` pass relies on. It also drops any pending timer for that run.
- **Storage** via `Store`: `MemoryStore`, `JSONLStore` (one readable file per
  run), `SQLiteStore` (pure-Go `modernc.org/sqlite`), and `MultiStore` to
  combine them. slash runs `MultiStore(SQLite data/workflows.db, JSONL
  data/workflows/)`, so a comment lives both in history and as jsonl.
- **Recovery:** `engine.Recover()` at startup re-drives every
  `running`/`waiting` run — **prioritised**, see below.
- Tests: `tembed/*_test.go`.

Endpoints (starts, signals, read models) live in
**`.claude/rules/tembed-endpoints.md`** — this file describes what each workflow
does, that one how it is reached.

## Recovery priority (don't let slow LLM work block startup)

`advance()` runs an activity **inline** when its result isn't in history, and
`Recover()` re-drives every mid-flight run at startup. So a run killed
**mid-activity** re-executes that activity live on recovery — and for the LLM
workflows (`resolve_call` makes one `claude` call per unresolved call;
`code_warning` a whole agentic Opus pass) that is dozens of ~30s subprocess
calls, serially, on the startup goroutine *before* `ListenAndServe`. That once
wedged the server entirely. Hence a **priority** mechanism (still abstract — it
knows nothing about LLMs):

- **`Priority`** — Low/Normal/High. Affects **only** recovery; live
  `StartWorkflow`/`SignalWorkflow` are unaffected.
- **`SetWorkflowPriority(name, p)`** — Normal/High runs are re-driven
  synchronously (High first); **Low** runs drain on a **single** background
  goroutine (serially, to avoid a herd of subprocess calls), covered by `Wait()`.
  slash marks the pure-LLM types Low: `resolve_call`, `resolve_test_covers`,
  `explain_code`, `code_warning`.
- **`SetActivityPriority(name, p)`** — for a workflow that is otherwise fast but
  has one slow LLM step: during synchronous recovery, a Normal/High run that
  replays into a **live** `PriorityLow` activity yields to the background at
  that point (nothing recorded, so the background re-drive replays to the same
  point — still deterministic). slash marks **`generatePRSummary`** Low so a
  pr_status run killed mid-summary doesn't block startup, without demoting the
  whole merge-detection/ingest-refresh workflow.
- **`StartWorkflowDeferLow(name, input)`** — the same deferral for a fresh
  fire-and-forget start: run the fast leading activities, then yield at the
  first live Low activity. `ensurePRStatus` uses it so startup returns after
  stage 1 instead of blocking on the Haiku summary (the UI polls for the rest).
  With no live Low activity it behaves exactly like `StartWorkflow`.

## Hard rule: only workflows mutate state

**Workflows are the only writers.** State changes exclusively through a Workflow
Execution; everything else is read-only from the outside:

- **Modules** (`modules/*`) are "the things that can happen inside a workflow".
  Their write methods (`Save`, `AddReaction`, `PostReviewComment`, …) are called
  **only** from an Activity; their read methods feed the UI.
- The **HTTP API** writes only via workflow endpoints (start or signal);
  everything else, and the **UI**, is read-only.
- Why: the event history is the source of truth (durable, replayable, survives a
  restart). A module table is a derived read model.

See `.claude/rules/workflows-write-boundary.md` and
`.claude/rules/workflow-determinism.md`.

## The first slash task: `task_code_comment` (`workflows.go` + `modules/`)

Placing a comment on a line of code and keeping the thread alive. A **Workflow
Type** `task_code_comment`, one Execution per comment, whose **Run ID is the
comment id**.

**Flow:** `saveComment` + `postGithubComment` (best-effort), then a loop on
`reply` Signals. A reaction arrives from the UI **and** from a per-thread
poller, both as the same Signal; every reaction is stored, a UI reaction is
mirrored to GitHub, and `Done`/`/resolve` closes the thread.

### The three modules it drives

- **`modules/comments`** (`data/comments.db`, tables `comments`/`reactions`):
  counts reactions and sets `status` to `resolved` on `/resolve`.
  Each comment also stores:
  - **the code fragment it hangs on** (`code`/`gran`/`label`) — the exact
    navigation unit at placing time, so the thread shows the same code as the
    composer did (shared `composeTargetHint` box in `RelatedPanel.mjs`). No
    `code` (old/seeded comment) → no frame.
  - **its navigation anchor** (`row_start`/`row_end`/`seg`): the aligned-row
    range within the block plus, for a `call`, the segment key. That is what
    lets `RelatedPanel` scope the comment index to the selected block **and**
    the selected unit (call ⊂ line ⊂ group ⊂ block). `row_start -1` is the
    established "block known, row unknown" convention.
  - **a hierarchical path**, built deterministically by `commentPath` from input
    + Run ID: `/pr-<pr>/<file>/<label>/<codeRef>/comment-<id>` (`file` keeps its
    slashes so a directory prefix matches; `codeRef` = `group-5-9`/`line-7`/
    `call-7-<seg>`). A **prefix match** therefore scopes to a PR, file, block or
    unit — `comments.Search(prefix)` behind `GET /api/comments?path=`.
  - **`github_id`** — its own GitHub review-comment database id, once known: set
    immediately for an imported comment (`= ImportedRootID`), and for a normal
    in-app comment once `postGithubComment` completes. Persisted by a
    **`saveCommentGithubID`** Activity called **unconditionally** right after the
    import/local/normal switch, so the number of Activities depends on the input
    shape, not on whether the post happened to succeed (replay-determinism); the
    Activity is a no-op for `id <= 0` (local note, or a post that failed). The
    frontend uses it for the comment menu's "Open op GitHub"
    (`#discussion_r<id>`), falling back for pre-`github_id` rows to parsing the
    `gh-<id>` shape of an imported run's Run ID — that fallback only ever covers
    `source === 'github'`.

  The **thread** opens with the comment itself as its first message:
  `threadMessages(c)` = a synthetic opening (`{source:'ui', body:c.body}`) plus
  `c.reactions`, and the keyboard cursor counts that opening, so `↑` reaches it.
- **`modules/github`** (`gh api`): `PostReviewComment`, `PostIssueComment`,
  `Reply`, `FetchReplies`, `FetchReviewComments`, `FetchGeneralComments`,
  `PRState`, `PRMeta`, `DeleteComment`, `ResolveReviewThread`, `MarkFileViewed`,
  `SubmitReview`, `ListCollaborators`, `MarkReadyForReview`,
  `RequestReviewers`, `UsersByLogin`, `CurrentUser`. Interface +
  `github.Fake` for tests; **`SLASH_GITHUB=off`** → the Fake.
- **`modules/jira`** via the local `acli` CLI: `Issue(key)` (the `key` is
  validated against `^[A-Z][A-Z0-9]+-\d+$` before `exec`) flattens the ADF
  `description` tree into plain text; `AssignedToMe` for the task inbox.
  **`SLASH_JIRA=off`** → `jira.Fake`.

**Each CLI-bridge module enforces its own default `exec.CommandContext`
deadline, never relying solely on the caller** — a hung subprocess (e.g. `acli`
waiting on an interactive re-auth prompt with no TTY) would otherwise block that
run *and every later Signal on it* forever, since signalling drives Activities
inline. See the `cliTimeout` doc comment in `modules/jira/jira.go` (referenced
from `modules/github/github.go`) and `contextTimeout`/`agenticTimeout` in
`modules/claude/claude.go`.

### Anchoring a comment to GitHub

`CodeCommentInput` carries `StartLine`/`EndLine`/`Side`/`Segment` besides
`Line`. `postGithubComment`: `Side` is `RIGHT` (new/context, the default) or
`LEFT` (a removed line); `StartLine < EndLine` posts a **multi-line range**
(`start_line`..`line`, GitHub's requirement), otherwise single-line at `EndLine`
(falling back to `Line` when both are 0 — older callers). For `Gran == "call"`
with a `Segment`, the body **posted to GitHub** is prefixed with the segment as
a code span; the **stored** comment stays the raw `Body`. All input-driven, so
deterministic.

Frontend: `commentTarget()` (`home.mjs`) computes those four fields from the
current unit instead of sending `b.line`. `unitLineRange` counts aligned rows
from `b.code.new.start`/`old.start` (aligned rows carry no line numbers; a
filler row on the other side doesn't count) to get `startLine`/`endLine` +
`side` (`RIGHT` as soon as one row has a `right`, else `LEFT`); with code not
loaded it falls back to `{0,0,'RIGHT'}` and the backend falls back to `Line`.
`unitSegment` yields the underlined segment text for a `call` unit. There is
exactly **one** place that posts (`createComment`), reached by every composer
flow via `placeComment`, so every flow gets the same anchoring.

**`commentTarget()` follows `focusedBlock()`, not always the top-level
`curBlock()`:** in a drilled column the reference code must be that column's
block + its own `drillCursor` cursor. The `commentScope` watch must therefore
list `state.focusLevel`/`drill`/`drillCursor` **inline** in its deps, else the
comment index stays scoped to the pre-drill block (see the watch-inline-deps
rule in `conventions.md`). Test: `tests/drill-comment-target.spec.mjs`.

### Private note (`local` flag)

`Local` on the input — sent by "Alleen voor mijzelf" — makes the workflow
**skip `postGithubComment`**. Replay-safe because the number of Activities
depends on the input, not on live state. `posted.RootID` stays 0, so no poller
starts and the existing `RootID == 0` guards make `deleteGithubComment`/
`replyGithub` no-ops: reacting to or deleting a private note never touches
GitHub.

### Poller cadence (heartbeat-driven)

The poller checks GitHub on a **fast** cadence (`pollInterval`, 1 min) as long
as a **heartbeat** arrived within `heartbeatWindow` (10 min) — the UI pings the
task you're viewing, but only on **real activity** (tab visible **and** focused
**and** input within `ACTIVITY_WINDOW`, 2 min), so an abandoned tab stops
heartbeating by itself. Without a recent heartbeat it drops to
`idlePollInterval` (10 min), and **only** on that slow cadence does it also
check whether the PR is merged/closed and stop. The poller wakes on the fast
tick but gates the actual GitHub calls on the desired cadence, so a heartbeat
mid-idle switches back to fast immediately.

## `pr_status` (per PR): metadata, merge detection, ingest refresh

One Execution per PR that receives `state` Signals from the pollers and
**completes** once the PR is merged/closed — the durable source of truth the
pollers read to stop. `ensurePRStatus(pr)` starts/reuses one per PR, also after
a restart.

**On start** it runs three Activities in sequence, each with its own targeted
read-model write, so the UI can render **progressively** instead of waiting for
everything (see "Progressive loading" in `.claude/rules/detail-layout.md`):

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

Since this feature the same `state`-Signal loop also processes **new commits**,
so a reviewer needn't re-ingest by hand after every push. `PRStateSignal`
carries `BaseSHA`/`HeadSHA` besides `State` (both variants ride on the one
signal name): `State` set = a lifecycle observation; `State` empty + `HeadSHA`
set = a refresh request.

- **`pollIngestRefresh`** (its own loop, same heartbeat cadence) compares the
  live `headRefOid` against the stored `pr_ingest` row and signals on a
  difference. The per-thread comment heartbeat only fires with a thread open, so
  `home.mjs` separately pings the `pr_status` Run ID every 60s while the PR page
  is visible+focused (operational, no state).
- **`refreshIngestDelta` Activity** (`ingest.go`) diffs the **previously
  stored** head SHA against the new one (`changedFileNames`) and rescans only
  those files, writing via **`upsertPRFileBlocks`** (a DELETE+INSERT scoped to
  those paths) so every other file's blocks — and everything hanging off their
  **stable** block id in the separate comments/approvals/callresolve stores —
  stays untouched. The head worktree is updated **in place**
  (`git checkout --detach`, falling back to the hard rebuild) instead of
  remove+recreate, which was fine for an occasional manual ingest but too heavy
  for a per-minute cadence.
  - **`--no-renames` is load-bearing:** with rename detection on, `--name-only`
    reports only the **new** path, so the old path drops out of the delta and
    `upsertPRFileBlocks`' `DELETE … WHERE file IN (…)` can never reach it —
    seen in practice as permanently orphaned blocks for a directory renamed
    mid-PR. With `--no-renames` a rename yields both paths and the old one is
    cleaned up like any other removal.
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
✓. Neither was repairable by hand. Hence `reanchorAfterRefresh` +
`reanchor.go`, run **before** the relations rebuild.

- **A comment carries its own code snapshot** (`comments.Code`, built from whole
  aligned rows), so re-anchoring is a search for that snippet in the new rows,
  **whitespace-insensitively** (`wsKey`, the same way `diffLines` pairs lines,
  so a pure re-indent still matches). Blank/filler rows are skipped inside a
  multi-line match.
- **An approval stores no text**, only indices — which is why the pass needs the
  PREVIOUS sides. `refreshIngestDelta` therefore reports
  `PrevBaseSHA`/`PrevHeadSHA`/`ChangedFiles` on its result (it already computed
  all three; reading them back afterwards is impossible — the refresh has
  overwritten `pr_ingest` — and wouldn't be replay-safe), and `planReanchor`
  materialises those two revisions of just the touched paths into a throwaway
  **shadow worktree pair** (`git show <sha>:<path>`, stdout only — `runGit`'s
  `CombinedOutput` would splice stderr into the file content) so
  `blockAlignedRows` can be reused verbatim on a historical revision. The real
  head worktree is no help: it has already been checked out to the new SHA.
- **It degrades instead of guessing.** No match, or several (a snippet like a
  bare `}` recurs) → the comment **unpins** to `row_start -1`, so it shows
  anywhere in its block and claims no 💬 row. Symbol gone entirely →
  **`AnchorOrphan`**, keeping the old rows as a record. An approved row whose
  text can't be found unambiguously is **dropped** — the reviewer did not
  approve what replaced it, and "unapproved again" needs no new state.
- **A narrower second pass, `contextRemap`, recovers a subset of those dropped
  approval rows:** a row whose text repeats within the block but whose immediate
  neighbour(s) still corroborate it. Found via a real report — a try/catch block
  with two near-identical `return [...]` arrays lost over half its rows on every
  refresh even when none of that code changed.
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
    texts: an LCS resolves duplicates by relative **order**, so a genuine
    reordering looks exactly like "Nth maps to Nth" and would silently reattach
    an approval to code the reviewer never reviewed in its new place. A dropped
    approval they redo is better than a wrong ✓.
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
  number of Signal sends in the body (replay-safe only *because* driven off a
  recorded result); one Activity is simply a fixed history position. Best-effort
  per anchor — a comment whose Execution already completed can't be signalled,
  and that must not sink the rest of the pass.
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
  `.claude/rules/detail-layout.md` for how an orphan stays reachable.
- Tests: `reanchor_test.go`, `blockstats_test.go`'s
  `TestRowForLineSharesRowSpaceWithApproveTotal`,
  `tests/comment-orphan-anchor.spec.mjs`.

## `pr_inbox` (per repo)

The **only** workflow that reads GitHub for the overview: a `refresh` Signal
(from the UI on load and from `pollInbox` on the heartbeat cadence) drives the
`refreshInbox` Activity, which fetches the inbox and writes it into the `inbox`
read model, returning only a small summary so the endlessly-refreshing history
stays compact. `EnsureInbox` starts/reuses one per repo and does a synchronous
first refresh at startup. See `.claude/rules/pages-and-routing.md`.

## Importing existing GitHub comments (living threads)

Comments placed **outside the app** (or before ingest) are pulled in as **full,
living threads** — replying mirrors to GitHub, GitHub replies are polled in —
not read-only copies.

- **Fetch:** `FetchReviewComments` returns the diff review **thread roots**
  (`in_reply_to_id == 0`, paginated); `FetchGeneralComments` the **PR-wide**
  ones without a file:line — the issue conversation (`Kind issue`) and the
  non-empty bodies of submitted reviews (`Kind review_summary`). Replies to an
  imported root then arrive via the existing `FetchReplies` path.
- **Mapping (`comment_import.go`,** reads the worktrees, so a read-only side
  effect like `blockstats.go`): `mapReviewComment` maps `file:line(+side)` to a
  block + aligned-row anchor in **exactly the same index space** as
  approvals/app comments (`dedent4` → `alignRows` + `rowForLine`). Block + row
  found → a normal line comment (`Kind ""`); block but not the exact row →
  `RowStart -1`; **no** block → PR-wide (`Kind "review"`).
  `mapGeneralComment` is always anchorless. All carry
  `ImportedRootID`/`Source "github"`/`Author`/`CreatedAt` (the original GitHub
  timestamp). A LEFT-side comment matches its block via the **old** source range
  (base worktree), since the stored lines are head coordinates.
- **Workflow branch:** the posting choice is input-driven (so
  replay-deterministic) in four cases:
  - **imported** (`ImportedRootID != 0`) → skip posting but set
    `posted.RootID = ImportedRootID`, so the reply poller runs and UI replies
    mirror to the real thread — never re-post.
  - **local** → `RootID 0`, all GitHub calls no-op.
  - **PR-wide, freshly created** (`isPRWide(Kind)`, not imported, not local —
    the case `convertPrWideWarningToComment` introduced) → post as a new
    **issue** comment (`postGithubIssueComment`, best-effort, never returns a Go
    error), since a PR-wide comment has no reply thread and no file:line
    guaranteed to still be covered by the diff; a plain `postGithubComment`
    attempt would often just fail, which — unlike the reactions loop's
    best-effort mirrors — would abort the whole workflow.
  - **normal** → post as a review comment + record `RootID`.
- **Reply loop per thread kind** (`isPRWide(kind)` =
  `issue`/`review_summary`/`review`): echo prevention unchanged (only
  `Source == "ui"` mirrors out), but the mirror path differs.
  - **Review-diff thread** (`Kind ""`): a real body mirrors as a review reply. A
    resolve (`Done`) also resolves the conversation **on GitHub**
    (`resolveGithubThread` → `ResolveReviewThread`, which looks up the thread
    node id from the root comment's `databaseId` and runs the
    `resolveReviewThread` mutation). The **`"/resolve"` sentinel body is never
    posted as text** — the loop only posts a non-empty, non-sentinel body, then
    (if `Done`) resolves. Determinism holds: the number of Activities depends
    purely on the Signal input.
  - **PR-wide thread**: no reply thread exists on GitHub, so a reply is mirrored
    as a **new issue comment** (the Activity returns the new id so it lands in
    history, for the dedup below). A resolve is **local only** — GitHub has no
    concept for it, so the workflow never calls out (`if !r.Done`).
- **Dedup against the app's own comments (`knownGithubIDs`):** the import
  fetches **all** roots, including ones the app placed itself (whose run has no
  `gh-<id>` Run ID, so `StartWorkflowID` idempotency doesn't catch them).
  `knownGithubIDs(pr)` scans every `task_code_comment` run of the PR for
  `input.ImportedRootID` + every post result in its history and the importer
  skips a known id. All durable, so restart-safe; O(runs), like `ResumePolling`.
- **Importer glue + poller:** `importPRComments` reads the blocks, fetches both
  comment kinds, maps them, and starts one Execution per comment with
  `StartWorkflowID("gh-<id>", …)` — the **only** write, made idempotent by that
  deterministic id. `pollImportComments` runs one import immediately and then on
  the heartbeat cadence, stopping once `pr_status` is done. For each imported
  **review-diff** thread it starts the per-thread reply `poll`; an in-memory
  `importPolled` set prevents a second poller per run.
- **Restart:** an imported thread's root id lives in the **input**, not in a
  post event, so `ResumePolling` reads it from there.
- **Reply dedup relies on the DB, not the poller's `seen` map:** that map is a
  speed cache that starts empty on restart, which is safe because `AddReaction`
  does an `INSERT OR IGNORE` on the reaction id (`gh-<id>`) and only bumps the
  count for a genuinely new row. Keep that contract intact.
- **The avatar-backfill glue checks the run's `Status` BEFORE attempting its
  `avatar` Signal** and skips silently on `failed`/`completed`. A terminal run
  can never accept a Signal again, and without this check a permanently failed
  thread (e.g. a `SQLITE_BUSY` during `saveReaction`) was retried on every
  restart forever — `avatarTried` only dedups within one process. Test:
  `TestImportSkipsAvatarBackfillOnFailedRun`.
- **Read model:** `Source` (`ui`/`github`) + `Kind` columns; `GET /api/comments`
  serves imported comments automatically, no new endpoint. The frontend badges
  `source: github` and renders PR-wide comments as their own navigable index
  rows (see `.claude/rules/detail-layout.md`).
- Tests: `comment_import_test.go`, `modules/comments/comments_test.go`,
  `tembed/engine_test.go` (`StartWorkflowID` idempotency).

## Relations between blocks (`build_relations` + `modules/relations`)

One Execution per PR, deriving **many-to-many relations** between blocks — the
call-graph edges, but meaning-driven instead of textual. The first `kind`,
**`event_listener`**: a changed block that dispatches an event becomes the
**parent** of the `Listener::handle` for it, **provided that handle is itself
also changed** in this PR (both sides must change for a link).

- **`modules/relations`** (`data/relations.db`):
  `relations(pr, parent_id, child_id, kind, line)`, block id =
  `<pr>:<file>:<symbol>`. `line` is the **absolute source line within the
  parent's own text** where the detector found the trigger; the frontend uses it
  to reorder the Underlying-code panel around the selected `group` unit (see
  `groupLineRange` in `home.mjs`). `0` = a row from before the field existed.
  `Replace(pr, rels)` is a full swap per PR (so replay-safe); `kind` keeps the
  table open for later types.
- **Analysis service `relations.go`** (package main, not a module — it reads the
  head worktree) runs a list of **detectors**. The event→listener map comes from
  three sources unioned: the `handle(EventType $e)` type hint, a `$listen` array
  in a `*ServiceProvider.php`, and `Event::listen(...)` calls; dispatch sites are
  scanned per block body. `blockText(headDir, b)` returns the full `codeSide`
  (text + the absolute start line of a **fresh** scan, not `b`'s possibly stale
  `Line`), and each detector converts its regex match offset to an absolute line
  via `matchLine`.
- **`providerListenerDetector` is the mirror of `eventListenerDetector`:** the
  latter only finds a parent via a **dispatch site**, so a ServiceProvider that
  only *registers* never became a parent even when its own `$listen` entry for a
  changed listener changed. This one scans a changed `<class-header>` block of a
  `*ServiceProvider.php` with the same regexes and makes the provider the parent
  (still `KindEventListener` — the child is still "the listener", regardless of
  dispatch vs. register). Still both-changed.
- **Laravel request chain** — five more kinds, all **both-changed**, so the
  highest level that *does* change automatically becomes the tree root (relation
  children sort to the bottom of the left list). The head worktree may be read
  freely for the mapping. Middleware is **deliberately out of scope**. Shared
  helpers: `blockIndex`, `blockText`, `edgeEmitter` (dedup).
  - **`route_controller`** — a changed route file (whole-file `ROUTE` block) →
    the changed controller methods it calls: array-callable, string-callable
    `'Ns\X@m'` (namespace ignored via `shortName`), and resource routes →
    **every** changed CONTROLLER method of that class.
  - **`controller_request`** — controller method → the changed `XRequest` block
    from a type-hinted parameter → all changed REQUEST methods of that class.
  - **`controller_resource`** — → the changed API Resource it builds/returns
    (`new XResource(`, `XResource::make|collection(`, `): XResource`).
  - **`controller_model`** — → the changed route-model-bound `Model` from a
    type-hinted parameter, filtered on the MODEL category so
    Request/Resource/interfaces drop out → **all** changed methods of that class
    (agreed granularity: a model param names a class, not a method).
  - **`request_policy`** — a changed `FormRequest::authorize` → the Policy
    method it checks (`->can('ability', XPolicy::class)`, ability = method). A
    `Model::class` ref resolves via the `$policies` map in a `*ServiceProvider`,
    with the `{Model}Policy` convention as fallback. `POLICY` is its own
    category; `isPolicyBlock` falls back to path/suffix so a not-yet-re-ingested
    block also matches.
- **Workflow:** runs `buildRelations` once at start and again on every
  **`rebuild`** Signal. `EnsureRelations(ctx, pr)` starts/reuses one per PR and
  is called by `handleIngest` after a successful ingest.
- Block JSON carries a computed **`id`** so the frontend can match
  `parentId`/`childId`.
- **Frontend:** `home.mjs` loads relations in `loadBlocks` and splits
  `state.blocks` (top-level = `allBlocks` minus children) from
  `state.allBlocks`; children render in the Underlying-code card. `childrenOf`
  carries the relation `kind` per child so `KIND_LABEL` names the **child's role
  as seen from its parent** (`route_controller`→"controller", etc.). The chain
  nests for free via drilling.
- Tests: `relations_test.go`, `tests/relations.spec.mjs` (seeded via
  `slash seed -relations`).

## Resolving (also unchanged) called methods (`resolve_call` + `modules/callresolve` + `modules/claude`)

The Underlying-code card also links the **method calls** a changed block makes
to their **definition**, even in a file the PR did not change. Two layers: a Go
resolver first, an LLM as fallback.

**Why a separate read model, not `relations`:** these children point to
unchanged files (so their block id is not a PR block the frontend knows), and
`relations.Replace` is a full swap per PR — an expensive LLM resolution would
vanish on a rebuild.

- **`modules/callresolve`** (`data/callresolve.db`):
  `call_resolutions(pr, caller_id, call_key, status, child_*, kind, model,
  confidence, updated_at)`, PK `(pr, caller_id, call_key)`. The row carries the
  **full child descriptor + code text**, so the frontend needs no extra fetch.
  `status`: `resolved` (Go), `unresolved` (Go failed → automatic LLM search),
  `searching`/`found`/`notfound` (LLM).
  - `UpsertGo` writes Go rows but **never overwrites** a `searching`/`found`
    row → the LLM wins over a rebuild. It *does* reset a `notfound` row back to
    `unresolved` (see `resolveCallAttempted` below for why that matters).
  - `Prune(pr, keep)` removes any row whose `(caller_id, call_key)` isn't in the
    current Go scan (caller fell out of the PR, or the call site is no longer on
    a changed line) — including LLM rows, since the site is gone.
  - **`kind`** (default `method_call`) distinguishes a normal call from a
    **class-level** child (`ChildMethod` empty — the whole model/enum). An empty
    Kind normalises to `method_call` on write, so none of the plain call rules
    needed changes; only `emitKind` callers pass something else
    (`model_usage`/`migration_model`/`data_provider`/`translation`/
    `trait_usage`). Frontend: the label branches on `childMethod` (empty → bare
    class name, never an ugly `Class::`), `KIND_LABEL` maps the words, and
    `DIFFSTAT_KINDS` gives them the same `+A −R`/`Unchanged` badge.
- **Analysis service `callresolve_analysis.go`** (reads the head worktree):
  `resolveCalls` builds one worktree-wide index (`buildSymbolIndex`:
  class→methods, method→blocks, Eloquent scope alias, enums, macros, facades,
  models, model `$casts`, traits, commands) and scans each changed new-side
  block with regexes.
  - **`idxSkipDirs` only skips genuinely vendored/generated dirs** (`vendor`,
    `node_modules`, `.git`, `storage`, `public`) — deliberately **not**
    `tests/`: a custom test base class or shared trait is app code, and
    excluding it meant every call to an inherited test helper escalated to the
    expensive agentic pass, which then found it via `Grep` anyway. Purely
    additive — a unique match can't become more ambiguous.
    See `TestResolveCallsTestHelperClassIndexed`.
  - **Only the changed lines** of a block are scanned (`changedNewLines`, a
    per-file base↔head diff; a missing base file → everything counts as
    changed). A call on an unchanged line therefore never produces a child —
    that used to give unrelated "Underlying code" (a builder's `->join(` on an
    old line matching a coincidental app method).
  - Resolution rules, in order: `$this->`/`self::`/`static::` (own class);
    `Foo::m(`/`(new Foo)->m(`; `$var->m(` via the **receiver variable name**
    (`$order->billingAddress()` → `Order::billingAddress`, even when several
    classes have that method — note the call key is the bare method name, so two
    receivers calling the same method in one block collapse onto the first
    match); `->m(` on a **unique** global or scope match. Ambiguous (>1
    candidate) → `unresolved`; a method that exists nowhere in the app worktree
    (framework calls like `->where(`) also → `unresolved`, since by definition
    it sits on a changed line and the automatic search should try.
  - **Rule 2b/2c/2d — Eloquent models.** `new Foo(` on a model class explicitly
    **excludes** the constructor even when one exists: the reviewer wants the
    model, not its constructor body. `scanModels` indexes every `app/Models/`
    file as a **whole-class synthetic block** (`ChildMethod` empty), so
    `new Model()`/`Model::…` (2c) and a **type-hinted model parameter** (2d)
    both emit one deduped `model_usage` child. 2d scans the **whole** block body
    instead of only the changed lines — a **deliberate, documented exception**
    to `resolveCalls`' changed-lines principle: a parameter type is a structural
    property of the whole (changed) function, mirroring how
    `controllerModelDetector` also scans the whole body. Inherited Eloquent
    methods (`fill`/`save`/`query`) stay plain `unresolved`.
  - **Rule 3 — facades.** A facade forwards its static calls to its accessor, so
    `scanFacades` links `class X extends …Facade` + `getFacadeAccessor()` and a
    `Foo::m(` that doesn't resolve on `Foo` retries on the accessor. A method on
    neither (a framework method, vendor isn't indexed) stays `unresolved`.
  - **Rule 3c — Artisan commands.** `$schedule->command('accounting:import …')`
    resolves to the command class's `handle`, via `scanCommands` (`$signature`'s
    first token). The **call key is the command name**, so different scheduled
    commands stay separate children and the generic `->command(` arrow call is
    suppressed. A framework command (`queue:work`) → `unresolved`.
  - **Rule 5/5a — Eloquent magic properties.** `->name` without parentheses is
    the relation **method** `name()`; treated as a call only when `name`'s body
    is a relation (`morphOne`/`hasMany`/`belongsTo`), so bare attribute access
    (`->id`) stays ignored. First the receiver variable name, then generically:
    unique → resolved, multiple models → `unresolved`. Runs after rule 4, so a
    real `->name()` call wins the key.
  - **Rule 5b — `$casts` targets.** A field cast to an enum/class is not a
    relation method, so 5/5a matched nothing and it produced **silently
    nothing**. `scanModelCasts` (legacy `protected $casts = [...]` array form
    only; the Laravel 11 `casts(): array` method form is out of v1 scope)
    indexes `model.field → class`; exactly one same-name enum → whole-enum
    child, another model → whole-model child, several same-name enums (this app
    has three `Driver` enums) or a non-indexed target → `unresolved`, never
    silently nothing, since the call site is on a changed line.
  - **Rule 6 — enum cases.** `Foo::NAME` **without** parentheses resolves to the
    enum declaration when `Foo` is an indexed enum defining that case
    (`scanEnums` → synthetic block; `child_method` = the case name).
    `Foo::class` and constants on non-enum classes are ignored; the same case on
    several enums → `unresolved`. The frontend's `findCallSites` therefore also
    matches `::name`.
  - **Rule 7 — API Resource `toArray()`.** A Resource used on a changed line
    surfaces its own `toArray()`, since that's where the output is defined —
    even when the Resource class itself isn't changed (the common case, unlike
    `controllerResourceDetector`'s both-changed relation). Call key
    `resource:<class>`. A Resource that doesn't override `toArray()` yields
    **nothing**, never `unresolved` — that's an absence, not an ambiguity. The
    shared `reResourceUse`/`reResourceReturn` also match a versioned/collection
    suffix (`AffiliateResourceV2`, `…ResourceCollection`), anchored right before
    the `(`/`::`/return-type boundary so `ResourceManager` still never matches.
  - **Rule 8 — trait usage.** `use TraitName;` in a changed `<class-header>`
    surfaces the trait's own definition (`scanTraits`, whole-class synthetic
    block). Only the plain, comma-separated form ending in `;` — a
    trait-adaptation block (`{ A::foo insteadof B; }`) is out of v1 scope, as is
    a `use` after the first method (that text falls outside every scanned
    block). Call key `trait_usage:<trait>`; an unindexed name (vendor, typo) →
    nothing.
  - **Laravel macros** (`scanMacros`) are indexed too: a
    `Builder::macro('joinAddress', function …)` inside a boot method is a
    closure and thus invisible to `ScanBlocks` (`skipBody` swallows it), so the
    registration is detected by regex and turned into a synthetic block. Its
    code comes from `blockSource`'s line-slicing fallback (the symbol lookup
    fails for a nested block).
  - **A call key containing `:`** (`migration_model:`, `data_provider:`,
    `resource:`, `trait_usage:`, `translation:`, a command name) can never match
    a real call-site identifier in `findCallSites`, so such a child shows at
    group/list level and isn't tied to one line/call.
- **`modules/claude`** — the CLI bridge (`claude -p <prompt> --model <id>`, with
  a context timeout). Agentic runs get `cwd` = head worktree + read-only tools
  (`Read,Grep,Glob`). **`SLASH_CLAUDE=off`** → `claude.Fake`.
  - **Context-only calls run from a neutral scratch cwd, not the slash repo.**
    `claude` auto-loads the project's `CLAUDE.md` + `.claude/rules` from its cwd
    on every call — pure overhead for a context-only prompt about PHP code.
    Measured ~110k `cache_creation` tokens (~$0.22) with cwd = slash repo vs.
    ~7k (~$0.016) from an empty cwd outside any repo. `Module` therefore holds a
    `scratchDir` **under `os.TempDir()`**, explicitly not under `dataDir`:
    `claude` walks **up** the tree looking for a `CLAUDE.md`, so an empty
    subfolder of this repo still cost ~112k (empirically confirmed before the
    location moved). Nothing changes for the agentic pass: that worktree carries
    plug-and-pay's own `CLAUDE.md` (bigger still), and turning that off would
    need `--bare` + a separate `ANTHROPIC_API_KEY` — an auth/billing decision,
    deliberately untouched.
  - **The static instruction text per action is decoupled from the varying call
    content via `--append-system-prompt`.** `RunRequest.SystemPrompt` carries
    the call-independent part — **byte-for-byte** the text that used to sit
    inline in `-p` — now in `modules/claude/prompts/*.md`, embedded with
    `//go:embed`. Deliberately **not** under `.claude/` (which would itself be
    subject to auto-discovery in an interactive session here): this is prompt
    content for a subprocess, not documentation. Purely a relocation (a
    byte-equality test pins it), so resolution quality is unchanged; side
    benefit is that the piece is now identical across repeated calls of the same
    action, so `claude`'s own prompt cache can reuse it.
  - Both changes live inside `Module.Run`/the payload, so the number and order
    of `cl.Run` calls per workflow body is unchanged.
- **Workflow `resolve_call`:** `markCallsSearching` → `resolveWithModel` (Haiku,
  context-only shortlist from the Go index) → `saveResolutions`. Purely
  automatic, no Signal. Every LLM claim is verified against the worktree
  (`verifyDefinition` + path containment) before it becomes `found`.
  - **Haiku only — no automatic escalation to Sonnet.** That used to escalate an
    uncertain answer to an agentic Sonnet pass; removed on explicit request, so
    an uncertain/not-found outcome simply stays `notfound`. The generic agentic
    machinery still exists in `resolve_call.go` but is never called from this
    workflow (a deliberately minimal change: only the call site went).
    `Entry.HadCandidates` still travels in the result but drives nothing.
    Pinned by `TestResolveCallNeverEscalatesToSonnet`.
  - **A curated denylist (`vendorBuiltinNames`) skips even the Haiku call** for
    a handful of very common vendor/framework method names (PHPUnit/Laravel HTTP
    test DSL, Schema Blueprint, `cases`) — but **only** when the Go index also
    had zero candidates, so a same-named app method is never suppressed
    (`TestResolveCallVendorBuiltinDoesNotSuppressRealCandidate`). Saves spend
    and the pointless "Searching…" chip.
- **The search also starts automatically SERVER-SIDE.** Right after
  `buildRelations`' `UpsertGo`/`Prune` (so via both `build_relations` and the
  delta refresh), `autoStartResolveCall` groups the fresh scan's `unresolved`
  rows **per caller** and starts one Execution per group — the reviewer needn't
  open a block first. **Fire-and-forget** (its own goroutine), so ingest never
  waits on a live claude call. `StartResolveCall` is **idempotent**
  (`resolveCallRunID` over `pr|callerId|sorted(calls)`), so the automatic
  trigger and the frontend's own `startCallSearch` safety net can never both
  spend a call.
  - **Never re-submits an already-attempted call, across any number of later
    rebuilds:** `groupUnresolvedCalls` requires a call to be `unresolved` **and**
    absent from `resolveCallAttempted(pr)` — the durable set of every
    `(callerId, callKey)` that ever appeared in a `resolve_call` input, read
    from the event history, **not** from the read model's status. Load-bearing:
    `UpsertGo` resets a `notfound` row back to `unresolved` on every rebuild
    that doesn't touch that call, so a DB snapshot could only distinguish
    "already attempted" for the one rebuild right after a search. The history
    never forgets. Accepted consequence: such a row's status can keep
    cosmetically flipping to `unresolved` (pre-existing `UpsertGo` behaviour) —
    the guarantee is "never a second LLM call", not "the status reflects that it
    was tried".
  - **Deliberately server-only:** the headless twin `slash relations <pr>`
    bypasses the engine entirely and starts no search; such a PR relies on the
    frontend trigger once a server is running.
- **Frontend:** `state.callResolve` adds `resolved`/`found` rows as children and
  starts the search for `unresolved` calls automatically in the `setRelated`
  watch (deduped in `searchRequested`, resolving the block's **whole**
  unresolved set rather than the selection's). `findCallSites` maps each call to
  the diff segment it's on; `callScopeMethods` scopes to the selected unit in
  diff mode and shows all calls in list mode. Ordering: definition changed in
  this PR → call on a changed line → rest. A `found` child shows a
  **`source: haiku`** badge; Go-resolved shows none. The list is computed in a
  watch and pushed via `setRelated`, never in a render binding (that races with
  the diff over `b.code`). See `.claude/rules/detail-layout.md`.
- **Migration → model (`resolveMigrationModels`).** A changed migration usually
  belongs to an **existing, unchanged** model ("add a column"), which makes this
  a callresolve rule rather than a both-changed relation detector — and
  rule-based, so **no LLM fallback**: an unmappable migration yields **silently
  nothing**, no `unresolved`, no search. Scope: a changed `MIGRATION`/`up` block
  (a migration is the anonymous `return new class extends Migration`, so
  `Class == ""`; never `down`). Per `Schema::create|table('table', …)` match,
  table → model via an explicit `protected $table` override or the Eloquent
  convention (`singularizeTable`, a deliberately **pragmatic** inflector:
  `-ies`→`-y`, trailing `-s`, then `studly`). One deduped child per table, key
  `migration_model:<table>`.
- **PHPUnit data providers (`resolveDataProviders`).** Same motivation/shape: a
  test with `#[DataProvider('m')]` (or the legacy `@dataProvider` tag) shows the
  provider itself, usually unchanged. **No LLM fallback** because a bare
  `#[DataProvider]` always names a method **on the test's own class** (the
  `DataProviderExternal` form is out of scope), so there is no ambiguity; a
  non-matching name yields nothing. Reuses `methodZone` to read the
  attribute/docblock text. Key `data_provider:<name>`.
- **Resolving translation keys (`resolveTranslations`).** A `trans('file.key')` / `__()` /
  `@lang()` / `trans_choice()` call on a **changed line** surfaces the Laravel
  lang file(s) — **one child per locale**. Deterministic, no LLM: the key splits
  on the **first** `.` (before → `<fileSeg>.php`, rest → the nested array path),
  locales are the lang-root subdirs containing that file, and `sliceLangKey`
  extracts the value source (a quoted scalar or a nested `[...]`). Key
  `translation:<locale>:<key>` (unique per locale), `Kind translation`,
  `ChildClass` = the locale; an **absent** key still emits a row with empty code
  so the UI can mark "ontbreekt in <locale>". **v1 boundaries, silently
  skipped:** a dynamic key, a namespaced/vendor key (`pkg::file.key`), and a
  bare whole-file reference. Frontend: always a **leaf value view**
  (`translationValueView`, current value per locale, no diff), never drillable;
  `findCallSites` couples it via the key **string literal** (the same literal
  for every locale) and `resolvedCallTargetIds` skips `translation` so a changed
  lang file's own block stays in the left list.
- All of these are **merged** into the one `UpsertGo`/`Prune` call in the
  `buildRelations` Activity (and in the headless `slash relations` twin), so
  they share the keep set and need no prune scope of their own.
- Tests: `callresolve_analysis_test.go`, `resolve_call_test.go`,
  `modules/callresolve/callresolve_test.go`; frontend via
  `slash seed -callresolve <json>`.

## Linking test coverage (`resolve_test_covers` + `modules/testcovers`)

A PHPUnit test links to the method it tests, in **both directions**: a test
shows the tested method as a child, and a tested method shows "covered by
TestX::testY" (only when the test itself also changes, since only then is there
a test PR block to hang it on). Go detector first, a **limited** AI fallback for
one specific case.

**Why a dedicated module:** the tested method is often in an unchanged file, so
its block id is not a PR block — same reason as `callresolve`, hence a row
likewise carries the full child descriptor + code text.

- **`modules/testcovers`** (`data/testcovers.db`):
  `test_covers(pr, test_id, target_key, status, covered_*, annotation, model,
  confidence, updated_at, line)`. `target_key` mirrors `call_key`:
  `method:Class::method` (statically resolved), `class:Class` (AI territory),
  `none`. `line` (distinct from `covered_line`, the tested method's declaration)
  is where the annotation sits **in the test file**, used to reorder the panel
  around the selected group. Only set on a `resolved`/`unresolved` row; a
  `found` row that escalated from a class-only annotation deliberately doesn't
  carry it (too much plumbing for this narrow path), so it degrades to the same
  "not in the group" tier as `covered_by`.
  Statuses:
  - **`resolved`** — a **method-level** annotation (`#[CoversMethod(X::class,
    'm')]`, `@covers X::m`, `@coversDefaultClass` + `@covers ::m`) always names
    both class and method, so it resolves statically, verified against the
    worktree. **`#[CoversMethod]` names both regardless of where it sits** —
    including above the class declaration (one attribute standing in for "this
    whole test class covers this method"), so `coverTargets` matches it against
    the class zone too and it then resolves for **every** test method of that
    class. That is the opposite of `#[CoversClass]`, which only ever names a
    class wherever it sits and therefore stays LLM territory.
  - **`unannotated`** — no annotation at all → **permanent warning, never AI**.
  - **`unresolved`** — a class-level-only annotation → triggers the search.
  - **`searching`/`found`/`notfound`** — LLM-owned, as in callresolve.
  `UpsertGo` never overwrites an LLM-owned row; `Prune` cleans up orphans.
- **Static detector `testcovers_analysis.go`** scans, per **changed test file**
  (no whole-worktree scan), the raw text around each test method (`methodZone`,
  bounded by the previous block) and around the class declaration (`classZone`)
  for the four annotation forms — pure regex, no parser. A method-level
  annotation wins over a class-level one for the same class (no needless AI
  search). A test method is recognised via the `test` prefix or a
  `#[Test]`/`@test` marker, so `setUp`/helpers stay out. Called **inside the
  existing `buildRelations` Activity**, like callresolve's Go rows.
- **AI branch:** runs **only** for `unresolved` (a class-level-only annotation),
  never for `unannotated`. Haiku gets the **candidate methods of the named
  class** + the test body and picks which one is exercised. **Haiku only — the
  automatic Sonnet escalation was removed** (the machinery remains but is
  uncalled). Verification is stricter than `verifyDefinition`: the class is
  already fixed by the annotation, so only the method's existence on that class
  is checked.
- **Sibling reuse within the same test class (`reuseSiblingCovers`):** several
  tests in one file often cover the same class, so before asking Haiku the
  workflow checks whether a **sibling** test (same PR + same test file, i.e. the
  same `<pr>:<file>:` prefix, different `test_id`) already resolved that class.
  Matched via **`CoveredClass`**, not the raw `target_key` — a `resolved` row
  carries `method:…` and a `found`/`unresolved` row `class:…`, so only that
  field identifies "the same tested class" across both forms. Only **`resolved`**
  (most authoritative) and **`found`** are reused, never
  `notfound`/`searching`/`unresolved`/`unannotated` (an earlier miss says
  nothing about another test); `resolved` wins, then `List`'s own stable order.
  A reused row is a **literal copy** (so the existing per-status badge just
  appears; no "reused" marker). **Determinism:** the lookup is its own Activity
  (`reuseTestCoverSiblings`, the only reader of `List`; the matching itself is
  pure), so the **number** of model calls is a function of a recorded result —
  the same pattern as callresolve's `HadCandidates` gate. This only saves Haiku
  calls; it does not reintroduce Sonnet.
- **Frontend:** direction 1 = `resolvedTestCoverChildren` (`covers` child, same
  diffstat/`source` badges as a call child); direction 2 = `coveredByChildren`
  (`covered_by`, reusing the existing test PR block, so no code snapshot). Both
  **block-level**, so they drop out at `gran==='call'` like listener children —
  coverage is not a line-bound concept. `directChildBlocks`/`nestedPrBlocks`
  include **only direction 1**, to avoid a method↔test cycle in the recursive
  approval rollup. **Test coverage hides no block from the left list** — neither
  side: unlike a call target or listener (often genuinely unchanged reference
  code), a tested method that is a PR block is always changed, primary
  reviewable code, so a test must never make it disappear. A **warning**
  (`related-covers-warning`) shows for an `unannotated` row, or a `notfound` one
  after a failed search, with different text per case; the "searching…"
  indicator reuses callresolve's own helpers, and the search starts
  automatically from the same `setRelated` watch.
- Tests: `testcovers_analysis_test.go`, `resolve_test_covers_test.go`,
  `modules/testcovers/testcovers_test.go`, `tests/testcovers.spec.mjs` (seeded
  via `slash seed -testcovers <json>`).

## AI description of a code unit (`explain_code` + `modules/explanations`)

Generates the **footer description**: a short Dutch Opus explanation of the
focused `line`/`group` unit (see the Footer section in
`.claude/rules/keyboard-navigation.md`) — **every** such unit with real code,
not only one containing an if-statement (that earlier frontend gate was lifted
with "Diepgravend onderzoek"). One Execution per **unit + code hash**, no
Signals.

- **`modules/explanations`** (`data/explanations.db`):
  `explanations(pr, block_id, unit_key, code_hash, status, text, model,
  updated_at)`, at most one live row per unit — a new hash (new commit)
  overwrites it. `status`: `searching`/`done`/`failed` (terminal: the footer then
  shows nothing and doesn't ask again). A row with an **empty `code_hash`**
  matches any hash on the frontend side (seed fixtures).
- **Input-driven, no worktree reads:** the input carries the unit code, the
  surrounding block as context (frontend-truncated), file/label/gran, the
  `unitKey` (same codeRef shape as `commentPath`) and the `codeHash` (frontend
  `fnv1a` over `EXPLAIN_PROMPT_VERSION + '|' + code + context`; the backend only
  stores it). So the body is a pure function of its input.
- The prompt caps the answer at ~40 words / ~275 characters, measured against
  `line-clamp-2` at the footer's real width, so it fits without ending in "…".
  **`EXPLAIN_PROMPT_VERSION`** (frontend-only, folded into `codeHash`) exists
  for exactly this kind of change: bumping it invalidates every previously
  generated row with no backend migration — a stale hash simply stops matching
  and the row is lazily regenerated.
- **Flow:** `markExplainSearching` → `generateExplanation` (Opus, context-only;
  empty output → `failed`) → `saveExplanation`. The done/failed decision reads
  the **stored** result, so replay-deterministic.
- **Idempotent start** via `explainRunID` (`expl-` + sha256 over
  pr|blockId|unitKey|codeHash — hashed because block ids contain paths/colons
  and Run IDs are used as JSONL file names).
- **Frontend:** the footer watch builds a request for the focused unit as soon
  as it has non-blank code, shows "generating…", and starts with a 600ms
  debounce, deduped in `explainRequested` and **only after the read model loaded
  at least once** (`explanationsLoaded`) — otherwise a fresh run would overwrite
  an existing/seeded row before the first GET landed.
- Tests: `explain_test.go`, `modules/explanations/explanations_test.go`,
  `tests/footer-explanation.spec.mjs`.

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
  (`persistApproval`). The UI never writes directly.
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
  one deliberate difference from the otherwise identical `task_snooze` mould
  above, which has no such hook.
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
  id shape (`commentBlockItem`) and is added on read.
- **Known, accepted gap:** ignoring a comment that is deleted afterwards leaves
  an orphan row until the PR is purged. It is invisible (the frontend only
  matches these ids against comments it actually loaded), and cleaning it up
  eagerly would give the comment-delete path a dependency on this module for no
  visible gain. See `Set`'s own doc comment.
- Tests: `modules/commentignore/commentignore_test.go`,
  `ignore_comment_test.go`, `cleanup_test.go` (the purge sweep), and
  `tests/comment-ignore-persists.spec.mjs`.

## Ingest pipeline as a workflow (`ingest` + `.claude/rules/blocks-and-ingest.md`)

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
- See `.claude/rules/blocks-and-ingest.md`; `ingest_test.go` skips itself when
  gh is unreachable.

## Actually approving/rejecting a PR on GitHub (`submit_review` + `github.Client.SubmitReview`)

Submits a **real GitHub PR-level review**, for the menu after approving the last
blocks. Signal-less, one Execution per request.

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
PR-overview popover (see `.claude/rules/pages-and-routing.md`). Signal-less.

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

## AI risk check of the whole PR (`code_warning` + `code_warning.go`)

A **PR-wide, agentic** risk check — correctness, security, style/quality — that
also looks at code a change is **connected** to (callers, called code, tests,
listeners) which the PR itself doesn't touch. Deliberately **agentic Opus only**
(with `Read`/`Grep`/`Glob` in the head worktree): the whole point is that the
model explores the worktree to find something outside the context we hand it (a
caller whose call no longer matches a changed signature, a test still checking
the old form, a listener not handling a new payload field). Opus because this is
a manually triggered, low-frequency action.

- **Trigger: manual, PR-wide** — the `/` menu item **"Diepgravend onderzoek"**.
  No automatic trigger (unlike `explain_code`'s debounce or `resolve_call`'s
  auto-search): a PR-wide agentic pass with a judgment-based goal is too
  expensive and too noise-sensitive to run silently on every navigation step.
  **Re-running it is a deliberate "refresh"** — no idempotent Run ID: every run
  supersedes the previous findings of the files in scope, so it replaces rather
  than stacks. **Incremental on a new commit is deliberately NOT built**: a
  fast-follow could piggyback on `refreshIngestDelta`'s changed-file list, but
  that touches `pr_status`'s body and `ingestResult`'s schema.
- **Scope + cap (`resolveWarningScope`,** read-only): the files come from the
  PR's current blocks (`Files` empty → all changed files; filled → passed
  through, reserved for that fast-follow). The findings cap is
  **`warningsPerBlock` (2) × blocks-in-scope**, floor 2 — "on average ~2 per
  block", not a fixed number. The model is told the cap, but it is
  **hard-enforced in Go** (sort on `file, line`, truncate), so a model ignoring
  the instruction can't exceed it.
- **Findings carry their own anchor, mapped onto the existing comment model:**
  the model returns `[{"file","line","text"}]`. **Hallucination protection:** a
  finding is trusted only if its `file` is literally one of the files the prompt
  named — a made-up path is silently rejected. `anchoredWarning` then reuses
  **literally** `blockForLine`/`rowForLine`, the same mechanism an imported
  GitHub review comment uses: inside a block → a normal block-scoped warning
  (`Kind ""`, `Gran "line"`); not inside one (an unchanged/context line, or a
  slightly-off line) → **PR-wide** (`Kind "ai_warning"`, added to `isPRWide`)
  instead of being discarded, with `File` still set as a hint.
- **Auto-supersede, scoped per file** (`supersedeFileWarnings`, run **before**
  the agentic call): for each file in scope, every existing `Source:"ai"`
  comment on it is deleted via the **existing delete Signal** on its own
  Execution — best-effort per comment (an already-closed run can't be signalled
  and must not block the rest). A file **outside** scope keeps its old warnings.
- **Every warning is a normal `task_code_comment` Execution** — no new comment
  machinery: `createWarningComment` calls `StartCodeComment` with `Source:"ai"`
  + `Local:true` (never to GitHub) and `Author:"AI check"`. Being a full
  Execution, the reviewer can resolve or delete it like any other comment.
- **Determinism:** the body only does `ExecuteActivity` calls in a fixed order
  (scope → supersede → the one Opus call → one `createWarningComment` per
  finding), and that last count comes from the **stored** review result.
- **Frontend:** the same warning-triangle SVG as `related-covers-warning`, now
  as an `aiWarningBadge` pill; the Taken card shows the run as "Risk check" with
  either "searching the PR for risks…" or the **exact** number of findings —
  including "no risks found" — via `WorkflowRunView.WarningsFound`.
- Tests: `code_warning_test.go`.

## Snoozing a task (`task_snooze` + `modules/tasksnooze`)

One Execution per **repo** (mould of `approve`), making "hide this **task** from
`/inbox`" durable. Purely local — no network, so no `SLASH_*=off` gating. Unlike
the removed per-PR `ignore` feature this is keyed on a generic **task id**
(`pr:<n>`/`comment:<runId>`/`jira:<KEY>`), since a task isn't always a PR.

- **`modules/tasksnooze`** (`data/tasksnooze.db`, `snoozes(task_id, until)`):
  `until` is an **absolute Unix-ms expiry** (`0` = forever). `Set` upserts, or —
  when **`until < 0`** — deletes the row (un-snooze). `List` does **not** filter
  on expiry: "is it still snoozed?" is checked at **read time** in the UI
  (`until === 0 || until > Date.now()`), like the old feature did.
- **Workflow:** a loop on `snooze` (`SnoozeSignal{TaskID, Until, Clear}`), one
  `saveTaskSnooze` Activity per signal. **Deterministic without a clock:** the
  UI computes the absolute `Until` (browser-local) and sends it, so the body
  never reads `w.Now()`. Never completes. `EnsureTaskSnooze()` starts/reuses it
  at startup; unlike the inbox trackers it has **no poller** — it only ever
  reacts to UI signals.
- **Frontend:** see "The task inbox page (`/inbox`)" in
  `.claude/rules/pages-and-routing.md`.
- Tests: `modules/tasksnooze/tasksnooze_test.go`, `task_snooze_test.go`.

## The task inbox: `task_inbox` + `modules/taskinbox` (aggregation) + the `/inbox` page

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
- **Frontend:** see "The task inbox page (`/inbox`)" in
  `.claude/rules/pages-and-routing.md`.
- Tests: `modules/jira/jira_test.go`, `modules/taskinbox/taskinbox_test.go`,
  `taskinbox_analysis_test.go`, `workflows_test.go`'s
  `TestTaskInboxRefreshPopulatesReadModel`, `tests/inbox-tasks.spec.mjs` — all
  offline.

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
  through (~40 call sites), so one wrapper covers them all and a future call
  site is free. `problemMirrorLogger()` does the same for the engine's own lines
  via `tembed.WithLogger` (e.g. `run X uses unregistered workflow`, which only
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
  (see `.claude/rules/pages-and-routing.md`).

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
    (worktree gone but a stray row left, or vice versa) self-healing.
  - **Eligibility** uses `PRMeta`'s **`MergedAt`** (empty when not merged): a PR
    is a target only if that is non-empty **and** parses **and** falls before
    the cutoff. A closed-without-merging PR is **never** touched. A gh hiccup,
    an unparsable timestamp, or a too-recent merge simply leaves it out —
    cleanup only removes data it's certain about.
- **`purgePR`**, called once per resolved target (so the call count is a
  function of the stored target list), removes for that PR:
  1. **Worktrees** — deregister via `git worktree remove --force` (best-effort,
     an already-broken directory just falls through) then `os.RemoveAll`, with a
     final best-effort `prune` sweep. By far the biggest disk win.
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
  pass, then one per interval. **Not** a durable `w.Sleep` loop inside the
  workflow, because (1) it's the shape every other periodic trigger here
  already uses; (2) cleanup has no reviewer heartbeat to piggyback on — it's
  unconditional maintenance, so the fast/slow cadence machinery doesn't apply;
  (3) it keeps the Workflow Type itself short and one-shot instead of an
  infinite-loop workflow sitting permanently `waiting` in `GET /api/workflows`.
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
  specific PR numbers unconditionally, bypassing the merged/age gate.
  Motivation: a PR that can never pass the gate at all (no real GitHub PR to
  look up, e.g. a synthetic test number that landed in the live tree via an
  ad-hoc write — see "Playwright test infra" in
  `.claude/rules/conventions.md`) would otherwise stay forever. Forced PRs are
  added straight to the target list without calling `PRMeta`, and skipped in the
  ordinary candidate walk so they're never added twice. Set only via
  `StartCleanupForce` → `slash cleanup -force <pr1,pr2>` — **deliberately not
  exposed over HTTP**, so there is no standing endpoint that can force-purge an
  arbitrary PR's data.
- Tests: `cleanup_test.go` (candidate discovery, all eligibility branches,
  force, full purge, idempotency, retired-run purge) — offline.
