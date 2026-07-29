# Tembed: durable workflows (`tembed/`)

`tembed/` is an **embeddable durable-workflow engine** — "Temporal, but a Go
package". It lives as a **git subtree** (prefix `tembed/`) in this repo and is
at the same time its own module (`github.com/reindert-vetter/tembed`), so
other projects can import it standalone. **`tembed/` is deliberately
abstract** — it knows nothing about PRs, blocks, or gh; keep it that way.

- **Subtree flow:** pull it in with `git subtree add --prefix=tembed
  https://github.com/reindert-vetter/tembed main --squash`; push changes
  back to the tembed repo with `git subtree push --prefix=tembed <url>
  main`, pull updates with `git subtree pull`. slash imports it via a
  `replace github.com/reindert-vetter/tembed => ./tembed` in `go.mod`.
- **Core (event sourcing + replay):** every run has an append-only
  event history; the engine re-runs the workflow function **from the
  beginning** each time against that history. An `ExecuteActivity` whose
  result is already in the history returns the stored value (the activity
  thus runs **once**); otherwise the activity runs now and the result is
  written out. A `WaitSignal` whose signal hasn't arrived yet **yields**
  (an internal panic sentinel), is persisted as `waiting`, and is driven
  again once the signal/timer arrives. **Workflow code must be
  deterministic** — all non-determinism goes through the `*Workflow`
  handle (`ExecuteActivity`, `WaitSignal`, `Sleep`, `SideEffect`, `Now`).
- **Signals** are buffered: a signal that arrives before the `WaitSignal`
  waits until the workflow asks for it. **Timers** (`Sleep`) are durable
  (absolute fire time in the history, rescheduled on `Recover`).
