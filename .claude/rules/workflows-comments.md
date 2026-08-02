# Comment workflows: `task_code_comment` + GitHub import

The comment-thread half of the workflow layer: placing a comment on a line of
code and keeping the thread alive, plus pulling in threads that were placed
outside the app. Engine mechanics live in `.claude/rules/tembed-workflows.md`,
endpoints in `.claude/rules/tembed-endpoints.md`.

## `task_code_comment` (`workflows.go` + `modules/`)

A **Workflow Type** `task_code_comment`, one Execution per comment, whose **Run
ID is the comment id**.

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
rule in `.claude/rules/arrowjs-pitfalls.md`). Test:
`tests/drill-comment-target.spec.mjs`.

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
  can never accept a Signal again; without this check a permanently failed
  thread was retried on every restart forever (`avatarTried` only dedups within
  one process). Test: `TestImportSkipsAvatarBackfillOnFailedRun`.
- **Read model:** `Source` (`ui`/`github`) + `Kind` columns; `GET /api/comments`
  serves imported comments automatically, no new endpoint. The frontend badges
  `source: github` and renders PR-wide comments as their own navigable index
  rows (see "Comment-index items" in `.claude/rules/comments-panel.md`).
- Tests: `comment_import_test.go`, `modules/comments/comments_test.go`,
  `tembed/engine_test.go` (`StartWorkflowID` idempotency).

## `claude_chat` (`chat_workflow.go` + `modules/chat` + `modules/claude`'s `RunChat`)

An embedded, multi-turn Claude conversation next to a review comment thread —
the reviewer can ask Claude about the code/comment without leaving the review
tree. **Phase 1 (backbone) only so far**: no frontend panel yet, no tool
access, no ability to influence the left thread. This section documents what
exists; the phases still to come are called out explicitly below.

### Scope: one conversation per comment thread

**A `claude_chat` Execution always hangs off an existing `task_code_comment`
thread** — its **Run ID is derived from that comment's id**
(`chatConversationRunID`, `"chat-" + commentID`), not from the PR or the
navigation unit. This was a deliberate product decision (over "one chat per
PR" or "one chat per navigation unit"): it reuses the comment thread as the
one existing place with a durable Execution and a reply mechanism, so a later
phase can let the reviewer ask Claude to act on **that same thread** with no
new addressing scheme.

**If the reviewer opens the chat panel somewhere with no comment thread yet,
the frontend places one first** — an ordinary `task_code_comment` Execution
with `Local: true` (so it's never posted to GitHub, see the `Local` flag
above) and an empty/placeholder body — and then starts the chat on that
comment's id. This is the sanctioned write path already used for every other
comment (`StartCodeComment`); `claude_chat` itself never creates a comment.

`StartClaudeChat(ClaudeChatInput{PR, CommentID})` starts/reuses the Execution
(idempotent via `StartWorkflowID`, mirroring `resolveCallRunID`/
`explainRunID` — no in-memory map needed, unlike the per-PR trackers, since
the Run ID is already a pure function of the input).

### Flow

`ensureChatConversation` (creates the `chat_conversations` row, idempotent)
then a loop on **`message`** Signals (`ChatMessageSignal{ID, Author, Body}`,
mould of `task_code_comment`'s reactions loop): per turn,

1. if the assistant's last turn was an unanswered **question** (see below),
   `saveChatAnswer` records the reviewer's reply as that question's `Answer`;
2. `saveChatMessage` stores the reviewer's own turn (`role: "user"`);
3. `runClaudeTurn` calls `claude.Client.RunChat` (context-only for now — no
   `Tools`/`WorkDir`, see "Not yet built" below) and stores the assistant's
   reply.

Never completes — a long-lived per-conversation tracker. Marked
`PriorityLow` (a real turn is a `claude` subprocess call, same reasoning as
`resolve_call`/`code_warning` — an interrupted turn must not block server
startup on recovery).

**Determinism:** the loop tracks "is a question still open" purely from the
**previous Activity's result** (`assistant.Kind`), never from wall-clock/
random state, so it replays safely; the reviewer-turn's `ID` is generated by
the HTTP handler (`"msg-" + newUIReactionID()`), exactly like a
`ReactionSignal.ID` — never inside the workflow body.

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

### A failed Claude call degrades to a visible error turn

`runOneClaudeTurn` never fails the workflow on a `RunChat` error — it stores a
`Kind: chat.KindError` assistant message with a fixed apology text instead, so
the conversation stays alive and the reviewer can simply try again. Mirrors
the "best-effort, log and carry on" convention used elsewhere for
GitHub/Claude side effects, except here the failure is surfaced **in the
transcript itself** (not just the log) since the reviewer is actively waiting
on it.

### `modules/chat` (`data/chat.db`)

`chat_conversations(id, pr, session_id, created_at, updated_at)` +
`chat_messages(id, conversation_id, pr, role, kind, body, options_json,
answer, created_at)` — `options_json` round-trips `Message.Options`
([]string) through the SQLite TEXT column. Write methods
(`EnsureConversation`/`SaveMessage`/`SetAnswer`/`SetSession`) are
workflow-Activity-only; `List`/`GetSession` back the read-only UI/API. `Purge`
is wired into the `cleanup` workflow's `purgeDeps`/`purgePR` like every other
PR-scoped module.

### Not yet built (phases 2-4, tracked but not implemented)

- **No frontend panel yet** — no `cs.focus==='claude'` stop, no rendering, no
  polling of `GET /api/chat`. See "Fase 2" of the original plan; nothing in
  `.claude/rules/detail-layout.md`/`keyboard-navigation.md` changed for this
  yet.
- **No agentic tool access** — `runOneClaudeTurn` calls `RunChat` with no
  `Tools`/`WorkDir`, so Claude cannot read the worktree or edit code yet. When
  built, edits land in a **disposable shadow-worktree copy** (à la
  `reanchor.go`'s shadow-worktree-pair technique), never directly in the
  shared `data/worktrees/pr-<n>-head` that `/api/code`/ingest-refresh/re-anchor
  depend on — only an explicit reviewer "commit this change" action writes it
  back into the real head worktree.
- **No influence on the left comment thread yet** — Claude may never post to
  or resolve the comment thread on its own initiative. A later phase parses an
  **opt-in** directive (only emitted when the reviewer explicitly asks for it
  in the conversation) and signals the thread's own `task_code_comment`
  Execution via its existing `reply` Signal (`Source: "ai"`) — the exact same
  sanctioned write path an AI `code_warning` finding already uses, never a new
  one.

### Endpoints

`POST /api/workflows/claude_chat {pr, commentId}` → `StartClaudeChat`
(validates `commentId` names an existing comment of `pr` before starting);
`POST /api/workflows/{runID}/signals/message {author, body}` → the generic
signal route (the reviewer turn); `GET /api/chat?commentId=X` → the read-only
transcript. Full table: `.claude/rules/tembed-endpoints.md`.

### Tests

`modules/chat/chat_test.go` (round-trip, question+answer on one row, per-PR
purge — all offline, no `claude`), `chat_workflow_test.go` (end-to-end via
`claude.Fake`: idempotent start, the reviewer/assistant turn cycle + session
id reuse, a question turn's answer landing on the same row, and a failed turn
degrading to a `KindError` message) — all offline, no live `claude`/`gh` call.
