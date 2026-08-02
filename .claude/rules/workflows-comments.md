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
then a loop on **`message`** Signals (`ChatMessageSignal{ID, Author, Body,
Action}`, mould of `task_code_comment`'s reactions loop). `Action` rides along
as a variant of this one Signal (tembed can only `WaitSignal` on one name at a
time — the same reason `task_code_comment`'s `delete` rides on its `reply`
Signal via `ReactionSignal.Action`), validated by the HTTP handler **before**
it ever reaches the workflow: `""` (plain, read-only turn), `chatActionEdit`
("edit" — let Claude use its Edit tool), `chatActionCommit` ("commit" — push,
see "Agentic edits" below). Per turn:

- **`sig.Action == chatActionCommit`** skips everything else: one
  `commitChatShadowEdits` Activity, no Claude call, no user/assistant text turn
  beyond the status message that Activity itself saves — see "Agentic edits"
  below.
- Otherwise (a plain or an edit turn): if the assistant's last turn was an
  unanswered **question** (see below), `saveChatAnswer` records the reviewer's
  reply as that question's `Answer`; `saveChatMessage` stores the reviewer's
  own turn (`role: "user"`); `runClaudeTurn` calls `claude.Client.RunChat` —
  context-only (no `Tools`/`WorkDir`) for a plain turn, or against the
  conversation's own shadow worktree with the `Edit` tool for
  `chatActionEdit` — and stores the assistant's reply.

Every branch is decided purely by `sig.Action`, part of the Signal's own
recorded input, so the Activity count/order per Signal stays a pure function
of history — deterministic under replay regardless of live git/filesystem
state.

Never completes — a long-lived per-conversation tracker. Marked
`PriorityLow` (a real turn is a `claude` subprocess call, same reasoning as
`resolve_call`/`code_warning` — an interrupted turn must not block server
startup on recovery).

**Determinism:** the loop tracks "is a question still open" purely from the
**previous Activity's result** (`assistant.Kind`), never from wall-clock/
random state, so it replays safely; the reviewer-turn's `ID` is generated by
the HTTP handler (`"msg-" + newUIReactionID()`), exactly like a
`ReactionSignal.ID` — never inside the workflow body.

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
`.claude/rules/claude-chat-panel.md` for the UI half). `RunChat` runs with
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

### Agentic edits (Phase 3): a per-conversation shadow worktree, never the shared head

`chatActionEdit` lets Claude use its **Edit tool** on real files, but never
against the shared `data/worktrees/pr-<n>-head` that `/api/code`,
`blockstats.go`, the re-anchor pass and the ingest-refresh poller all depend on
staying pinned to the exact recorded `head_sha`. Instead each conversation gets
its own **disposable, non-detached** worktree (`chat_shadow.go`) — deliberately
a **third** worktree, not a repurposed base/head one, and deliberately checked
out **on a real local branch** rather than detached (unlike `ensureWorktree`'s
base/head worktrees), so it can be committed and pushed with an ordinary git
flow.

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
- **Prompt:** an edit turn swaps the system prompt from `claude.ChatSystemPrompt`
  to its sibling **`claude.ChatEditSystemPrompt`**
  (`modules/claude/prompts/chat_edit.md`) — the CLI only takes one
  `--append-system-prompt`, so this is a full replacement, not an addition. It
  keeps the same assistant framing + question-directive contract and adds that
  the Edit tool is available **this turn**, scoped to the conversation's own
  disposable shadow worktree, and that nothing reaches the real PR until the
  reviewer explicitly commits it.
- **Lazy creation, live refresh** (`ensureChatShadowWorktree` →
  `ensureChatShadowWorktreeAt`, called at the start of every edit turn): fetches
  the PR's real head branch (`gh pr view --json headRefName`, see
  `prMeta.HeadRefName` in `gh.go`) and either creates the worktree
  (`git worktree add -b chat/<id> <dir> origin/<headRef>`) or, if it already
  exists **and has nothing pending** (clean + no local commits ahead of
  `origin/<headRef>`), fast-forwards it in place (`git reset --hard`). A dirty
  or ahead-of-remote shadow is **left exactly as is** — an in-progress or
  already-committed-but-unpushed edit must never be silently discarded/rebased,
  the same "degrade rather than guess" rule the re-anchor pass follows.
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
  then **fast-forward-push only** onto the PR's real head branch via an
  explicit refspec (`chat/<id>:<headRef>`) — **never a force-push**. A
  pre-flight `rev-list --count HEAD..origin/<headRef>` check refuses the push
  (with a reviewer-facing message, no Go error) the moment the real branch has
  moved on since the shadow was based, on top of git's own default refusal of a
  non-fast-forward push. On success the shadow worktree + its branch are
  **reclaimed immediately** (`git worktree remove` + `git branch -D`) — nothing
  is left to represent once the shadow matches the new head; a later edit turn
  re-materializes it lazily. A pushed commit is picked up like any other new
  commit: the existing `pr_status` ingest-refresh poller notices the head SHA
  moved and does its normal delta refresh + re-anchor pass — no new
  integration needed. **This is no longer called directly from
  `claudeChatWorkflow`** — see "Serializing concurrent commits (`chat_merge`)"
  below for what wraps it and why.
- **Cleanup:** `cleanup.go`'s `reWorktreeDir`/`removePRWorktrees` were extended
  to also discover/sweep any `pr-<n>-chatshadow-*` directory (plus its
  `chat/<conversationId>` branch) once the PR itself is purged — covers a
  conversation whose edits were never committed/pushed. See "Daily data
  cleanup" in `.claude/rules/workflows-trackers.md`.
