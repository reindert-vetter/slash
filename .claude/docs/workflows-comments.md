# Comment workflows: `task_code_comment` + GitHub import

The comment-thread half of the workflow layer: placing a comment on a line of
code and keeping the thread alive, plus pulling in threads that were placed
outside the app. Engine mechanics live in `.claude/docs/tembed-workflows.md`,
endpoints in `.claude/docs/tembed-endpoints.md`.

## `task_code_comment` (`workflows.go` + `modules/`)

A **Workflow Type** `task_code_comment`, one Execution per comment, whose **Run
ID is the comment id**.

**Flow:** `saveComment` + `postGithubComment` (best-effort), then a loop on
`reply` Signals. A reaction arrives from the UI **and** from a per-thread
poller, both as the same Signal; every reaction is stored, a UI reaction is
mirrored to GitHub, and `Done`/`/resolve` resolves the thread — which it can be
brought back out of again, see "Resolve is reversible" below. Only a **delete**
ends the Execution.

### The three modules it drives

- **`modules/comments`** (`data/comments.db`, tables `comments`/`reactions`):
  counts reactions and sets `status` to `resolved` on `/resolve` (and back to
  `open` via `SetStatus`, see the `unresolve` action below).
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
  - **`reactions.github_id`** is the reply's own equivalent of the comment's
    `github_id` above: the GitHub comment id a UI reply was mirrored to (a
    review-comment reply, or — for a PR-wide thread — a new issue comment; see
    "The `edit` Action" below), set by **`saveReactionGithubID`**, called right
    after the existing reply-mirror Activity (`replyGithub`/
    `postGithubIssueComment`, both of which now return the mirrored id as a
    `postResult` for this purpose) whenever it returned a non-zero id. 0 for a
    GitHub-sourced reply (never mirrored) or one that failed to mirror.
- **`modules/github`** (`gh api`): `PostReviewComment`, `PostIssueComment`,
  `Reply`, `FetchReplies`, `FetchReviewComments`, `FetchGeneralComments`,
  `PRState`, `PRMeta`, `DeleteComment`, `EditReviewComment`,
  `EditIssueComment`, `ResolveReviewThread`, `MarkFileViewed`,
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
rule in `.claude/rules/arrowjs-pitfalls.md`). Test:
`tests/drill-comment-target.spec.mjs`.

### The `edit` Action — changing an already-placed message's own wording

`ReactionSignal` gained an `Action: "edit"` value: the reviewer changing the
wording of a message they wrote earlier, in place — never adds a new reply.
`ID` is **reused** rather than adding a field: under `"edit"` it names the
message being edited (the thread's own Run ID for the root/opening message, or
an existing reply's own reaction id) instead of a new message's id; `Body` is
the new wording. Frontend: `sendMessageEdit`
(`RelatedPanel.mjs`) posts `{author:'reviewer', body, action:'edit',
targetId}` to the same `POST /api/workflows/{runID}/signals/reply` endpoint
every reply already uses — the HTTP handler (`tasks_api.go`) validates
`action`/`targetId` before ever reaching the workflow, mirroring the
`message` Signal's own `action` validation. Full UI mechanism (the palette
item, the inline editor, `isOwnMessage` gating): "Editing an own message" in
`.claude/docs/comments-panel.md`.

**In `taskCodeCommentWorkflow`'s reactions loop:**

- `r.ID == runID` → the root: **`editCommentBody`** overwrites `comments.body`
  (`comments.Module.UpdateBody`). Leaves status/anchor/code/`github_id`
  untouched.
- otherwise → a reply: **`editReactionBody`** overwrites that one row's
  `reactions.body` (`comments.Module.UpdateReactionBody`).

**Mirrored to GitHub, best-effort, exactly like every other GitHub call in
this loop** — never a Go error, just a log line on failure:

- Root: PATCHed when `posted.RootID != 0` (the value already known in the
  workflow's own memory from the initial post/import, no fresh lookup needed).
- Reply: PATCHed when that reply was itself mirrored when first sent —
  tracked via **`replyGithubIDs`**, a `map[string]int64` **local to this one
  loop**, populated only from this same loop's own already-recorded mirror
  Activity results (`replyGithub`/`postGithubIssueComment`, both changed to
  return the mirrored id as a `postResult` for this purpose, persisted via the
  new **`saveReactionGithubID`** Activity into `reactions.github_id`). Rebuilt
  identically on every replay — never a live GitHub lookup — since it's
  populated purely from this same loop's own recorded history, the same
  reasoning as the `reactions` counter right above it.
- **Which endpoint**: `isPRWide(in.Kind)` → **`editGithubIssueComment`**
  (`gh.EditIssueComment`, `PATCH .../issues/comments/{id}`) — both the root of
  a PR-wide thread and any of its replies always mirror as plain issue
  comments (see "Reply loop per thread kind" below). Otherwise →
  **`editGithubReviewComment`** (`gh.EditReviewComment`,
  `PATCH .../pulls/comments/{id}`) — GitHub represents a review-comment reply
  as a review comment too, at the same endpoint as the root, so one Activity
  covers both.
- **Deliberately not special-cased per sub-kind of `isPRWide`** (`issue` /
  `review_summary` / `review` / `ai_warning`): every one of them posts (root)
  or mirrors (reply) via `postGithubIssueComment` in the existing code above,
  so the same id is always issue-comment-shaped for any of them — including an
  **imported** `review_summary` root, where the recorded id is actually a
  review's own id rather than a plain issue comment (GitHub has no per-comment
  edit endpoint for a review body at all). That one case's PATCH simply
  404s and is logged, the same graceful degrade every other best-effort GitHub
  call here already accepts — not worth a special case for.

Tests: `TestTaskCodeCommentEditRoot`, `TestTaskCodeCommentEditReply`,
`TestTaskCodeCommentEditPRWideRootUsesIssueEndpoint` (`workflows_test.go`,
against `github.Fake`'s `EditedReviews`/`EditedIssues` maps), plus
`TestUpdateBody`/`TestUpdateReactionBodyAndSetReactionGithubID`
(`modules/comments/comments_test.go`).

### Private note (`local` flag)

`Local` on the input — e.g. the Claude-chat auto-anchor comment
(`ensureClaudeAnchorForNew`, `RelatedPanel.mjs`, always local) — makes the
workflow **skip `postGithubComment`**. Replay-safe because the number of Activities
depends on the input, not on live state. `posted.RootID` stays 0, so no poller
starts and the existing `RootID == 0` guards make `deleteGithubComment`/
`replyGithub` no-ops: reacting to or deleting a private note never touches
GitHub.

### Publishing a local thread to GitHub afterwards (`Publish`)

A local thread (a private note, or an **`ai`** `code_warning` finding — always
`Local: true`) is not a dead end: sending a reply on one first asks what may
become public, and the answer rides along on that same `reply` Signal as
**`Publish`** (`""` | `"reply"` | `"thread"`) + **`PublishHistory`**.

- **`"reply"`** — GitHub has no reply without a root, so the reviewer's own
  reply text is posted **as the thread's root** (`postGithubComment`, or
  `postGithubIssueComment` for a PR-wide thread) and is therefore **not**
  mirrored a second time by the ordinary reply path (`publishedAsRoot`). The
  local root's body (e.g. the finding's own wording) stays private.
- **`"thread"`** — the root's own body is posted first and the reply then
  mirrors onto it through the unchanged reply path. An `ai` root goes out as
  **`aiQuoteBody`**: every line quoted, the first prefixed `> [AI-check] ` —
  a reader on GitHub must never mistake the AI check's wording for the
  reviewer's own.
- **`PublishHistory`** additionally mirrors the reviewer's OWN earlier replies —
  the ones written while the thread was still local — in their original order,
  right after the root lands. They come from **`localReplies`**, an ordered
  slice appended in this same loop for every `ui` reply seen while
  `posted.RootID == 0`, and cleared once published: rebuilt identically on
  replay, and a slice rather than a map so the mirror order is deterministic.
  `ai`/system notes in the thread are never mirrored.