- **Deterministic, idempotent start (`StartWorkflowID`):** `StartWorkflow`
  generates a random Run ID; `StartWorkflowID(id, name, input)` takes the
  Run ID from the **caller** and is **idempotent** — if a run with that
  `id` already exists (whatever its status), it's a **no-op reuse** that
  returns `id` and leaves the existing run (and its original input)
  untouched. The existence check + create happens under the run lock, so
  two concurrent starts of the same `id` can never both create one. This
  lets a caller derive a **deterministic** Run ID from an external key
  (e.g. `gh-<commentID>`) so that a repeated start — the same poll running
  twice, or a restart that sees the same GitHub comment again — never
  creates a second Execution. The Run ID comes from the caller (glue), not
  from the workflow body, so this doesn't violate the body's determinism
  requirement. Used by the comment import (see "Importing existing GitHub
  comments").
- **Storage** via the `Store` interface: `MemoryStore` (tests), `JSONLStore`
  (one readable file per run), `SQLiteStore` (pure-Go `modernc.org/sqlite`,
  no cgo), and `MultiStore` to combine them (SQLite for queries + JSONL as
  an audit trail). The only runtime dependency is `modernc.org/sqlite`.
- **Recovery:** `engine.Recover()` at startup dry-runs every `running`/
  `waiting` run again (replants timers, re-blocks on signals) — **prioritised**,
  see "Recovery priority" below.
- **Tests:** `tembed/*_test.go` (activity replay, signals, buffered signal,
  durable timer, activity failure, SQLite+JSONL combination, recovery
  priority + `StartWorkflowDeferLow`).

## Recovery priority (don't let slow LLM work block startup)

`advance()` runs an activity **inline** (blocking) when its result isn't yet in
history, and `Recover()` re-drives every mid-flight run at startup. So a run
that was killed **mid-activity** re-executes that activity live on recovery —
and for the LLM workflows (`resolve_call` makes **one `claude` call per
unresolved call** in the block; `code_warning` a whole agentic Opus pass)
that's dozens of ~30s subprocess calls, serially, on the **startup goroutine**,
*before* `ListenAndServe`. That once wedged the whole server (it never came up).
tembed therefore has a **priority** mechanism (still fully abstract — it knows
nothing about LLMs/PRs):

- **`Priority`** — `PriorityLow` / `PriorityNormal` (default) / `PriorityHigh`.
  Affects **only** recovery; live `StartWorkflow`/`SignalWorkflow` are
  unaffected.
- **`Engine.SetWorkflowPriority(name, p)`** — a whole workflow type's recovery
  priority. In `Recover()`, Normal/High runs are re-driven **synchronously**
  (High first), so recovery blocks until they're back on their feet; **Low**
  runs are drained by a **single background goroutine** (serially, to avoid a
  thundering herd of subprocess/LLM calls), so a slow one never blocks startup
  or the fast, important workflows. Tracked by `e.wg`, so `Wait()` still covers
  it. slash marks the pure-LLM workflows Low: `resolve_call`,
  `resolve_test_covers`, `explain_code`, `code_warning` (in `NewTaskManager`,
  `workflows.go`).
- **`Engine.SetActivityPriority(name, p)`** — one **activity's** recovery
  priority, for a workflow that is otherwise important/fast but has a single
  slow LLM step. During synchronous recovery, if a Normal/High run's replay
  reaches a **live** (unrecorded) `PriorityLow` activity, the whole run **yields
  to the background** at that point instead of running it on the startup path
  (nothing is recorded — the background re-drive replays to the same point and
  runs it then, so it stays deterministic; already-recorded earlier activities
  replay from history as usual). slash marks **`generatePRSummary`** (pr_status's
  Haiku step) Low so a pr_status run killed mid-summary doesn't block startup,
  without demoting the whole (merge-detection/ingest-refresh) workflow.
- **`Engine.StartWorkflowDeferLow(name, input)`** — the same activity-level
  deferral, but for a **fresh, fire-and-forget start** (not recovery): runs the
  fast leading activities synchronously, then yields at the first live
  `PriorityLow` activity to the background. `ensurePRStatus` uses it so
  `ResumePolling` ensuring a pr_status tracker per PR at startup returns after
  stage 1 (basics) instead of blocking on the Haiku summary — the UI polls the
  read model for the rest anyway (progressive load, see "Progressive loading"
  in `.claude/rules/detail-layout.md`). If a workflow has no live low-priority
  activity, it behaves exactly like `StartWorkflow`.

Net effect: the server reaches `ListenAndServe` promptly and the deferred LLM
work (interrupted `resolve_call` searches, an unfinished summary) drains in the
background without blocking anything. Tests: `tembed/engine_test.go`
(`TestRecoverDefersLowPriority`, `TestStartWorkflowDeferLow`).

## Hard rule: only workflows mutate state

**Workflows are the only writers.** State changes exclusively through a
Workflow Execution; everything else is **read-only from the outside**:

- **Modules** (`modules/*`, e.g. `comments`, `github`, `inbox`) are the
  things that "can happen inside a workflow" — they are called **only** by
  workflow Activities. Their write methods (`Save`, `AddReaction`,
  `PostReviewComment`, …) must not be called anywhere else; their **read**
  methods (`List`, …) feed the UI.
- The **HTTP API** only writes via workflow endpoints (starting an
  Execution or sending a Signal). Every other endpoint, and the **UI, are
  read-only**.
- Why: the workflow event history is the source of truth (durable,
  replayable, survives a restart). A module table is a derived read model.
  See `.claude/rules/workflows-write-boundary.md` and
  `.claude/rules/workflow-determinism.md`.

## The first slash task: `task_code_comment` (`workflows.go` + `modules/`)

The first concrete task runs on tembed: **placing a comment on a line of
code** and keeping the thread alive. Terminology follows Temporal — a
**Workflow Type** `task_code_comment`, started as a **Workflow Execution**
(with a **Run ID** that also serves as the comment id), which runs
**Activities** and reacts to **Signals**.

- **Two modules** that the workflow drives as Activities:
  - `modules/comments` — the comments module with its **own SQLite read
    model** (`comments`/`reactions`, `data/comments.db`). "Does its own
    thing": counts reactions (`reaction_count`) and sets `status` to
    `resolved` on `/resolve`. Write (`Save`/`AddReaction`) = workflow-only;
    `List` = read for the UI. Each comment also stores the **code
    fragment** it hangs on (`code`/`gran`/`label` columns, passed in via
    `CodeCommentInput`) — the exact navigation unit at the moment of
    placing — so the thread later shows the same code as the composer.
    `RelatedPanel.mjs` shares one `composeTargetHint` box for this (the
    frame with granularity + `class::method` + Prism-highlighted fragment):
    the composer feeds it from `commentTarget()` (live navigation), the
    placed-comment thread from the stored `code`/`gran`/`label`. A comment
    without `code` (e.g. an old or seeded one) shows no frame. A light
    `migrate` adds those columns to an existing DB (`ALTER TABLE … ADD
    COLUMN`, duplicate-column error ignored).
    Alongside the fragment, a comment also stores its **navigation anchor**
    (`row_start`/`row_end`/`seg`): the aligned-row range within the block +
    (for a `call`) the segment key. That lets `RelatedPanel` scope the
    comment index to the selected block **and** the selection unit
    (call ⊂ line ⊂ group ⊂ block; `commentUnder`/`visibleComments`,
    `home.mjs` pushes the scope via a `watch` + `setCommentScope`). Every
    comment also gets a **hierarchical path** that the workflow builds
    deterministically (`commentPath` in `workflows.go`, from the input +
    Run ID) and which is indexed in the `path` column:
    `/pr-<pr>/<file>/<label>/<codeRef>/comment-<id>` (the `file` keeps its
    slashes, so a directory prefix also matches; `codeRef` = `group-5-9` /
    `line-7` / `call-7-<seg>`). A **prefix match** thus finds every comment
    under a scope: `/pr-123` (whole PR), `/pr-123/app/Foo.php` (file),
    `…/Foo::bar` (block), `…/group-5-9` (unit) — via `comments.Search(prefix)`
    (read-only) behind `GET /api/comments?path=<prefix>`. Writing the path
    remains workflow-only (`saveComment` Activity). Separately, the diff
    marks every line with a comment with a **💬** (`commentRowSet` → `Block`
    `commentedRows` → `paneHTML`, presence-only).
    A comment also carries **`github_id`** (`Comment.GithubID`,
    `json:"githubId,omitempty"`): its own GitHub review-comment database id,
    once known — set for an imported comment (`= ImportedRootID`, right
    away) and, for a normal in-app comment, once its `postGithubComment`
    call actually completes. `taskCodeCommentWorkflow` persists this via its
    own **`saveCommentGithubID` Activity**, called unconditionally right
    after the existing `posted.RootID` switch (import/local/normal) — so the
    number of Activities stays a fixed function of the input shape, not of
    whether the post happened to succeed (replay-deterministic); the
    Activity itself (`comments.Module.SetGithubID`) is a no-op for `id <= 0`
    (a local/private note, or a post that never happened/failed), so the
    column then simply stays at its zero-value default. **Purely additive
    read data** — no new write path, `SetGithubID` is only ever called from
    this one Activity. The frontend reads it via `focusedCommentGithubId`
    (`RelatedPanel.mjs`) to show/hide and build the **"Open op GitHub"**
    item at the bottom of the comment-command-menu (see `COMMENT_COMMANDS`
    in `.claude/rules/keyboard-navigation.md`) — a `"#discussion_r<id>"` deep
    link on the PR URL, since the comment-scoped panel only ever shows
    block-scoped review/diff comments (`kind === ''`). For a comment
    imported/seeded before this field existed, `focusedCommentGithubId`
    falls back to parsing the `"gh-<id>"` shape an imported comment's
    `runId` always has (`importedRunID` in `comment_import.go`) — but that
    fallback only ever covers `source === 'github'`; a normal in-app comment
    has no such fallback and simply shows the option once `github_id` lands.
    The **thread** also opens with the comment itself as the **first
    message**: the body that titles the comment also appears as the first
    chat bubble (on the reviewer's side), followed by the reactions.
    `RelatedPanel.mjs` builds that with `threadMessages(c)` = the synthetic
    opening (`{source:'ui', body:c.body}`, key `origin:<id>`) + `c.reactions`;
    the keyboard nav (`reactionCount`/`threadPos`) counts that opening too,
    so `↑` walks all the way up to the opening. A **click** on a comment
    row also really lands on it (`toComment()` → highlight + thread open +
    reply field focused), same as the keyboard landing.
  - `modules/github` — the GitHub communication (`gh api`): `PostReviewComment`
    (line range + side, see below), `Reply`, `FetchReplies`, `PRState`
    (`open`/`merged`/`closed`), `PRMeta` (title/URL/body/author/diff-stats/head-ref),
    `DeleteComment`, `ResolveReviewThread` (resolves a review-diff thread on
    GitHub, via `gh api graphql` — the thread node ID is looked up from the
    root comment's `databaseId`, then the `resolveReviewThread` mutation
    runs), `MarkFileViewed` (the Files-changed "Viewed" checkbox, via
    `gh api graphql`). Interface `github.Client` + `github.Fake` (with `SetPRState`,
    `IsViewed`/`ViewedFiles`, `LastStartLine`/`LastEndLine`/`LastSide`/
    `LastPostedBody`, `ResolvedThreadCount`/`LastResolvedThread`) for tests.
  - `modules/jira` — the Jira communication via the local `acli` CLI (same
    bridge pattern as `modules/github`/`modules/claude`, no new
    dependency): `Issue(key)` runs `acli jira workitem view <key> --fields
    summary,description --json` (the `key` is first validated against
    `^[A-Z][A-Z0-9]+-\d+$` — never unvalidated input into
    `exec.CommandContext`) and flattens the ADF `description` (Atlassian
    Document Format, a `{type:"doc", content:[...]}` tree) into plain text
    by recursively walking the content tree and concatenating all `text`
    leaves (paragraphs separated by `\n`). Interface `jira.Client` +
    `jira.Fake` (`SetIssue`) for tests; **`SLASH_JIRA=off`** → `jira.Fake{}`
    (no network, mirrors `SLASH_GITHUB=off`/`SLASH_CLAUDE=off`), wired up in
    `newTasks` (`tasks_api.go`).
  - **Each of these three CLI-bridge modules enforces its own default
    `exec.CommandContext` deadline internally, never relying solely on the
    caller** — a hung subprocess (e.g. `acli`/`gh` waiting on an interactive
    re-auth prompt with no TTY) would otherwise block that workflow run, and
    every later Signal on the same run, forever (`SignalWorkflow`/`advance`
    runs a workflow — and thus its Activities — inline/blocking). See the
    `cliTimeout` doc comment in `modules/jira/jira.go` (also referenced from
    `modules/github/github.go`) for the "shorter deadline always wins" rule
    and the var-not-const testability note, and the
    `contextTimeout`/`agenticTimeout` doc comment in `modules/claude/claude.go`
    for why Claude gets two different values depending on `RunRequest.Tools`.
- **Flow:** `saveComment` (comments) + `postGithubComment` (github, best-effort),
  then a loop on `reply`-**Signals**. A reaction comes in via the **UI**
  (`POST /api/workflows/{runID}/signals/reply`) and via a **per-thread poller**;
  both are delivered as the same Signal. Every reaction is stored
  (comments) and a UI reaction is mirrored to GitHub; `Done`/`/resolve`
  closes the thread.
- **Line range, side, and call context to GitHub:** `CodeCommentInput` carries
  `StartLine`/`EndLine`/`Side`/`Segment` besides `Line`. `postGithubComment`
  builds the `github.PostReviewComment(ctx, pr, file, start, end, side,
  body)` call from those: `Side` is `"RIGHT"` (new/context, the default when
  empty) or `"LEFT"` (a removed line); if `StartLine < EndLine` it posts a
  **multi-line range** (`start_line`..`line`, GitHub requirement), otherwise
  single-line at `EndLine` (falls back to `Line` when both are 0 —
  backward-compat with older callers that only set `Line`). For `Gran ==
  "call"` with a non-empty `Segment`, the body **posted to GitHub** is
  prefixed with the segment as a code span (`` `segment`\n\n`` + body) — the
  **stored** comment (`saveComment`, the read model behind the thread)
  stays the raw `Body`, unaffected by `Segment`. Purely input-driven, so
  deterministic under replay.
  **Frontend side:** `commentTarget()` (`home.mjs`) computes these four
  fields from the current navigation unit instead of always sending
  `b.line` (the block's start line). `unitLineRange(b, rows, unit)` counts
  the aligned rows of `blockRows(b)` from `b.code.new.start`/
  `b.code.old.start` (the source start line from `GET /api/code`; aligned
  rows themselves carry no line numbers, a filler row on the other side
  doesn't count) to determine `startLine`/`endLine` + `side`: `side` is
  `'RIGHT'` as soon as one row in the unit has a `right`, otherwise (a pure
  removal) `'LEFT'`; if the code isn't loaded yet it falls back to
  `{startLine:0, endLine:0, side:'RIGHT'}` (the backend in turn falls back
  to `Line`). `unitSegment(rows, unit)` yields, for a `'call'` unit, the
  underlined segment text (the same `unit.right`/`unit.left` Sets as
  `segKey`/the indigo underline in `Block.mjs`, substring `min..max`
  inclusive); a group/line unit has no `char` flag and returns `''`.
  `placeComment` (`RelatedPanel.mjs`) passes all four to `createComment`,
  plus `line: t.startLine || b.line` (the same backward-compat fallback as
  the Go side). There is exactly one place that posts to the workflow
  (`createComment`); every composer flow (keyboard, click, the comment-kind
  menu's "For myself only") goes through `placeComment` and thus gets the
  same anchoring.
  **`commentTarget()` follows `focusedBlock()`, not always the top-level
  `curBlock()`:** if the keyboard is on a drilled column (`state.focusLevel
  > 0`, see "Drilling"/"Column navigation" in
  `.claude/rules/detail-layout.md`), then the reference code of a freshly
  started comment must be that column's block + its own
  `state.drillCursor[focusLevel-1].{gran,change}` — not the top-level
  block. `placeComment` therefore uses `t.file`/`t.startLine` (from
  `commentTarget()`) instead of the top-level `b.file`/`b.line`, and
  `commentsSection`'s "New comment · `<file>:<line>`" header likewise. The
  `commentScope` `watch` in `home.mjs` (which scopes `cs.view`, the visible
  comment list) must also include `state.focusLevel`/`state.drill`/
  `state.drillCursor` **inline** in its dependency array — otherwise the
  comment index stays scoped to the pre-drill block after drilling, even
  though the newly placed comment itself is correctly anchored (see the
  watch-inline-deps rule in `.claude/rules/conventions.md`). Tested in
  `tests/drill-comment-target.spec.mjs`.
- **Private note (`local` flag):** `CodeCommentInput` carries a `Local
  bool` flag. If set — the UI sends it for the **"For myself only"**
  choice in the comment-kind menu (see
  `.claude/rules/keyboard-navigation.md`) — the workflow **skips
  `postGithubComment`** (`if !in.Local`). The comment is thus stored in the
  read model but never posted to GitHub. That's replay-deterministic: the
  number of `ExecuteActivity` calls depends on the **input**, not on live
  state. There's nothing further to worry about: `posted` stays the
  zero-value (`RootID == 0`), so `StartCodeComment` doesn't start a poller
  and the existing `RootID == 0` guards make `deleteGithubComment`/
  `replyGithub` no-ops — reacting to or deleting a private note thus never
  touches GitHub.
- **Poller cadence (heartbeat-driven):** the poller checks GitHub
  **quickly** (`pollInterval = time.Minute`) as long as a **heartbeat**
  arrived within the last `heartbeatWindow` (10 min) — the UI pings
  `POST /api/workflows/{runID}/heartbeat` for the **task you're currently
  viewing** (per active task, no state mutation: just in-memory poll
  timing, so outside the write boundary). The UI only pings on **real
  activity**: tab visible **and** focused **and** input within the last
  `ACTIVITY_WINDOW` (2 min) — an open-but-abandoned tab thus naturally
  stops heartbeating (`tabActive`/`beat` in `RelatedPanel.mjs`). Without a
  recent heartbeat it falls back to a **slow** cadence (`idlePollInterval =
  10 min`); **only** on that slow cadence does it also check whether the PR
  is merged/closed and **stop** if so. The poller wakes on the fast tick
  but gates the actual GitHub calls on the desired cadence, so a heartbeat
  mid-idle immediately switches back to fast.
- **`pr_status` workflow (per PR):** a second Workflow Type, one Execution
  per PR, that receives `state` **Signals** from the pollers and
  **completes** once the PR is merged/closed. That's the durable source of
  truth that pollers read to stop (writing thus stays within a workflow).
  `ensurePRStatus(pr)` starts/reuses one tracker per PR (also after a
  restart, via `Runs()`+`Input()`).
  **On start** (synchronously in `StartWorkflow`, before the signal loop)
  it runs three Activities **in sequence**, each followed by its own
  read-model write — so the UI can show things **progressively** (title +
  description first, then the summary, then the review/CI status) instead
  of waiting until everything is in:
  1. **`fetchPRBasics`** — fetches title/URL/body/author/diff-stats/head-ref
     via the github module (`PRMeta`, best-effort — a gh hiccup leaves the
     rest empty), derives a Jira key from the title (`\b([A-Z][A-Z0-9]+-\d+)\b`,
     the same regex as the frontend) and, if a key is found, fetches the
     Jira ticket (`jira.Issue`, best-effort — no key or a Jira hiccup
     leaves the jira fields empty), then `prmeta.SaveBasics(...)`.
  2. **`generatePRSummary`** — builds a prompt from the just-stored basics
     (title, body, the distinct changed files from the `blocks` table, and
     the Jira ticket) and asks Haiku (`claude.Client.Run`, context-only) to
     summarize in 2-4 sentences what the PR does, then
     `prmeta.SaveSummary(pr, summary)`.
  3. **`fetchPRStatuses`** — reuses the existing heavy inbox status query
     (`statusesFor` from `inbox.go`: reviewDecision, checks, reviewers) for
     precisely this one PR (respects `SLASH_GITHUB=off`), then
     `prmeta.SaveStatuses(...)`. Note: GitHub's rollup only gives a
     **total** + an overall state, no per-check pass count; `checksPassed`
     is therefore `checksTotal` on a `SUCCESS` rollup, otherwise `0` —
     enough for a status pill, not an exact count.

  Every stage writes via its **own, targeted** `prmeta` method (see
  below) so a later stage never overwrites an earlier one. The UI (the
  `/` menu, see `.claude/rules/keyboard-navigation.md`) reads that via
  `GET /api/pr?pr=N` for the Jira/GitHub deep links; the title yields the
  `KEY-123` ticket key. `EnsurePRStatus` is the exported ensure wrapper
  that the UI calls via `POST /api/workflows/pr_status {pr}` on load (an
  Execution start = the sanctioned write path) — the UI does **not** wait
  for this POST, but polls `GET /api/pr` and renders whatever is already
  there (a field of a not-yet-run stage is simply empty/0).

  **Ingest refresh (automatically pulling in new commits):** `pr_status`
  originally only drove merge/closed detection; since the ingest refresh
  it also uses the same `state`-Signal loop to incrementally process
  **new commits on the PR**, so a reviewer doesn't have to manually run
  `POST /api/ingest` after every push. `PRStateSignal` therefore carries,
  besides `State`, also `BaseSHA`/`HeadSHA` (just like
  `ReactionSignal.Action` / `ApprovalSignal.Viewed`, both variants ride on
  **the same** Signal — a workflow can only `WaitSignal` on one Signal name
  at a time): `State` set = a lifecycle observation (merged/closed,
  unchanged behavior); `State` empty + `HeadSHA` set = an ingest-refresh
  request.
  - **`pollIngestRefresh`** (a new, separate poller loop, distinct from any
    comment thread — mirrors `poll`/`pollInbox`, same heartbeat cadence:
    fast `pollInterval` if a heartbeat came in within `heartbeatWindow`,
    otherwise slow `idlePollInterval`) checks, on its cadence,
    `fetchPRMeta`'s live `headRefOid` against the stored `pr_ingest` record
    (see below). If it differs, it signals `PRStateSignal{BaseSHA,
    HeadSHA}` to the `pr_status` tracker. **Important:** the per-
    comment-thread heartbeat (`RelatedPanel.mjs`) only pings when a
    task/thread is open; without an open thread this poller would always
    stay on the slow cadence. That's why `home.mjs`
    (`startPRStatusHeartbeat`) separately pings, every 60s, the
    `pr_status` Run ID as long as the PR page is visible+focused — an
    operational ping without state mutation, so outside the write
    boundary, like the existing comment/inbox heartbeats.
  - **`refreshIngestDelta` Activity** (`ingest.go`): diffs the **previously
    stored** head SHA (from the new `pr_ingest` table, `db.go`) against the
    **newly observed** head SHA (`changedFileNames`, a `git diff
    --no-renames --name-only` — no full unified diff needed just to know
    the file names) to determine **exactly** which files changed since the
    previous ingest. Only those files get rescanned
    (`diffBetweenSHAs` + `parseFiles`, scoped) and written via
    **`upsertPRFileBlocks`**: a DELETE+INSERT that touches **only** the
    blocks of those files (`DELETE FROM blocks WHERE pr=? AND file IN
    (...)`) — every other file's own blocks (and thus everything hanging
    off their block id: comments/approvals/callresolve, in separate SQLite
    files with no FK) stay completely untouched. **`--no-renames` is
    load-bearing:** modern git detects renames by default for `git diff`,
    and with rename detection on, `--name-only` for a renamed file shows
    **only the new path** — the old path then drops entirely out of the
    delta, and `upsertPRFileBlocks` can never apply its `DELETE … WHERE
    file IN (...)` to that old path. Without `--no-renames` the blocks of
    the old path would thus stay permanently as orphan rows in the DB
    (seen in practice: an SDK that got renamed halfway through a PR from
    `Snapshots` to `Resources` never made the old `Snapshot*` blocks
    disappear). With `--no-renames`, `--name-only` yields **both** paths
    for a rename (old as removed, new as added), so the DELETE cleanly
    cleans up the old path — exactly like any other real removal. The head
    worktree is updated **in place** (`updateWorktree`: `git checkout
    --detach <sha>` inside the existing worktree directory, falls back to
    the existing hard-rebuild `ensureWorktree` if that fails) instead of
    the previous remove+recreate — which was fine for a manual, occasional
    ingest but too heavy for a cadence that can fire every minute.
    **Base SHA changed** (e.g. a rebase onto a newer `develop`) makes an
    incremental diff against the old base unsafe; then the Activity falls
    back to the **full** existing ingest pipeline (`prepareIngestWorktrees`
    + `scanAndStoreIngestBlocks`, exactly the same full swap as a manual
    `POST /api/ingest`) — `ingestResult.FullFallback` marks that in the
    workflow history.
  - **`pr_ingest` table** (`db.go`, `schemaDDL`): `pr → base_sha, head_sha`,
    updated by **both** a full ingest (`scanAndStoreIngestBlocks`) and a
    delta refresh, so the poller always knows where the next refresh
    should diff from. Empty (no row) means "never ingested" — the
    poller/Activity then do nothing (a refresh requires a prior full
    ingest).
  - **Relations/callresolve keep being recomputed "in full", not delta-scoped:**
    after a successful (non-`Skipped`) refresh, `prStatusWorkflow` simply
    calls the existing `buildRelations` Activity (the same Activity that
    `build_relations` also uses) — over the PR's **full current** block
    list (`blocksByPR`, a DB read, no re-parse). Deliberate choice: the
    cost of `buildRelations`/`resolveCalls` already scales with PR size
    (not repo size), and `resolveCalls` builds a whole-worktree symbol
    index anyway regardless of how many blocks you feed it — so
    delta-scoping *which* blocks barely saves anything, while a relation
    between two separate, unrelated files (`event_listener`: dispatcher in
    file A, listener handle in file B) gives a partial keep-set an actual
    risk of stale/vanished relations. With the **full** block list as the
    keep-set, `relations.Replace`/`callresolve.Prune`/`UpsertGo` can never
    prune a valid row of an unchanged file, and `UpsertGo` never touches a
    `searching`/`found` row (LLM-owned) anyway.
  - **Comment/approval anchors are RE-ANCHORED on every refresh
    (`reanchorAfterRefresh` Activity + `reanchor.go`), before the relations
    rebuild.** A comment's `row_start`/`row_end` and an approval's approved row
    indices are positions in the **aligned-row space** of a block
    (`blockAlignedRows`, `blockstats.go`), and a refresh rewrites exactly that
    space for the files it re-scanned. Leaving those read-models untouched (which
    `upsertPRFileBlocks` deliberately does — see `db.go`'s own note) therefore
    preserved the *rows* but not their *meaning*: a comment kept pointing at an
    index that now held different code (its 💬 marker landing on the wrong line,
    and in diff mode it only resurfaced if the cursor happened to land on a unit
    containing the stale range), and an approval re-applied its emerald ✓ to
    whatever took that index — so a line inserted above an approved line silently
    inherited its approval. Neither was recoverable by hand.
    - **A comment carries its own snapshot** of the code it was placed on
      (`comments.Code`, built from whole aligned rows by `commentTarget` in
      `home.mjs` — the same side choice as `rowDisplayText`), so re-anchoring is a
      search for that snippet in the new rows, **whitespace-insensitively** (via
      the existing `wsKey`, matching how `diffLines` itself pairs lines, so a pure
      re-indent still finds its row). Blank/filler rows are skipped inside a
      multi-line match.
    - **An approval stores no text**, only indices — which is exactly why the pass
      needs the PREVIOUS sides. `refreshIngestDelta` therefore reports
      `PrevBaseSHA`/`PrevHeadSHA`/`ChangedFiles` on its `ingestResult` (it already
      computed all three; reading them back from `pr_ingest` afterwards is
      impossible — the refresh has overwritten those rows — and wouldn't be
      replay-safe either), and `planReanchor` materializes those two revisions of
      just the touched paths into a throwaway **shadow worktree pair**
      (`showFileAtSHA` → `git show <sha>:<path>`, stdout only — `runGit`'s
      `CombinedOutput` would splice stderr into the file content) so
      `blockAlignedRows` can be reused verbatim on a historical revision. The real
      head worktree is no help: `updateWorktree` has by then checked it out to the
      new SHA in place.
    - **It degrades instead of guessing.** No match, or several (a snippet like a
      bare `}` occurs all over the block) → the comment **unpins**: `row_start`
      back to `-1`, i.e. the pre-existing "block known, row unknown" convention, so
      it shows anywhere within its block and claims no 💬 row. The symbol gone
      entirely (renamed/removed/file dropped) → **`AnchorOrphan`**, keeping the old
      rows as a record of where it was. An approved row whose text can't be found
      unambiguously is **dropped** — the reviewer did not approve what replaced it,
      and that needs no new state (the row is simply unapproved again).
    - **A `'call'` anchor** addresses character offsets *within* its row
      (`segKey`'s `"r:<min>-<max>"`, `home.mjs`), so it only survives while that
      row is **byte-identical**; otherwise it degrades to `gran: 'line'` with no
      segment — still the line the reviewer picked, one granularity coarser. Note
      `dedent4` is computed over the old/new **pair**, so the shared indent can
      change between refreshes; that too shows up as a non-identical row and thus a
      demotion. Deliberately accepted: safe degradation, not a wrong anchor.
    - **An anchor that still resolves to the same rows produces no update at all**
      (`appendAnchorChange` compares against what's stored), so a repeated refresh
      costs no Signals and no writes — the common case for a commit touching files
      nobody has commented on.
    - **Write path:** planning is a read (the read-models, the blocks table, the
      worktrees, `git show`); applying goes through the sanctioned paths only — a
      new **`"reanchor"` action on the existing `reply` Signal**
      (`ReactionSignal.Action`, alongside `""`/`"delete"`/`"avatar"`, carrying an
      `Anchor` payload) to each comment's own Execution → the
      **`saveCommentAnchor`** Activity → `comments.Module.SetAnchor`, and the
      approve tracker's **existing `set` Signal** per remapped block (no new
      signal needed there at all). So each moved anchor lands in its own comment's
      replayable history. `SetAnchor` also rewrites the `codeRef` segment of the
      comment's `Path` (rebuilt via `commentPath`, not string-patched, so the two
      can't drift) — otherwise a prefix `Search` would address rows the anchor no
      longer sits on.
    - **Plan and apply share ONE Activity**, mirroring `supersedeFileWarnings`
      (which likewise lists comments and signals each of them). Returning the plan
      and looping in the workflow body would put a variable number of Signal sends
      in the body — replay-safe only *because* it's driven off a recorded result;
      one Activity is simply a fixed position in the history and needs no such
      argument. Best-effort per anchor: a comment whose Execution already completed
      can't be signalled again, and that must not sink the rest of the pass.
    - **The full-fallback path is covered too** (base SHA moved → `replacePRBlocks`):
      `ChangedFiles` is then every path of the PR, not just a delta.
    - **`comments.anchor_state`** (`''` | `'unpinned'` | `'orphan'`, light
      `ALTER TABLE … ADD COLUMN`) carries the outcome to the frontend as
      `anchorState`. It is deliberately separate from `Kind`: an orphan is still a
      block-scoped review comment, and flipping its `Kind` to a PR-wide one would
      change how its replies mirror to GitHub (`isPRWide`). See "Comment-index
      items" in `.claude/rules/detail-layout.md` for how an orphan surfaces as its
      own navigable "Start" row instead of being lost.
    - **The UI cannot move an anchor**, by design: the generic reply-signal handler
      (`tasks_api.go`) decodes only `author`/`body`/`done` and drops
      `action`/`anchor`. That also means a Playwright spec can't drive this state
      through the API — hence `slash seed -comments <json>` (mirror of the four
      existing seed paths), used by `tests/comment-orphan-anchor.spec.mjs`.
    - Tests: `reanchor_test.go` (shift, no-op, edited-code → unpinned, ambiguous →
      unpinned, re-indent → still pinned, symbol gone → orphan, renamed file
      matched via `oldPath()`, call-segment preserved vs. demoted, approvals
      remapped/dropped/left-alone, the `reanchor` Signal end to end),
      `blockstats_test.go`'s `TestRowForLineSharesRowSpaceWithApproveTotal`, and
      `tests/comment-orphan-anchor.spec.mjs`.
- **`pr_inbox` workflow (per repo):** a third Workflow Type that owns the PR
  inbox — it's the **only one** that reads GitHub for the overview. A
  `refresh` Signal (from the UI on load and from `pollInbox` on the
  heartbeat cadence) drives the `refreshInbox` Activity, which fetches the
  inbox and writes it into the **`inbox` module** (read model).
  `EnsureInbox` starts/reuses one Execution per repo and does a synchronous
  first refresh at startup. See `.claude/rules/pages-and-routing.md`
  (section "PR inbox").
- **Storage:** the tembed engine uses `MultiStore(SQLite data/workflows.db,
  JSONL data/workflows/)` — comments thus live both in the workflow
  history and in **jsonl files**. The comments module also keeps its own
  read model on top of that.
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/task_code_comment` (start),
  `GET` (list), `POST /api/workflows/{runID}/signals/reply` (UI reaction),
  `POST /api/workflows/{runID}/heartbeat` (UI heartbeat, no state write),
  `GET /api/workflows/{runID}` (status), and read-only `GET /api/comments?pr=N`
  (or `?path=<prefix>` for the hierarchical prefix search over comment
  paths). Read-only `GET /api/workflows?pr=N` (note: **without** a trailing
  slash, so a different pattern than `/api/workflows/`) gives
  `{ok,runs:[...]}` — **every** workflow run for that PR (`RunsForPR` in
  `tasks_api.go` filters `engine.Runs()` on the `pr` field in each run's
  stored input, so `pr_inbox` — per-repo, no `pr` field — naturally falls
  out), newest `updatedAt` first. Every `task_code_comment` run also
  carries a nested, optional `comment` field (`WorkflowRunView.Comment`, a
  `*CommentRef`): `RunsForPR` parses the run's own (immutable) `Input`
  again as `CodeCommentInput` and fills in
  `{file,label,gran,line,rowStart,rowEnd,snippet}` — `snippet` is `Body`
  truncated at a word boundary (`commentSnippet`, ~60 characters + `…`).
  `RunID` (== the comment's id, see above) is already on the outer view.
  Feeds the "Taken" block (`workflows-panel`, `TasksPanel` in
  `RelatedPanel.mjs`, under the PR-description column), see
  `.claude/rules/detail-layout.md`: the per-row description and the
  click-through-to-the-comment (`openTask` in `home.mjs`) rely on this field.
  For PR metadata: `POST /api/workflows/pr_status {pr}` (ensure the
  tracker, which synchronously runs the three stages) + read-only
  `GET /api/pr?pr=N` (reads the `prmeta` read model: `{ok,pr,title,url,
  updatedAt,body,author,additions,deletions,changedFiles,headRef,summary,
  jiraKey,jiraTitle,jiraDesc,jiraUrl,reviewDecision,checksTotal,
  checksPassed,reviewers}`; `{ok:false}` as long as nothing has been
  fetched yet, and a field of a not-yet-run stage is simply at its
  zero-value). For the inbox: `POST /api/workflows/{runID}/signals/refresh`
  + read-only `GET /api/inbox` (reads the `inbox` read model).
  Bootstrap + recovery + resuming pollers + `EnsureInbox`:
  `newTasks(ctx, db, dataDir, repo)` in `tasks_api.go`, called from
  `runServe`.
- **Adding a new workflow or module:** skills `add-workflow` / `add-module`
  (+ templates `.claude/templates/workflow.go` / `module.go`).
- Tests: `workflows_test.go` (UI reaction + gh-poll→signal + resolve, a
  restart durability test, `pr_status`-stops-on-merge, heartbeat-keeps-fast,
  `pr_status`-fetches-PR-meta, plus `pr_inbox`-refresh-fills-read-model);
  `tests/pr-menu.spec.mjs` (Playwright: the `/` menu and its submenus);
  modules are pure and independently testable.

## Importing existing GitHub comments (living threads)

Comments placed **outside the app** on the PR (or before ingest) don't
automatically show up in the `comments` read model — the app only knew
about comments it placed itself via `task_code_comment`. The import pulls
them in and turns them into **full, living threads** (replying mirrors to
GitHub, GitHub replies get polled in), instead of read-only copies.

- **Fetch (`modules/github`):** `FetchReviewComments(pr)` returns the
  **thread roots** of the diff review comments (`in_reply_to_id == 0`,
  paginated via `apiPaginate`); `FetchGeneralComments(pr)` returns the
  **PR-wide** comments without a file:line — the issue conversation
  (`issues/{pr}/comments`) and the non-empty bodies of submitted reviews
  (`pulls/{pr}/reviews`, `Kind` `issue` resp. `review_summary`). Replies to
  an imported root then come in via the existing `FetchReplies` path.
  `github.Fake` has `SetReviewComments`/`SetGeneralComments` for tests.
- **Mapping (`comment_import.go`, package main — reads the head/base
  worktree, so a read-only side effect like `blockstats.go`/`/api/code`):**
  `mapReviewComment(dataDir, pr, blocks, gc)` maps a review comment's
  `file:line(+side)` to a block + **aligned-row anchor** in **exactly the
  same** index space as approvals/app comments (`dedent4` → `alignRows` +
  `rowForLine`, which counts the source line on the chosen side to its row
  index from the block's `Start`). If it finds the block + the row → a
  normal block-scoped line comment (`Kind ""`); if it finds the block but
  not the exact row → `RowStart -1` (shown anywhere within the block, the
  existing "unknown anchor" convention); if it finds **no** block →
  **PR-wide** (`Kind "review"`, empty `Label`). `mapGeneralComment` always
  produces an anchorless PR-wide input (`Kind` `issue`/`review_summary`).
  All three carry `ImportedRootID`/`Source "github"`/`Author`/`CreatedAt`
  (the original GitHub timestamp). LEFT-side (removed line) comments match
  the block via its **old** source range (base worktree), since the stored
  `Line`/`EndLine` are head coordinates.
- **Workflow branch (`taskCodeCommentWorkflow`):** `CodeCommentInput` got
  `ImportedRootID`/`Source`/`Kind`/`CreatedAt`. The posting choice is
  input-driven (so replay-deterministic) in **four** cases: **imported**
  (`ImportedRootID != 0`) → **skip posting** but set
  `posted.RootID = in.ImportedRootID` (the comment already exists on
  GitHub — never re-post), so the reply poller runs and UI replies do
  mirror to the real thread; **local** (private note) → `RootID 0`, all
  GitHub calls no-op; **PR-wide, freshly created** (`isPRWide(in.Kind)`, not
  imported, not local — the case `convertPrWideWarningToComment` introduced,
  see "Converting an AI-controle finding into a real comment" in
  `detail-layout.md`) → post it as a new **issue** comment
  (`postGithubIssueComment`, best-effort — it never returns a Go error
  itself) instead of `postGithubComment`, since a PR-wide comment has no
  reply thread on GitHub and, unlike a review-diff comment, no file:line
  guaranteed to still sit on a line the current diff covers (a plain
  `postGithubComment` attempt would often simply fail for it, which — unlike
  the reactions loop's own best-effort mirrors below — would abort the whole
  workflow); **normal** (block-scoped) → post as a review comment
  (`postGithubComment`) + record `RootID`. `saveComment`
  stores `Source`/`Kind`/`CreatedAt`. Right after this switch, a further
  **`saveCommentGithubID`** Activity persists whatever `posted.RootID` ended
  up being into the comment's own `github_id` column (see the `github_id`
  paragraph in "The first slash task" above) — so this also covers the
  **normal** (in-app, non-imported) case, not only an import.
- **Reply loop per thread kind (`isPRWide(kind)` = `issue`/`review_summary`/
  `review`):** echo prevention unchanged (only `Source == "ui"` mirrors to
  GitHub, `github`-sourced replies don't), but the **mirror path** depends
  on the thread:
  - **Review-diff thread** (`Kind ""`): a **real** reply body mirrors as a
    **review reply** (`replyGithub` → `pulls/{pr}/comments/{rootId}/replies`). A
    **resolve** (`Done`) resolves the conversation **on GitHub** (Activity
    `resolveGithubThread` → `github.Client.ResolveReviewThread`, which uses
    `gh api graphql` to look up the review thread node ID from the
    root comment's `databaseId` and runs the `resolveReviewThread`
    mutation). The **`"/resolve"` sentinel body** (sent by a bare resolve,
    see `resolveFocusedComment`/`sendReaction` in `RelatedPanel.mjs` and
    the `COMMENT_COMMANDS` "Resolve comment" item) is **never** posted as
    text — the reply loop only posts a non-empty, non-sentinel body
    (`body != "" && body != "/resolve"`), and then (if `Done`) resolves the
    thread. Determinism stays intact: the number of `ExecuteActivity` calls
    depends purely on the Signal input (`r.Body`/`r.Done`).
  - **PR-wide thread** (`isPRWide`): PR-wide comments (issue comments/review
    summaries) have **no reply thread** on GitHub — a reply is therefore
    mirrored as a **new issue comment** on the flat PR conversation
    (`postGithubIssueComment` → `github.PostIssueComment` →
    `issues/{pr}/comments`). That Activity returns the new comment id as
    `postResult` so it ends up in the history (for the dedup below). A
    **resolve** (`Done`) on a PR-wide thread is **local only**: GitHub has
    no concept for it, so the workflow never touches GitHub (`if !r.Done`)
    — `saveReaction` just sets the read-model status to `resolved`.
- **Dedup against the app's own comments (`knownGithubIDs`):** `importPRComments`
  fetches **all** GitHub comment roots — **including** the ones the app
  itself placed (an app review comment, or a PR-wide reply that was posted
  as an issue comment). Without dedup that would create a duplicate (the
  app run has no `gh-<id>` Run ID, so `StartWorkflowID` idempotency doesn't
  catch it). `knownGithubIDs(pr)` therefore scans all `task_code_comment`
  runs of the PR and collects their known GitHub ids — `input.ImportedRootID`
  + every `postGithubComment`/`postGithubIssueComment` result from the
  history — and `importPRComments` skips a comment with a known id.
  Everything durable (history/input), so restart-safe. O(runs), same scale
  as `ResumePolling`.
- **Importer glue + poller (`workflows.go`, cadence piggybacking on `pr_status`):**
  `importPRComments(ctx, pr)` reads the blocks (DB), fetches review +
  general comments (reads-in-glue, like `poll`/`pollInbox`), maps them, and
  starts one Execution per comment with `StartWorkflowID("gh-<id>", …)` —
  the **only write**, made idempotent by the deterministic Run ID.
  `pollImportComments(ctx, prRunID, pr)` runs one import immediately and
  then on the heartbeat cadence (mirror of `pollIngestRefresh`: fast
  within `heartbeatWindow`, otherwise slow), and stops once the
  `pr_status` tracker is done (merged/closed). Started alongside
  `pollIngestRefresh` in `ensurePRStatus` (new tracker) and
  `ResumePRStatusPolling` (after a restart). For each imported
  **review-diff** thread (not PR-wide) it starts the per-thread reply
  `poll`; an in-memory `importPolled` set (dedup, operational —
  reconstructed by `ResumePolling` after a restart) prevents a second
  poller per run on a subsequent import tick.
- **Restart (`ResumePolling`):** the root ID of an imported thread lives in
  the **input** (`ImportedRootID`), not in a `postGithubComment` history
  event (there isn't one), so `ResumePolling` reads it from there and marks
  the run in `importPolled`.
- **Note — reply dedup relies on the DB, not on the poller's `seen` map:**
  the per-poller `seen[replyID]` map (in `poll`) is a speed cache that
  starts empty on restart; that's safe because `comments.AddReaction` does
  an **`INSERT OR IGNORE`** on the reaction id (`gh-<id>`) and only bumps
  the count for a genuinely new row ("already recorded — no double
  count"). Restart → poller re-signals all replies → no double counting.
  This same contract makes the `StartWorkflowID` dedup and the `seen`
  reset together restart-safe; keep it intact.
- **Read model & frontend:** `comments.Comment` got `Source` (`ui`/`github`)
  + `Kind` columns (light `migrate`, `ALTER TABLE … ADD COLUMN`). `GET
  /api/comments?pr=N` serves the imported comments automatically — no new
  endpoint. The frontend badges `source: github` and shows the PR-wide
  comments (`Kind != ""`) in their own block under the PR-info column (see
  `.claude/rules/detail-layout.md`), separate from the block-scoped
  comments sidebar.
- Tests: `comment_import_test.go` (mapping anchor + PR-wide degradation +
  general; `importPRComments` fills the read model with `source github`,
  **never re-posts**, and is idempotent on re-import; an imported thread
  mirrors a UI reply and doesn't echo a GitHub reply; a restart resumes the
  poller via the input root ID), `modules/comments/comments_test.go`
  (`Source`/`Kind` round-trip), `tembed/engine_test.go` (`StartWorkflowID`
  idempotency).

## Relations between blocks (`build_relations` + `modules/relations`)

A fourth Workflow Type, **`build_relations`** (one Execution per PR),
derives **many-to-many relations** between blocks — the call-graph edges,
but meaning-driven instead of textual. The first relation `kind`:
**`event_listener`** — a changed block that dispatches an event becomes the
**parent** of the `Listener::handle` for that event, **provided that handle
is itself also changed** in this PR (both sides must change for a link).

- **`modules/relations`** (`data/relations.db`): the read model,
  `relations(pr, parent_id, child_id, kind, line)` (block id =
  `<pr>:<file>:<symbol>`). `line` is the **absolute source line, within the
  parent's own text**, where the detector found the trigger for this
  relation (a dispatch call, a route action, a type-hinted param, …) — the
  frontend uses it to reorder the Underlying Code panel around the
  `group` unit the reviewer selected (see `groupLineRange`/
  `relatedChildren` in `home.mjs`, and the "Underlying code" section in
  `.claude/rules/detail-layout.md`); `0` for a row from before this field
  existed (an old row that only gets a real value at the next rebuild).
  Write `Replace(pr, rels)` (workflow-only, full swap per PR → replay-safe),
  read `List(pr)`. `kind` keeps the table open for later relation types. A
  light `migrate` adds `line` to an existing DB (`ALTER TABLE … ADD
  COLUMN`, duplicate-column error ignored — the same pattern as the
  comments module).
- **Analysis service `relations.go`** (package main, not a module — reads
  the head worktree = side effect): `buildRelations(dataDir, pr, blocks)`
  runs a list of **detectors** (now `eventListenerDetector` +
  `providerListenerDetector` + the five Laravel detectors below). The
  event→listener map robustly comes from three sources (union): the
  `handle(EventType $e)` type hint, the `$listen` array in a
  `*ServiceProvider.php`, and `Event::listen(...)` calls; dispatch sites
  are scanned per block body (`event(new X`, `X::dispatch(`, …). Reuses
  `extractBlockSource` (code.go) to read block bodies. `blockText(headDir,
  b)` no longer returns just text but the full `codeSide` (text + the
  absolute start line `Start` of a **fresh** scan — not `b`'s own,
  possibly stale `Line` field): each detector converts the byte offset of
  its regex match within that text to an absolute file line via
  **`matchLine(text, match, fromLine)`** (counts the `\n`'s up to the
  first occurrence of the matched text) and passes that along to
  `emit`/the relation itself. Purely additive — no detector behavior
  changed, just an extra line anchor recorded;
  `TestBuildRelationsLaravelChainCapturesLine` (`relations_test.go`)
  verifies it against an independent scan of the fixture source.
  **`providerListenerDetector` is the mirror image of `eventListenerDetector`:**
  the latter only finds the parent via a **dispatch site** in a changed
  block (`event(new X`, `X::dispatch(`, …) — a `*ServiceProvider` that only
  registers (never dispatches itself) thus never produced a parent, even
  if its own `$listen` registration for a changed listener in the PR
  changed (e.g. a new `OrderCreated::class => [SyncOrderFlow::class]`
  line). `providerListenerDetector` covers exactly that case: for each
  changed `<class-header>` block (`classHeaderSentinel`, see
  `blocks-and-ingest.md`) of a `*ServiceProvider.php` file, it scans **its
  own** block text (not the repo-wide `providerEventMap` file scan) with
  the same `reListenBlock`/`reListenEntry` regexes, and for every
  `Listener::class` entry that is itself a changed `handle()` block
  (`changedListenerHandles`, extracted from `eventListenerDetector` so
  both detectors share it), the **ServiceProvider itself** becomes the
  parent (`relations.KindEventListener` — not a new kind, the child is
  still "the listener", regardless of whether the parent dispatches or
  registers it). Still both-changed: no edge if the listener isn't itself
  a changed block. Tests: `TestBuildRelationsProviderListener`/
  `TestBuildRelationsProviderListenerBothSidesRequired` (`relations_test.go`).
- **Laravel request chain** — five extra **`kind`s**, all **both-changed**
  (like `event_listener`: an edge only appears if both blocks change in
  this PR; unchanged files are never injected as a node, and the
  highest level that **does** change automatically becomes the tree root
  since `recomputeLeftList` sorts each relation child to the bottom of the
  left-hand list, under the "Onderliggende code" heading).
  The head worktree may be read freely for the mapping (like
  `providerEventMap` reads unchanged ServiceProviders). Middleware is
  **deliberately out of scope**. The detectors share `blockIndex`
  (changed new-side blocks per short class name), `blockText` (reads a
  block body; for the whole-file `ROUTE` fallback, the whole file) and
  `edgeEmitter` (dedup):
  - **`route_controller`** (`routeControllerDetector`) — a changed route file
    (whole-file `ROUTE` block) → the changed controller methods it calls:
    array-callable `[X::class, 'm']`, string-callable `'Ns\X@m'` (namespace
    prefix ignored via `shortName`), and resource routes
    `Route::(api)resource('p', X::class|'X')` (including the old string
    controller form) → **every** changed CONTROLLER method of that class.
  - **`controller_request`** (`controllerRequestDetector`) — a changed
    controller method → the changed `XRequest` block from a type-hinted
    parameter (`\w+Request \$`) → all changed REQUEST methods of that class.
  - **`controller_resource`** (`controllerResourceDetector`) — controller
    method → the changed API Resource it builds/returns: `new XResource(`,
    `XResource::make|collection(`, or the return type `): XResource`.
  - **`controller_model`** (`controllerModelDetector`) — controller method →
    the changed route-model-bound `Model` block from a type-hinted
    parameter (`ProductGroup $productGroup`), filtered on the MODEL
    category so Request/Resource/interfaces drop out → **all** changed
    methods of that model class (agreed granularity: a model param names a
    class, not a method).
  - **`request_policy`** (`requestPolicyDetector`) — a changed
    `FormRequest::authorize` → the changed Policy method it checks:
    `->can('ability', XPolicy::class)` (and the array form `[XPolicy::class,
    …]`), where the **ability** is the Policy method (`can('show', …)` →
    `XPolicy::show`). A `Model::class` ref resolves to its Policy via the
    `$policies` map in a `*ServiceProvider` (`policiesMap`), with the
    `{Model}Policy` convention as fallback. `POLICY` is a new category
    (`classify.go`, `app/Policies/`); `isPolicyBlock` falls back to
    path/`Policy` suffix so a not-yet-re-ingested block also matches.
- **Workflow** (`workflows.go`): `buildRelationsWorkflow` runs the
  `buildRelations` Activity once at start (synchronously in `StartWorkflow`)
  and again on every **`rebuild`** Signal. `EnsureRelations(ctx, pr)`
  (mirrors `ensurePRStatus`) starts/reuses one Execution per PR; **after a
  successful ingest** `handleIngest` (`api.go`) calls it.
- **Endpoints:** read-only `GET /api/relations?pr=N` (reads the read
  model); `POST /api/workflows/{runID}/signals/rebuild`. Block JSON now
  carries a computed **`id`** (`model.go` `MarshalJSON`) so the frontend
  can match `parentId`/`childId` to blocks.
- **Frontend:** `home.mjs` loads the relations in `loadBlocks`, splits
  `state.blocks` (top-level = `allBlocks` minus children) from
  `state.allBlocks`; the sidebar + navigation run on `state.blocks`,
  children render in the **Underlying code** card (see
  `.claude/rules/detail-layout.md`). `childrenOf` carries the relation
  `kind` per child (`{ block, kind }`, no longer hardcoded to
  `event_listener`) so `relatedChildren` passes it through and
  `KIND_LABEL` (`RelatedPanel.mjs`) shows the right badge — the badge
  names the **role of the child** as seen from its parent
  (`route_controller`→"controller", `controller_request`→"request",
  `controller_resource`→"resource", `controller_model`→"model",
  `request_policy`→"policy"). The chain nests for free via drill (a
  child that is itself a PR block gets its own Underlying Code panel):
  route → controller → request/resource/model, and request → policy.
- Tests: `relations_test.go` (event: detector with both mapping sources,
  the both-sides requirement, module round-trip, and the workflow
  end-to-end; Laravel: `TestBuildRelationsLaravelChain` (all five edges +
  the array/string/resource route forms), `TestBuildRelationsLaravelBothSidesRequired`
  (no policy block → no `request_policy`; no route block → no
  `route_controller`, but the controller-downstream edges still fire), and
  `TestBuildRelationsLaravelWorkflow`); `tests/relations.spec.mjs`
  (Playwright: child out of the list, but in the panel — seeded via
  `slash seed -relations`).

## Resolving (also unchanged) called methods (`resolve_call` + `modules/callresolve` + `modules/claude`)

Besides the meaning-relations, the **Underlying code** card also links the
**method calls** a changed block makes to their **definition** — even if
that method is in a file the PR did **not** change (e.g. `joinAddress`
from `->joinAddress('contract')`). Two layers: a Go resolver first, an LLM
as fallback.

- **Why a separate read model, not the `relations` table:** these children
  point to unchanged files (so their block id is not a PR block the
  frontend knows), and `relations.Replace` does a full swap per PR — an
  expensive LLM resolution would disappear on a rebuild. Hence a dedicated
  module.
- **`modules/callresolve`** (`data/callresolve.db`): the read model
  `call_resolutions(pr, caller_id, call_key, status, child_*, model,
  confidence, updated_at)`, PK `(pr, caller_id, call_key)`. `status`:
  `resolved` (Go), `unresolved` (Go failed → automatic LLM search),
  `searching`/`found`/`notfound` (LLM). The row carries the **full child
  descriptor + the code text** (`child_code`), so the frontend renders
  without a separate code fetch. Writes (workflow-only): `UpsertGo`
  (writes Go rows, but **never overwrites** a `searching`/`found` row → LLM
  wins over a rebuild), `SaveSearching`, `Save`, and `Prune(pr, keep)`
  (removes any row whose `(caller_id, call_key)` pair is not in the
  current Go scan — the caller has fallen out of the PR or the call site
  is no longer on a changed line; this also cleans up LLM rows, since the
  call site is gone). Read: `List(pr)`. The `buildRelations` Activity calls
  `Prune` after `UpsertGo` with the just-scanned entries as the keep set.
- **Analysis service `callresolve_analysis.go`** (package main, not a
  module — reads the head worktree): `resolveCalls(dataDir, pr, blocks)`
  builds one worktree-wide index via `buildSymbolIndex` (class→methods,
  method→blocks, Eloquent scope alias `scopeX→x`, enums) and scans each
  changed new-side block with regexes (pattern from `dispatchedEvents`).
  **`idxSkipDirs` only skips genuinely vendored/generated directories**
  (`vendor`, `node_modules`, `.git`, `storage`, `public`) — deliberately
  **not** `tests/`: a custom test base class (`tests/TestCase.php`,
  `tests/HttpTestCase.php`) or a shared trait is just as much app code, and
  was previously wrongly excluded from the index. Without that candidate
  the Go resolver could never pin a call to such an inherited test helper
  itself (rule 1's `$this->m()` check only looks at the own class, not
  through inheritance) and needlessly escalated every such call all the
  way to the expensive agentic Sonnet pass, which found it via `Grep`
  anyway. Purely additive: a unique match can never become more ambiguous
  than before. See `TestResolveCallsTestHelperClassIndexed`. **Only the
  changed lines** of the block are scanned: `changedNewLines` diffs
  base↔head per file (`git diff --no-index --unified=0`, parsed with the
  ingest's `parseUnifiedDiff`, new-side sets unioned because `--no-index`
  yields two absolute paths; a missing base file → everything counts as
  changed). A call on an unchanged line thus never produces a child —
  that gave unrelated "Underlying code", e.g. a builder's `->join(` on an
  old line that uniquely matched a coincidental app method
  (`MerchantController::join`). Resolves `$this->`/`self::`/`static::`
  (own class), `Foo::m(`/`(new Foo)->m(` (class in the call),
  **`$var->m(` via the receiver variable name** (rule 3b:
  `$order->billingAddress()` → `Order::billingAddress`, even if that
  method exists on multiple classes; including the scope form — the same
  heuristic that `resolvePrompt` teaches the LLM; note: the call key is
  the bare method name, so two receivers calling the same method within
  one block collapse onto the first match), and `->m(` on a **unique**
  global or scope match. Ambiguous (>1 candidate) → `unresolved`; methods
  that don't exist anywhere in the app worktree (vendor is skipped —
  framework calls like `->where(`) also become **`unresolved`**: by
  definition they're on a changed line, so the automatic LLM search picks
  them up instead of showing nothing.
  **Enum cases** (rule 6, `reStaticRef`): a `Foo::NAME` **without
  parentheses** — `AddressType::BILLING` — resolves to the **enum
  declaration** if `Foo` is an indexed enum that defines that case/const
  (`scanEnums` turns each enum into a synthetic block, à la macros; code
  via `blockSource` line-slicing; `child_method` = the case name, so the
  label becomes `AddressType::BILLING`). `Foo::class` and constants on
  non-enum classes are ignored; the same case on multiple enums →
  `unresolved`. The frontend's `findCallSites` therefore matches `::name`
  in addition to `name(` and `->name`.
  **API Resource `toArray()`** (rule 7, reuses relations.go's `reResourceUse`/
  `reResourceReturn`): a Resource used on a changed line (`new XResource(`,
  `XResource::make|collection(`, or a `): XResource` return type — the same
  forms `controllerResourceDetector` matches) also surfaces that Resource's
  own `toArray()` method as underlying code, since that's where a Laravel
  API Resource actually defines its output — even when the Resource class
  itself is **not** changed in this PR (the common case, unlike
  `controllerResourceDetector`'s both-changed relation, which then finds
  nothing). Deliberately a callresolve rule for that reason, mirroring
  `resolveMigrationModels`/`resolveDataProviders` below. Call key
  `"resource:" + class` (contains `:`, so — like `migration_model:`/
  `data_provider:` — it never matches a real call-site literal in
  `findCallSites`, shows at group/list level, and never collides with rule
  2b's plain class-name constructor key); `Kind` stays the default
  `method_call` (no special badge — renders exactly like any other resolved
  method call). A Resource that doesn't override `toArray()` (uses the
  framework default) silently yields no child, never an `unresolved` row —
  not an ambiguity for the LLM, just an absence.
  `reResourceUse`/`reResourceReturn` also match a **versioned/collection**
  class-name suffix — `AffiliateResourceV2`, `AffiliateResourceCollection`,
  `AffiliateResourceCollectionV3` (`(?:Collection)?(?:V\d+)?` right after
  the required `Resource`) — not just the plain `XResource` form; the
  suffix is anchored immediately before the `(`/`::`/return-type boundary,
  so a class merely containing "Resource" followed by an unrelated word
  (`ResourceManager`, `ResourceController`) still never matches. This
  extension automatically applies to `controllerResourceDetector`
  (relations.go) too, since both share the same two regexes.
  **Eloquent magic properties** (rule 5, `reArrowProp`): a `->name`
  **without parentheses** — `$order->billingAddress` — is Laravel syntax
  for the relation **method** `billingAddress()`. We treat it as a call if
  `name` matches a method whose body is a **relation** (`return
  $this->morphOne/hasMany/belongsTo(...)`, `reRelationCall` +
  `relationshipCandidates`) — so bare attribute access (`->id`, `->total`)
  stays ignored: first rule 5a tries the **receiver variable name**
  (`$order->billingAddress` → `Order::billingAddress`, even with multiple
  models having that relation), then rule 5 generically: unique →
  `resolved`, multiple models → `unresolved` (LLM picks the right model).
  Runs after rule 4, so a real `->name()` call wins the key. The frontend
  links such a property segment to the child via `findCallSites`, which
  besides `name(` also matches `->name` (property). The LLM prompt
  (`resolvePrompt`) explains to Haiku/Sonnet that `->name` and `name()`
  are the same target and that the receiver variable name (`$order` →
  `Order`) reveals the right model.
  **Laravel macros** are also indexed (`scanMacros`, called in
  `buildSymbolIndex`): a `Receiver::macro('name', function (…) {…})` — e.g.
  `Builder::macro('joinAddress', …)` in a `*ServiceProvider` — is an
  anonymous closure **inside** a boot method and thus invisible to
  `ScanBlocks` (`skipBody` swallows the whole method body, including the
  macro registration). We detect the registration with a regex
  (`reMacroDef`) and turn it into a synthetic block (`Class` = the
  receiver, `Name` = the macro name), so a `->joinAddress(` call resolves
  via rule 4 as a normal unique method. The code for such a macro comes
  via `blockSource` (code.go): the symbol lookup fails (the block is
  nested, not top-level), so it falls back to line-slicing on the stored
  `Line`/`EndLine`.
  **Artisan commands** (rule 3c, `reCommandCall`): a scheduled
  `$schedule->command('accounting:import --provider=…')` call resolves to
  the **`handle` method of the command class**. `buildSymbolIndex` builds
  a `commands` map for this: `scanCommands` reads every `protected
  $signature = 'name …'` (only `$signature`, command-specific), takes the
  **first token** as the command name, and links it to the `handle` block
  of the same file. The **call key is the command name**
  (`accounting:import`), not `command`, so different scheduled commands
  stay separate children; the generic `->command(` arrow call is
  suppressed (`seen["command"]`). A command with no app class (framework,
  e.g. `queue:work`) becomes `unresolved`. The frontend's `findCallSites`
  matches a command key (contains `:`/`-`, so never a method identifier)
  via the **string literal** `command('name…')` instead of the identifier
  forms.
  **Laravel facades** (rule 3, fallback on `reStaticCall`): a facade
  forwards its static calls to its accessor class, so
  `AccountingClient::providers()` actually runs on
  `AccountingDriver::providers()`. `buildSymbolIndex` builds a `facades`
  map (facade short name → accessor short name) with `scanFacades`: it
  detects `class X extends …Facade` (`reFacadeClass`) plus
  `getFacadeAccessor() { return Y::class; }` (`reFacadeAccessor`) and links
  X→Y (positionally paired — a facade file contains one facade + one
  accessor). In rule 3, a `Foo::m(` that doesn't resolve on `Foo` itself
  falls back to `methodOnClass(accessor, m)` if `Foo` is an indexed
  facade. A method that also doesn't exist on the accessor (e.g. the
  framework's `Manager::forgetDrivers()` after `providers()`, vendor is
  not indexed) stays `unresolved` → automatic LLM search.
  **Eloquent model as a whole** (rule 2c, `new Model()`/`Model::…`): if a
  controller/service uses an Eloquent model (`new ProductGroup()`,
  `ProductGroup::query()` — e.g. followed by `->fill()`/`->save()`), the
  reviewer wants to see **the model itself** as Underlying Code, not its
  constructor or a stray inherited Eloquent method (`fill`/`save`/`query`
  are never defined in the app and stay plain `unresolved`, unchanged).
  `buildSymbolIndex` indexes every file under `app/Models/`
  (`hasSeg(rel, "app/Models/")`) with `scanModels` — a **whole-class
  synthetic block** per class declaration (`Class` = the model name,
  `Name` empty, spans the whole class body — mirrors `scanEnums`,
  `blockSource` falls back to line-slicing for the empty `Name`) — in a
  separate `idx.models` map (model name → block). Rule 2c scans `new Foo(`
  (`reNewObj`) and `Foo::m(` (`reStaticCall`) on a receiver that's in
  `idx.models` and emits **one** child per model (call key = model name,
  `seen`-deduped — instantiation + a later static call on the same model
  in one block thus never give two children), with `ChildClass` = the
  model name and **`ChildMethod` empty** — the frontend's `blockLabel`
  convention then shows the bare model name (`ProductGroup`), no
  `::method`. Rule 2b (`new Foo()` → constructor) **explicitly excludes**
  a model class (`idx.models[class]` check) — even if the model does have
  an explicit `__construct`, this never points to the constructor: the
  reviewer wants the model, not its constructor body. Diffstat/
  `Unchanged` badge come for free (the same mechanism as any other
  `method_call` child, based on whether `ChildFile` changes in the PR).
  Other resolutions on the same line (e.g.
  `ProductGroupResource::make($productGroup)` → the resource class) stay
  unaffected — this is an additional child, not a replacement.
  **Type-hinted model parameter (rule 2d):** a method **signature** that
  type-hints an Eloquent model (`fromModel(Payment $payment)`) wants the
  model shown too even if the signature itself hasn't changed — only the
  body (the common case: an existing static constructor gets one extra
  field). Rule 2d therefore scans **not** `scan` (the changed-lines text,
  like every other rule in `resolveCalls`) but the **whole** block body
  (`src.Text`) with the same `Foo $var` regex as `relations.go`'s
  `reTypedParam` (reused, not duplicated — both files are `package main`),
  filtered on `idx.models`. This is a **deliberate, explicitly documented
  exception** to `resolveCalls`'s "only changed lines" principle (see its
  own doc comment) — a parameter type is a structural property of the
  whole (changed) function, not a separate reviewable line — and mirrors
  how `controllerModelDetector` (`relations.go`) already scans the whole
  body too, and how `resolveMigrationModels`/`resolveDataProviders`
  already point to unchanged code anyway. Same `emitKind(shortName, &def,
  KindModelUsage)` path as rule 2c, so the same badge/display; the
  false-positive risk is negligible since only a type that happens to be
  in `idx.models` (thus a genuine `app/Models/` file) matches.
  **Eloquent attribute cast property (rule 5b, `$var->key` without
  parentheses, possibly followed by `?->…`):** rule 5a/5 only recognize a
  **relation**-like magic property (`isRelationship`/`reRelationCall` on
  the method body); a field that's cast via Eloquent's `$casts` array to
  an **enum or other class** (`protected $casts = ['processor' =>
  Driver::class]`, so not a relation method, just a cast on a raw column)
  matches neither and previously produced **silently nothing** — not even
  `unresolved`. New index `idx.modelCasts[ModelShort][field] = ClassShort`
  (`scanModelCasts`, parsed from `protected $casts = [...]` — only the
  legacy array form; the Laravel 11 `casts(): array` method form is
  deliberately out of scope for v1) filled during the same `scanModels`
  worktree walk. Rule 5b scans — like 5a — `scan` (the call site itself
  is here on a changed line, so no changed-lines exception needed): for
  `$var->key` where `ucfirst(var)` is a model with a cast entry for
  `key`, the cast target is looked up in `idx.enums` then `idx.models`:
  **exactly one** same-name enum → resolved whole-enum child
  (`method_call` kind, like rule 6, `ChildMethod` empty — it's about the
  whole enum, not one case); **multiple** same-name enums (this app has,
  for instance, three separate `Driver` enums in different modules) →
  `unresolved` (Go can't resolve the namespace ambiguity without
  `use`-import parsing, so the automatic LLM search gets it — which does
  see the model's own `use` imports as context); target is itself again a
  model → resolved whole-model child (`KindModelUsage`, same path as rule
  2c/2d); target not indexed at all (e.g. a lone Value Object/Castable) →
  also `unresolved`, never silently nothing, since the call site is on a
  changed line.
- **`modules/claude`** (`modules/claude/claude.go`): the CLI bridge to
  `claude` (`Client` interface + `Fake`, the pattern of `modules/github`).
  `Run` shells out to `claude -p <prompt> --model <id>` with a context
  timeout; agentic (Sonnet) gets `cwd`=head worktree + read-only tools
  (`Read,Grep,Glob`). Model IDs: `claude-haiku-4-5`, `claude-sonnet-5`.
  **`SLASH_CLAUDE=off`** → `claude.Fake` (no network; empty = resolves
  nothing), for offline/tests.
  - **Context-only Haiku calls run from a neutral scratch cwd, not the
    slash repo.** `claude` automatically loads the full project's
    `CLAUDE.md` + `.claude/rules` from its cwd as system context on every
    `-p` call — for a context-only call (no tools, `RunRequest.WorkDir ==
    ""`: the Haiku pass of `resolve_call`, `explain_code`, `pr_status`'s
    summary) that's **pure overhead**, since those prompts are about PHP
    code in the PR, not about how this project is built. Measured: ~110k
    `cache_creation` tokens (~$0.22 on a trivial test call) with cwd =
    slash repo, versus ~7k (~$0.016) with an empty cwd outside any repo —
    a ~94% drop. `Module` (`claude.go`) therefore carries a `scratchDir`
    field: `Run` sets `cmd.Dir` to `req.WorkDir` if it's set (agentic,
    unchanged — Sonnet still runs in the checked-out PR worktree for
    `Read`/`Grep`/`Glob`), otherwise to `m.scratchDir`. `tasks_api.go`
    gives `claude.New(...)` a path for this **under `os.TempDir()`**
    (`slash-llm-cwd`), explicitly **not** under `dataDir`: `claude` looks
    for a `CLAUDE.md` by walking **up** the directory tree (like git looks
    for `.git`), so an empty subfolder of the slash repo (e.g.
    `data/llm-cwd`) would, via that parent chain, still load the repo's
    `CLAUDE.md` — empirically confirmed (it still cost ~112k tokens)
    before the location was moved to `os.TempDir()`. Nothing changes for
    the agentic Sonnet escalation: that worktree carries plug-and-pay's
    **own** `CLAUDE.md`/`.claude/rules` (~150k+ tokens overhead, bigger
    than slash's own ~110k) and that's a separate, bigger question (only
    `--bare` + a separate `ANTHROPIC_API_KEY` instead of the current
    OAuth/subscription auth would actually turn off that auto-discovery —
    an auth/billing decision, deliberately left untouched here).
  - **The static instruction text per action is decoupled from the
    varying call content, via `--append-system-prompt`.**
    `RunRequest.SystemPrompt` carries the call-independent part of each
    prompt (task description + JSON contract for `resolve_call`, the
    Dutch unit-explanation instruction for `explain_code`, the
    "Summarize…" instruction for `pr_status`'s summary) — **byte-for-byte**
    the same text that previously sat inline in the `-p` prompt, now moved
    to `modules/claude/prompts/{resolve_call,explain_code,pr_summary}.md`
    and embedded with `//go:embed` (stdlib, no dependency, no build step)
    as `claude.ResolveCallSystemPrompt`/`ExplainCodeSystemPrompt`/
    `PRSummarySystemPrompt`. Deliberately **not** under `.claude/` (that
    would itself again be sensitive to auto-discovery in an interactive
    `claude` session in this very repo) but under `modules/claude/
    prompts/` — prompt content for a subprocess call, not documentation
    for this project. `resolvePrompt`/`explainPrompt`/`prSummaryPrompt`
    still build the varying content (call name, caller body, candidate
    list, selected code, PR metadata) — only the always-identical piece
    was lifted out. Purely a relocation: the final instruction text the
    model sees is unchanged (verified with a byte-equality test against
    the embedded content), so resolution quality doesn't change.
    Side benefit: since this system-prompt piece is now identical across
    repeated calls of the same action within one PR (e.g. 32× `resolve_call`),
    `claude`'s own prompt cache can reuse it — that couldn't happen while
    it sat inline in the ever-changing `-p` string.
  - **Determinism:** both changes are entirely within `Module.Run`
    (cwd choice) and the `RunRequest` payload (`SystemPrompt`) — the
    number/order of `cl.Run` calls per workflow body is unchanged, so this
    doesn't affect the replay-determinism requirement
    (`.claude/rules/workflow-determinism.md`).
- **Workflow `resolve_call`** (`workflows.go` + `resolve_call.go`): one
  Execution per search action. Body (deterministic): `markCallsSearching`
  → `resolveWithModel` (Haiku, context-only shortlist from the Go index) →
  `saveResolutions`. **Purely automatic, no signal.** Every LLM claim is
  verified against the worktree (`verifyDefinition` + path containment)
  before it becomes `found`.
  **Haiku only — no automatic escalation to Sonnet.** That used to be
  different: a call that Haiku wasn't sure about (and for which the Go
  index had at least one static candidate, `HadCandidates`) used to
  automatically escalate to an agentic Sonnet pass (`Read`/`Grep`/`Glob`
  in the worktree). On explicit request that escalation step has been
  removed from `resolveCallWorkflow`: an uncertain/not-found Haiku outcome
  now simply stays `notfound`, a second, more expensive model call is
  never made anymore. The generic Sonnet/agentic machinery in
  `resolve_call.go` (`resolveArg.Model`, the `agentic` prompt branch,
  `claude.ModelSonnet`) still exists — it's simply never called anymore
  from this workflow (deliberately a minimal change: only the call site
  was removed, not the underlying resolver code).
  `callresolve.Entry.HadCandidates` still travels along in the Activity
  result but no longer drives any decision.
  `TestResolveCallHaikuConfident`/`TestResolveCallNeverEscalatesToSonnet`/
  `TestResolveCallNoEscalationWithoutCandidates` (`resolve_call_test.go`)
  pin down that a Sonnet call never happens, even when Haiku answers
  `found:false` and a Sonnet output is programmed in.
  **A curated denylist (`vendorBuiltinNames`/`isVendorBuiltin`,
  `resolve_call.go`) even skips the Haiku call** for a handful of
  extremely common vendor/framework method names (PHPUnit/Laravel
  HTTP test DSL: `assertStatus`, `postJson`/`getJson`/`putJson`/
  `patchJson`/`deleteJson`, `assertDatabaseHas`, every `assertJson*`;
  Schema Blueprint: `nullable`, `unique`, `dropColumn`, `dropIndex`,
  `softDeletes`, `table`; PHP-language builtin: `cases`) — but
  **exclusively** when the Go index also had `len(candidates)==0`, so it
  never suppresses a real, same-named app method
  (`TestResolveCallVendorBuiltinDoesNotSuppressRealCandidate` proves this
  explicitly with an app class that itself defines a `table()` method).
  Saves the Haiku spend, and prevents the pointless "Searching…" chip for
  code that by definition never has a reviewable app definition
  (`TestResolveCallVendorBuiltinSkipsLLM`).
- **Endpoints:** `POST /api/workflows/resolve_call` (start; body `{pr,
  callerId, callerFile, callerClass, callerName, calls}`) and read-only
  `GET /api/callresolve?pr=N`. The `buildRelations` Activity writes the
  Go rows along with it (next to the relations). Progress: the UI reloads
  the read model on an interval (like `syncComments`), no run poll. The
  headless twin **`slash relations <pr>`** (`main.go`) runs, next to
  `buildRelations`, also `resolveCalls` + `UpsertGo`/`Prune`, so a re-run
  without a full re-ingest refreshes the Underlying Code read model
  (handy after a resolver change).
- **Frontend:** `home.mjs` loads `state.callResolve` (`loadCallResolve`),
  adds `resolved`/`found` rows as `method_call` children
  (`relatedChildren`), and starts the LLM search for `unresolved` calls
  **automatically** — no button: `startCallSearch(focusedBlock())` runs in
  the `setRelated` watch as soon as the panel shows a block with
  unresolved calls (deduped per caller+callKey in `searchRequested`,
  resolves the block's **whole** unresolved set instead of scoped to the
  selection). The panel now only shows the "searching…" indicator
  (`related-searching`). The card **follows the cursor**: `findCallSites`
  maps each call method to the diff segment it's on, `callScopeMethods`
  scopes, in diff mode, to the selected unit (on `gran==='call'` the one
  active call; on line/group the calls on the lines within
  `[unit.start, unit.end]`), and only in list mode does it show all calls
  of the block, ordered (changed child block → call on a changed line →
  rest). The list is computed in a `watch` and pushed into the panel via
  `setRelated` (not in the render binding — that races with the diff over
  `b.code`). An LLM-found child shows a **`source: haiku`** badge (the
  `source` from the row — since the Sonnet escalation was removed this is
  in practice always `haiku`; Go-resolved shows no source badge). See
  `.claude/rules/detail-layout.md`.
- Tests: `callresolve_analysis_test.go` (resolver on fixture PHP, including
  a macro call → `Builder::joinAddress`, the changed-lines restriction with
  a real base+head diff, an enum case → `AddressType::BILLING`, a
  scheduled `->command('accounting:import …')` → `AccountingImport::handle`,
  a facade call `AccountingClient::providers()` → `AccountingDriver::providers`,
  and `TestResolveCallsModelUsage`/`TestResolveCallsModelWithoutConstructor`
  (`new Model()`/`Model::…` → one deduped whole-class model child, never
  the constructor even though it sometimes exists, `fill`/`save` stay
  `unresolved`, a resource resolution on the same line stays unaffected),
  `TestResolveCallsTypedParamModel`/`TestResolveCallsTypedParamNonModelIgnored`
  (rule 2d: an unchanged signature with a `Payment $payment` param still
  resolves via the whole-body scan; a param type outside `app/Models/`
  never produces an entry), and
  `TestResolveCallsCastPropertyEnum`/`TestResolveCallsCastPropertyAmbiguousEnum`/
  `TestResolveCallsCastPropertyUnknownTargetUnresolved` (rule 5b:
  `$payment->processor?->value` resolves via `$casts` to the enum
  declaration; multiple same-name enums → `unresolved`; a non-indexed
  cast target → also `unresolved`, never silently nothing)),
  `resolve_call_test.go` (Haiku-confident → found; never escalates to
  Sonnet, even on an uncertain/missing Haiku answer; notfound;
  verification rejects a made-up definition), and
  `modules/callresolve/callresolve_test.go` (round-trip + `UpsertGo`
  preserves LLM rows + `Prune` cleans up orphan callers and stale call
  keys).
  The frontend side has a **seed path**: `slash seed … -callresolve
  <callresolve.json>` (mirror of `-relations`) loads resolved rows into
  `callresolve.db` so Playwright renders the `method_call` children
  without a resolver run (`tests/fixtures/callresolve.json`, PR 91 in
  `relations.spec.mjs` — proves, among other things, that the Underlying
  Code panel follows block selection).
- **`kind` column (`call_resolutions.kind`, default `method_call`):**
  distinguishes a normal call resolution from a **class-level** child
  (`ChildMethod` empty — the whole model, no method). `Entry.Kind` in Go:
  empty → normalized to `KindMethodCall` on write (`UpsertGo`/`Save` in
  `modules/callresolve`), so none of the existing call-emitting rules (1
  through 6) needed changes — only `emitKind` (the new underlying
  implementation of `emit`, with an explicit `kind` parameter) is called
  by rule 2c (`KindModelUsage`), `resolveMigrationModels`
  (`KindMigrationModel`, see below), and `resolveDataProviders`
  (`KindDataProvider`, see "PHPUnit data providers" below). An existing
  `callresolve.db` migrates via a light `ALTER TABLE … ADD COLUMN`
  (duplicate-column error ignored — the standard pattern from
  `relations`/`comments`). Frontend: `resolvedCallChildren` (`home.mjs`)
  now **takes over** `r.kind` instead of always hardcoding
  `'method_call'`, and the **label** branches on `r.childMethod` (empty →
  bare `r.childClass`, filled → the existing `Class::method` template) —
  this already applied before this column existed, for rule 2c's
  model-usage children (which used to show a `"ProductGroup::"` with an
  empty, ugly `::` tail) and now applies too for
  `migration_model`/`data_provider` (both always have a filled
  `childMethod`, so they render as a normal `Class::method` child).
  `KIND_LABEL` (`RelatedPanel.mjs`) links `model_usage`/`migration_model`
  to the badge word **"model"** and `data_provider` to **"provider"**; the
  `diffStatBadge`/`unchanged` helpers recognize all three alongside
  `method_call`/`covers` (shared `DIFFSTAT_KINDS` set) so they too get a
  `+A −R`/`Unchanged` badge and the grey "unchanged" ring style, exactly
  like a normal call child.
- **Migration → model (`resolveMigrationModels`, `callresolve_analysis.go`):**
  a changed migration usually belongs to an **already-existing, unchanged**
  model — the main case is "add a column to an existing table", not
  "new model + new migration at the same time". That makes this a
  **callresolve** rule (may point to an unchanged file), not a
  `relations` detector (those are all both-changed, see the Laravel chain
  above) — and without an LLM fallback: the mapping is rule-based and
  deterministic, so a migration that can't be mapped produces **silently
  nothing** (no `unresolved` row, no "Search" button). Scope: every changed
  `Category == "MIGRATION" && Name == "up"` block (a migration is always
  the anonymous `return new class extends Migration {...}`, so `Class ==
  ""` — see `classify.go`'s `database/migrations/` rule and `phpscan.go`'s
  anonymous-class handling; only `up` counts, never `down`). Per
  `Schema::create('table', ...)`/`Schema::table('table', ...)` match
  (`reSchemaTable`, both count — a column migration belongs to its model
  just as much as a create migration) in the `up` body: table → model via
  (1) an explicit `protected $table = '...'` override (`idx.modelTables`,
  filled during the same `buildSymbolIndex` worktree walk as
  `idx.models`/`scanModels` — no second walk) or (2) the Eloquent
  convention (`singularizeTable` — a deliberately **pragmatic**,
  non-exhaustive inflector: `-ies`→`-y`, trailing `-s` dropped — followed
  by `studly`). One deduped child per distinct table (`seenTable` within
  the migration — two `Schema::table` calls on the same table thus never
  give two children), child = the `idx.models` whole-class block (the
  same synthetic block as rule 2c above — `ChildMethod` empty, bare model
  name label). `CallKey` = `"migration_model:" + table` (never clashes
  with a real method-call key, which contains no `:`). This function's
  entries are **merged** in the `build_relations` Activity (`workflows.go`)
  with `resolveCalls`'s entries before the one `UpsertGo`/`Prune` call —
  so no separate prune scope needed, migration rows automatically stay
  in the keep set as long as their migration keeps changing in the PR.
- Tests: `TestResolveMigrationModelsConvention`/`ExplicitTable`/
  `MultipleTablesDeduped` (`callresolve_analysis_test.go`, fixture PHP: a
  `Schema::create` migration that resolves to its model via the
  convention, a `$table` override that overrides the convention, and a
  migration with two `Schema::table` calls on the same table + a
  non-mappable table — deduped resp. silently skipped);
  `TestKindRoundTrip`/`TestMigrateAddsKindColumn`
  (`modules/callresolve/callresolve_test.go`: an empty Kind normalizes to
  `method_call` via both `UpsertGo` and `Save`, an explicit Kind round-trips,
  and a DB without the column migrates on `Open`).
  Playwright: `tests/migration-model.spec.mjs` (PR 101, `migrationmodel-*.json`
  — proves that both a `model_usage` and a `migration_model` child show a
  bare model name + "model" badge, never the `Class::` form).
- **PHPUnit data providers (`resolveDataProviders`, `callresolve_analysis.go`):**
  a test method with `#[DataProvider('providerMethod')]` (or the legacy
  `@dataProvider providerMethod` docblock tag) wants the reviewer to see
  the provider method itself as Underlying Code — usually an **already
  existing, unchanged** provider that a new/changed test reuses. Same
  motivation/architecture as "Migration → model" above: a **callresolve**
  rule (may point to an unchanged file), not a `relations` detector, and
  **without an LLM fallback** — PHPUnit's bare `#[DataProvider(...)]`/
  `@dataProvider` always names a method **on the test's own class** (no
  `Class::method` form like `#[DataProviderExternal(...)]`, deliberately
  out of scope), so there's no ambiguity to put in front of an LLM; a name
  that doesn't match (typo, or an external provider) produces **silently
  nothing**, never an `unresolved` row.
  Scope: every changed `Category == "TEST"` block (the same scoping as
  `scanTestCovers`). For each such block, `resolveDataProviders` reuses
  **`methodZone`** (`testcovers_analysis.go`, unchanged function — see
  the scanner note in `.claude/rules/blocks-and-ingest.md` about how it
  now also counts the leading attributes folded into the block via
  `funcDeclLine`) to read the test method's attribute/docblock text,
  matches `reDataProviderAttr`/`reDataProviderDocblock` in it (deduped per
  name), and resolves each name via `methodOnClass(idx, b.Class, name)` —
  always the same class as the test, never another one. Child =
  `KindDataProvider`, `CallKey = "data_provider:" + name` (contains `:`,
  so — like `migration_model:` — never matches as a real call site in the
  frontend's `findCallSites`/`callScopeMethods`, meaning this child drops
  out at `line`/`call` granularity but stays visible at `group`/list level,
  identical to how a block-level relation behaves). The entries are
  **merged** in the `build_relations` Activity (`workflows.go`) with
  `resolveCalls`/`resolveMigrationModels`'s entries before the one
  `UpsertGo`/`Prune` call — the same keep set, so no separate prune scope
  needed; the headless `slash relations <pr>` twin (`main.go`) calls it
  too.
  Tests: `TestResolveDataProviders` (`callresolve_analysis_test.go`: the
  attribute form, the legacy docblock form, and a non-resolvable name that
  silently produces nothing — reuses `testCoversBlocks` from
  `testcovers_analysis_test.go` so the scan uses real, scanner-produced
  line numbers, which `methodZone`/`funcDeclLine` require).
- **Translation keys (`resolveTranslations`, `callresolve_analysis.go`):** a
  `trans('file.key')` / `__('file.key')` / `@lang('file.key')` /
  `trans_choice('file.key', …)` call on a **changed line** surfaces the Laravel
  lang file(s) it references as Underlying Code — **one child per locale**
  (`resources/lang/<locale>/<file>.php`, e.g. nl **and** en). Same motivation/
  architecture as "Migration → model"/"PHPUnit data providers": a **callresolve**
  rule (points at usually-unchanged lang files), **deterministic, no LLM** — the
  key maps mechanically to a file + array path, so there is nothing to guess.
  The key is split on the **first** `.` (`fileSeg` = before → `<fileSeg>.php`,
  the rest = the nested array path); locales are discovered by listing the lang
  root's subdirectories (`resources/lang/` then `lang/`, whichever exists) that
  contain `<fileSeg>.php`. Per locale, `sliceLangKey` extracts the key's value
  source text (a quoted scalar or a nested `[ ... ]` sub-array). `CallKey` is
  **`translation:<locale>:<key>`** (the `translation:` prefix keeps the PK
  `(pr, caller_id, call_key)` unique per locale, mirroring `migration_model:`/
  `data_provider:`); `Kind` = **`translation`** (new `callresolve.Kind*`
  constant); `ChildFile` = the lang file, `ChildClass` = the locale,
  `ChildMethod` = "" , `ChildCode` = the sliced value (empty when the key is
  **absent** in that locale — still emitted, so the frontend can mark it
  "ontbreekt in <locale>"). **Deliberate v1 boundaries** (silently skipped, no
  `unresolved`/LLM fallback): a **dynamic** key (`trans($var)`, concatenation),
  a **namespaced/vendor** key (`pkg::file.key`), and a bare whole-file
  reference without a `.` (`trans('checkout')`). Merged into the one
  `UpsertGo`/`Prune` call in **both** the `build_relations` Activity
  (`workflows.go`) and the headless `slash relations` twin (`main.go`).
  **Frontend** (`home.mjs` `resolvedCallChildren` + `findCallSites`): a
  translation child is always a **leaf value view** (never a drillable PR
  block) — `RelatedPanel`'s `relatedCard` renders `translationValueView`
  (`translationDiff.mjs`): the **current** value of the key per locale (no
  diff), or "ontbreekt in <locale>". `findCallSites` couples a translation
  child to its call site via the **key string literal** (the same literal for
  every locale, so nl and en both attach to the one `trans(...)` call), so it
  scopes at `line`/`call` like any other call child. `KIND_LABEL.translation`
  = "vertaling"; `resolvedCallTargetIds` skips `translation` so a changed lang
  file's standalone `TRANSLATION` block (see `.claude/rules/blocks-and-ingest.md`)
  is never pulled out of the left list. Tests: `TestSliceLangKey`/
  `TestResolveTranslations` (`callresolve_analysis_test.go`).
- **Resolving trait usage (rule 8, `callresolve_analysis.go`):** a
  `use TraitName;` statement added to a class's header
  (`classHeaderSentinel`, see `.claude/rules/blocks-and-ingest.md`) surfaces
  the trait's own definition as Underlying Code, since a class importing a
  trait is very often reusing an **already-existing, unchanged** trait —
  same motivation/architecture as "Migration → model"/"PHPUnit data
  providers": a **callresolve** rule, Go-only, no LLM fallback. Every `.php`
  file in the worktree is scanned for `trait X { ... }` declarations
  (`scanTraits`, mirrors `scanModels`/`scanEnums` — a whole-class synthetic
  block, `ChildMethod` empty) and indexed into `symbolIndex.traits`. Only a
  changed `classHeaderSentinel` block is scanned (`b.Name ==
  classHeaderSentinel`), matching `reTraitUse` (`use A, B;`, comma-separated,
  only the plain form ending directly in `;`) against that block's **changed
  lines** — a trait-adaptation block (`use A, B { A::foo insteadof B; }`) is
  deliberately out of v1 scope, as is a `use` statement added elsewhere in
  the class body (after the first method), since that text falls outside
  every block the scanner produces. `CallKey = "trait_usage:" + trait`
  (contains `:`, so — like `migration_model:`/`data_provider:` — never
  matches a real call site, meaning this child shows at `group`/list level,
  not tied to one line/call); `Kind = KindTraitUsage` (`KIND_LABEL.trait_usage`
  = "trait"). A name that isn't an indexed trait (a vendor trait, a typo)
  produces **silently nothing**, never an `unresolved` row. Tests:
  `TestResolveCallsTraitUsage`/`TestResolveCallsTraitUsageOutsideHeaderIgnored`
  (`callresolve_analysis_test.go`).

## Linking test coverage (`resolve_test_covers` + `modules/testcovers`)

A PHPUnit test method links to the method it tests — in **both
directions** of the "Underlying code" card: a test shows the tested method
as a child, and a tested production method shows "covered by
TestX::testY" as a child (provided the test itself also changes in the
PR, since only then does a test PR block exist to hang it on). Two
layers, like call-resolve: a Go detector first, a **limited** AI fallback
only for one specific case.

- **Why a dedicated module, not a `relations` row:** the tested method can
  be in a file the PR does **not** change (the normal case — an existing
  test on existing production code), so its block id is often not a PR
  block the frontend knows about. Just like `callresolve`, a row therefore
  carries the **full child descriptor + code text**, not just a block id
  pair.
- **`modules/testcovers`** (`data/testcovers.db`): the read model
  `test_covers(pr, test_id, target_key, status, covered_*, annotation,
  model, confidence, updated_at, line)`, PK `(pr, test_id, target_key)`.
  `target_key` mirrors callresolve's `call_key`: `"method:Class::method"`
  for a statically resolved annotation, `"class:Class"` for a class-level
  annotation (AI territory), `"none"` for "no annotation". `line`
  (distinct from `covered_line`, the declaration line of the **tested**
  method) is the absolute source line **within the test file itself**
  where the coverage annotation sits — recorded by the Go scan
  (`coverTarget.line` in `testcovers_analysis.go`, via the same
  `matchLine` approach as the relations detectors) and used by the
  frontend to reorder the Underlying Code panel around the selected
  `group` unit (see `groupLineRange`/`resolvedTestCoverChildren` in
  `home.mjs`, and the "Underlying code" section in
  `.claude/rules/detail-layout.md`). Only set on a `resolved`/`unresolved`
  row (the annotation lives in the text the Go scan searches); a `found`
  row that escalated from an `unresolved` class-only annotation (see
  below) deliberately does **not** carry it — too much extra plumbing
  (API/workflow/Activity payload) for this narrow AI path, so such a row
  degrades to the same "not in the group" tier as `covered_by` (see
  `detail-layout.md`). Six statuses — the five from `callresolve` plus one
  new terminal one:
  - **`resolved`** — a **method-level** annotation
    (`#[CoversMethod(Class::class, 'method')]`, `@covers Class::method`,
    or `@coversDefaultClass` + `@covers ::method`) **always** names both
    class and method, so this resolves **statically, without AI**,
    verified against the worktree.
  - **`unannotated`** — no annotation found at all → **permanent warning,
    never AI**.
  - **`unresolved`** — a **class-level-only** annotation
    (`#[CoversClass(Class::class)]`, bare `@covers Class`) names only a
    class, no method → exactly the meaning of callresolve's `unresolved`:
    "Go couldn't pin it, offer the AI search" — automatically triggers
    `resolve_test_covers`.
  - **`searching`/`found`/`notfound`** — LLM-owned, identical to
    callresolve.
  - Write `UpsertGo` (writes `resolved`/`unannotated`/`unresolved` rows,
    never overwrites a `searching`/`found`/`notfound` row — a Go rebuild
    must not wipe out an expensive AI resolution) and `Prune` (cleans up
    orphan rows whose `(test_id, target_key)` is no longer in the current
    scan), `SaveSearching`/`Save` for the AI branch, `List` read-only.
- **Static detector `testcovers_analysis.go`** (package main, reads the
  head worktree): `scanTestCovers(dataDir, pr, blocks)` scans, per
  **changed test file** (TEST-category PR blocks — no whole-worktree scan
  of tests), the raw text around each test method (`methodZone`, bounded
  by the previous block in the same file) and around the class
  declaration (`classZone`, everything before the first `class` keyword —
  for a class-wide `@coversDefaultClass`/`#[CoversClass]`/bare
  `@covers Class`) for the four annotation forms, pure regex, no parser. A
  method-level annotation always wins over a class-level annotation for
  the same class (no double AI search when the method is already
  precisely known). A test method is recognized via the `test` name
  prefix or a `#[Test]`/`@test` marker (`isTestMethod`) — so `setUp`/
  helper methods stay out of consideration. `buildTestCovers` is called
  **within the existing `buildRelations` Activity** (alongside the
  existing `resolveCalls`/`UpsertGo`/`Prune` call for callresolve) — no
  separate Workflow Type for this static part, exactly the same precedent
  as callresolve's Go rows.
- **AI branch `resolve_test_covers.go` + workflow `resolveTestCoversWorkflow`**
  (mirror of `resolve_call.go`/`resolveCallWorkflow`): runs **only** for
  `unresolved` targets (a class-level-only annotation) — **never** for
  `unannotated`. Haiku gets, as context, the **candidate methods of the
  named class** (`idx.byClass[class]`, the same limited, easy-to-verify
  scope the coordinator asked for earlier) + the test method body, and
  picks **which method** the test exercises. **Haiku only — no more
  automatic escalation to Sonnet** (previously: on low confidence the
  workflow automatically escalated to Sonnet, agentic `Read`/`Grep`/`Glob`
  in the worktree; that step was removed from `resolveTestCoversWorkflow`,
  on explicit request). The generic Sonnet/agentic machinery in
  `resolve_test_covers.go` (`testCoverArg.Model`, the `agentic` prompt
  branch) still exists, it's just no longer called from this workflow.
  Every claim is verified: the method must **really exist on the named
  class** (`methodOnClass`) — stricter than `verifyDefinition` because the
  class is already fixed by the annotation, only the method is uncertain.
  Result `found` (with `model`/`confidence`, `model` is now always
  `haiku`) or `notfound`.
- **Sibling reuse within the same test class (`reuseSiblingCovers`,
  `resolve_test_covers.go`):** multiple test methods in **the same test
  file** often cover the same class — before `resolveTestCoversWorkflow`
  asks Haiku, it checks, per class-level-only annotation, whether a
  **sibling test** (same PR + same test file, so the same
  `<pr>:<file>:` block-id prefix, a *different* `test_id`) already
  resolved that same class. Matches via **`CoveredClass`**, not the raw
  `target_key` string: a `resolved` row (method-level annotation) carries
  `target_key = "method:Class::Method"`, a `found`/`unresolved` row
  (class-level-only) carries `target_key = "class:Class"` —
  `CoveredClass` is the field that consistently identifies "the same
  tested class" across both forms. Only **`resolved`** (a statically
  verified method-level annotation on another test method — the most
  authoritative) and **`found`** (an earlier LLM answer for exactly the
  same class-level-only target) are reused; `notfound`/`searching`/
  `unresolved`/`unannotated` never — an earlier miss says nothing useful
  for another test. If both exist for the same class, `resolved` wins;
  within the same status, the first match in `List`'s own stable
  `ORDER BY test_id, target_key` wins. A reused row is a **literal copy**
  of the sibling row (status/`model`/`confidence`/covered-* fields
  unchanged, only `test_id`/`target_key` rewritten to the own test) — no
  separate "reused" marker, so the existing per-status badge
  (`source: haiku` on `found`, no badge on `resolved`) just naturally
  appears. **Determinism:** the lookup is its **own Activity**
  (`reuseTestCoverSiblings`, the only place that reads `testcovers.List`
  — the matching itself, `reuseSiblingCovers`, is a pure function of that
  snapshot); the **number** of `resolveTestCoversWithModel` calls (zero
  once every named class has been reused) is thus a function of that
  Activity result from the history, the same replay pattern as
  callresolve's `HadCandidates` gate. This only saves Haiku calls — it
  doesn't reintroduce Sonnet escalation (that stays off, see above).
- **Endpoints:** `POST /api/workflows/resolve_test_covers` (start; body
  `{pr, testId, testFile, testClass, testName, classes}`) and read-only
  `GET /api/testcovers?pr=N`.
- **Frontend** (`home.mjs`): `state.testCovers` (`loadTestCovers`).
  **Direction 1** (test → tested method): `resolvedTestCoverChildren(b)`
  for a TEST block `b` — child `covers`, the same diffstat/`Unchanged`
  badge and `source: haiku` badge as a `method_call` child (since the
  Sonnet escalation was removed, `model` here is always `haiku`; the badge
  mechanism itself still just shows whatever is in the row). **Direction
  2** (tested production method → covering test):
  `coveredByChildren(b)` — child `covered_by`, reuses the existing test PR
  block (no separate code snapshot needed). Both are **block-level** (like
  `event_listener`): they drop away at `gran==='call'`, just like the
  listener children — coverage isn't a line/call-bound concept.
  `directChildBlocks`/`nestedPrBlocks` (the combined-approval rollup) only
  include **direction 1** (test → tested method); direction 2
  deliberately **not**, to avoid a method↔test cycle in that recursive
  rollup. **Test coverage hides no block whatsoever** from the left-hand
  list — neither the test nor the tested method. Unlike a call target or
  a listener (often genuinely unchanged reference code that
  `resolvedCallTargetIds`/the relation children **do** pull out of the
  list) a tested method that is a PR block is **always** changed, primary
  reviewable code (e.g. a newly added controller that the PR introduces).
  A test must therefore never make such a block disappear from the tree:
  `recomputeLeftList` does **not** add `testCoverTargetIds()` to the
  hidden set (the function still exists, but is no longer used to hide
  anything). Both sides stay in the list and additionally appear as each
  other's Underlying Code child: the test shows the tested method as a
  `covers` child, the method shows the test as a `covered_by` child — fully
  symmetric.
  **Warning** (`data-testid=related-covers-warning`, custom inline SVG,
  in the card header next to `related-approval-total`): shown as soon as
  the focused TEST block has an `unannotated` row, or (after a failed AI
  search) a `notfound` row, with different text per case.
  **"searching…"** indicator (`related-searching`) reuses the same
  `searching()`/`pending()` helpers as callresolve —
  `unresolvedTestCovers(b)` is simply concatenated into the same
  `unresolved` argument of `setRelated`. The AI search starts
  **automatically** (`startTestCoverSearch`, the same `setRelated` watch
  as `startCallSearch`), deduped per test+class in
  `testCoverSearchRequested`.
- Tests: `testcovers_analysis_test.go` (all annotation forms, class-level
  → `unresolved`, an unverifiable claim → effectively `unannotated`, a
  non-TEST block gets skipped, and a `build_relations` end-to-end test
  that confirms the Activity also fills `testcovers.db`),
  `resolve_test_covers_test.go` (mirror of `resolve_call_test.go`:
  Haiku-confident → found, never escalates to Sonnet even on an
  uncertain Haiku answer, notfound, verification rejects a method that
  doesn't exist on the named class, plus three tests for the sibling
  reuse: a seeded `found` sibling in the same test file gets literally
  copied without Haiku being called (`fake.CallCount() == 0`), the same
  sibling in a *different* test file is **not** reused (Haiku runs after
  all), and a seeded `resolved` sibling (method-level annotation) gets
  reused just like a `found` sibling), `modules/testcovers/testcovers_test.go`
  (round-trip, `UpsertGo` protects a `found` row, `Prune` cleans up orphan
  rows). Playwright: `tests/testcovers.spec.mjs` (both directions + drill
  recursion, both warning variants, the `source: sonnet` badge — a seeded
  fixture value, only shows that the badge mechanism itself is
  model-independent), seeded via `slash seed … -testcovers
  <testcovers.json>` (mirror of `-callresolve`, `tests/fixtures/testcovers.json`
  + `testcovers-blocks.json`, PR 92/93/94).

## AI description of a code unit (`explain_code` + `modules/explanations`)

A small Workflow Type, **`explain_code`**, generates the **footer
description**: a short Dutch Opus explanation of the focused `line`/`group`
navigation unit (see the Footer section in
`.claude/rules/keyboard-navigation.md` for the frontend side) — **every**
such unit with actual code, not only one containing an if-statement (the
frontend's earlier `reIfStatement` gate in `footerUnitInfo`, `home.mjs`, was
lifted as part of "Diepgravend onderzoek", see the `code_warning` section
below). One Execution per **unit + code hash**, no Signals — it completes
right away.

- **`modules/explanations`** (`data/explanations.db`): the read model
  `explanations(pr, block_id, unit_key, code_hash, status, text, model,
  updated_at)`, PK `(pr, block_id, unit_key)` — at most one live row per
  unit; a new hash (new commit) overwrites the old row. `status`:
  `searching`/`done`/`failed` (`failed` is terminal — offline/Claude
  hiccup, the footer then shows nothing and doesn't ask again). Writes
  (`SaveSearching`/`Save`) workflow-only; `List(pr)` read-only. A row with
  an **empty `code_hash`** matches any hash on the frontend side (seed
  fixtures).
- **Input-driven, no worktree reads:** `ExplainCodeInput` carries
  everything the LLM sees — the unit code (new-side text of the aligned
  rows), the surrounding block code as context (frontend-truncated,
  `EXPLAIN_CONTEXT_LINES`), file/label/gran, the `unitKey`
  (`group-<start>-<end>`/`line-<row>`, the same codeRef form as
  `commentPath`) and the `codeHash` (frontend `fnv1a` over
  `EXPLAIN_PROMPT_VERSION + '|' + code + context`; the backend only stores
  it). The workflow body is thus a pure function of its input. The prompt
  itself caps the answer at roughly **40 words / 275 characters** (measured:
  a real answer fits ~52 words/341 characters into the footer's two clamped
  lines at a ~1378px window before `line-clamp-2` starts cutting it off —
  the budget takes ~80% of that as a safety margin) so it reliably fits
  `Footer.mjs`'s `line-clamp-2` instead of ending in "…". `EXPLAIN_PROMPT_VERSION`
  (`home.mjs`) is a small frontend-only version token folded into `codeHash`
  for exactly this kind of change: bumping it invalidates every previously
  generated (now too-long) row without a backend migration — a stale row's
  hash simply stops matching, so `computeFooterSnapshots` treats it as "no
  explanation yet" and lazily re-requests a fresh (shorter) one the next
  time that unit is focused.
- **Workflow** (`workflows.go` + `explain.go`): `markExplainSearching` →
  `generateExplanation` (Opus via `modules/claude`, **context-only** — no
  tools; empty output → `failed`) → `saveExplanation`. The done/failed
  decision reads the **stored** Activity result (history), so
  replay-deterministic.
- **Idempotent start:** `StartExplainCode` uses `StartWorkflowID` with a
  **deterministic Run ID** (`explainRunID`: `expl-` + sha256 over
  pr|blockId|unitKey|codeHash, hashed because block ids contain
  paths/colons and Run IDs serve as JSONL file names) — a repeated
  selection or a duplicate POST reuses the existing run instead of a
  second LLM call.
- **Endpoints:** `POST /api/workflows/explain_code` (start; body
  `{pr, blockId, file, label, gran, unitKey, codeHash, code, context}`) and
  read-only `GET /api/explanations?pr=N`.
- **Frontend** (`home.mjs`): the footer `watch` builds an explain-request
  descriptor for the focused unit as soon as it has actual (non-blank) code
  (`footerUnitInfo` — no longer gated on containing an if-statement), shows
  "generating…" and starts the workflow automatically with a 600ms
  debounce, client-side deduped (`explainRequested`) and only after the
  read model has been loaded at least once (`explanationsLoaded` —
  otherwise a fresh run would overwrite an already-existing/seeded row
  before the first GET had landed). `SLASH_CLAUDE=off` → `claude.Fake` →
  `failed` row → footer stays silent.
- Tests: `explain_test.go` (Fake-Opus → done row + Dutch prompt check,
  idempotent restart, offline → failed),
  `modules/explanations/explanations_test.go` (round-trip + hash
  supersede), `tests/footer-explanation.spec.mjs` (seeded display, drilled
  column; PR 97, seeded via `slash seed … -explanations
  <explanations.json>` + the `pr-97` worktrees materialized in
  `tests/_setup.mjs`).

## Persisting reviewer approval (`approve` + `modules/approvals`)

A fifth Workflow Type, **`approve`** (one Execution per PR), makes
reviewer approval **durable** so a browser refresh remembers what's been
checked off. Pattern of `build_relations`/`pr_status`.

- **`modules/approvals`** (`data/approvals.db`): the read model
  `approvals(pr, block_id, rows, calls, PRIMARY KEY(pr, block_id))`, with
  `rows`/`calls` as JSON arrays (the approved row indices resp. the
  `${row}:${segStart}` call-segment keys — the client-side
  `b.approvedRows`/`b.approvedCalls`). Write `Replace(pr, blockID, rows,
  calls)` (workflow-only): full swap per block, an **empty** set removes
  the row → replay-safe. Read `List(pr)`.
- **Workflow** (`workflows.go`): `approveWorkflow` is a loop on a **`set`**
  Signal (`ApprovalSignal{blockId, rows, calls}`); every `set` runs one
  `saveApproval` Activity that calls `approvals.Replace`. Deterministic:
  the number of Activities is exactly the number of `set` Signals in the
  history (no live state, no clock/random). Never completes — a long-lived
  per-PR tracker. `EnsureApprovals(pr)` (mirrors `EnsurePRStatus`) starts/
  reuses one Execution per PR, also after a restart (`engine.Recover()`
  re-blocks the waiting Execution on `set`; `findApproveLocked` finds it
  back).
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/approve {pr}` →
  `EnsureApprovals`, returns `runId`; the generic `POST
  /api/workflows/{runID}/signals/set {blockId, rows, calls}` delivers the
  Signal; read-only `GET /api/approvals?pr=N` → `approvals.List(pr)`.
- **Frontend** (`home.mjs`): `loadApprovals` ensures the tracker (runId in
  `state.approveRunId`) and restores `b.approvedRows`/`b.approvedCalls` per
  block id. Every mutation (`toggleApprove`/`toggleCallApprove`, plus the
  top checkbox via the `onApprove` callback that `Block.mjs` runs) sends,
  after the local reassignment, `persistApproval(b)` → the `set` Signal
  with the full set for that block. The UI never writes directly — only
  this Signal (write boundary).
- **Keeping the GitHub "Viewed" checkbox in sync:** a viewed request rides
  along on the same `set` Signal — mirror of `ReactionSignal.Action`.
  `ApprovalSignal` carries `File string` + `Viewed *bool` for this: `nil` =
  a normal block-approval set (existing behavior), non-`nil` = "mark/unmark
  this file" and `BlockID`/`Rows`/`Calls` are ignored. `approveWorkflow`
  branches on `sig.Viewed != nil` to the Activity **`setFileViewed`**
  (instead of `saveApproval`), which calls `github.Client.MarkFileViewed(ctx,
  pr, file, viewed)` — the only place that sets GitHub's Files-changed
  "Viewed" checkbox (`gh api graphql`: first fetch the PR node ID, then
  `markFileAsViewed`/`unmarkFileAsViewed` as the mutation). The UI detects
  the transition itself: `syncViewedFiles` in `home.mjs` groups
  `state.blocks` per file and compares "all blocks of this file fully
  approved + code loaded" against `state.viewedFiles`; only on a
  transition (newly complete / no longer complete) does it send the
  signal. It runs at the end of `persistApproval` (every approve toggle)
  and in `ensureCode` as soon as a block's code arrives after all (in case
  a file only receives its last code fetch after a refresh).

## Ingest pipeline as a workflow (`ingest` + `.claude/rules/blocks-and-ingest.md`)

A sixth Workflow Type, **`ingest`**, brings the PR→blocks pipeline within
the write boundary: before this workflow, `ingestPR` wrote the `blocks`
table and the git worktrees directly from `handleIngest` (HTTP) and the
CLI — the one real breach of the "only workflows mutate state" rule. One
Execution per ingest request, **no Signal** — the workflow body runs its
two Activities sequentially and completes right away (`StartWorkflow`
drives it synchronously to completion since there's no `WaitSignal` in
it).

- **`prepareWorktrees` Activity:** `gh pr view` (via `fetchPRMeta`) +
  `ensureCommits` + the two `ensureWorktree` calls (`ingest.go`,
  `prepareIngestWorktrees`). Returns only the small `worktreeSHAs` summary
  (base SHA, head SHA, changed file paths) — not the worktree contents,
  which stay on disk at their deterministic path (`worktreeDirs`).
- **`scanAndStoreBlocks` Activity:** `git diff` + the PHP scanner/
  classification + `replacePRBlocks` (`ingest.go`,
  `scanAndStoreIngestBlocks`) — the only place that still writes the
  `blocks` table. Returns only the small `ingestResult` summary (`{pr,
  stored, byStatus, warnings}`), not the blocks themselves, so the event
  history stays compact (same pattern as `build_relations`/`pr_inbox`).
- **`TaskManager.StartIngest(ctx, pr) (*ingestResult, error)`** starts the
  Execution and reads the result back (`engine.Result`) — the sanctioned
  write path. `handleIngest` (`api.go`) calls it instead of calling
  `ingestPR` directly, and afterward calls `EnsureRelations` as before.
- **CLI (`slash ingest <pr>`, `main.go`):** builds its own separate engine +
  modules via `newTasks(ctx, db, dataDir, repo, resumeRuntime=false)` — the
  `resumeRuntime` flag skips `ResumePolling`/`EnsureInbox` (server-only
  runtime: no poller resumption, no inbox fetch for a one-shot headless
  ingest) — and then calls `StartIngest` + `EnsureRelations`, just like the
  HTTP flow.
- **Determinism:** both Activities are the only non-determinism/IO
  (network, git, DB); the workflow body itself adds nothing
  non-deterministic and always runs the two steps in the same order.
  `ingestMu` (a package-level mutex, unchanged) serializes concurrent
  ingests of the same PR at the worktree level — now within each Activity
  separately instead of around the old, unsplit `ingestPR`.
- See `.claude/rules/blocks-and-ingest.md` for the full pipeline
  explanation, and `ingest_test.go` (`TestIngestWorkflowEndToEnd`, a real
  gh/git-dependent end-to-end test that skips itself if gh is
  unreachable).
- Tests: `approvals_test.go` (module round-trip incl. full swap/clear, the
  workflow end-to-end: `set` Signal → read model, `EnsureApprovals`
  idempotency, and a viewed request that drives `setFileViewed`/
  `github.Client.MarkFileViewed` instead of touching the approvals read
  model).

## Actually approving/rejecting a PR on GitHub (`submit_review` + `github.Client.SubmitReview`)

A seventh Workflow Type, **`submit_review`**, submits a **real GitHub
PR-level review** (approve or request-changes) — intended for the menu
that appears after approving all/the last blocks. Signal-less, one
Execution per submit request, mirrors `ingest`'s synchronous pattern
exactly (no long-lived tracker, no Signal loop).

- **`modules/github`:** `Client.SubmitReview(ctx, pr, event, body) error` —
  `event` is `"APPROVE"` or `"REQUEST_CHANGES"`. `Module.SubmitReview`
  validates `event` against a fixed allowlist (`allowedReviewEvents`)
  before the `gh api --method POST repos/<repo>/pulls/<pr>/reviews` call
  (`-f event=<event>` + `-f body=<body>` only if non-empty) — in line
  with the requirement to validate input before `exec.CommandContext`.
  `github.Fake` unconditionally records `event`/`body`
  (`LastReviewEvent`/`LastReviewBody`/`ReviewSubmittedCount`, for tests) —
  the allowlist validation only lives in the **real** `Module`, not in the
  Fake.
- **Body required when rejecting:** GitHub refuses a bodyless
  `REQUEST_CHANGES` review; an `APPROVE` may be bodyless. Deliberate
  choice: **hard reject** (400), no auto-generated body — the reviewer
  must justify the rejection, and the frontend can enforce that with a
  required text field. Validated by the pure, independently testable
  function `validateSubmitReview` (`tasks_api.go`) — before the workflow
  ever starts: `pr <= 0`, an unknown `event`, or an empty/whitespace-only
  `body` with `REQUEST_CHANGES` all yield a 400 without `gh` being
  touched.
- **Workflow** (`workflows.go`): `submitReviewWorkflow` runs one
  `ExecuteActivity("submitGithubReview", in, nil)` and completes — no
  best-effort swallow like `postGithubComment`: a failed submit must
  reach the reviewer as a real error, so `Activity` failures propagate.
  `TaskManager.StartSubmitReview(in)` mirrors `StartIngest`:
  `StartWorkflow` (runs synchronously through to completion, no Signal) +
  a `Status` check that returns a `StatusFailed` run as an error.
- **Endpoint:** `POST /api/workflows/submit_review` — body
  `{"pr": N, "event": "APPROVE"|"REQUEST_CHANGES", "body": "…"}`, 200
  `{"runId": "…"}`, 400 on an invalid request (before any GitHub call),
  502 `{"error": "…"}` if the `gh` submit itself fails.
- Tests: `submit_review_test.go` (`TestValidateSubmitReview`, a table test
  on the validation function including the body-required-on-rejection
  rule; `TestSubmitReviewWorkflowPassesEventAndBody`, workflow-level with
  `github.Fake` — proves that `event`/`body` are passed through unchanged
  for both APPROVE and REQUEST_CHANGES;
  `TestGithubModuleRejectsUnknownReviewEvent`, the real `Module`'s
  allowlist as defense-in-depth).

## Draft → ready for review + reviewer picker (`ready_for_review` + `modules/reviewerusage`)

A Workflow Type, **`ready_for_review`**, flips a **draft** PR to "ready for
review" and optionally requests reviewers — driven from the PR-overview
per-row popover (see "Ready for review" in `.claude/rules/pages-and-routing.md`).
Signal-less, one Execution per request, mirrors `submit_review`'s synchronous
pattern.

- **`modules/github`** got three methods (`Client` + `Fake`):
  `ListCollaborators` (read — `repos/{repo}/collaborators`, the candidate
  reviewers), `MarkReadyForReview` (GraphQL `markPullRequestReadyForReview`
  via the existing `prNodeID`), and `RequestReviewers`
  (`POST repos/{repo}/pulls/{pr}/requested_reviewers`, each login validated
  against `reReviewerLogin` before `exec`). `Fake` records
  `ReadyForReviewCount`/`LastRequestedReviewers` + `SetCollaborators` for
  tests.
- **`modules/reviewerusage`** (`data/reviewerusage.db`): the local, "personal"
  usage-store — `reviewer_usage(repo, login, count)`. Nothing else writes it,
  so it only ever reflects the reviewers this user assigned through this
  feature. Write `Bump(repo, logins)` (workflow-only, `ON CONFLICT … count+1`,
  dedups a login within one call); read `List(repo)` (most-used first, ties
  alphabetical). Opened in `newTasks` and set on the manager
  **post-construction** (`mgr.reviewerusage = ru`) rather than as a
  `NewTaskManager` param — deliberately, to avoid churning every existing test
  call site; a nil store makes the `bumpReviewerUsage` Activity a no-op (like
  the other module-guarded activities).
- **Workflow** (`workflows.go`): `readyForReviewWorkflow` runs
  `markReadyForReview` → (only when reviewers are given) `requestReviewers` →
  `bumpReviewerUsage`. Deterministic — the number of Activities is a function
  of the input's reviewer list. `StartReadyForReview` runs it synchronously
  and surfaces a failed GitHub call as an error (mirrors `StartSubmitReview`).
- **Reviewer candidates** (`TaskManager.Reviewers`, read): merges
  `ListCollaborators` with the usage counts and sorts most-used-first (ties +
  never-used collaborators fall back to alphabetical). Served by read-only
  `GET /api/reviewers` → `{ok, reviewers:[{login, avatarUrl, count}]}`.
- **Endpoint:** `POST /api/workflows/ready_for_review {pr, reviewers?}`
  (`handleReadyForReview`); `validateReadyForReview` rejects a non-positive pr
  or an invalid login (400) and trims+dedups the reviewer list before the
  workflow starts.
- Tests: `ready_for_review_test.go` (`TestValidateReadyForReview`;
  `TestReadyForReviewWorkflow` — marks ready + requests + bumps usage via the
  Fake, then `Reviewers()` sorts alice(2)/bob(1)/carol(0);
  `TestReadyForReviewWorkflowNoReviewers` — the reviewer Activities are skipped
  with no reviewers), `modules/reviewerusage/reviewerusage_test.go`
  (Bump/List round-trip + dedup + most-used ordering).

## AI risk check of the whole PR (`code_warning` + `code_warning.go`)

An eighth Workflow Type, **`code_warning`**, does a **PR-wide, agentic**
risk check: not a per-line check, but a single run that searches the
**whole PR** for risks — correctness, security, and style/quality — while
also looking at code a change is **connected** to (callers, called code,
tests, listeners) that the PR itself doesn't touch. This is deliberately
**agentic Opus only** (`claude.ModelOpus`, with `Read`/`Grep`/`Glob` in
the head worktree) — no Haiku context-only pass like `explain_code`, and
no Haiku-first-then-Sonnet/Opus escalation like `resolve_call` used to do:
the whole point is that the model itself must explore the worktree to find
something outside the context we hand it in advance (a caller whose call
no longer matches a changed signature, a test that still checks the old
form, an event listener that doesn't handle a new payload field). Opus is
deliberately the strongest available model here — this is a manually
triggered, low-frequency action, not something run on every navigation
step (unlike `explain_code`, which is also Opus but on-demand per unit —
see above). One Execution per manual run, **no Signal** — the workflow
runs its Activities sequentially and completes, mirroring
`submit_review`/`ingest`.

- **Trigger: manual, PR-wide** (not per group/line/call) — the item
  **"Diepgravend onderzoek"** ("in-depth investigation") in the `/` menu
  (`PR_COMMANDS`, `home.mjs`), which calls `POST /api/workflows/code_warning
  {pr}` (`checkPRWarnings`). Deliberately no automatic trigger (like
  `explain_code`'s debounce or `resolve_call`'s auto-search): a PR-wide
  agentic Opus pass with a judgment-based (not merely searching) goal is
  too expensive/too noise-sensitive to run silently on every navigation
  step.
  **Running it repeatedly is a deliberate, repeatable "refresh" of the
  check** — no idempotent Run-ID dedup like `explain_code`
  (`StartCodeWarning` is a bare `StartWorkflow`): every run supersedes
  (see below) the previous findings of the files in scope, so running it
  again replaces instead of stacking.
  **Incremental on a new commit is deliberately NOT built yet** — a
  fast-follow could piggyback this on `pr_status`'s ingest-refresh delta
  (`refreshIngestDelta`'s already-computed changed-file list), but that
  touches `pr_status`'s workflow body and the `ingestResult` schema, which
  was deliberately kept out of this task.
- **Scope + cap (`resolveWarningScope` Activity):** reads the PR's current
  blocks (`blocksByPR`) and derives the files to check from that
  (`CodeWarningInput.Files` empty → all currently changed files of the PR;
  filled → passed through unchanged, reserved for the incremental
  fast-follow, today always empty from the one caller). Also yields the
  number of blocks in scope, which determines the findings cap:
  **`warningsPerBlock` (2) × blocks-in-scope**, with a floor of 2 — "on
  average at most ~2 warnings per block", not a fixed number. The model
  also gets that cap + instruction ("quality over quantity") in the prompt
  (`warningPrompt`), but the cap is **hard-enforced in Go**
  (`runCodeWarningReview` sorts on `file, line` and truncates at
  `MaxFindings`) — a model that ignores the instruction can thus never
  exceed it.
- **Findings come back as a list with their own anchor, mapped onto the
  existing comment anchor model:** the model responds with a JSON array
  `[{"file","line","text"}]` (`claude.CodeWarningSystemPrompt`,
  `modules/claude/prompts/code_warning.md`) — there's no pre-selected unit
  anymore, so the agentic call must return the locations itself.
  **Hallucination protection:** a finding is only trusted if its `file` is
  literally one of the files the prompt gave the model
  (`runCodeWarningReview`'s `allowed` set) — a completely made-up path is
  silently rejected, never shown. `anchoredWarning` (`code_warning.go`)
  then reuses **literally** `blockForLine`/`rowForLine` — the same
  mechanism an imported GitHub review comment uses to anchor (see
  "Importing existing GitHub comments" above): if the `file`+`line` falls
  within a block of this PR, it becomes a **normal, block-scoped** warning
  (`Kind ""`, `Gran "line"`, anchored on its row — exactly like any other
  line comment); if it does **not** fall within a block (an
  unchanged/context line, or a `line` the model got slightly wrong), then
  — instead of being silently discarded — it becomes a **PR-wide** warning
  (`Kind "ai_warning"`, added to `isPRWide` in `comment_import.go`),
  visible in the PR-wide-comments card under the PR-info column (see
  "PR-wide comments" in `.claude/rules/detail-layout.md`) — `File` still
  gets set, as a hint of what the finding is about, even without a precise
  line.
- **Auto-supersede, scoped per file** (`supersedeFileWarnings` Activity,
  runs **before** the agentic call): for each file in scope, every
  existing `Source:"ai"` comment on that file gets deleted via the
  **existing delete Signal** (`ReactionSignal{Action:"delete"}` on the
  comment's own `task_code_comment` Execution — the same mechanism as the
  UI's "Delete comment", see the section above) — best-effort per comment
  (a run that's already closed can't be signaled again, and that must not
  block the rest of the supersede). A file **outside** this run's scope
  simply keeps its old AI warnings.
- **Every warning is a normal `task_code_comment` Execution** — no new
  comment machinery: the `createWarningComment` Activity simply calls
  `TaskManager.StartCodeComment` (the same sanctioned write path as a
  UI-placed comment) with `Source:"ai"` (a new value alongside `"ui"`/
  `"github"`) + `Local:true` (never to GitHub — the same flag as a private
  note), `Author:"AI check"`. Because it's a full Execution, the reviewer
  can resolve or delete it just like any other comment (the existing
  delete Signal, see above) — no separate read model, no separate UI
  layer.
- **Determinism/write boundary:** the workflow body (`codeWarningWorkflow`)
  does no IO itself — only `ExecuteActivity` calls in a fixed order
  (scope resolution → supersede → the one Opus call → one
  `createWarningComment` per finding); the number of `createWarningComment`
  calls is exactly `len(toCreate)`, a function of `runAgenticReview`'s
  **stored** result, so replay-safe. All non-determinism/IO (DB reads, the
  Opus call, comments reads/deletes/creates) sits in Activities; the
  only writers are the existing sanctioned paths (`TaskManager.Signal`/
  `StartCodeComment`) — no new direct module writes.
- **Frontend:** the warning gets its own badge — the same warning-triangle
  SVG as `related-covers-warning` (see "Linking test coverage" above), now
  as a small pill (`aiWarningBadge`, `data-testid=comment-ai-warning`,
  `RelatedPanel.mjs`) in the comment row, the thread header, and the
  PR-wide-comments row (`PW_KIND_LABEL.ai_warning` = "AI risk"). The
  "Tasks" column shows the run as **"Risk check"**
  (`WORKFLOW_LABELS.code_warning`); a running run shows "searching the PR
  for risks…", a finished run shows the **exact number** of findings —
  including "no risks found" — via a new `WorkflowRunView.WarningsFound`
  field (`tasks_api.go`'s `RunsForPR`, read from the run's own stored
  `Result` with `engine.Result`, mirroring how `Comment` is parsed from the
  run's `Input`).
- **Endpoint:** `POST /api/workflows/code_warning {pr}` (`handleCodeWarning`).
  `GET /api/workflows?pr=N` (existing) shows the run like any other.
- Tests: `code_warning_test.go` (Fake-Opus yields a findings array →
  anchorable becomes block-scoped with `Source:"ai"`/`Local:true`,
  non-anchorable becomes PR-wide `Kind:"ai_warning"`, a finding outside
  scope is silently rejected, a second run supersedes the first instead of
  stacking, and the `warningsPerBlock` cap is hard-enforced despite a
  model ignoring it).

## Snoozing a task (`task_snooze` + `modules/tasksnooze`)

A ninth Workflow Type, **`task_snooze`** (one Execution per **repo**, mold
of `approve`/`ignore` — the task-level successor of the removed per-PR
`ignore` feature), makes reviewer choices to hide a **task** from the
`/inbox` task list **durable**. Purely local — it never touches the
network, so no `SLASH_*=off` gating is needed. Unlike the removed `ignore`
feature (keyed on a PR number), this is keyed on a generic **task id**
(`pr:<n>` / `comment:<runId>` / `jira:<KEY>`, the same ids `taskinbox_analysis.go`
assigns — see below), since a task isn't always a PR.

- **`modules/tasksnooze`** (`data/tasksnooze.db`, mold of `modules/ignore`):
  the read model `snoozes(task_id, until)`, PK `task_id`. `until` is an
  **absolute Unix-ms expiry** (`0` = forever, never expires). Write
  `Set(taskID, until)` (workflow-only): upsert, or — when **`until < 0`** —
  a DELETE of the row (un-snooze). Read `List()`. `List` does **not**
  filter on expiry: the "is this still snoozed?" check happens at
  **read time** in the UI (`until === 0 || until > Date.now()`), exactly
  like the old `ignore` feature's own client-side check.
- **Workflow** (`workflows.go`): `taskSnoozeWorkflow` is a loop on
  **`SignalSnooze = "snooze"`** (`SnoozeSignal{TaskID, Until, Clear}`);
  every signal runs one `saveTaskSnooze` Activity (`Clear` → `Set(...,
  -1)`, otherwise `Set(..., Until)`). **Deterministic without a clock:**
  the UI computes the absolute `Until` (browser-local time,
  `snoozeUntil(kind)` in `src/inbox.mjs`) and sends it along, so the
  workflow body never reads `w.Now()` — the number of Activities is
  exactly the number of signals in the history. Never completes, one
  long-lived per-repo tracker. `EnsureTaskSnooze()` (mirrors `EnsureInbox`,
  field `snoozeRun` + `findTaskSnoozeRunLocked`) starts/reuses the
  Execution, also after a restart (`engine.Recover` re-blocks it on the
  signal); called at server startup (`newTasks`) alongside `EnsureInbox`.
  Unlike `pr_inbox`/`task_inbox`, `EnsureTaskSnooze` has **no poller** — it
  only ever reacts to UI signals, there's nothing to periodically refresh.
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/task_snooze` →
  `EnsureTaskSnooze`, returns `{runId}` (the UI signals snooze/un-snooze
  there); the **generic** `POST /api/workflows/{runID}/signals/snooze
  {taskId, until|clear}` delivers the Signal (a decode branch alongside
  `set`/`reply`/`rebuild`); read-only `GET /api/tasksnoozes` →
  `{ok, snoozes:[{taskId, until}]}`.
- **Frontend:** see "The task inbox page (`/inbox`)" in
  `.claude/rules/pages-and-routing.md` (the per-row snooze-duration
  popover, the client-side hiding + "snoozed tasks" drawer).
- Tests: `modules/tasksnooze/tasksnooze_test.go` (round-trip, upsert
  overwrites, a negative `until` clears), `task_snooze_test.go`
  (`TestTaskSnoozeWorkflow`: `EnsureTaskSnooze` + a `snooze` Signal → read
  model, a `Clear` Signal un-snoozes, and `EnsureTaskSnooze` idempotency).

## The task inbox: `task_inbox` + `modules/taskinbox` (aggregation) + the `/inbox` page

A "task" is **derived, not primarily stored** — it doesn't live in its own
table anywhere. Three independent sources each yield candidate tasks;
`buildTaskInbox` (`taskinbox_analysis.go`) merges and scores them into one
flat list, which the `task_inbox` workflow (mirrors `pr_inbox` exactly: one
Execution per repo, a `refresh` Signal drives one Activity, never
completes) full-swaps into the `taskinbox` read-model. `GET /api/tasks`
serves that read-model to the `/inbox` page (`src/inbox.mjs`, see "The task
inbox page (`/inbox`)" in `.claude/rules/pages-and-routing.md`), which
combines it with the `task_snooze` read-model above to hide snoozed tasks.

- **Source A — `pr_review`** (id `pr:<n>`): open PRs where you're a
  reviewer. Reuses the **existing** "Needs your review" section of
  `pr_inbox`'s own `buildInboxSnapshot` (`inbox.go`) — no separate GitHub
  query. `prReviewCandidates` just filters `snap.Sections` by
  `needsYourReviewTitle`.
- **Source B — `comment_unread`** (id `comment:<commentID>`): for every
  **other** open PR you authored (the four remaining `inboxSections`
  entries that are all `author:@me state:open`, named in
  `myOpenPRSectionTitles` — together with source A's section they exhaust
  `author:@me state:open`, since `buildInbox`'s cross-section de-dupe
  guarantees a PR lands in only the first section it matches), every
  comment thread (`comments.Module.List`) whose **last message** wasn't
  written by you and whose status isn't `resolved`. A `comments.Comment`
  **is** the thread root; its `Reactions` are the replies (see the comments
  module's own doc comment) — `unreadCommentCandidates` compares the root's
  own author/time against the last reaction's, if any.
- **Source C — `jira`** (id `jira:<KEY>`): every Jira issue assigned to you,
  regardless of status, via the new `jira.Client.AssignedToMe` (`acli jira
  workitem search --jql "assignee = currentUser() order by updated desc"
  --fields "key,summary,status" --json`, verified interactively against a
  real, authenticated `acli`). `jira.Issue` grew a `Status` field for this.
- **Scoring (`taskinbox_analysis.go`, pure, table-driven):** every kind has
  a `baseScore` (pr_review 20, comment_unread 20, jira 10) plus zero or more
  `pointRules` — small `{ID, Kind, Eval(taskSignals) (points, label)}`
  entries, summed by `computeTaskPoints` into a total + a `[]PointNote`
  breakdown (always starts with a `"basis"` note, so the base score is
  never silently hidden). Adding a rule is one new table entry — no change
  to `computeTaskPoints` itself. Current rules: `ci_failing` (+10, latest
  CI rollup FAILURE/ERROR), `pr_aging` (+10, PR open > 3 days — the same
  threshold as the `ouder-3-dagen` filter preset, now read from a plain
  `createdAt` field added to `inboxRow`/`ghPRNode`/`lightFields` instead of
  a gh search qualifier), `changes_requested` (+10, the thread's PR
  currently has `reviewDecision CHANGES_REQUESTED`), `comment_aging` (+10
  per day unanswered, capped at +30 — day 0 doesn't count, it only just
  became unread), `jira_active` (+10, ticket status isn't
  Backlog/To&nbsp;Do — `isJiraActive` matches on the status **name**,
  case-insensitively, not the statusCategory key, since that taxonomy
  differs per Jira project).
- **`modules/taskinbox`** (`data/taskinbox.db`): the read-model,
  `tasks(id, kind, title, subtitle, points, point_notes, pr, url, detail,
  updated_at)` — `point_notes`/`detail` are opaque JSON strings (the main
  package owns their shape per `kind`: `prReviewDetail`/
  `commentUnreadDetail` (the thread's messages + the comment's own
  code/gran/label/row anchor, if any)/`jiraDetail`). Write
  `Replace(tasks)` (workflow-only, full swap, mirrors
  `relations.Replace`/the inbox snapshot — a derived list, no incremental
  maintenance); read `List()`. Sort order (by points, tie-break recency) is
  deliberately left to the later frontend phase — `List` just returns
  whatever is stored.
- **Workflow (`workflows.go`):** `taskInboxWorkflow` is an exact mirror of
  `prInboxWorkflow` — a `for` loop on `SignalRefresh` driving one
  `refreshTasks` Activity (`buildTaskInbox` + `taskinbox.Replace`).
  `EnsureTaskInbox`/`findTaskInboxRunLocked`/`pollTaskInbox` mirror
  `EnsureInbox`/`findInboxRunLocked`/`pollInbox` exactly (heartbeat-driven
  cadence, one Execution per repo, resumed via `engine.Recover` after a
  restart). Called once at server startup (`newTasks`, alongside
  `EnsureInbox`); `taskinbox` itself is wired onto `TaskManager`
  **post-construction** (`mgr.taskinbox = ti`, the same pattern as
  `reviewerusage`) rather than as a `NewTaskManager` parameter, so no
  existing test call site needed to change.
- **Endpoints:** `POST /api/workflows/task_inbox` (ensure the tracker,
  returns `{runId}` — only re-ensures if no Run ID exists yet, since
  `EnsureTaskInbox` spawns a poller goroutine and must not be called
  repeatedly) and read-only `GET /api/tasks` → `{ok, tasks:[...]}`. The
  **generic** `.../signals/refresh` handler (already used by `pr_inbox`)
  works unchanged here too — it just signals whatever Run ID it's given.
- **Best-effort per source:** `buildTaskInbox` never fails the whole
  refresh over one source hiccup — a failed `buildInboxSnapshot` skips
  sources A+B for that round (C still runs), a failed
  `jira.AssignedToMe`/`comments.List` per PR is likewise swallowed. Mirrors
  `buildInboxSnapshot`'s own "keep the last good snapshot" philosophy,
  narrowed to "skip only the failing source" instead of the whole refresh.
- **Login resolution reuses `snap.GeneratedFor`, never calls `ghLogin`
  directly:** `ghLogin` (`inbox.go`) always shells out to the real `gh`
  binary — every existing caller only reaches it from `buildInbox`'s
  non-offline path. `buildTaskInbox` instead reads the already-resolved
  login off the `buildInboxSnapshot` result (`ghLogin(ctx)` online, the
  fixture's own `generatedFor` field offline), so a `SLASH_GITHUB=off` test
  never touches `gh` even indirectly.
- **Open point (flagged, not guessed):** the exact `acli jira workitem
  search` subcommand/flags were verified interactively against a real,
  authenticated `acli` in this environment (see `AssignedToMe`'s doc
  comment for the exact invocation and sample output) — so this is
  confirmed, not a guess. What's still open for whoever authenticates
  `acli` differently (e.g. a different Jira Cloud site config) is whether
  the JQL default order (`order by updated desc`) and the `--limit 100`
  cap need tuning; no test depends on live `acli`.
- **Frontend (`src/inbox.mjs`):** see "The task inbox page (`/inbox`)" in
  `.claude/rules/pages-and-routing.md` for the index/detail layout, the
  three kind-specific detail views, and how snoozing (see the `task_snooze`
  section above) and the `comment_unread` reply/resolve flow (the existing
  `task_code_comment` reply Signal, see "The first slash task" above) hang
  off this same read-model.
- Tests: `modules/jira/jira_test.go` (`AssignedToMe`'s `Fake` round-trip),
  `modules/taskinbox/taskinbox_test.go` (`Replace`/`List` round-trip +
  full-swap + empty-clears), `taskinbox_analysis_test.go`
  (`TestComputeTaskPoints` — a table test per rule, isolated and stacked;
  `TestIsJiraActive`; `TestUnreadCommentCandidates` — root-vs-reaction last
  speaker, resolved-thread exclusion, own-comment-with-no-reply exclusion;
  `TestJiraCandidates`), `workflows_test.go`'s
  `TestTaskInboxRefreshPopulatesReadModel` (end-to-end: the offline inbox
  fixture for source A, a seeded unread comment for source B via the real
  `comments.Module`, `jira.Fake` for source C → `taskinbox.List` filled
  with one task per source). Entirely offline
  (`SLASH_GITHUB=off`/`github.Fake`/`jira.Fake`) — no real
  gh/acli/network call in any test. Playwright: `tests/inbox-tasks.spec.mjs`
  (all three kinds shown with a points badge + breakdown, seeded via the
  shared `tests/fixtures/inbox.json` + `tests/fixtures/jira-assigned.json`
  under `SLASH_JIRA_ASSIGNED`, see `tests/_fixtures.mjs`).


## Daily data cleanup (`cleanup` + per-module `Purge`)

A tenth Workflow Type, **`cleanup`**, purges **all** data of a PR once it has
been merged for more than 7 days. Motivation: `data/` is dominated (~99.6%) by
the git worktrees the ingest pipeline materializes per PR
(`data/worktrees/pr-<n>-{base,head}`, ~300 MB per checkout) — a PR that's
long since merged has no further reason to keep that disk around, and neither
do its workflow runs or its read-model rows. One Execution per run,
**signal-less** — it runs its two Activities sequentially and completes,
mirroring `WorkflowIngest`/`WorkflowSubmitReview`.

- **`cleanupMergedAge`** (`cleanup.go`) is the retention window — `7 * 24 *
  time.Hour`. The workflow body computes the cutoff **once**, via `w.Now()`
  (recorded through `SideEffect`, so replay reuses the same value) unless the
  input already carries an explicit `Cutoff` (tests pin one this way, so they
  don't depend on wall-clock timing).
- **`resolveCleanupTargets` Activity** (read-only: github + DB + disk reads,
  never a write) determines the candidate PRs and which of them qualify:
  - **Candidates** (`cleanupCandidatePRs`) are the **union** of `DISTINCT pr`
    from `blocks`, `DISTINCT pr` from `pr_ingest` (graph.db), and any PR
    number found in a `data/worktrees/pr-<n>-{base,head}` directory name —
    not just the blocks table. This makes a half-finished previous cleanup
    (worktree already gone but a stray read-model row survived, or vice
    versa — e.g. the process died mid-purge) self-healing: the next run
    still finds it as a candidate and finishes the job.
  - **Eligibility** relies on `github.Client.PRMeta`'s new **`MergedAt`**
    field (RFC3339, empty when the PR isn't merged — `Module.PRMeta` reads
    GitHub's nullable `merged_at` alongside the fields it already fetched, no
    extra `gh api` call). A PR is a target only if `MergedAt` is non-empty
    (really merged — a closed-without-merging PR is **never** touched,
    "niet enkel closed") **and** parses **and** falls before the cutoff. A
    `gh` hiccup, an unparsable timestamp, or a too-recent merge all simply
    leave the PR out — cleanup only ever removes data it's certain about.
    `github.Fake` grew `SetPRMetaFor(pr, meta)` (a per-PR override, checked
    before the existing PR-independent `SetPRMeta`) so a test can give
    several candidate PRs distinct merge states at once.
- **`purgePR` Activity**, called once per resolved target (so the number of
  calls is a function of `resolveCleanupTargets`'s **stored** result —
  replay-safe), removes, for that one PR:
  1. **Worktrees** — `removePRWorktrees` deregisters each directory via `git
     worktree remove --force` (best-effort — an already-broken/foreign
     directory just falls through) and then `os.RemoveAll`s it; a directory
     that's already gone is simply skipped. Finishes with a best-effort `git
     worktree remove`/`prune` sweep. By far the biggest disk win.
  2. **Workflow runs** — `deletePRWorkflowRuns` walks `engine.Runs()` and
     parses each run's stored input for a `"pr"` field, **exactly** the way
     `RunsForPR` (`tasks_api.go`) already does, then calls the new
     `Engine.DeleteRun(runID)` (see below) for every match. A **per-repo**
     tracker (`pr_inbox`/`task_inbox`/`task_snooze` — no `"pr"` field in
     their input) never matches and is therefore never touched.
  3. **Read-model rows** — `purgePRBlocks` (`db.go`, `blocks` + `pr_ingest`
     in one transaction) plus a new **`Purge(ctx, pr) (int64, error)`**
     method on every other read-model with a `pr` column: `comments`
     (a single `DELETE FROM comments`, relying on the same `reactions`
     cascade `Delete` already trusts), `approvals`, `relations`,
     `callresolve` (unconditional, unlike `Prune`'s keep-set variant),
     `testcovers` (ditto), `prmeta`, `explanations`. There is **no** `ignore`
     module anymore — the old per-PR ignore feature was already replaced by
     the task-level, per-repo `task_snooze` (see "Snoozing a task" above), so
     there's nothing to purge there.
  Every dependency (each module, the engine, the DB) is optionally `nil`,
  mirroring every other Activity in `NewTaskManager` — a caller that doesn't
  wire a given module simply skips that store. `purgePR` logs, per PR, the
  worktrees/workflow-runs/row counts removed (`log.Printf`, inside the
  Activity — never in the workflow body itself, consistent with every other
  workflow here). Every underlying `DELETE`/`os.RemoveAll` is unconditional
  on `pr`/the path, so **re-running cleanup on the same PR is always a
  no-op** once its data is gone — that's the idempotency the daily trigger
  (below) relies on.
- **`Engine.DeleteRun(runID)` (`tembed/engine.go` + `Store.DeleteRun`)** is a
  new, deliberately abstract tembed primitive (it knows nothing about PRs) —
  the engine previously had no way to remove a run at all. `Store.DeleteRun`
  is implemented by all four stores: `MemoryStore`/`SQLiteStore` (SQLite:
  `DELETE FROM events` then `DELETE FROM runs` in one tx — explicit rather
  than relying on the `events.run_id` `ON DELETE CASCADE`, since SQLite's
  `PRAGMA foreign_keys` is per-connection and `database/sql`'s pool may hand
  out a different connection than the one the schema was applied on) and
  `JSONLStore` (removes the `<id>.meta.jsonl`/`<id>.events.jsonl` files,
  tolerating "already gone"). `MultiStore.DeleteRun` fans out to every
  wrapped store. `Engine.DeleteRun` additionally stops/discards any pending
  durable timer for that run and releases its run lock — a deleted run can
  never be woken up again. **Deleting an unknown run ID is a no-op, not an
  error** — the idempotency guarantee a repeated cleanup pass (and thus
  `deletePRWorkflowRuns`) needs. Test: `tembed/engine_test.go`'s
  `TestEngineDeleteRun`.
- **Triggered two ways:**
  - **Manually:** `POST /api/workflows/cleanup` (`handleCleanup`,
    `tasks_api.go`) — the sanctioned write path, no request body (the cutoff
    is always computed server-side, so a caller can't widen the safety
    window via the API).
  - **Automatically, once a day:** `TaskManager.StartCleanupScheduler(ctx)`,
    called from `newTasks` alongside the other `Ensure*` calls (gated by
    `resumeRuntime`, so a one-shot CLI caller never starts it). It's a
    **plain background goroutine** with a `time.Ticker` (24h) — an immediate
    pass, then one every `cleanupScheduleInterval` — **not** a durable
    `w.Sleep` loop inside the `cleanup` workflow itself. Chosen because: (1)
    it's the same shape every other periodic trigger in this codebase
    already uses (`pollInbox`/`pollIngestRefresh`/`pollImportComments` — all
    external goroutines that Start/Signal on a cadence, never a workflow
    that sleeps forever); (2) cleanup has no reviewer-driven heartbeat
    concept to piggyback on — it's unconditional daily maintenance, not
    something a user is "actively viewing", so the fast/slow cadence
    machinery those pollers use doesn't apply; (3) it keeps the `cleanup`
    Workflow Type itself a short, one-shot, signal-less run (mirroring
    `ingest`/`submit_review`) instead of an unusual infinite-loop workflow
    that would otherwise sit permanently `waiting` in `GET /api/workflows`.
    Running an extra pass on every restart is harmless — see the
    idempotency guarantee above.
- **Also purges orphaned runs of a permanently retired Workflow Type
  (`purgeRetiredWorkflowRuns` + `retiredWorkflowTypes`, `cleanup.go`) —
  unconditional, run once per cleanup pass via its own `purgeRetiredWorkflows`
  Activity, independent of the resolved PR targets above.** Motivation: when
  a Workflow Type's registering code is removed from the codebase (e.g. the
  old per-PR `ignore` feature, replaced by the per-repo `task_snooze` — see
  "Snoozing a task" above), any run of that type that was still
  `running`/`waiting` becomes a permanent orphan: `engine.Recover()` logs
  `tembed: run <id> uses unregistered workflow "<name>"` on **every** server
  start, forever, since nothing can ever advance it again.
  `retiredWorkflowTypes` is a small, explicit, hand-maintained map of names
  known to be gone for good (currently just `"ignore"`) — deliberately
  **not** "whatever `engine.Runs()` reports as currently unregistered": the
  headless CLI (`slash ingest`/`relations`/`seed`) registers only a subset of
  workflows on purpose (`newTasks(..., resumeRuntime=false)`), so treating
  "not registered in this process" as "safe to delete" would risk deleting a
  perfectly legitimate run just because the binary invoking cleanup happens
  not to register that type. A name only belongs in this map once its
  registering code has been deleted from the codebase entirely. Because
  `cleanup` itself only runs in the actual server (`StartCleanupScheduler` is
  gated by `resumeRuntime`, see below), the headless CLI never runs this
  purge either — reinforcing that this stays a deliberate, server-only,
  explicitly-named cleanup, never an automatic "unregistered = dead"
  inference. `purgeRetiredWorkflowRuns` walks `engine.Runs()` and calls the
  same `Engine.DeleteRun` as `deletePRWorkflowRuns` for every match; the
  result count lands in the new `CleanupResult.RetiredRunsDeleted` field.
- **Endpoint:** `POST /api/workflows/cleanup` → `{cutoff, purged:[{pr,
  worktreesRemoved, workflowRunsDeleted, rowsDeleted}], retiredRunsDeleted}`
  (`handleCleanup`, added to the reserved-names guard in `handleWorkflows`
  alongside the other signal-less Workflow Types).
- Tests: `cleanup_test.go` (`TestResolveCleanupTargets` — candidate
  discovery via the blocks table *and* bare worktree dirs, and the four
  eligibility branches: merged-old/merged-recent/open/unparsable;
  `TestPurgePRRemovesEverything` — seeds one row in every read-model plus a
  worktree pair plus a per-PR **and** a per-repo workflow run, then asserts
  everything PR-scoped is gone and the per-repo tracker survives;
  `TestCleanupSkipsRecentMerge`; `TestCleanupNeverTouchesOpenPR`;
  `TestCleanupIdempotent` — a second same-day run is a no-op;
  `TestCleanupPurgesRetiredWorkflowRuns` — a simulated orphaned `"ignore"`
  run is deleted and its count reported, while a current per-repo tracker
  survives the same pass). Entirely offline (`github.Fake`), no real
  gh/network call.