- **Known test boundary:** `fetchPRMeta` (gh.go) has no offline Fake (same as
  every other ingest.go caller of it), so `ensureChatShadowWorktree`/
  `commitChatShadowEdits` themselves are untested; the git-plumbing bodies once
  the head branch name is already known
  (`ensureChatShadowWorktreeAt`/`commitChatShadowEditsAt`) are split out
  specifically so they're testable offline against a throwaway local
  bare-repo-as-"origin" (`chat_shadow_test.go`, `t.Setenv("SLASH_REPO_DIR",
  ...)`) — no `gh`/network call at all.

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
     ordinary **`git merge origin/<headRef>`** in the conversation's own
     shadow. Non-overlapping edits (different files/regions) merge cleanly
     with **no AI involved at all** — by far the common case for "several
     conversations changed different things".
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
     `git commit --no-edit` + the push.
  4. **Bounded to exactly one merge/resolve attempt, no internal loop.** Any
     failure at any step — the merge command itself failing for a non-conflict
     reason, an unresolved conflict, a push that fails again after a
     successful resolve — **aborts the merge** (`git merge --abort`, so the
     shadow is left clean, never mid-conflict) and degrades to a
     reviewer-facing message. The reviewer's own next "commit" click enqueues
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
- **`pushAndReclaimChatShadow`** (`chat_shadow.go`) is the ONE place that ever
  pushes a chat shadow onto the real PR branch — extracted out of
  `commitChatShadowEditsAt`'s own tail so both the plain fast-forward path and
  chat_merge's merge/conflict-resolved path share it, instead of two copies of
  the same push+reclaim logic. `ingestMu`-guarded, same reasoning as
  `ensureChatShadowWorktreeAt`.
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

- **The system prompt (`modules/claude/prompts/chat.md`) states the "only on
  explicit request, never on your own initiative" rule directly next to the
  format**, mirroring how the `question` directive is introduced. This is a
  correctness aid, not the actual guard — see below for what really prevents
  misuse.
- **The conversation's own comment id is injected into the system prompt in
  Go** (`runOneClaudeTurn`, appended after `claude.ChatSystemPrompt`/
  `claude.ChatEditSystemPrompt`, both of which stay static embedded files) so
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
  function) is the only thing that signals anything, and only after every
  check passes, in order:
  1. **`directive.CommentID` must equal the conversation's own thread**
     (`arg.ConversationID`) — a chat has no context about any other comment of
     the PR, so a mismatch can only be a mistake/hallucination, never a
     legitimate cross-thread request. Never signalled; logged via `logf` and
     surfaced as a `KindError` turn.
  2. **The comment must still exist and not be `deleting`/`deleted`**
     (`comments.Module.Get`, a new read method — `WHERE id = ?`, mirrors
     `List`/`Search`'s shared `query`).
  3. **The target Execution must still be signallable**
     (`engine.Status(c.RunID)` not `completed`/`failed`) — a completed/failed
     run can never receive a Signal again; checked **before** signalling
     (mirrors the avatar-backfill glue's own `Status` check in
     `comment_import.go`) so the reviewer-facing message can name the real
     reason instead of a bare error.
  4. Only then: **the existing `reply` Signal** (`ReactionSignal{Source: "ai",
     Author: "Claude", Body, Done}` — `Done: true` + the `"/resolve"` sentinel
     body for `"resolve"`) via `TaskManager.Signal` — the exact same sanctioned
     write path an AI `code_warning` finding already uses, never a new one.
  A failed `Signal` call itself is also caught (best-effort, never a Go error
  that would fail the whole `claude_chat` workflow) and surfaced the same way.
- **Exactly one visible outcome turn is recorded either way**
  (`saveChatActionOutcome`): `Kind: chat.KindAction` with a `"✓ …"` confirmation
  text on success, `Kind: chat.KindError` with a concrete reason on any
  failure — so the reviewer always sees what happened, never an optimistic
  message that turns out wrong. `chat.KindAction` is a new `Message.Kind` value
  alongside `KindQuestion`/`KindError`.
- **No UI trigger yet for `chatActionEdit`/`chatActionCommit`** (unrelated to
  Phase 4) — the frontend panel only ever sends a plain (`Action: ""`) turn
  today; a later pass needs to add the composer action(s)/button(s) that set
  `action: "edit"` or `"commit"` on the `POST .../signals/message` call. The
  backend contract (this section) is ready for it.

### Endpoints

`POST /api/workflows/claude_chat {pr, commentId}` → `StartClaudeChat`
(validates `commentId` names an existing comment of `pr` before starting);
`POST /api/workflows/{runID}/signals/message {author, body, action?}` → the
generic signal route (the reviewer turn; `action` is `""`/`"edit"`/`"commit"`
and is validated in the handler before it ever reaches the workflow);
`GET /api/chat?commentId=X` → the read-only transcript;
`GET /api/chat/progress?commentId=X` → the in-memory snapshot of a running
turn, which is the resync read for the SSE stream `GET /api/events` pushes the
live progress over (`.claude/rules/server-events.md`). Full table:
`.claude/rules/tembed-endpoints.md`.

### Tests

`modules/chat/chat_test.go` (round-trip, question+answer on one row, per-PR
purge — all offline, no `claude`), `chat_workflow_test.go` (end-to-end via
`claude.Fake`: idempotent start, the reviewer/assistant turn cycle + session
id reuse, a question turn's answer landing on the same row, a failed turn
degrading to a `KindError` message, a valid `comment_action` reply/resolve
directive landing on the target thread's own `task_code_comment` Execution
with `Source: "ai"` plus a `KindAction` confirmation turn, a directive whose
`commentId` doesn't match the conversation being rejected without touching any
thread, a directive targeting a forced-`completed` Execution degrading to
`KindError`, and a malformed directive degrading to plain text),
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