**`Action: "publish"`** is the same thing without a message: it publishes the
thread **as it stands** (the root, plus the earlier local replies with
`PublishHistory`) and stores no reaction — the reviewer moving an
already-written local conversation over without typing a new reply first
(`Enter` on an empty reply field, see the comment menu's "Zet op GitHub"). It
sits with the other message-less Actions (`avatar`/`reanchor`/`chat`) and is a
no-op once `posted.RootID != 0`.

All of it lives in **`publishThread`** (a closure in the workflow body), which
also runs `saveCommentGithubID`, so `github_id` flips to non-zero — and that,
with no new state anywhere, IS the "this is a GitHub chat now" marker: from then
on `posted.RootID != 0` makes every following reply mirror through the existing
path, and the frontend stops asking (`needsPublishChoice`). A `Publish` on a
thread that already has a root is ignored for the same reason.

**`rootPublished`** guards one asymmetry: after `Publish: "reply"` the GitHub
comment at `posted.RootID` holds the *reply*, not the root's body, so the
`edit` Action must not PATCH it when the reviewer rewords the still-private
root. It is true only for an imported/normally-posted root or a `"thread"`
publish.

The HTTP handler validates `publish` (`""`/`"reply"`/`"thread"`, and only
together with `action: ""`) and accepts `action: "publish"` with no body,
before either reaches the workflow — like the `action`/`targetId` validation
above. Frontend mechanism (the menu, the held
send): "Publishing a local thread to GitHub" in
`.claude/docs/comments-panel.md`. Tests: `TestPublishLocalThreadWithReply`,
`TestPublishLocalThreadWithHistory`,
`TestPublishLocalThreadKeepsHistoryLocal`,
`TestPublishActionMovesThreadToGithub` (`workflows_test.go`) and
`tests/reply-publish-local-thread.spec.mjs`.

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
  found → a normal line comment (`Kind ""`), **but only when that row is
  itself one of the block's changed rows** (`rowChanged`+`rowHasContent`, the
  same predicates `firstChangedRowIndex` uses, `blockstats.go`) — a GitHub
  review comment can sit on any unchanged context line the diff shows around a
  hunk (unlike an AI `code_warning` finding, which is guarded to a changed
  line before it ever reaches `anchoredWarning`, see "AI risk check of the
  whole PR" in `workflows-analysis.md`), and such a row has no navigable
  line-granularity unit of its own on the frontend (`commentUnder`/`unitAtRow`,
  `RelatedPanel.mjs`/`home.mjs`), so it would silently never show under any
  drilled cursor — reported bug (a real PR comment anchored on a method's
  closing brace, several lines past the actual diff hunk). Pinned row found but
  not a changed one → falls back to the block's own **first changed row**,
  `BlockWide: true` (mirrors `anchoredWarning`'s identical fallback
  one-for-one; kept as pinned-but-unchanged instead if the block happens to
  have no changed row at all — shouldn't happen for a block a real diff ever
  surfaced, but a real row beats none). Block but no row pinned at all →
  `RowStart -1` (shown anywhere in the block, the same "unknown anchor"
  convention app-placed legacy comments use). No block at all → PR-wide
  (`Kind "review"`). `mapGeneralComment` is always anchorless. All carry
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

### Resolve is reversible — the `unresolve` action

A resolve used to `break` out of the reactions loop, which **completed** the
Execution; a completed Execution accepts no Signals, so there was no way back.
It no longer does: the loop keeps waiting after a resolve, and only a `delete`
ends the thread. That makes the mirror action possible.

**`Action: "unresolve"`** (a `reply` Signal like every other action, validated
in `tasks_api.go`'s action switch, sent by `unresolveFocusedComment` /
`unresolvePrCommentItem` in `RelatedPanel.mjs`) does three things, all
input-driven so replay stays deterministic:

1. **`reopenComment`** — `comments.SetStatus(id, "open")`, plus it restarts the
   thread's GitHub reply poller (see below).
2. **`saveReaction`** with the body `reopenSentinel` — the visible trace in the
   conversation. **Local only**: the branch `continue`s before the mirror path,
   because GitHub's own thread state already says it.
3. **`unresolveGithubThread`** → `github.UnresolveReviewThread` (the
   `unresolveReviewThread` mutation, sharing `reviewThreadMutation`'s lookup
   with the resolve direction) — review-diff threads only, best-effort, same
   PR-wide carve-out as the resolve.

**The two sentinel bodies** live in `workflows.go` as `resolveSentinel`
(`"/resolve"`) and `reopenSentinel` (`"/reopen"`). `"/unresolve"` would have
been the obvious name and is deliberately **not** used: `modules/github`
detects a GitHub-side resolve with `strings.Contains(body, "/resolve")`, which
that string matches — a reopen coming back from GitHub would be read as a
resolve. Both are stored verbatim and rendered as a **status line** by the
frontend (`threadStatusSentinel`, see `comments-panel.md`).

**The poller now stops while a thread is resolved.** Without the `break` a
resolved thread would poll GitHub forever, so `poll` returns as soon as the
comment's read-model status is `resolved`, and the `reopenComment` Activity
starts a fresh one (under `m.baseCtx`). `beginPolling`/`endPolling` keep that to
**one** poller per thread and close the race where a reopen lands exactly while
the old poller is exiting (`pollRestart` → the exiting poller relaunches). This
is in-memory only — no read-model, no history, gone after a restart — so it
falls under the same operational carve-out as the heartbeat map
(`.claude/rules/workflows-write-boundary.md`); the actual write is still the
Activity.

**Only threads resolved after this change can be reopened.** One resolved
earlier already completed its Execution, and nothing can signal it again — the
"Unresolve comment" command then simply fails server-side and the status stays
`resolved`. Accepted deliberately: the alternative (a second Execution per
comment, with the comment id no longer equal to its Run ID) is a far larger
change for a one-off backlog.
- **Echo-of-self guard on an INCOMING `github` reply:** `replyGithubIDs` (the
  in-memory map, keyed by our own reply's Signal id, of the GitHub comment id
  each UI reply was mirrored to — same map the "edit" action above uses,
  rebuilt purely from this workflow's own history on replay) is also checked
  right before an ordinary `Source == "github"` reply is saved: if the
  incoming id (`"gh-<id>"`) equals one of those mirrored ids, it's skipped
  entirely rather than stored as a second reaction. Without this, the
  per-thread poller (`poll()`, `TaskManager`) fetches EVERY reply on the
  GitHub thread — including the one this same workflow just mirrored out a
  moment earlier via `replyGithub`/`postGithubIssueComment` above — and that
  echo used to come back under a different reaction id (`"gh-<githubId>"` vs
  the original `"ui-<id>"`), so `AddReaction`'s id-based `INSERT OR IGNORE`
  never caught it: the reviewer's own reply showed up twice in the thread.
  Deterministic: the check only reads `replyGithubIDs`, never a fresh GitHub
  lookup. Test: `TestTaskCodeCommentGithubEchoOfOwnReplyIsIgnored`
  (`workflows_test.go`) — also documents why the existing fixture tests
  (`TestTaskCodeCommentFlow`, `TestImportedThreadMirrorsWithoutEcho`) enqueue
  a deliberately high, non-colliding GitHub reply id for a genuinely external
  reply: a real GitHub comment id is globally unique, so it can never equal
  one this workflow itself just mirrored — a low, colliding test id would
  look like this guard incorrectly swallowing a real external reply.
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
- **A thread resolved ON GitHub is mirrored back** (`applyGithubResolves`, run
  at the end of every `importPRComments`). Nothing did this before: the import
  reads comment **bodies**, and the only local resolve trigger was a reply
  literally containing `"/resolve"` (`FetchReplies`' `Done`), so a thread
  somebody resolved on github.com stayed `open` here forever — no ✓, not
  dimmed, still marking its diff row with a 💬, never folding into "Toon N
  goedgekeurde blokken". `isResolved` exists only on the GraphQL `reviewThread`
  node, never on the REST comment, hence a new read-only
  **`ResolvedReviewThreads(ctx, pr) map[int64]bool`**; it shares one
  `reviewThreads` helper (and thus one query) with `reviewThreadID`, the lookup
  the resolve/unresolve **mutations** already used.

  It rides entirely on the **existing** resolve path — the same `reply` Signal
  with the `resolveSentinel` body + `Done` the reviewer's own "Resolve comment"
  sends — so there is no new workflow branch, Action or endpoint. Sent with
  `Source: "github"`, which is exactly what keeps it from being mirrored back
  out (the loop only mirrors `Source == "ui"`), and it renders as the ordinary
  "✓ Thread opgelost" status line (`threadStatusSentinel`).

  Two deliberate scoping choices: keyed on the comment's own **`GithubID`**
  rather than on "was this imported", so it also covers a thread the app placed
  itself and the reviewer then resolved on github.com; and **not** filtered by
  `Kind`, because a review comment that merely failed to map to a block is
  stored as the PR-wide `Kind "review"` yet still has a real, resolvable
  thread. Membership in the resolved set is the only filter needed — an issue
  comment's id is never in it. No in-memory dedup: signalling is synchronous,
  so the `Status == "open"` check is already false on the next tick, and a
  local **unresolve** unresolves the GitHub conversation too, so it leaves the
  set at the same moment. Terminal runs are skipped with the same
  `engine.Status` check as the avatar backfill (a thread resolved back when a
  resolve still completed the Execution can never be signalled again). Test:
  `TestImportAppliesGithubResolvedState`.
- **Restart:** an imported thread's root id lives in the **input**, not in a
  post event, so `ResumePolling` reads it from there.
- **Reply dedup relies on the DB, not the poller's `seen` map:** that map is a
  speed cache that starts empty on restart, which is safe because `AddReaction`
  does an `INSERT OR IGNORE` on the reaction id (`gh-<id>`) and only bumps the
  count for a genuinely new row. Keep that contract intact.
- **The avatar-backfill glue checks the run's `Status` BEFORE attempting its
  `avatar` Signal** and skips silently on `failed`/`completed`. A terminal run
  can never accept a Signal again; without this check a permanently failed
  thread was retried on every restart forever (`avatarTried` only dedups within
  one process). Test: `TestImportSkipsAvatarBackfillOnFailedRun`.
- **Read model:** `Source` (`ui`/`github`) + `Kind` columns; `GET /api/comments`
  serves imported comments automatically, no new endpoint. The frontend badges
  `source: github` and renders PR-wide comments as their own navigable index
  rows (see "Comment-index items" in `.claude/docs/comments-panel.md`).
- Tests: `comment_import_test.go`, `modules/comments/comments_test.go`,
  `tembed/engine_test.go` (`StartWorkflowID` idempotency).

### A kilo-code finding gets an automatic verification chat

Reviewer request: for every individual finding the `kilo-code-bot[bot]` review
posts, automatically find out whether kilo is actually right and get a
shorter, clearer summary than kilo's own wording — with an optional fix
proposal — without having to open the chat and ask by hand. Deliberately
narrow to kilo's own per-line findings, not its PR-wide summary comment
(`<!-- kilo-review -->`, see `isKiloReview` above), which is never imported at
all and therefore never reaches this either.

- **Trigger:** `isKiloComment(in.Author)` (`comment_import.go`, an exact match
  on `kilo-code-bot[bot]`) is checked right after `importPRComments` starts a
  **brand-new** thread for an imported comment (never for a re-import — the
  `known[in.ImportedRootID]` dedup above `continue`s before this point on
  every later poll). On a match it spawns `autoStartKiloCheck` in its own
  goroutine, same fire-and-forget shape as `autoStartCodeWarning`/the avatar
  backfill, so the import loop never blocks on a Claude call.
- **Gated by the SAME "Live AI assistent" toggle as `code_warning`/
  `explain_code`/`comment_titles`** (`AutoWarnEnabled`, see "Reviewer on/off
  switch" in `.claude/docs/workflows-analysis.md`) — this is exactly the kind
  of automatic, unasked-for Claude call that switch exists to gate. A manual
  chat the reviewer starts themselves is never gated by it, same as every
  other automatic trigger this toggle covers.
- **`autoStartKiloCheck` (`workflows.go`)** calls the ordinary
  `StartClaudeChat(ClaudeChatInput{Repo, PR, CommentID: commentRunID})` — so
  the resulting conversation is an ordinary child of that comment thread, with
  no special-cased Run ID or storage — then sends ONE `message` Signal
  straight via `engine.SignalWorkflow` (server-side glue, never the HTTP
  handler/`tasks_api.go`'s validation switch, which this path never touches)
  carrying a new `Action` value, `chatActionAutoCheck` (`"auto_check"`,
  `chat_workflow.go`). That Action runs through the exact same path as an
  ordinary `""` turn (saved as a `role: "user"` message, a real Claude call
  with the usual shell access) — it exists purely so the saved message can
  carry `chat.KindAutoCheck`, which `chatKindBadge` (`src/ClaudeChat.mjs`)
  turns into a small "automatische controle van kilo-opmerking" badge next to
  the ordinary "Jij" bubble, so the reviewer can tell apart a message they
  never typed from one they did (colorblind rule: word + glyph, not colour
  alone — the bubble itself keeps its ordinary "mine" tint).
- **The prompt (`kiloCheckPrompt`, `workflows.go`)** is built server-side, in
  Dutch like every other reviewer-facing prompt/label: kilo's own body is
  quoted as a Markdown blockquote (so Claude and the reviewer can tell kilo's
  claim apart from Claude's own answer), prefixed with the file/line when
  known (`in.File`/`in.Line`, from the same `CodeCommentInput` the thread
  itself was started from), and closes by asking Claude to verify the claim
  against the real code, summarize it more clearly than kilo did, and
  optionally propose a fix. No code excerpt is embedded — the turn already
  gets its usual Read/Grep/Glob/Bash access to the shadow worktree
  (`runOneClaudeTurn` tries this for every turn), so Claude looks the real
  code up itself rather than trusting a snippet in the prompt.
- **No backfill, by explicit product decision** ("vanaf nu is genoeg") — a
  kilo comment imported before this existed keeps whatever chat state it had
  (usually none); only a comment imported from this point on gets the
  automatic turn.
- Tests: `TestImportKiloCommentAutoStartsVerificationChat`,
  `TestImportKiloCommentSkipsAutoChatWhenAutoWarnDisabled`,
  `TestImportNonKiloCommentNeverAutoStartsChat` (`comment_import_test.go`).

## `claude_chat` (`chat_workflow.go` + `modules/chat` + `modules/claude`'s `RunChat`)

An embedded, multi-turn Claude conversation next to a review comment thread —
the reviewer can ask Claude about the code/comment without leaving the review
tree. **All four phases built**: backbone, frontend panel, agentic tool access
+ committing edits, and — on the reviewer's own explicit request only —
influencing the left comment thread (see "Opt-in influence on the left comment
thread (Phase 4)" below).

### Scope: one conversation per comment thread

**A `claude_chat` Execution always hangs off an existing `task_code_comment`
thread** — its **Run ID is derived from that comment's id**
(`chatConversationRunID`, `"chat-" + commentID`), not from the PR or the
navigation unit. This was a deliberate product decision (over "one chat per
PR" or "one chat per navigation unit"): it reuses the comment thread as the
one existing place with a durable Execution and a reply mechanism, so a later
phase can let the reviewer ask Claude to act on **that same thread** with no
new addressing scheme.

**No comment ⇒ no chat.** Nothing creates a comment to hang a conversation on:
an earlier version had the frontend silently place an empty `Local: true`
placeholder comment for that purpose, which put a comment the reviewer never
wrote on every unit they walked past — removed, and it must not come back (see
`.claude/docs/claude-chat-panel.md` for the frontend rule and how an
already-happened conversation stays reachable). `claude_chat` itself has never
created a comment and still doesn't.

### The conversation is a CHILD workflow of its comment thread

`StartClaudeChat(ClaudeChatInput{PR, CommentID})` starts/reuses the Execution,
idempotently, and always returns the same derived
`chatConversationRunID(CommentID)`. It gets there by **signalling the comment
thread's own `task_code_comment` Execution** — its existing `reply` Signal with
`Action: "chat"` (riding along like `"avatar"`/`"reanchor"`/`"delete"`, since a
workflow can only `WaitSignal` on one name at a time) — whose branch calls
`w.ExecuteChildWorkflowID(chatConversationRunID(runID), WorkflowClaudeChat, …)`.
So the run tree says what is true: the conversation belongs to the comment
(`RunRecord.ParentRunID`). Deliberately:

- **`ExecuteChildWorkflowID`, not `ExecuteChildWorkflow`** — the positional
  variant would derive `<runID>/child-<idx>` and throw away the
  `chat-<commentID>` Run ID that the UI's `message` Signal, `chat_merge.go` and
  `cleanup.go` all address. The explicit-ID variant is idempotent on the
  recorded `EventChildWorkflowStarted` name, so a second `"chat"` signal reuses
  the child instead of starting a `child-1`.
- **No `WaitChildWorkflow`** — a `claude_chat` Execution never completes, so
  the comment thread must not block on it. It signals and `continue`s.
- **Signalling is synchronous** (`SignalWorkflow` → `advance` → the child's own
  start, all inline), so the chat run exists by the time `StartClaudeChat`
  returns and can immediately be signalled itself.
- **The child starts while the parent's run lock is held** (and that lock is
  not reentrant), so `claude_chat`'s FIRST Activity must never signal its
  parent thread. It only ensures its conversation row and then waits — keep it
  that way.

**Carve-out — a thread that can no longer be signalled:**
`taskCodeCommentWorkflow` **ends** on a delete (and used to on a resolve too,
before that became reversible — see "Resolve is reversible" above; threads
resolved back then are still completed), and a completed/failed Execution
accepts no Signals. `StartClaudeChat`
therefore checks the thread's status first (the same shape
`applyChatCommentAction` uses) and falls back to the original top-level
`StartWorkflowID` when the thread is unknown or terminal, logging it via
`tm.logf` — a resolved thread must not lose its chat. Such a run simply has an
empty `ParentRunID`, exactly like every chat created before this change, so
nothing needed migrating and no run needed restarting.

### Flow

`ensureChatConversation` (creates the `chat_conversations` row, idempotent)
then a loop on **`message`** Signals (`ChatMessageSignal{ID, Author, Body,
Action}`, mould of `task_code_comment`'s reactions loop). `Action` rides along
as a variant of this one Signal (tembed can only `WaitSignal` on one name at a
time — the same reason `task_code_comment`'s `delete` rides on its `reply`
Signal via `ReactionSignal.Action`), validated by the HTTP handler **before**
it ever reaches the workflow: `""` (the ordinary turn), `chatActionEdit`
("edit" — now a **no-op synonym** of `""`, kept only for backward
compatibility, see below), `chatActionCommit` ("commit" — push, see "Agentic
edits" below). Per turn:

- **`sig.Action == chatActionCommit`** skips everything else: one
  `commitChatShadowEdits` Activity, no Claude call, no user/assistant text turn
  beyond the status message that Activity itself saves — see "Agentic edits"
  below.
- Otherwise (every other turn, `""` and `chatActionEdit` alike): if the
  assistant's last turn was an unanswered **question** (see below),
  `saveChatAnswer` records the reviewer's reply as that question's `Answer`;
  `saveChatMessage` stores the reviewer's own turn (`role: "user"`);
  `runClaudeTurn` calls `claude.Client.RunChat` — **`runOneClaudeTurn` itself
  decides the tool scope, not `sig.Action`**: it tries
  `prepareChatShellWorkDir` (wrapping `ensureChatShadowWorktree`,
  `chat_shadow.go`) for every turn, gets `Tools:
  ["Read","Grep","Glob","Edit","Bash"]` + `WorkDir` set to the shadow worktree
  on success, and gracefully falls back to a context-only call (no
  `Tools`/`WorkDir`) on any failure — see "Agentic edits" below and
  `.claude/rules/workflows-write-boundary.md`'s "Exception: the Claude chat
  turn may act through a shell". Either way, the assistant's reply is stored
  the same way.

The workflow's own branch (commit vs. everything else) is still decided purely
by `sig.Action`, part of the Signal's own recorded input, so the Activity
count/order per Signal stays a pure function of history — deterministic under
replay regardless of live git/filesystem state. The Tools/WorkDir decision
INSIDE `runOneClaudeTurn` is not part of that determinism boundary — it is an
ordinary Activity side effect (like the `gh`/git calls it makes), free to vary
with live reachability across replays; only the Activity's recorded output
(the saved message) has to be reproduced, never the internal path that
produced it.

Never completes — a long-lived per-conversation tracker. Marked
`PriorityLow` (a real turn is a `claude` subprocess call, same reasoning as
`resolve_call`/`code_warning` — an interrupted turn must not block server
startup on recovery).

**Determinism:** the loop tracks "is a question still open" purely from the
**previous Activity's result** (`assistant.Kind`), never from wall-clock/
random state, so it replays safely; the reviewer-turn's `ID` is generated by
the HTTP handler (`"msg-" + newUIReactionID()`), exactly like a
`ReactionSignal.ID` — never inside the workflow body.

### `Context`: the reviewer's selection reaches the CLI prompt, never the saved bubble

`ChatMessageSignal` carries one more field beyond `{ID, Author, Body, Action}`:
**`Context`** — the reviewer's file/old-new-line-range/code-excerpt selection
at send time, built client-side by `RelatedPanel.mjs`'s `claudeContextBlock`
(only for a conversation's very FIRST turn — see
`.claude/docs/claude-chat-panel.md`) and decoded from the extra `context` JSON
field by `tasks_api.go`'s `SignalMessage` handler. It threads straight through
to `chatTurnInput.Context` (unaffected: `saveChatMessage` still only ever
persists `sig.Body`, the reviewer's own typed text — this is exactly why a
question like "what do you know about the code I selected?" used to get "I
have no idea what you selected" before this existed, since `req.Prompt` was
plain `arg.Body`). `runOneClaudeTurn` now builds the CLI prompt via
**`buildChatPrompt(selectionContext, body)`**: `selectionContext + "\n\n" +
body` when non-empty, otherwise a bare pass-through of `body` — every turn
after the first, or no cursor info available client-side, is byte-identical
to the pre-`Context` behaviour. Deterministic (`Context` is part of the
Signal's own recorded input, like `Body`) and write-boundary-clean (no new
write path, one more field riding the existing Signal → Activity chain). Test:
`TestChatTurnContextEnrichesPromptNotBody` (`chat_workflow_test.go`), which
uses `claude.Fake.Calls[i].Prompt` to assert the CLI-bound prompt differs from
the saved `chat.Message.Body`.

### Every message id a turn writes derives from that turn (`chatMessageID`)

An Activity's side effects happen **before** its result is appended to the
history, so a process killed in that window re-executes the whole Activity on
recovery. With a random `newUIReactionID()` per message that produced a
**duplicate, orphaned assistant turn** in the transcript — the reviewer's
report that started this fix. Every id a turn writes is therefore derived from
the reviewer Signal's own `ID`, which rides along as `TurnID` on
`chatTurnInput`/`chatCommitInput`/`chatCommentActionInput` and is part of the
recorded input, hence identical on every replay:

- `chatMessageID(turnID, "")` — the assistant's own turn (its reply, or a
  `KindError` for a failed Claude/worktree call, or a commit turn's status
  message — all mutually exclusive within one turn).
- `chatMessageID(turnID, "action")` — the one comment_action outcome turn,
  which can legitimately coexist with the assistant turn above.
- `chatActionReactionID(turnID)` — the reply a comment_action posts into the
  comment thread, so a replay can't post it twice (`comments.AddReaction` is an
  `INSERT OR IGNORE` on that id).

`modules/chat.SaveMessage` is an `INSERT OR REPLACE` on the id, so a re-run
**overwrites** its own row. An empty `TurnID` (an input recorded before the
field existed) falls back to the old random id — exactly the previous
behaviour, never a shared constant that would collide. Test:
`TestChatTurnMessageIDsAreDerivedFromTheTurn`.

### Live progress of a running turn (streamed, never persisted)

A turn is a minutes-long subprocess call, so the reviewer must see what it is
doing and read the answer as it is produced (see "Live progress" in
`.claude/docs/claude-chat-panel.md` for the UI half). `RunChat` runs with
`--output-format stream-json --verbose` (plus `--include-partial-messages`
only when someone is listening) and parses the CLI's newline-delimited frames
in `readChatStream`:

- The final `{"type":"result",...}` frame carries exactly the `result` /
  `session_id` the old non-streaming `json` format returned as one object, so
  **`ChatResult` is unchanged** and a caller without a listener sees no
  difference. A stream that ends **without** a result frame (a killed CLI) is a
  real error — never an empty-but-successful turn.
- Everything else becomes a `ChatEvent` for the optional
  `RunRequest.OnEvent` callback: `status`, `thinking` (the fact only — never
  the thinking text), `text` (one delta of the visible answer), `tool` (name +
  one short, truncated argument hint picked in a fixed field order, so the
  label can't flicker with map iteration).

`runOneClaudeTurn` wires that callback to `chatProgressSink`, which folds the
events into the in-memory `chatProgress` snapshot (`chat_progress.go`) and
publishes it over SSE, throttled to `chatProgressThrottle` (120ms) for text
deltas while a phase/tool change always goes out immediately.

**Determinism is untouched, by construction:** `OnEvent` is a Go func on the
module request, not data on `chatTurnInput`, so it can never end up in the
recorded input; fragments are written only to an in-memory map that is empty
after a restart; and the single `chat.Message` the Activity saves still comes
from the CLI's own final result. An interrupted turn therefore leaves **no**
half-written row behind — only a stale progress entry, which dies with the
process. Tests: `modules/claude/stream_test.go`, `chat_progress_test.go`,
`TestChatTurnPublishesProgressButPersistsOnlyTheResult`.

### Sessions, not resent transcripts (`modules/claude`'s `RunChat`)

`RunChat` is `Run`'s conversational sibling, added to the `Client`
interface (so every existing one-shot caller — `resolve_call`, `explain_code`,
`code_warning`, `pr_status`'s summary — is untouched; only `Module`/`Fake`
gained the new method). Confirmed against the real CLI:
`--session-id <uuid>` starts a session with an id we pick ourselves (must be a
valid UUID — `newSessionID`, a plain `crypto/rand` v4 UUID, fine since this is
Module-side, not workflow-body, code); `--resume <id>` continues that same
session and the CLI keeps prior turns in context; `--output-format json`'s
`session_id` field never rotates across turns of one session, so the module
just echoes it back as `ChatResult.SessionID`.

**`runOneClaudeTurn` therefore never resends the transcript itself** — only
the new turn's `Body` travels in `chatTurnInput` (already in the workflow's
own history via the Signal); the CLI/backend's own session state carries
everything earlier. `modules/chat.Module.GetSession`/`SetSession` persist the
one session id per conversation.

### Cold-start cost of a brand-new conversation (`coldStartArgs`/`agenticToolUniverse`)

A brand-new `claude_chat` conversation's first turn pays a large,
**one-time-per-conversation** `cache_creation_input_tokens` bill before the
first token comes back (measured on a real conversation: ~47k tokens,
against ~5k for that same conversation's second turn) — this is most of the
3-7s time-to-first-token a reviewer sees on a fresh chat. Root cause: each
conversation gets its own shadow worktree (a fresh cwd, see "Agentic edits"
below), so the CLI's per-session context-discovery (skill listing, agent
listing, deferred-tool descriptions, MCP server instructions, plus the
default system prompt's cwd/env/git-status section) is both freshly injected
AND, because the cwd is unique per conversation, never eligible for the
provider-side prompt cache to reuse across conversations — every single one
starts stone cold.

Traced (via real session logs under `~/.claude/projects/...` plus manual
`claude -p --output-format stream-json --verbose` runs against a copy of a
real shadow worktree) to four `attachment` frames the CLI injects on session
init: `skill_listing` (~14.6k chars), `agent_listing_delta` (~10.4k chars),
`deferred_tools_delta` (~5.6k chars) and `mcp_instructions_delta` (~0.5k
chars, a **personal** MCP server, not project config). `Module.Run`/`RunChat`
(`modules/claude/claude.go`) now pass three additional CLI flags,
`coldStartArgs()`/`agenticToolUniverse()`, deliberately narrow in scope after
weighing what's actually safe to cut:

- **`--strict-mcp-config`** (both Run/RunChat, always) — this module never
  passes `--mcp-config`, so this just guarantees no MCP server anywhere on
  the machine (project or personal) loads into a review-chat turn. Pure
  removal, no behaviour change: review-chat never needs an MCP tool.
- **`--exclude-dynamic-system-prompt-sections`** (both, always) — moves the
  per-machine parts of the default system prompt (cwd, env info, git status)
  out of the cached prefix into the first user message. This is what makes
  the REST of the prefix shareable **across different shadow-worktree
  directories** — verified directly: repeating the identical flag/tool
  combination from a different scratch directory read back the bulk of an
  earlier run's prefix via `cache_read_input_tokens` instead of paying it
  again, which cannot happen at all without this flag (today's cwd-baked
  prefix is unique per conversation, by construction).
- **`--tools`** (agentic runs only, `agenticToolUniverse`) — shrinks the
  CLI's own built-in tool UNIVERSE to `req.Tools` (`Read,Grep,Glob,Edit,Bash`)
  plus `Skill` — unlike `--allowedTools`, which only gates permission within
  whatever universe already exists, `--tools` removes a name (and everything
  the CLI advertises about it) entirely. A `claude_chat` turn is never
  granted `Task`, so **every** subagent it's told about — plug-and-pay's own
  13 project agents, the `claude-security` plugin's subagents, personal
  agents — was, and remains, structurally unreachable; same for the
  background-agent tool family (`CronCreate`/`DesignSync`/`PushNotification`/
  `RemoteTrigger`/`SendMessage`/`TaskCreate`/…), `NotebookEdit`, `Monitor`,
  `Write`, and the MCP resource tools (already moot given
  `--strict-mcp-config`). Measured, same manual-run method: shrinking the
  universe to just the five granted tools roughly **halved** the
  steady-state `cache_creation + cache_read` total (~31.2k → ~15.6k tokens);
  keeping `Skill` in the universe (required — see below) still cut it to
  ~18.2k.

**Explicitly NOT changed, after discussion:**

- **Skills stay on, unconditionally — never disabled, not even later "based
  on the numbers".** `skill_listing` is real, valuable, mostly
  plug-and-pay's own committed playbooks (`module-boundary`,
  `git-and-release-workflow`, `new-api-endpoint`, …) that a reviewer chat can
  legitimately benefit from Claude auto-applying while editing code — worth
  the ~3.6k tokens even though, unlike agents, skill invocation IS reachable
  from this turn's tool set. Concretely this means `agenticToolUniverse`
  keeps `"Skill"` in the `--tools` universe: measured omitting it removes
  `"Skill"` from the CLI's own reported tool set entirely, which would
  silently break autonomous skill invocation. `Skill` is deliberately **not**
  added to `req.Tools`/`--allowedTools` itself — that exactly mirrors how
  skills already worked before this change (available in the default,
  unrestricted universe, without being explicitly allow-listed), so nothing
  about skill *permission* behaviour changes, only what was already
  unreachable is removed.
- **No `--setting-sources` restriction.** Would additionally drop personal
  `~/.claude` config (a small further win — a personal MCP server, a couple
  of personal agents/skills), but plug-and-pay's own `.claude/settings.json`
  enables the `claude-security` plugin at the PROJECT level while that
  plugin's actual marketplace/catalog registration may live as machine state
  under `~/.claude/plugins/`; restricting setting sources risks silently
  breaking that plugin's resolution for an unverified, comparatively small
  gain. Not attempted.
- `CLAUDE.md` auto-discovery and the project's own `SessionStart`/
  `PreToolUse` hooks (`session-context.sh`'s branch/uncommitted-files hint,
  `scan-secrets.sh`'s safety net before every Write/Edit) are untouched —
  cheap and functionally valuable, see "Agentic edits" below.

**Honest result:** the measurement environment (a shared account, with other
concurrent `claude` sessions/background agents running on the same machine)
made a clean single-number "before vs. after" comparison unreliable — a
truly cold, flag-free baseline run measured *lower* than a cold run with the
new flags in one sample, almost certainly because the flag-free baseline
incidentally reused a provider-side cache warmed by unrelated background
activity on the same account, not because the new flags cost more. The
robust, repeatable finding (controlled, same worktree, same model, flags
isolated one at a time, repeated until stable) is the `--tools` universe
restriction: it consistently and reproducibly roughly **halves** the
steady-state per-conversation token total once a conversation with the same
flag/tool combination has run once. That reuse is the mechanism, not a fixed
guaranteed-first-token discount — the very first `claude_chat` conversation
after a cache TTL expiry (or after a `claude` CLI upgrade changes the
cacheable prefix) still pays close to the full cold cost.

### The optional clarifying-question turn (`KindQuestion`)

Per product decision, Claude can ask the reviewer a short clarifying question
with **up to 3 options** (the reviewer can always type free text as an
implicit extra choice — no real 4th option needed in the model). The contract
is a strict JSON directive (`claude.ChatSystemPrompt`,
`modules/claude/prompts/chat.md`):

```
{"type":"question","question":"...","options":["...","...","..."]}
```

`parseAssistantTurn` (`chat_workflow.go`) recognizes this shape (anything that
doesn't parse this way — including a stray `{`-prefixed non-directive text —
degrades to a plain text turn, never dropped) and caps `Options` at
`maxChatQuestionOptions` (3) even if the model returned more. The resulting
row is `Kind: chat.KindQuestion`, `Body` = the question, `Options` = the
choices; **`Answer` is filled in on that SAME row** once the reviewer's next
message arrives (step 1 above) — deliberately not a separate "answer" row, so
a refresh shows question+answer tied together regardless of ordering.

### A failed Claude call degrades to a visible turn — and is retried by itself

`runOneClaudeTurn` never fails the workflow on a `RunChat` error: it stores a
visible assistant message instead, so the conversation stays alive. Mirrors
the "best-effort, log and carry on" convention used elsewhere for
GitHub/Claude side effects, except here the failure is surfaced **in the
transcript itself** (not just the log) since the reviewer is actively waiting
on it.

On top of that, `runChatTurnWithRetries` (`chat_workflow.go`) drives a turn
through an **automatic backoff ladder**: `chatRetryDelays` = 3, 6, 12, 24, 48
seconds, so six attempts in total (~93s). The two Kinds are what steer it:

- **`chat.KindRetrying`** — the attempt failed and another one is coming. This
  Kind is literally the loop condition: the workflow `w.Sleep`s the next rung
  and calls the Activity again.
- **`chat.KindError`** — the ladder is exhausted. The turn stands as "mislukt"
  until the reviewer asks for it again (manual retry, below).

**Every attempt reuses the same `TurnID`**, so `chatMessageID` yields the same
row id and `SaveMessage` (INSERT OR REPLACE) makes each attempt **replace** the
previous one. A turn therefore never leaves a trail of attempt bubbles: one row
walks `retrying → retrying → error`, or is overwritten by the real answer.

**Model escalation, per turn only.** `chatModelForAttempt` returns Opus for
attempts 0-1 and **Sonnet from attempt 2 on**. Not on the first retry: the
common failure is a short capacity blip that is gone after three seconds, and
the reviewer picked this panel for Opus answers. But two Opus failures three
seconds apart mean a sustained capacity problem, where another model beats
waiting longer. Deliberately **not sticky**: the next reviewer turn (and a
manual retry) starts at attempt 0, hence at Opus again — a temporary outage
must not silently downgrade the whole conversation, and keeping the choice a
pure function of the attempt counter is exactly what keeps it deterministic.
The CLI session is unaffected; the model is a per-invocation `--model` flag,
`--resume` keeps the same transcript. `chat.Message.Model` records which model
answered, which the UI shows as a pill when it isn't the default one.

**Determinism** (`.claude/rules/workflow-determinism.md`): the iteration count
and the delay index follow only from the recorded Activity results and the loop
counter, the waiting is `w.Sleep` (a durable timer event, rescheduled after a
restart — this is the first place in slash that uses it), and nothing reads a
live clock. `chatRetryDelays` is a `var` purely so a test can shrink it.

**`runChatTurnWithRetries` allocates a FRESH `chatTurnResult` every loop
iteration — never reuse one across iterations.** `chat.Message.Kind` is
`json:"kind,omitempty"`, so a successful attempt's encoded Activity result
OMITS `"kind"` entirely; `tembed.Workflow.ExecuteActivity`'s decode is a plain
`json.Unmarshal` into whatever pointer it's given, which only overwrites
fields that ARE present. Reusing one `result` variable across the loop
therefore left a PRIOR failed attempt's `chat.KindRetrying` sitting in
`Message.Kind` even once a LATER attempt genuinely succeeded — the loop then
read that stale value as "still retrying" and drove the ladder through every
remaining rung for real, in the background, well after the turn already had
its final answer (a long-lived tracker never gets torn down, so this kept
running/logging long past the reviewer's own turn). Test:
`TestRunChatTurnWithRetriesResetsResultPerAttempt`.

**Manual retry** — `chatActionRetry` ("retry"), the fourth
`ChatMessageSignal.Action` variant, validated in `tasks_api.go` next to
`commit`/`clear` as a no-text action. The workflow keeps the finally-failed
turn's own input in `lastFailedTurn` and re-runs **that** through the same
ladder: same `TurnID`/`Body`/`Context`, so no second user bubble appears and
the failed row is replaced. Nothing about the turn is re-sent from the browser.
A Signal with nothing failed is a no-op; a `clear` drops `lastFailedTurn`. On
the frontend both entry points call the one `retryClaudeTurn`
(`RelatedPanel.mjs`): the button on the failed bubble and the Claude-column
palette item — see `.claude/docs/claude-chat-panel.md`.

Tests: `TestClaudeChatRetriesTransientFailure`, `TestClaudeChatEscalatesToSonnet`,
`TestClaudeChatGivesUpAfterLadder`, `TestClaudeChatManualRetryRerunsFailedTurn`
(all shrink the ladder to milliseconds via `shrinkChatRetryDelays`).

**A THIRD terminal Kind sits next to `KindRetrying`/`KindError`:
`chat.KindCancelled`** — the reviewer's own "Stop", not a failure at all. It
shares `KindError`'s `lastFailedTurn` bookkeeping (so `chatActionRetry` still
reruns the same turn afterwards) but, unlike `KindError`, is never reached
THROUGH the ladder — `chatFailureMessage` short-circuits to it (via
`runCtx.Err()`, never by inspecting the killed subprocess's own error value)
before `chatFailureTurn`'s retry/backoff decision ever runs, so a cancel can
never schedule a `w.Sleep` that silently restarts it later. Full mechanism
(the cancel registry, why it cannot be a Signal, the cleanup-choice follow-up,
the Stop control, the process-tree kill, the test hook): "Cancelling a running
turn" in `.claude/docs/claude-chat-panel.md`. Regression test:
`TestCancelledTurnDoesNotAutoRetry`.

### `modules/chat` (`data/chat.db`)

`chat_conversations(id, pr, session_id, created_at, updated_at)` +
`chat_messages(id, conversation_id, pr, role, kind, body, options_json,
answer, model, created_at)` — `options_json` round-trips `Message.Options`
([]string) through the SQLite TEXT column. Write methods
(`EnsureConversation`/`SaveMessage`/`SetAnswer`/`SetSession`) are
workflow-Activity-only; `List`/`GetSession` back the read-only UI/API. `Purge`
is wired into the `cleanup` workflow's `purgeDeps`/`purgePR` like every other
PR-scoped module. `model` was added later and therefore also lives in a small
`migrate(db)` (`ALTER TABLE … ADD COLUMN`, duplicate-column error ignored),
same shape as `modules/comments`' own — a row written before it exists simply
reads back as `""`, which the UI treats as "no pill".

### Agentic edits (Phase 3): the PR's shared local checkout, never the shared head

**SUPERSEDED, read this before the rest of this section.** The disposable,
per-conversation shadow worktree described below is GONE. A write turn now
edits a real, standing local git checkout of the REVIEWER's own — resolved
once per PR (not per conversation) via a selection ladder (an explicit
`chatCheckoutDirs` list in `settings.json`, else a bounded home-dir scan) and
remembered for the rest of the review; every conversation of that PR shares
the same directory and the same real branch. A dirty/ambiguous candidate
triggers a forceful consult (`chat.KindDirectoryDecision`, answered through
the same message/Signal round trip as an ordinary `KindQuestion`) before
anything is touched. See `chat_checkout.go` (the implementation, replacing
`chat_shadow.go`) and `todo/todo-local-checkout-chat-edits.md` (the design —
kept local/uncommitted, not part of the repo) for the full mechanism:
candidate matching/exclusion rules, the dirty-tree/reuse-merged-branch
decisions, why `chat_write_gate.go`'s existing one-code-turn-at-a-time gate
already makes this shared checkout safe with no extra locking, and how
landing now works (a local, network-less `git fetch` of the checkout's new
commit into the shared clone, then the SAME `refs/slash/pending/...` ref
advance as before — see "Serializing concurrent commits" below).
The rest of this section (task 3's two-step tool access, the escalation
trigger, the write gate) is otherwise UNCHANGED — only WHERE Claude gets
Edit/Bash access changed, not WHEN.

#### An unreachable `origin` never costs the reviewer their work directory

`classifyCheckoutCandidate` (`chat_checkout.go`) refreshes a candidate's
remote-tracking refs with `git fetch origin <branch>` before it decides
ahead/behind and merged-into-base. That fetch used to be **fatal**: an error
made the whole candidate return an error, `listCheckoutCandidates` dropped it,
and with every candidate dropped the write turn told the reviewer
*"Voeg een pad toe aan `chatCheckoutDirs` in settings.json"* — a configuration
problem that did not exist. Reported on a machine where the correct checkout
was sitting there, already on the PR's own branch; the real cause was an
ssh-agent with **no identities loaded**, so every `git fetch` came back
`Permission denied (publickey)`. Same failure shape offline, on a dropped VPN,
or with an expired token — i.e. it hit any user, any directory, at any moment,
and it presented as a permanent misconfiguration.

The fetch is now a **refresh, never a gate**. Every answer this classification
gives comes from refs that are already on disk, so an unreachable origin
degrades to "decide from what we have" and only sets `SyncUnknown`:

- On the PR's own branch with a local `refs/remotes/origin/<headRef>`:
  ahead/behind are still computed from it, but `BehindOrigin` is forced false
  — "behind" measured against a ref we could not refresh says nothing, and
  acting on it (`fastForwardCheckoutToOrigin`) would just re-run the fetch
  that already failed.
- On the PR's own branch with **no** such ref at all: still usable
  (`FastForwardable`, never `BehindOrigin`). A write turn only ever COMMITS on
  top; it never discards or force-overwrites, so there is nothing to lose.
- On another branch: `merge-base --is-ancestor <branch> origin/<base>` runs
  against the local base ref whenever one exists, instead of being skipped
  entirely when the fetch failed.

`checkoutOntoBranch`/`fastForwardCheckoutToOrigin` follow the same rule: a
failed fetch is only a real error when the checkout has no local
`origin/<headRef>` to work from either.

The **landing** (`commitCheckoutEditsAt`) had the identical bug one step
later, and it bit right after the first fix: Claude made the edit, said so,
and the next bubble was a red *"Kon de laatste stand van de branch niet
ophalen."* — a finished edit left uncommitted. Its fetch exists for ONE
decision, `amendableChatCommit`'s "is HEAD already pushed?", where a stale
`origin/<headRef>` really would risk rewriting a commit GitHub already has. So
a failed fetch now sets `staleOrigin`, which **suppresses the amend** and
stacks an ordinary new commit instead — never destructive — while the landing
itself stays fast-forward-only as always. Only a checkout with no local
`origin/<headRef>` at all still refuses, and says so in those words (plus
where the change is sitting), because without any reference point there is
nothing to measure "what is new here" against.

#### A dead end says what was actually in the way

`listCheckoutCandidates` returns a `checkoutDiscovery` alongside the
candidates — how many local checkouts of **this** repo it saw, which were
rejected as busy (on someone else's not-yet-merged branch), and which failed
classification outright. `checkoutDiscovery.reason()` turns that into one
reviewer-facing sentence, stored on the PR's assignment as `LastReason` and
read back by `chat_workflow.go` (via `checkoutFailureReason`) and by the
"andere directory kiezen" menu (`listAllCheckoutChoices`). Only a genuinely
empty discovery — no checkout of this repo anywhere — keeps the original
"configure or clone one" wording, which is the one case it is true for.
`LastReason` is cleared as soon as a directory resolves or a choice is raised,
so it can never outlive the failure it describes.

Every turn — not just a special "edit action" — lets Claude use its **Edit
tool plus a real Bash shell** on real files, but never against the shared
`data/worktrees/pr-<n>-head` that `/api/code`, `blockstats.go`, the re-anchor
pass and the ingest-refresh poller all depend on staying pinned to the exact
recorded `head_sha`.

**No separate action needed — every turn tries to get real tool access, and
gracefully degrades when it can't.** `chatActionEdit` itself still exists as a
Signal value (`tasks_api.go` validation, `ChatMessageSignal.Action`) purely for
backward compatibility — it is a no-op synonym of `""`, since `runOneClaudeTurn`
no longer branches on it at all.

#### Two-step tool access: a cheap read-only first attempt, the shadow only when asked for (task 3)

Materializing the shadow worktree (a `git fetch` plus `worktree add`/`reset
--hard`, under `ingestMu`) has a real, avoidable cost for the large majority of
turns, which never edit anything — a plain "wat doet deze functie?" paid the
exact same setup as a genuine "commit dit". `runOneClaudeTurn`
(`chat_workflow.go`) therefore makes **up to two** `RunChat` calls per turn
instead of committing upfront to full shell access:

1. **Attempt 1 (always).** `prepareChatReadOnlyWorkDir` (`chat_shadow.go`) — a
   plain `os.Stat` against the PR's already-ingested, **shared** head worktree
   (`worktreeDirs`, `ingest.go`; the same directory `/api/code`/`blockstats.go`
   already read from, never written to here). No `git fetch`, no `ingestMu`
   lock, no `gh` call at all. On success the CLI gets `Tools:
   ["Read","Grep","Glob"]` and `claude.ChatReadOnlySystemPrompt`; on failure (no
   PR ingested yet — in practice unreachable for an existing comment thread) it
   falls back to the plain, tool-less `claude.ChatSystemPrompt`. Either way this
   ONE call answers the large majority of turns (explaining code, answering a
   question) at essentially zero extra cost over the old tool-less baseline.
2. **Attempt 2 (only on request).** The read-only prompt teaches the model one
   more strict JSON directive, `{"type":"need_write"}` — Claude's own signal
   that the reviewer's request genuinely needs to edit/run something.
   `isNeedWriteDirective` recognizes exactly this shape (nothing else). Only
   then does `runOneClaudeTurn` call `prepareChatShellWorkDir` (unchanged, see
   below) and make a SECOND call, **resuming the same CLI session** attempt 1
   used (so Claude keeps whatever it already learned there, plus the
   reviewer's own original message already in that session's history) via the
   synthetic continuation prompt `chatNeedWriteContinuationPrompt`. That call's
   reply is what actually gets saved/parsed; attempt 1's bare directive is not.

Bounded to exactly one escalation, mirroring the "one begrensde Claude attempt"
shape used elsewhere in this file — no retry loop against the CLI if the
second attempt also happens to reply with a directive. Reported bug (a
reviewer screenshot): that repeated `{"type":"need_write"}` used to fall
through `parseAssistantTurn`'s generic "unknown JSON shape → plain text"
default and land in the transcript as the literal raw string
`{"type":"need_write"}` — Claude getting stuck repeating the escalation
signal instead of acting on the write access attempt 2 had just handed it.
`runOneClaudeTurn` now checks `isNeedWriteDirective(result.Text)` again right
after attempt 2 and, if it still matches, saves a short reviewer-facing
Dutch sentence instead ("Claude had schrijftoegang, maar kwam er niet uit.
Formuleer je verzoek iets concreter.") and returns early, never reaching
`parseAssistantTurn` with the raw directive. Deliberately a **plain** text
turn — no `Kind` at all, and specifically **not** `chat.KindError`: nothing
failed in the sense the existing error/retry ladder means (a CLI call that
errored or ran out of automatic retries), so there is no "Opnieuw proberen"
button on it; it reads as an ordinary, if confusing, assistant reply the
reviewer can just respond to by typing again. `parseAssistantTurn`'s own
generic default is untouched and still applies to every OTHER unrecognized
JSON shape (a genuinely malformed `comment_action`, for instance) — this fix
is scoped to exactly the repeated-escalation case, not a broader "any
JSON-looking body gets prettified" change. Attempt 2 can itself fail to get
the shadow worktree (gh/git unreachable) — that degrades to a plain,
`NoShell: true` reviewer-facing explanation rather than an error turn, the
same graceful-degrade philosophy as attempt 1's own fallback.
`chat.Message.NoShell` is therefore true only when **neither** attempt got
any real tool access at all — a turn that only ever needed the read-only
pass is not degraded, it simply never asked to escalate. Tests:
`chat_shell_test.go`'s
`TestRunOneClaudeTurnUsesReadOnlyHeadWorktreeWithoutEscalating` (no gh/git
round trip at all for a plain question),
`TestRunOneClaudeTurnEscalatesToShellOnNeedWrite` (the session-resuming
second call), `TestRunOneClaudeTurnDegradesWhenShellUnavailableAfterEscalating`,
`TestRunOneClaudeTurnDegeneratesGracefullyOnRepeatedNeedWrite` (the repeated
directive above).

#### The pending checkout decision is scoped to the conversation that raised it, not the whole PR

Reported bug, screenshot: a reviewer typed a plain, purely conversational
follow-up ("maar hij komt wel in die flow toch?") in one conversation and got
back an unrelated, confusing checkout question ("Dat antwoord herkende ik niet
als een van de keuzes… heeft nog niet-gerelateerde, niet-gecommitte
wijzigingen") that in fact belonged to a completely DIFFERENT conversation of
the same PR — one that had genuinely asked for a code change and hit a dirty
candidate. Two symptoms from one cause: the question leaked into a
conversation that never raised it, AND a turn that never needed write access
at all got dragged into the checkout machinery before Claude was even called.

`runOneClaudeTurn`'s very first step, before calling Claude at all, resolves
"is a PREVIOUS turn still waiting on an answer about the local checkout"
(`hasPendingCheckoutDecision`) — but `chatCheckoutAssignment.Pending` used to
be purely PR-scoped, with no record of which conversation raised it. So as
long as ANY conversation of the PR had an open decision, EVERY other
conversation's very next message was intercepted and fed to
`applyCheckoutDecisionReply` as if it were an attempt to answer it — which
predictably never matched any option, so the exact same question got
re-asked, now saved under the unrelated conversation's own id.

Fixed with `chatCheckoutAssignment.PendingConversationID` (`chat_checkout.go`),
set alongside every place a NEW decision is raised from inside a chat turn
(`prepareChatShellWorkDirAt`'s three raise sites) and cleared alongside every
resolution:

- **`hasPendingCheckoutDecision(repo, pr, conversationID)`** now answers "does
  THIS conversation have an open question", not "does this PR" — so
  `runOneClaudeTurn`'s pre-Claude-call intercept only ever fires for the
  conversation that actually raised it. Every OTHER conversation's message
  flows straight into the ordinary two-step read-only/escalate logic above —
  a plain question never even reaches the checkout code, so it can never
  generate a checkout decision of its own either.
- **`prepareChatShellWorkDirAt` itself** gained the matching ownership guard,
  for the case where a NON-owning conversation's own turn later needs write
  access too (`isNeedWriteDirective`): rather than treating its reviewer reply
  as an (inevitably mismatched) answer to someone else's question, it gets a
  plain "no directory right now" (`nil, false`) while the actual owner's
  `Pending`/`PendingConversationID` are left completely untouched. This also
  protects `comment_batch.go`'s and `test_run.go`'s own calls
  (`commentBatchConvID`/`testRunConvID`, one stable id per PR each) from the
  same misattribution.

  **It used to hand out an unanswerable `checkoutStageBlockedElsewhere`
  decision of its own instead ("Een andere Claude-conversatie in deze PR
  wacht nog op een keuze…", no `Options`); that stage is removed.** Reported
  bug, screenshot: a reviewer asked for an edit, got that bubble with a
  "keuze over lokale checkout nodig" pill and no buttons, and asked *"waarom
  zie ik die chat niet onder deze chat staan?"* — rightly, because nothing in
  the UI can find that other conversation: there is no PR-wide list of Claude
  conversations (`claudeChatVisible()`, `.claude/docs/claude-chat-panel.md`),
  and a bare chat anchor deliberately gets no comment-index row either
  (`isChatAnchorPlaceholder`, `.claude/docs/comments-panel.md`). So the
  message pointed at something unreachable. Each caller now recognizes the
  case itself through **`checkoutChoiceOpen(repo, pr)`** — a plain read of the
  same in-memory assignment, so no call signature changed — and says in
  words that a choice is still open, instead of asking an unanswerable
  question. Where the reviewer makes that choice: the work-directory overlay
  (`.claude/docs/command-palette.md`).
#### The work-directory choice left the chat: it is a PR-wide setting

Reviewer decision, in his own words: *"vraag alleen stellen in de chat waar het
over gaat. niet blokkeren voor chats die alleen vragen stellen. het gebruik
maken van een directory is een algemene instellingen en mag als een popup
overlay worden getoond."*

So **no chat turn ever creates a `chat.KindDirectoryDecision` any more.** A
turn that needs write access and finds an open (or newly raised) choice saves
one plain, `NoShell` sentence — "er staat nog een keuze open over de werkmap
van deze PR" — and stops; `comment_batch`/`test_run` say the same thing through
their own progress-failure text. The choice itself lives in the read model
(`buildCheckoutView` → `GET /api/chat/checkout`) and is answered in the
work-directory overlay or through the chip, both via the existing
`checkoutAnswer` Action. What that removed:

- **`chatCheckoutAssignment.PendingConversationID` and
  `hasPendingCheckoutDecision`** — with nobody owning the choice there is
  nothing to scope and no ownership guard to write. `Pending` is now simply
  "this PR's one open choice", read by **`checkoutChoiceOpen(repo, pr)`**.
- **`prepareChatShellWorkDir`'s `conversationID` parameter**, for the same
  reason.
- **The pre-Claude "does this turn's body answer a pending decision" step** in
  `runOneClaudeTurn`, and with it `chatCheckoutResumedPrompt`. A chat turn now
  passes `reviewerReply: ""`, and `prepareChatShellWorkDirAt` returns an open
  choice **untouched** when the reply is empty — so a reviewer's ordinary
  message can never be misread as an answer, which is what produced both
  reported bugs (first "Dat antwoord herkende ik niet als een van de keuzes",
  then the unanswerable "een andere Claude-conversatie wacht nog op een
  keuze").
- **`publishCheckoutChanged`** is now also fired at the three sites that RAISE
  a choice (`prepareChatShellWorkDirAt`), not only by the menu Actions —
  otherwise the overlay would not open until the next refresh.

**Accepted consequence:** the turn that ran into the choice is finished, so
after answering it the reviewer sends their request again. There is
deliberately no "resume where you were" mechanism; that is what the removed
`chatCheckoutResumedPrompt` used to be, and it is exactly the coupling between
"a choice about a directory" and "a conversation's turn" that this change
undoes.

**`chat.KindDirectoryDecision` itself stays** — as a Kind, for bubbles already
in stored history, which still render and still accept a reviewer reply
through the ordinary `pendingQuestionID` round trip. Nothing creates a new one.

#### A "leave it dirty" answer stays answered (DirtyAcceptedDir/DirtyAcceptedPaths)

Reported bug, two screenshots: the reviewer answered the dirty-tree question
with **"Meenemen in de commit"**, asked Claude for a change (`retry`), and got
`"Ik kan nu geen code aanpassen: er staat nog een keuze open over de werkmap
van deze PR"` back — with the overlay reopening on the byte-identical
question. Forever, several stacked bubbles deep.

Cause: `chatCheckoutResolved.Final` only skips the re-classification **inside
the call that resolved the choice**. The two options that deliberately LEAVE
the working tree dirty (`optKeepSeparate`, `optKeepCombined`) recorded nothing
about that acceptance, so the NEXT caller (a write turn, `comment_batch`,
`test_run` — all passing `reviewerReply ""`) walked
`prepareChatShellWorkDirAt`'s `a.Dir != ""` branch, found `cand.Dirty` still
true, and raised `chatCheckoutDirtyDecision` all over again. Every answer was
applied correctly; it just never stuck.

`chatCheckoutAssignment` therefore records **`DirtyAcceptedDir` +
`DirtyAcceptedPaths`** — which directory the reviewer accepted a dirty tree
for, and exactly which paths were dirty at that moment — set by both Final
options and cleared by `optDiscard`/the two stash options (which leave a
genuinely clean tree, so an older acceptance must not linger) and by
`checkoutSetOff`. The dirty question is then gated on
`!dirtyAlreadyAccepted(ctx, a)`.

Two deliberate details:

- **A subset check, not equality.** `dirtyAlreadyAccepted` asks whether every
  path `git status` reports RIGHT NOW is covered by the accepted set: accepted
  work that has since been committed/reverted simply drops off the list (still
  accepted), while genuinely new, never-discussed changes bring the question
  back. An unreadable status answers `false` — asking again is the
  conservative side, like every other degrade path in `chat_checkout.go`.
- **Separate from `KeepSeparatePaths`**, which `commitCheckoutEditsAt` clears
  after a landing. Those paths are still dirty afterwards, so reusing that
  field would start asking again right after the first landing.

Still in-memory only, gone after a restart (the whole assignment is), so the
choice is asked once more after a server restart and then sticks. Tests:
`TestPrepareChatShellWorkDirKeepsAnAcceptedDirtyTreeResolved` (including the
"new dirty work asks again" half) and
`TestPrepareChatShellWorkDirKeepsKeepSeparateResolved`
(`chat_checkout_test.go`).

#### Visible wording: it is a "werkmap", never a "checkout"

Reviewer request. Everything the reviewer READS about the one local directory
Claude edits says **werkmap** — the word this UI already used for it
(`PHASE_LABEL.preparing`, *"Werkmap klaarzetten…"*, `ClaudeChat.mjs`) — so the
chat notices above, the `comment_batch`/`test_run` progress failures, the chip
label and the overlay all name the same thing the same way. The INTERNAL names
are deliberately left alone (`chat_checkout.go`, `checkoutView`,
`chat.KindCleanupChoice`, the `checkout*` Actions, the `checkout.changed`
event): `kind` values sit in stored chat history, so renaming them would be a
migration for zero functional gain. When you touch a user-facing string here,
check it against this rule; when you touch an identifier, leave it.

The cancelled-turn cleanup question (`offerCancelCleanupIfDirty`,
`chat.KindCleanupChoice`) **stays a chat bubble** — unlike the work-directory
choice it really is about THAT turn ("de afgebroken beurt liet
niet-gecommitte wijzigingen achter") — and its badge already reads "opruimen
na afbreken", with no "checkout" anywhere in it.

- **`conversationID == ""` is the one deliberate exception**: the checkout
  settings chip's own direct answer (`checkoutAnswer`, `workflows.go`) and
  the "andere directory kiezen"/"uit" menu actions
  (`relistCheckoutCandidates`/`checkoutSetOff`) always pass/leave `""` as the
  owner — an explicit, reviewer-initiated action through the chip, not a chat
  message, so it may resolve (or replace) ANY pending decision regardless of
  which conversation it belongs to, unchanged from before this fix.

Tests: `chat_checkout_test.go`'s
`TestPrepareChatShellWorkDirDecisionStaysScopedToItsOwnConversation` (the
ownership guard, and that the owner's own decision survives untouched) and
`TestPrepareChatShellWorkDirMenuAnswerBypassesOwnership` (the `""` exception);
`chat_workflow_test.go`'s
`TestClaudeChatPlainQuestionNeverTouchesAnotherConversationsCheckoutDecision`
drives this end to end through the real workflow — a plain question in one
conversation while another conversation's decision is pending, asserting
**both** halves: the message never leaks in, and exactly one (read-only)
`RunChat` call happens — proving the plain question never escalates into the
checkout/write path at all.

This is orthogonal to `sig.Action`'s dispatch (`chatActionCommit`/`chatActionClear`/
`chatActionRetry`, handled by the workflow body before `runOneClaudeTurn` is
even called) and to the automatic landing described below — a turn escalates
or not purely based on what Claude itself says on its first, cheap attempt.

**There is deliberately no reviewer-facing "approve this edit" step, so a
model that invents one gets stuck.** Reported bug (two reviewer
screenshots): on a plain edit request, Claude's read-only first attempt
answered in ordinary Dutch prose instead of the bare `{"type":"need_write"}`
— proposing the diff and asking "Keur je hem goed, dan pas ik dit toe?" —
and when the reviewer then typed exactly that ("ik keur het goed"), the NEXT
turn's own read-only attempt again answered in prose ("Edit en Bash zijn in
deze sessie uitgeschakeld…") instead of emitting the directive. Both replies
were internally consistent (attempt 1 genuinely has no Edit/Bash) but never
triggered attempt 2, so the escalation this whole mechanism exists for never
ran — confirmed NOT a `chat_workflow.go` bug: `TestRunOneClaudeTurnEscalatesToShellOnNeedWrite`
already proves the Go side escalates correctly whenever the model DOES emit
the bare directive. The gap is prompt adherence: the model fell back to a
"propose, then wait for confirmation" habit that this app has no way to
receive an answer to (no button/key anywhere approves a pending edit — see
`ClaudeChat.mjs`/`RelatedPanel.mjs`), and did not treat the reviewer's plain
confirmation of its own earlier proposal as the "explicit request" the
directive requires. `chat_readonly.md` now says both things outright: there
is no separate approval step to wait for (so never propose-and-ask-to-confirm
in plain text — use `{"type":"need_write"}` immediately instead, which
grants real access automatically on the very next call), and a reviewer's
reply that approves/confirms a change Claude itself already proposed earlier
in the SAME conversation ("ja", "keur ik goed", "doe maar") counts as an
explicit request too, just like "pas dit aan" does. Prompt-only change (no
`chat_workflow.go`/`chat_shell.md` edit needed, since the escalation mechanics
were already correct); guarded by
`TestChatReadOnlySystemPromptCoversConfirmationAndForbidsAskingPermission`
(`modules/claude/prompts_test.go`) asserting the added wording is present —
not a live-model regression test, since no fixture can force a real model's
prose choice.

**The prompt fix above was not enough, so the escalation is now also
detected mechanically.** Same reviewer, two days later, same conversation
(PR 13451, stored in `data/chat.db`): a plain "verander in 1 zin dat dit de
nieuwe manier is" got the prose refusal *"Ik heb deze beurt alsnog geen
Edit/Bash, dus ik kan het niet zelf doorvoeren"* plus the proposed
replacement in a fence — again no directive, again no attempt 2. Replaying
that exact call by hand (the same `chat_readonly.md`, the same message,
`--allowedTools Read,Grep,Glob` in the PR's head worktree) DID produce the
bare directive, which settles it: a model's adherence to that instruction is
probabilistic, and no prompt wording can make it a guarantee.
`looksLikeWriteRefusal` (`chat_workflow.go`) therefore escalates on the prose
as well: it strips every ```-fence (a proposed replacement must never be able
to trigger or suppress an escalation) and scans only the remaining prose for
a short, explicit list of observed wordings — `writeRefusalPhrases` ("geen
edit", "geen bash", "geen shell", "geen schrijftoegang", "geen
schrijfrechten", "kan niets aanpassen") plus the two-clause variant "…Edit en
Bash… uitgeschakeld". Deliberately a phrase list, exactly like the
natural-language stand-in for the checkout choice (`chat_checkout.go`), never
a general "does this sound negative" test: a missed escalation costs one more
message, a false positive costs the one code-turn slot plus a real git/gh
work-directory resolve. Known, accepted false positive: a reviewer ASKING
about write access ("heb je hier Edit?") can escalate a turn that only needed
to answer.

From attempt 2 on, a prose escalation is indistinguishable from a directive
one — same session resume, same `chatNeedWriteContinuationPrompt`, same write
gate, and attempt 1's refusal prose is **never** saved (only attempt 2's
reply is, exactly as with the directive). **There is deliberately no
reviewer-facing action for any of this** — no button, key or palette command
grants write access (reviewer decision: *"zelf automatisch detecteren, dat
hoeft de gebruiker niet te zien, mag wel heel even als progress in de status
bar"*, and asked where such a control should live: *"nergens, automatisch"*).
The only visible trace is one momentary progress line, `chatPhaseEscalating`
→ "Schrijfrechten ophalen…" (`chat_progress.go` + `PHASE_LABEL` in
`src/ClaudeChat.mjs`), replaced by `waiting`/`starting` as soon as the
escalated call really begins. Tests:
`TestRunOneClaudeTurnEscalatesOnProseWriteRefusal` (the reported reply shape
costs 2 calls, the second one with `Edit`+`Bash`, and only its reply is
saved) and `TestLooksLikeWriteRefusalStaysNarrow` (the boundaries, including
a fence that merely contains those words), both in `chat_shell_test.go`.

**That escalation is also the ONE code-turn-at-a-time gate**
(`chat_write_gate.go`). Reviewer decision: a turn that only ANSWERS may run
unlimited in parallel (chatting on another selection while an earlier answer is
still being written is a feature, see "Parallel conversations" in
`.claude/docs/claude-chat-panel.md`), but a turn that GENERATES or CHANGES code
runs one at a time. Nothing is guessed about the reviewer's wording: the
`{"type":"need_write"}` directive above already IS "this turn is going to change
code", so a process-wide semaphore of capacity 1 wraps exactly attempt 2 and
attempt 1 is untouched. A second such turn **waits** — never refused — and says
so, through the `waiting` progress phase ("Wacht op een andere codewijziging…",
`chat_progress.go` + `PHASE_LABEL` in `src/ClaudeChat.mjs`), so a queued turn is
never mistaken for a hang. Deliberately process-wide rather than per PR: one
agentic edit at a time on this machine is the point (each owns a git worktree
and may run Bash). It blocks inside an **Activity**, never a workflow body, and
changes neither the number nor the order of `ExecuteActivity` calls, so replay
is unaffected. No lock-ordering risk either: a turn only ever takes this
semaphore and then, inside it, the short `ingestMu` plumbing lock — never the
reverse. Test: `chat_write_gate_test.go`.

- **Location/identity**: `chatShadowDir(dataDir, pr, conversationId)` →
  `data/worktrees/pr-<n>-chatshadow-<conversationId>`, checked out on local
  branch `chatShadowBranch(conversationId)` = `chat/<conversationId>`. No
  separate DB bookkeeping — the worktree's existence/identity is fully
  derivable from its own directory name, and its git state (dirty? ahead of the
  remote?) is read live from git whenever it matters.
- **Scope: per conversation, not per PR.** Two different comment threads on the
  same PR chatting about edits get fully independent shadows/branches — no
  shared mutable workspace, so "commit deze wijziging" on thread A can never
  accidentally sweep up thread B's still-in-progress edit.
- **Prompt:** a turn that escalates to the shadow (see "Two-step tool access"
  above) swaps the system prompt to **`claude.ChatShellSystemPrompt`**
  (`modules/claude/prompts/chat_shell.md`) — the CLI only takes one
  `--append-system-prompt`, so this is a full replacement, not an addition. It
  keeps the same assistant framing + question/`comment_action` JSON contracts
  and adds that the Edit tool **and Bash** are available **this turn**, scoped
  to the conversation's own disposable shadow worktree — including running
  `git`/`gh`/`acli` — but only ever on the reviewer's explicit request, never on
  Claude's own initiative. **Task 1: it does NOT need to decide where a commit
  lands, or push.** The prompt now says so explicitly: a plain "commit dit"
  needs only a local `git add`/`git commit` in the shadow's own branch —
  Claude never has to check out/create the real PR branch, never has to ask
  the reviewer where a commit should land, and never has to push itself,
  because the app now lands every such commit automatically (see "Automatic
  landing after a shell turn" below). Push stays available on the reviewer's
  own EXPLICIT request only (e.g. "push dit naar GitHub"), never on Claude's
  own initiative and never `--force` (the git-level fast-forward-only
  guarantee is enforced outside the model, see `landAndReclaimChatShadow`
  below). This closed a real, observed failure mode: without it, Claude's own
  `git branch`/`git status` inside the shadow would surface the developer's
  OWN, unrelated local checkout state (e.g. "`feature/X` is nergens
  uitgecheckt") and it would ask the reviewer where to land the commit instead
  of just committing locally and trusting the app. `chat_edit.md`/
  `ChatEditSystemPrompt` (the earlier Edit-only, no-Bash, no-`comment_action`
  sibling) have been folded into `chat_shell.md` and removed — there was no
  longer a separate "edit action" for them to belong to.
- **Lazy creation, live refresh** (`ensureChatShadowWorktree` →
  `ensureChatShadowWorktreeAt`, called at the start of every turn, via
  `prepareChatShellWorkDir`): fetches
  the PR's real head branch (`gh pr view --json headRefName`, see
  `prMeta.HeadRefName` in `gh.go`) and either creates the worktree
  (`git worktree add -b chat/<id> <dir> <tip>`) or, if it already
  exists **and has nothing pending** (clean + no local commits ahead of that
  tip), fast-forwards it in place (`git reset --hard`). `<tip>` is
  `chatShadowBaseTip`: the PR's **pending ref** when one exists, else
  `origin/<headRef>` — so a second conversation starts from the first one's
  already-landed-but-unpushed commit instead of trying to rewind it (see
  `.claude/docs/pending-push.md`). A dirty
  or ahead-of-remote shadow is **left exactly as is** — an in-progress or
  already-committed-but-unpushed edit must never be silently discarded/rebased,
  the same "degrade rather than guess" rule the re-anchor pass follows. Both
  the `worktree add` and the `reset --hard` run with **`-c
  submodule.recurse=false`**, and the status/ahead check
  (`chatShadowPendingState`/`chatShadowLocalPendingState`) with **`--ignore-
  submodules=all`** — see "Incident: a wedged shadow worktree…" below for why.
- **Concurrency: only the shared-clone git plumbing is serialized, never a
  Claude turn or a local commit.** `ensureChatShadowWorktreeAt`'s
  `worktree add`/`fetch` and `commitChatShadowEditsAt`'s `fetch`+`push` reuse
  the existing **`ingestMu`** (ingest.go) — the same mutex the ordinary ingest
  pipeline already takes around its own worktree operations, for the identical
  reason: two concurrent `git worktree add`/`fetch` calls against the one
  shared local clone (`repoDir()`) is a real race regardless of which feature
  triggers it. The lock is held only for that short plumbing step, never for
  the whole turn — a `claude` subprocess call and a local `git commit` inside a
  conversation's own exclusive directory/branch touch no shared clone state (a
  different conversation has a different branch ref), so unrelated
  conversations' edit turns still run fully concurrently.
- **"Commit deze wijziging" (`chatActionCommit` → `enqueueChatMerge` →
  the PR's own `chat_merge` queue → `processChatMerge` →
  `commitChatShadowEditsAt`):** stage+commit whatever changed in the shadow,
  then **land it, fast-forward-only, on the PR's LOCAL pending ref**
  (`refs/slash/pending/pr-<n>/<headRef>`, see
  `.claude/docs/pending-push.md`) — **not** a push to GitHub, which is a
  separate step the reviewer fires from the todo row at the bottom of the block
  index. A pre-flight `chatShadowMissingTips` check refuses the landing (with a
  reviewer-facing message, no Go error) the moment the shadow's commit does not
  contain both `origin/<headRef>` and the current pending ref. On success the
  shadow worktree + its branch are **reclaimed immediately**
  (`git worktree remove` + `git branch -D`) — nothing is left behind on disk; a
  later edit turn re-materializes it lazily. The landed commit is picked up like
  any other new commit, only sooner: `refreshTreeAfterLanding` signals the
  `pr_status` tracker itself with that local SHA, so the delta refresh +
  re-anchor pass run immediately instead of waiting for the poller (which, by
  design, will not signal for a commit GitHub cannot see —
  `ingestRefreshNeeded`). **This is no longer called directly from
  `claudeChatWorkflow`** — see "Serializing concurrent commits (`chat_merge`)"
  below for what wraps it and why. `chatActionCommit` itself is still a valid
  Signal value, kept for backward compatibility, but nothing in the UI sends it
  any more (see "No UI trigger needed any more" below) — see the next bullet
  for what replaced it as the practical trigger.

#### Automatic landing after a shell turn (tasks 1+2+4)

Since the reviewer only ever asks Claude to commit in plain words (no button),
and Claude's own `git commit` (chat_shell.md, task 1 above) never itself lands
anything on the PR branch or cleans up its worktree, something has to notice
that a commit happened and finish the job — otherwise a Claude-made commit sat
in the shadow's own local branch forever: never on the PR branch as slash sees
it, never visible in the review tree/diff, and the shadow worktree never
reclaimed.

- **`chatShadowNeedsLanding` (`chat_shadow.go`)** answers, purely locally (no
  network — it reuses `chatShadowLocalPendingState`, the same cheap check the
  shadow-status endpoint and "wis gesprek" already use): does this
  conversation's shadow worktree have an uncommitted edit OR a local commit
  that never made it onto the PR's pending ref? The `runClaudeTurn` Activity's
  own registration (`workflows.go`) calls it right after `runOneClaudeTurn`
  returns — regardless of whether THIS turn escalated to the shell, since an
  earlier turn may have committed without managing to land — and carries the
  answer on `chatTurnResult.NeedsLand`.
  **Superseded name, current behaviour lives in `chatCheckoutNeedsLanding`
  (`chat_checkout.go`)** since the shared, standing local checkout replaced
  the disposable shadow worktree — same shape (dirty OR unlanded-commit check,
  called PR-scoped after every turn regardless of whether that turn itself
  escalated). One bug fixed there: the unlanded-commit half originally compared
  HEAD against `--not --remotes` (any remote-tracking branch), which stays true
  FOREVER once a commit has actually landed on the PR's own local pending ref —
  that ref is never itself a remote, and landing never pushes to GitHub. So
  every LATER turn of the same PR, including a plain read-only question that
  never touched the checkout at all, kept reporting "needs landing" and
  re-triggered the auto-land Activity below, re-showing the "Wijziging staat
  op ..." notice for a commit already reported once. Fixed by comparing HEAD
  against the pending ref's own SHA (`prPendingRef`/`pendingRefSHA`) once that
  ref exists for this PR/branch, falling back to the original
  `--not --remotes` check only before anything has ever landed for it. Test:
  `chat_checkout_test.go`'s
  `TestChatCheckoutNeedsLandingStopsAfterALandedCommit`.
- **`turnChangedCheckout` (`chat_checkout.go`) is the gate in front of it, and
  it is TURN-scoped** — the fix for the same reviewer report coming back on a
  different route. `chatCheckoutNeedsLanding` above is PR-WIDE by nature, so
  its other half (a non-empty `git status`) fired for state that had nothing
  to do with the turn that just ran: the reviewer's own uncommitted work in
  their own standing checkout, or a local commit from before a restart wiped
  the in-memory assignment (`a.Branch == ""` falls back to the coarse
  `--not --remotes` check). A pure question turn — read-only, never even
  resolving a work directory — then still produced the "Wijziging staat op
  ..." bubble, and worse, swept the reviewer's own file into Claude's commit.
  So `runOneClaudeTurn` now records a **baseline fingerprint** of the checkout
  (`checkoutFingerprint`: HEAD sha + porcelain status) at the one moment a
  turn gains write access — right after `prepareChatShellWorkDir` resolved and
  fetched/checked out the directory — and the `runClaudeTurn` Activity's own
  registration lands only when `turnChangedCheckout(...) &&
  chatCheckoutNeedsLanding(...)`. No baseline at all (a read-only turn) means
  no landing, full stop; a baseline that still matches means this turn changed
  nothing. The baseline map is in-memory, per conversation, consumed on read —
  the same operational carve-out as `chatProgressByConv`/`chatCancelByConv`
  (`.claude/rules/workflows-write-boundary.md`), and never a source of truth:
  a lost entry only means "no automatic landing for this turn".
  **Deliberately given up (reviewer decision):** an EARLIER turn's failed
  landing is no longer retried by a later, unrelated turn — asking for a
  commit in plain words still works. Tests:
  `chat_checkout_test.go`'s `TestTurnChangedCheckoutGatesAutoLanding` and the
  second half of `chat_workflow_test.go`'s
  `TestClaudeChatAutoLandsPendingCheckoutWorkAfterATurn` (which now drives a
  real escalating, editing turn via the new `claude.Fake.SetChatHook`, then a
  follow-up question turn that must add no landing notice and must leave the
  reviewer's own uncommitted file alone).
- **`claudeChatWorkflow`'s own loop** (`chat_workflow.go`), after every
  ordinary (non-error) turn, checks that STORED `result.NeedsLand` field — never
  a live git read of its own, so this stays a deterministic function of the
  turn's own recorded Activity result (`.claude/rules/workflow-determinism.md`)
  — and, if true, runs the exact SAME `enqueueChatMerge` Activity the (now
  unused-by-the-UI) manual "commit" action already used: land
  fast-forward-only on the PR's pending ref, auto-merge/one-begrensde-Claude-
  attempt on a real conflict, refresh the review tree
  (`refreshTreeAfterLanding`), and reclaim the shadow worktree — all via the
  PR's own `chat_merge` queue, so it still serializes against every other
  conversation's landing/push request for that PR. Never a push — that stays
  the reviewer-gated todo row (`.claude/docs/pending-push.md`).
- **A dedicated `TurnID`** (`turn.TurnID + chatAutoLandTurnSuffix`, never the
  bare turn id) keeps the outcome message ("✓ … staat op `<headRef>` en is
  meteen zichtbaar in de review-tree…") under its OWN `chatMessageID`, so it can
  never overwrite the assistant's own reply to that same turn (both would
  otherwise collide on the same `INSERT OR REPLACE` id). Test:
  `chat_workflow_test.go`'s
  `TestClaudeChatAutoLandsPendingShadowWorkAfterATurn` (pre-seeds a real local
  commit in the shadow exactly like Claude's own `git commit` would leave one,
  then asserts an ordinary follow-up turn lands it, refreshes the tree, and
  reclaims the worktree, with no "commit" action ever sent).
- **Cleanup:** `cleanup.go`'s `reWorktreeDir`/`removePRWorktrees` were extended
  to also discover/sweep any `pr-<n>-chatshadow-*` directory (plus its
  `chat/<conversationId>` branch) once the PR itself is purged — covers a
  conversation whose edits were never committed/landed. `purgePR` also drops the
  PR's pending refs (`removePendingRefs`). See "Daily data
  cleanup" in `.claude/docs/workflows-trackers.md`.
- **Known test boundary:** `fetchPRMeta` (gh.go) has no offline Fake (same as
  every other ingest.go caller of it), so `ensureChatShadowWorktree`/
  `commitChatShadowEdits` themselves are untested directly; the git-plumbing
  bodies once the head branch name is already known
  (`ensureChatShadowWorktreeAt`/`commitChatShadowEditsAt`) are split out
  specifically so they're testable offline against a throwaway local
  bare-repo-as-"origin" (`chat_shadow_test.go`, `t.Setenv("SLASH_REPO_DIR",
  ...)`) — no `gh`/network call at all. `chat_shell_test.go` goes one step
  further for `runOneClaudeTurn`/`prepareChatShellWorkDir` specifically: a
  PATH-shim fake `gh` script (`stubReachableGh`/`stubUnreachableGh`, the same
  technique as `modules/claude/timeout_test.go`'s `writeSlowBinary`) makes
  `fetchPRMeta` itself succeed or fail deterministically offline, so the
  reachable→widened-Tools and unreachable→degrade paths are both
  covered without ever touching the real `gh` CLI/network — including,
  now, that the degraded turn's saved message carries `NoShell: true`.

#### Incident: a wedged shadow worktree degraded every turn to tool-less, silently

The reviewed repo (plug-and-pay) carries real, active submodules
(`forks/nova`, `modules/Ai`), and its shared local clone sets
`submodule.recurse=true`. A plain `git reset --hard <tip>` on an existing
shadow worktree — combined with those two settings — makes git try to
(re)initialize the submodule's own gitdir in a PER-WORKTREE location
(`<clone>/.git/worktrees/<shadow>/modules/forks/nova`). That can fail partway
(no credentials/network for a second, separate clone from this subprocess's
environment) and leaves a HALF-INITIALIZED gitdir behind: just a `config`
file, no `HEAD`/`objects`/`refs`. Every later git command touching that path
then aborts with `fatal: not a git repository: .../modules/forks/nova` /
`fatal: could not reset submodule index` — **permanently**, since nothing
about the corruption heals itself. In practice this wedged a conversation to
tool-less for every subsequent turn, and struck several PRs the same day (a
shadow only needs to live long enough for one refresh).

Fixed in `chat_shadow.go`: the shadow worktree never needs a submodule's own
content (Claude only edits app code), so every git call that could touch one
says so explicitly, per-invocation — never by writing to the shared clone's
own `.gitconfig`:
- `git worktree add`/`git reset --hard` get `-c submodule.recurse=false`
  (git-reset(1)'s own gate for whether reset touches a submodule's index/
  working tree at all). This also makes a refresh **self-healing** for a
  worktree wedged by an older build, since reset then never looks at the
  broken gitdir at all.
- `chatShadowPendingState`/`chatShadowLocalPendingState`'s `git status
  --porcelain` gets `--ignore-submodules=all` — without it, `status` itself
  aborts on an already-wedged submodule, turning the "can't tell, leave the
  worktree untouched" branch into a permanent no-op.

And the **degradation is no longer silent to the reviewer** either way it
happens: `runOneClaudeTurn` sets `chat.Message.NoShell` on the turn's own
saved reply, surfaced as the "Geen bestandstoegang" pill
(`claudeNoShellPill`, `ClaudeChat.mjs`) — see "Every turn gets a real shell by
default" in `.claude/docs/claude-chat-panel.md`.

Regression test: `TestEnsureChatShadowWorktreeRefreshSurvivesBrokenSubmodule`
(`chat_shadow_test.go`) builds a real local submodule with an unresolvable
URL, reproduces the exact production failure on a plain `git reset --hard`,
and asserts the actual `ensureChatShadowWorktreeAt` survives it — both on the
first affected refresh and on a worktree already wedged by an older build.

### Serializing concurrent commits (`chat_merge`)

Every `claude_chat` conversation is its **own** Workflow Execution with its
**own** shadow branch, so two conversations on the same PR asking to "commit
deze wijziging" around the same time used to race each other's
fast-forward-only push directly: `commitChatShadowEditsAt` (above) has no
shared state across Executions, so both could fetch/ahead-check at nearly the
same moment, one wins the push, and the other simply fails with "de branch is
intussen verder" — a manual retry the reviewer had to trigger by hand, with no
guarantee *which* conversation's edit landed first.

`chat_merge.go` adds one more Workflow Type, **`chat_merge`**, whose only job
is to make that "several commits at once" case land **one after another,
each automatically merged against whatever the previous one just pushed**,
instead of racing.

- **One Execution per PR** (`chatMergeQueueRunID(pr)`, `StartWorkflowID` —
  deterministic, like `chatConversationRunID`, so ensuring it needs no
  in-memory cache/mutex the way `EnsureApprovals`/`EnsureIgnoreComment` still
  do for their older random-Run-ID convention), looping on a **`"merge"`**
  Signal (`ChatMergeRequest{ConversationID, TurnID}`). Never started directly
  from the UI/HTTP — only ensured+signalled from **inside**
  `claudeChatWorkflow`'s own `chatActionCommit` Activity
  (`enqueueChatMerge`), the exact cross-workflow Ensure+Signal shape
  `reanchorAfterRefresh` already uses to hand approvals to the `approve`
  tracker from a *different* workflow's Activity.
- **Why a dedicated Workflow Type rather than a lock in `chat_shadow.go`:**
  `ingestMu` already serializes the shared-clone git plumbing itself (worktree
  add/fetch/push), but that only prevents the git *commands* from corrupting
  each other — it does nothing about the *outcome* (two conversations still
  each get their own fetch/ahead-check/push attempt and the loser still just
  fails). Resolving that properly needs a queue: hold one commit request while
  the previous one's git-merge-and-possibly-Claude-conflict-resolution runs to
  completion. That is exactly what a Workflow Execution's own per-Run-ID mutex
  already gives for free — a bespoke Go-level lock held for the whole duration
  of a possibly-slow Claude call would also have to block every *unrelated*
  ingest/worktree operation sharing `ingestMu`, which is a much bigger lock
  scope than this feature needs.
- **Serialization comes from tembed itself, not custom queue code.**
  `Engine.SignalWorkflow` appends the Signal event and then drives the run's
  Activities **inline, under that run's own mutex**
  (`Engine.runLock`/`advance`) — so two `SignalWorkflow` calls on the SAME
  `chat_merge` Run ID are naturally serialized: the second one's append+replay
  can only start once the first has fully finished processing (including its
  own Activity), and by then it already sees the first commit as part of
  history. `chatMergeQueueWorkflow`'s body calls **exactly one** Activity
  (`processChatMerge`) per `"merge"` Signal — the Activity count is a pure
  function of the Signal count, never of what that Activity discovers live
  (fast-forward possible? merge needed? a real conflict?) — per
  `.claude/rules/workflow-determinism.md`.
- **`processChatMerge` (→ `processChatMergeAt` once the head branch name is
  known, same testability split as `commitChatShadowEditsAt`):**
  1. Try the plain, unchanged `commitChatShadowEditsAt` first. Success, or any
     failure OTHER than "the branch moved on" (no shadow, couldn't determine
     the branch, the push itself failed) → return as-is, nothing more to try.
  2. **Only** on "branch moved on" (`chatShadowBranchMovedOnMsg`, a named
     constant shared between the two files so detecting this one specific
     outcome never string-matches an inline literal in two places): attempt an
     ordinary **`git merge`** of every tip the landing must contain
     (`chatShadowMissingTips`, in a fixed order: `origin/<headRef>`, then the
     PR's pending ref) in the conversation's own shadow. Both can have moved —
     someone pushing to GitHub advances the first, another conversation landing
     an edit the second — so merging both is what makes divergence resolve
     automatically instead of leaving the reviewer stuck. Non-overlapping edits
     (different files/regions) merge cleanly with **no AI involved at all** —
     by far the common case for "several conversations changed different
     things". Still exactly ONE Activity per Signal: the loop is internal.
  3. **Only on a genuine conflict** (`chatShadowConflictedPaths`, git's own
     `--diff-filter=U` list — never inferred from the merge command's exit
     code alone): **one begrensde Claude attempt** — a one-shot, non-session
     `claude.Client.Run` (not `RunChat`; this is a mechanical fix, not a turn
     in the reviewer's own conversation) scoped to that conversation's shadow
     worktree with the Edit tool, using the new
     `claude.ChatConflictSystemPrompt`
     (`modules/claude/prompts/chat_conflict.md`). The result is **never
     trusted on the model's own say-so** — `chatShadowConflictedPaths` is
     re-checked afterwards; only a genuinely clean tree gets `git add -A` +
     `git commit --no-edit` + the landing.
  4. **Bounded to one merge/resolve attempt per tip, no retry loop.** Any
     failure at any step — the merge command itself failing for a non-conflict
     reason, an unresolved conflict, a landing that fails again after a
     successful resolve — **aborts the merge** (`git merge --abort`, so the
     shadow is left clean, never mid-conflict) and degrades to a
     reviewer-facing message. For a conflict Claude could not clear, that
     message is deliberately a **consultation, not a dead end**
     (`chatMergeConflictConsultMsg`): it names which tip it conflicts with
     (GitHub's, or another conversation's landed-but-unpushed change), lists
     the conflicting files, says what was already tried, and asks how the
     reviewer wants to proceed. It lands in that same conversation's transcript,
     so the reviewer answers it in the Claude column and Claude can redo the
     change against the current state of the branch. The reviewer's own next "commit" click enqueues
     a brand new request, which starts over against whatever the branch looks
     like by then — this is what keeps the Activity a bounded, deterministic
     sequence of steps regardless of how much the branch thrashes, rather than
     a retry loop that could run indefinitely.
- **Every outcome is ONE `chat.Message`, written under the SAME deterministic
  id** `commitChatShadowEditsAt` already used
  (`chatMessageID(turnId, "")`) — `processChatMergeAt`'s own follow-up
  `SaveMessage` calls simply overwrite that row (transient intermediate
  "branch moved on" text, if it was ever briefly written, is never shown to
  the reviewer) rather than adding a second message, and the Activity
  registration's own `publishChatChanged` fires exactly once, after the whole
  attempt settles — never per intermediate step.
- **`landAndReclaimChatShadow`** (`chat_shadow.go`) is the ONE place that ever
  moves a PR's pending ref forward — extracted out of
  `commitChatShadowEditsAt`'s own tail so both the plain fast-forward path and
  chat_merge's merge/conflict-resolved path share it, instead of two copies of
  the same land+reclaim logic. Since it no longer pushes, git's own
  non-fast-forward refusal is gone, so it re-checks containment itself before
  `update-ref` — no code path can rewind another conversation's unpushed work.
  `ingestMu`-guarded, same reasoning as `ensureChatShadowWorktreeAt`. The push
  to GitHub is `pushPendingPR` (`pending_push.go`), a separate `"push"` request
  on this same queue — see `.claude/docs/pending-push.md`.
- **`PriorityLow`** (same reasoning as `claude_chat` itself): a conflict
  resolution is a real `claude` subprocess call, so an interrupted
  `processChatMerge` must not block server startup on recovery.
- **Known test boundary, same category as the agentic-edit path above:**
  `claude.Fake` never actually edits a file (it only returns programmed
  text), so the "Claude genuinely clears a real conflict" success path isn't
  exercisable offline — only the detection→invoke→still-conflicted→abort
  path is. Every deterministic git-plumbing path (fast-forward, clean
  auto-merge of non-overlapping edits, two requests processed in arrival
  order) IS fully covered offline.

### Opt-in influence on the left comment thread (Phase 4)

Claude may **never** post to or resolve the comment thread on its own
initiative — only on the reviewer's **explicit** request, spelled out within
the conversation itself (e.g. "zet dit als reactie op de comment", "los deze
comment op"). There is no button/tool for this yet (see the open UI-trigger
point below) — it is entirely driven by the model choosing to emit a second
strict JSON directive, parsed by the same `parseAssistantTurn` that already
recognizes the `question` shape:

```
{"type":"comment_action","action":"reply","commentId":"<id>","body":"<text>"}
{"type":"comment_action","action":"resolve","commentId":"<id>"}
```

- **The system prompt (`modules/claude/prompts/chat.md`, and its
  shell-enabled sibling `chat_shell.md`) states the "only on explicit request,
  never on your own initiative" rule directly next to the format**, mirroring
  how the `question` directive is introduced. This is a correctness aid, not
  the actual guard — see below for what really prevents misuse.
- **The conversation's own comment id is injected into the system prompt in
  Go** (`runOneClaudeTurn`, appended after `claude.ChatSystemPrompt`/
  `claude.ChatShellSystemPrompt`, both of which stay static embedded files) so
  the model can echo the right `commentId` back — the embedded prompt files
  are call-independent text, the same "static block + dynamic call-specific
  content" split every other prompt (`resolvePrompt`/`explainPrompt`/…)
  already uses.
- **`parseAssistantTurn` returns `(chat.Message, *commentActionDirective)`
  instead of just a message.** A validated `comment_action` directive (a
  recognized `action` of `"reply"`/`"resolve"`, a non-empty `body` for
  `"reply"`, a non-empty `commentId`) yields `(chat.Message{}, &directive)` —
  deliberately **not saved as a message here**: the raw JSON must never appear
  in the transcript, and whether the attempt actually succeeds is only known
  after the validation below runs. A malformed shape (any of those checks
  failing) degrades to a plain text turn, exactly like a malformed `question`
  directive — the raw text shows verbatim rather than vanishing.
#### One message may ask for BOTH a change and a reply

Reviewer report: a message ending in "maak een comment en reageer kort erop"
produced only the drafted reply — the read-only attempt picked the
`comment_action` format, the code change never happened, and the reviewer had
to send a second message ("zijn de aanpassingen al gemaakt? anders, doe het")
to get it. Both directives are "answer with NOTHING but this JSON object", so
one turn could only ever be one of the two.

Fixed in two places, deliberately keeping the directives strict:

- **`chat_readonly.md`**: a combined request (change/execute **and** reply to
  or resolve the thread) escalates with `{"type":"need_write"}` first, never
  with a `comment_action` — the reply is written in the write turn, once the
  change actually exists and Claude can say what it did.
- **`chat_shell.md` + `parseAssistantTurn`**: a write turn that changed
  something answers with its ordinary prose **and** puts the
  `comment_action` object on its own **last line**.
  `splitTrailingCommentAction` peels that line off (tolerating blank lines and
  a stray ``` fence around it), so the turn yields BOTH a visible text message
  and the directive. A turn that changed nothing still answers with the bare
  JSON object, unchanged. `runOneClaudeTurn` therefore saves its message
  whenever it has a body, instead of only when there is no directive — the
  reviewer ends up with the explanation bubble *and* the "concept in
  comment-veld gezet" draft from one message. Prose that merely ends on some
  other JSON-ish line stays plain text (the last line must parse as a
  `comment_action` directive).

- **`runClaudeTurn`'s own Activity result grew a matching `Action` field**
  (`chatTurnResult{Message, Action}`) so this workflow-only handoff travels
  through the *existing* Activity boundary without leaking into
  `modules/chat`, which knows nothing about `task_code_comment`/
  `ReactionSignal` addressing.
- **The workflow body's decision to run a second Activity is purely a
  function of that stored result** (`result.Action != nil`), exactly mirroring
  the existing `pendingQuestionID` branch — deterministic under replay, no
  live-state dependency.
- **`applyChatCommentAction`** (its own registered Activity, plain testable
  function) validates every directive the same way up front, in order:
  1. **`directive.CommentID` must equal the conversation's own thread**
     (`arg.ConversationID`) — a chat has no context about any other comment of
     the PR, so a mismatch can only be a mistake/hallucination, never a
     legitimate cross-thread request. Never signalled/drafted; logged via
     `logf` and surfaced as a `KindError` turn.
  2. **The comment must still exist and not be `deleting`/`deleted`**
     (`comments.Module.Get`, a new read method — `WHERE id = ?`, mirrors
     `List`/`Search`'s shared `query`).

  Past that point the two actions diverge — **a later, explicit correction
  from Reindert**: "Claude mag namens mij een bericht sturen, ik wil het
  daarna kunnen bewerken... je hoeft het dus vooral alleen in de input te
  plaatsen en de focus erop te zetten." A `"reply"` used to signal the thread
  exactly like `"resolve"` (see the git history of this section for the
  original one-Signal-for-both shape) — **removed**: there is text to review
  first, so the reviewer must see and possibly edit it before anything is
  ever written to the thread.

  - **`d.Action == "reply"`**: no Signal, no Execution-status check (a draft
    never touches the thread, so whether its Execution can still receive a
    Signal is irrelevant) — `saveChatDraftReply` just records the drafted body
    verbatim as its own turn, `Kind: chat.KindDraftReply`. The frontend
    (`RelatedPanel.mjs`'s `applyPendingDraftReplies`, see
    `.claude/docs/claude-chat-panel.md`'s "A `reply` directive only drafts,
    never posts") merges it into the LEFT thread's own reply composer; sending
    it afterwards is the ordinary, unprivileged `sendReaction` path — never
    `Source: "ai"`.
  - **`d.Action == "resolve"`**: unchanged — an immediate action, nothing to
    review. **The target Execution must still be signallable**
    (`engine.Status(c.RunID)` not `completed`/`failed`) — a completed/failed
    run can never receive a Signal again; checked **before** signalling
    (mirrors the avatar-backfill glue's own `Status` check in
    `comment_import.go`) so the reviewer-facing message can name the real
    reason instead of a bare error. Then the existing `reply` Signal
    (`ReactionSignal{Source: "ai", Author: "Claude", Body: "/resolve", Done:
    true}`) via `TaskManager.Signal` — the exact same sanctioned write path an
    AI `code_warning` finding already uses, never a new one. A failed `Signal`
    call itself is also caught (best-effort, never a Go error that would fail
    the whole `claude_chat` workflow) and surfaced the same way.
- **Exactly one visible outcome turn is recorded either way** for a "resolve"
  attempt or a validation failure of either action (`saveChatActionOutcome`):
  `Kind: chat.KindAction` with a `"✓ …"` confirmation text on success,
  `Kind: chat.KindError` with a concrete reason on any failure — so the
  reviewer always sees what happened, never an optimistic message that turns
  out wrong. A successful "reply" draft instead goes through
  `saveChatDraftReply` (`Kind: chat.KindDraftReply`, body verbatim, no
  "✓ …" framing — it hasn't happened yet). `chat.KindAction`/
  `chat.KindDraftReply` are `Message.Kind` values alongside
  `KindQuestion`/`KindError`.
- **No UI trigger needed any more, and none exists** (unrelated to Phase 4
  itself) — the frontend panel only ever sends a plain (`Action: ""`) turn,
  and always has. A later pass (Phase 3, see
  `.claude/docs/claude-chat-panel.md`'s former "Agentic edits" section) did
  add two composer buttons that set `action: "edit"`/`"commit"` on the
  `POST .../signals/message` call; those buttons (plus the commit confirm
  menu) were **removed again** on reviewer request — "I'll just say what I
  want in the message". Unlike the earlier state of this doc, there is now
  **no replacement trigger to wait for**: `runOneClaudeTurn` widens a turn's
  tool scope itself, on request (see "Two-step tool access" above), so a
  reviewer who wants Claude to edit/commit/open Jira just says so in a plain
  message and Claude reaches for Bash once it says `{"type":"need_write"}`,
  gated only by the system prompt's "only on explicit request" instruction.
  The blocker this bullet used to describe — defaulting every turn to
  `chatActionEdit` hard-depended on a live `gh`/git round trip with no
  degraded fallback — is fixed by `prepareChatShellWorkDir`'s graceful degrade,
  not by a frontend trigger. Landing a commit onto the PR branch and cleaning
  up the shadow worktree afterwards is likewise automatic now, not a second
  reviewer step — see "Automatic landing after a shell turn" above.

### "Wis gesprek" (`chatActionClear`) — clearing a conversation

A fourth `ChatMessageSignal.Action` value, `"clear"`, alongside `""`/`"edit"`/
`"commit"` — the command-palette's "Wis Claude-gesprek", which confirms first
only while the shadow worktree still holds pending work (frontend mechanism:
"Wis Claude-gesprek" in `.claude/docs/claude-chat-panel.md`). Needs
no `Body` (validated in `tasks_api.go`'s `SignalMessage` handler alongside
`"commit"`).

- **`claudeChatWorkflow`'s own branch** (`chat_workflow.go`), checked first in
  the Signal loop: runs exactly one `clearChatConversation` Activity, resets
  `pendingQuestionID = ""` (so a message right after a clear is never
  mistaken for an answer to the just-wiped question turn), then `continue`s —
  no Claude call, no user/assistant text turn. Decided purely by `sig.Action`,
  part of the Signal's own recorded input — deterministic under replay, same
  shape as the existing `chatActionCommit` branch.
- **`modules/chat.Module.ClearConversation`** deletes every row of that
  conversation from `chat_messages` and resets `chat_conversations.session_id`
  to `''` — the conversation row itself (and its id) survive, so it keeps
  anchoring to the same comment thread and the next turn simply starts a
  fresh `claude` session instead of `--resume`-ing the wiped one.
- **`clearChatShadow`** (`chat_shadow.go`), called right after, best-effort
  removes the conversation's agentic-edit shadow worktree + branch (`git
  worktree remove --force` + `git branch -D`, under `ingestMu` like every
  other shadow-worktree git call) — **unconditionally**, never re-checking for
  pending work itself: the reviewer already saw a warning about any
  uncommitted/locally-unpushed shadow content (see the shadow-status endpoint
  below) before confirming the clear on the frontend, so the backend simply
  acts once asked, per the usual "the UI decides to warn/confirm, the backend
  executes the write once asked" split. A no-op when no shadow worktree exists.
- **`chatShadowLocalPendingState(ctx, dir)`** (`chat_shadow.go`) is the cheap,
  purely local check both the shadow-status endpoint and (conceptually)
  `clearChatShadow` reason about: `git status --porcelain` for `dirty`, `git
  rev-list --count HEAD --not --remotes` for `ahead` — no `git fetch`/`gh`
  call, so it's safe to run synchronously from an HTTP handler. `--not
  --remotes` (every already-known remote-tracking ref) rather than
  specifically `origin/<headRef>` — resolving that would need a live `gh`
  lookup — good enough to answer "is there real, exclusively-local work here".

### Endpoints

`POST /api/workflows/claude_chat {pr, commentId}` → `StartClaudeChat`
(validates `commentId` names an existing comment of `pr` before starting);
`POST /api/workflows/{runID}/signals/message {author, body, action?}` → the
generic signal route (the reviewer turn; `action` is
`""`/`"edit"`/`"commit"`/`"clear"` and is validated in the handler before it
ever reaches the workflow);
`GET /api/chat?commentId=X` → the read-only transcript;
`GET /api/chat/progress?commentId=X` → the in-memory snapshot of a running
turn, which is the resync read for the SSE stream `GET /api/events` pushes the
live progress over (`.claude/docs/server-events.md`);
`GET /api/chat/shadow-status?pr=N&commentId=X` → read-only
`{exists, dirty, ahead}` for a conversation's shadow worktree
(`chatShadowLocalPendingState`) — the check that decides whether the "Wis
Claude-gesprek" palette command clears straight away or first shows a confirm
submenu naming the pending shadow work it would discard.
No module write, no workflow, no network (purely local git plumbing against a
directory already on disk) — the same read-only-side-effect class as
`blockstats.go`/`comment_import.go` reading a worktree, so it needs no
workflow of its own per `.claude/rules/workflows-write-boundary.md`. Full
table: `.claude/docs/tembed-endpoints.md`.

### Tests

`modules/chat/chat_test.go` (round-trip, question+answer on one row, per-PR
purge — all offline, no `claude`), `chat_workflow_test.go` (end-to-end via
`claude.Fake`: idempotent start, the reviewer/assistant turn cycle + session
id reuse, a question turn's answer landing on the same row, a failed turn
degrading to a `KindError` message, a `"reply"` directive drafting a
`KindDraftReply` turn WITHOUT touching the target thread at all (and still
succeeding even when that thread's own Execution has gone terminal — a draft
never signals it), a `"resolve"` directive landing on the target thread's own
`task_code_comment` Execution with `Source: "ai"` plus a `KindAction`
confirmation turn (and degrading to `KindError` when that Execution is
terminal), a directive whose `commentId` doesn't match the conversation being
rejected without touching any thread, and a malformed directive degrading to
plain text),
`chat_shadow_test.go` (the
`...At`-suffixed git-plumbing bodies against a throwaway local bare-repo
"origin": worktree creation on a real branch, refresh-when-clean,
never-discarding a pending/dirty edit, a fast-forward push actually landing on
the remote + the shadow being reclaimed afterwards, a non-fast-forward push
being refused without touching the remote, and the "nothing to commit" case),
and `chat_merge_test.go` (`processChatMergeAt` against the same kind of
throwaway bare repo: a clean auto-merge of two conversations' non-overlapping
edits with zero `claude.Fake` calls, two requests processed back-to-back in
arrival order both landing on the real branch, and a genuine same-line
conflict where the one begrensde Claude attempt — via `claude.Fake`, which
never really edits a file — is invoked exactly once, fails to clear the
conflict, and the merge is aborted without touching the remote; plus
`chatMergeQueueWorkflow`'s own ordering guarantee against a bare tembed engine
with a stub Activity, and `EnsureChatMergeQueue`'s idempotency) — all offline,
no live `claude`/`gh`/network call.

`chat_shell_test.go` additionally covers the two-step tool-access design
(task 3): `TestRunOneClaudeTurnUsesReadOnlyHeadWorktreeWithoutEscalating` (a
plain question costs exactly 1 `RunChat` call against the SHARED head
worktree, no gh/git round trip at all), `TestRunOneClaudeTurnEscalatesToShellOnNeedWrite`
(a `{"type":"need_write"}` reply triggers a second, session-resuming call with
the full shadow worktree), `TestRunOneClaudeTurnDegradesWhenShellUnavailableAfterEscalating`
(escalating but failing to get the shadow degrades to a visible, `NoShell`
reply, never an error turn) and the pre-existing `TestRunOneClaudeTurnDegradesWhenGhUnreachable`
(no head worktree and gh unreachable still degrades cleanly). `chat_workflow_test.go`'s
`TestClaudeChatAutoLandsPendingShadowWorkAfterATurn` covers the automatic
landing (tasks 1+2+4): pre-seeds a real local commit in the shadow — exactly
what Claude's own `git commit` leaves behind — and asserts an ORDINARY
follow-up turn (no "commit" action ever sent) lands it on the pending ref,
reclaims the shadow worktree, and reports the outcome under its own message
id; `TestRunChatTurnWithRetriesResetsResultPerAttempt` guards the
stale-`Kind`-across-retries bug documented above.

## `comment_batch` (`comment_batch.go` + `comment_batch_progress.go`)

"Laat Claude alle openstaande comments verwerken": **ONE** agentic Opus run
(`claude.ModelOpus`, `Read/Grep/Glob/Edit/Bash`) that walks every open comment
of a PR and edits code for it. Deliberately one run rather than one per comment
— the reviewer's own framing ("dan moet alles in 1 agent worden opgepakt"): the
comments of a PR touch the same files and each other's context, so one session
that has read everything once is both cheaper and better informed.

Three product decisions shape the whole thing:

1. **Code only.** The run never replies to a comment and never resolves one.
   The reviewer decides that afterwards, with **Space on the comment's own index
   row** (`spaceKey`, `home.mjs` → the existing `reply` Signal with
   `done: true`). So this workflow signals no comment thread at all — unlike
   `code_warning`, which creates comments of its own.
2. **The normal landing route.** The edits are made in the very same
   per-conversation shadow worktree a chat turn uses (`chat_shadow.go`), under
   the synthetic conversation id `commentBatchConvID(pr)` = `"batch-<pr>"`, and
   are landed by the existing `chat_merge` queue — so they end up on the PR's
   local pending ref and the reviewer pushes them himself from the todo row (see
   `.claude/docs/pending-push.md`). No new git path.
3. **Skipping is a first-class outcome.** A comment that is only a question, a
   compliment, or genuinely unclear is skipped WITH a reason and the run moves
   on; it stays an ordinary open comment.

**Which comments** ("van GitHub + eigen, geen AI"): `commentBatchEligible` —
open, `source != "ai"`, `kind != "ai_warning"`. Checked server-side against the
stored comments before the run starts (a browser list can be stale), and
mirrored in the frontend's own `isBatchEligible` (`commentBatch.mjs`) — see
"The comment_batch checkboxes and the bottom action row" below.

**Per-comment progress out of one agent** comes from marker lines the run
prints, fixed by `claude.CommentBatchSystemPrompt`:
`[slash:start] <id>` / `[slash:done] <id> <noot>` / `[slash:skip] <id> <noot>`.
They are parsed **twice**, on purpose: LIVE from the streamed events
(`commentBatchProgressSink`, same shape as `chatProgressSink`) for the volatile
snapshot, and once more from the run's **final text** for the Activity's
recorded result — so the durable result stays a pure function of that text and
replay never depends on whether a stream was observed (see
`.claude/rules/workflow-determinism.md`). A marker naming an id the run wasn't
given is ignored, in both paths.

`comment_batch_progress.go` is that snapshot (`GET /api/comment-batch?pr=N` +
the `commentbatch.progress` SSE event): the same in-memory carve-out as
`chat_progress.go`, with ONE deliberate difference — it is **kept** after the
run finished instead of deleted, because a batch leaves no durable per-comment
trace at all (see decision 1), so "Claude heeft deze comment verwerkt" would
otherwise vanish the moment the run ended. A restart drops it and the comments
are simply open comments again.

### Where the reviewer sees it

**Entirely in the sidebar — there is no palette entry point anymore** (an
earlier version opened a `'bulkComments'` palette mode with the comments
listed under each other; removed on request, see "The old palette entry point
was removed" in `.claude/docs/comments-panel.md` for the reasoning). Every
batch-eligible comment-index row (`batchEligibleRows`, `BlockList.mjs` — same
`isBatchEligible` predicate the server mirrors) gets its own checkbox,
checked by default; a bottom action row ("Verwerk N comments met Claude
(Opus 5)", `batchActionRow`) runs the batch over exactly the CHECKED ones
(`checkedBatchComments`) and is itself a stop of the sidebar's `↑`/`↓` loop
(`state.batchRowFocused`, see `.claude/docs/keyboard-navigation.md`) — Enter,
click, or the row's own click all run `startBatchFromRow` (`home.mjs`)
directly, no confirm step. Unchecking a row is mouse-click **or** `Space` on
the selected row (see keyboard-navigation.md) — the deliberate curation step
that replaces the removed palette's "read the list, then confirm" shape.
`Space` deliberately does NOT resolve a comment anymore either way — see "The
comment_batch checkboxes and the bottom action row" in
`.claude/docs/comments-panel.md`.

Starting it jumps straight to the FIRST checked comment, because that is
where the progress lives:

- `batchPill` (`BlockList.mjs`) on the comment's index row — a pulsing dot
  plus the WORD ("Claude bezig" / "verwerkt" / "overgeslagen");
- the log line in the EXISTING status element `comment-batch-status`
  (`CommentClaudeFooter`, which `commentDetailCard` also mounts —
  `{ batchOnly: true }`, see "The menu button … and the shared comment/Claude
  footer" in `.claude/docs/comments-panel.md`): while this comment is the
  current one it shows the same "Claude leest src/x.php" sentence a chat turn
  shows (`claudeStatusText`, so no second formatter), afterwards its one-line
  outcome — the `batchOnly` flag keeps this small per-comment card to just
  this one line, the live chat-turn status (`claude-chat-status`) stays only
  in the wide `comment-claude-row` footer, so the two never show the SAME
  running turn twice;
- the **bottom action row itself** (`batchRunningLines`, `BlockList.mjs`),
  which is the only PR-WIDE spot: it used to say nothing but "Claude bezig met
  de comments…" for the whole run. On request ("geef meer feedback als claude
  bezig is, bijvoorbeeld met welke comment hij bezig is en hoeveel van de
  hoeveel hij heeft verwerkt") it now shows three lines — the counter
  (`done + skipped` of `total`, plus the skipped count when there is one),
  "Bezig met: &lt;label&gt;" naming `batch.current` by the very label its own
  index row carries (`batchCurrentLabel`, so the two can never word the same
  comment differently), and the live activity through that same
  `claudeStatusText`. That third line is knowingly a DUPLICATE of the footer's
  when the reviewer happens to stand on the current comment — accepted,
  because the run must read as alive from anywhere in the sidebar. A
  `batch.error` replaces it. Elapsed seconds are 0 here, as in
  `RelatedPanel.mjs`'s own batch call: no ticker for a decoration line.

`src/commentBatch.mjs` is the one shared reactive snapshot behind all of the
above (one read + the SSE push, no poll of its own) — it also now exports
`isBatchEligible`, the single predicate `batchEligibleRows` (`BlockList.mjs`)
and thus `checkedBatchComments`/`startBatchFromRow` (`home.mjs`) build on.

### The index change it rides on

`indexComments` (`RelatedPanel.mjs`) now gives **every unresolved comment** its
own blokken-index row, not just the PR-wide/orphan/mentioned ones — with one
extra condition in `recomputeLeftList` (`home.mjs`, which owns `state.blocks`):
the comment's block must actually be in the tree, otherwise the row would be a
dead end. Two wanted consequences: every open comment is a stop on the ↑/↓ walk,
and — because `blockApproveCount` already scores a comment row as
"resolved == approved" — the PR is only fully approved once every comment is
resolved, **including other people's**. Resolving such a row (via its own
`Enter` menu — see `.claude/docs/approval.md`, `Space` deliberately does NOT
resolve it) is what makes that walk finishable.

Tests: `comment_batch_test.go` (marker parsing incl. prose that must not match,
the progress lifecycle, eligibility + prompt content, the no-work-copy degrade
path, and the streamed sink with a marker split across two text deltas) and
`tests/comment-batch.spec.mjs` (the index row, the checkboxes + bottom action
row + Space toggling them, and resolving via the Enter menu).
