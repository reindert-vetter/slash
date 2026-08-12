# HTTP endpoints around the workflow engine

Companion to `.claude/docs/tembed-workflows.md` (what each workflow *does*);
this file is the endpoint surface. The hard rule from
`.claude/rules/workflows-write-boundary.md` shapes it: **writing is only
possible by starting an Execution or sending a Signal** — every other endpoint
is a `GET` over a read model.

Handlers live in `tasks_api.go` (workflow + read models) and `api.go`
(blocks/code/ingest). Page routes and the inbox/overview endpoints are in
`.claude/docs/pages-and-routing.md`.

## Starting an Execution (the write path)

One handler per Workflow Type, all `POST /api/workflows/<type>`. A **long-lived
tracker** (pr_status, approve, task_snooze, task_inbox) is *ensured*: the
handler reuses the existing Execution for that PR/repo and returns its Run ID,
which the UI then signals. A **one-shot** type runs synchronously to completion
(no `WaitSignal` in its body) and returns its result or an error.

| Endpoint | Body | Kind | Notes |
|---|---|---|---|
| `/api/workflows/task_code_comment` | `CodeCommentInput` | one per comment | Run ID == the comment id. |
| `/api/workflows/pr_status` | `{pr}` | tracker | Returns as soon as stage 1 (basics) is recorded — the summary/statuses drain in the background (`StartWorkflowDeferLow`). |
| `/api/workflows/approve` | `{pr}` | tracker | Returns `runId`; the UI signals `set`. |
| `/api/workflows/task_snooze` | — | tracker (per repo) | Returns `runId`; the UI signals `snooze`. |
| `/api/workflows/ignore_comment` | `{pr}` | tracker (per PR) | Returns `runId`; the UI signals `ignore`. Per PR, not per repo, so `cleanup`'s `Purge` sweeps it. |
| `/api/workflows/task_inbox` | — | tracker (per repo) | Only re-ensures when no Run ID exists yet (ensuring spawns a poller goroutine). |
| `/api/workflows/resolve_call` | `{pr, callerId, callerFile, callerClass, callerName, calls}` | one-shot | Idempotent Run ID per request. |
| `/api/workflows/resolve_test_covers` | `{pr, testId, testFile, testClass, testName, classes}` | one-shot | |
| `/api/workflows/explain_code` | `{pr, blockId, file, label, gran, unitKey, codeHash, code, context}` | one-shot | Idempotent Run ID (`explainRunID`). |
| `/api/workflows/code_warning` | `{pr}` | one-shot | Manual "Diepgravend onderzoek"; re-running supersedes. |
| `/api/workflows/submit_review` | `{pr, event, body}` | one-shot | 400 on invalid input *before* any `gh` call (`validateSubmitReview`; a `REQUEST_CHANGES` needs a body), 502 if the submit itself fails. |
| `/api/workflows/ready_for_review` | `{pr, reviewers?}` | one-shot | 400 on a non-positive pr or invalid login (`validateReadyForReview`, which also trims+dedups). |
| `/api/workflows/remove_reviewer` | `{pr}` | one-shot | Drops **me** from that PR's requested reviewers. The request carries no login — the Activity resolves the authenticated user itself, so it can never remove somebody else. 400 on a non-positive pr. |
| `/api/workflows/cleanup` | — | one-shot | Never accepts a body: the retention cutoff is always server-side. Force-purging specific PRs is CLI-only (`slash cleanup -force`). |
| `/api/workflows/claude_chat` | `{pr, commentId}` | tracker (per comment thread) | Returns `runId` (`"chat-" + commentId`, deterministic — no in-memory map needed); the UI signals `message`. 400 if `commentId` doesn't name an existing comment of `pr`. Started as a **child** of that comment's `task_code_comment` run (via its `"chat"` Action Signal), with a top-level fallback for a thread that already ended — see "claude_chat" in `.claude/docs/workflows-comments.md`. |
| `/api/workflows/comment_batch` | `{pr, commentIds}` | one-shot | "Laat Claude alle openstaande comments verwerken": ONE agentic Opus run over those comments, landing its edits through the `chat_merge` queue. 400 when an id doesn't name an eligible (open, non-AI) comment of `pr`, **409 while a batch is already running for that PR** (both runs would edit the same shadow worktree). Progress is volatile only — see the read below and "comment_batch" in `.claude/docs/workflows-comments.md`. |
| `/api/ingest` | `{pr}` | one-shot | Starts the `ingest` workflow and then `EnsureRelations`; 200 only once both finished. See `.claude/docs/blocks-and-ingest.md`. |

**Adding a signal-less type also means adding its name to the reserved-name
guard** in `handleWorkflows` (`tasks_api.go`) — that handler owns
`/api/workflows/`, so without the guard `/api/workflows/<newtype>` would be
parsed as a Run ID.

**`chat_merge` deliberately has NO endpoint here.** It is a per-PR tracker
(`WorkflowChatMerge`) like the others in this table, but it is never
started/signalled from the UI or any HTTP handler — only from
*inside* the `claude_chat` workflow's own `chatActionCommit` Activity
(`enqueueChatMerge`, `chat_merge.go`), the same cross-workflow Ensure+Signal
shape `reanchorAfterRefresh` uses for the `approve` tracker. See "Serializing
concurrent commits (`chat_merge`)" in `.claude/docs/workflows-comments.md`.

## Signals

All through one generic route, `POST /api/workflows/{runID}/signals/<name>`.
A workflow can only `WaitSignal` on one name at a time, so several distinct
requests deliberately ride along **as variants of one signal payload** rather
than as their own signal names.

| Signal | Payload | Target | Variants riding along |
|---|---|---|---|
| `reply` | `{author, body, done, action?, targetId?, publish?}` | `task_code_comment` | `body == "/resolve"` + `done` = resolve (never posted as text); `action: "unresolve"` = reopen that resolved thread (no body — the workflow writes the `"/reopen"` trace itself, see "Resolve is reversible" in `.claude/docs/workflows-comments.md`); `action: "edit"`/`"publish"` = the two other message-less variants. The handler validates `action` before it reaches the workflow. |
| `delete` | `{author?}` | `task_code_comment` | Handler builds a `ReactionSignal{Action:"delete"}` — i.e. it *is* the reply signal underneath. |
| `set` | `ApprovalSignal{blockId, rows, calls}` | `approve` | `{file, viewed}` instead = GitHub "Viewed" checkbox (`Viewed != nil`). |
| `snooze` | `{taskId, until}` or `{taskId, clear}` | `task_snooze` | `until` is an absolute ms expiry computed client-side (keeps the workflow clock-free). |
| `ignore` | `{commentId, ignored}` | `ignore_comment` | A plain on/off flag — deliberately no expiry, unlike `snooze`. |
| `refresh` | — | `pr_inbox` / `task_inbox` | |
| `rebuild` | — | `build_relations` | |
| `message` | `{author, body, action?}` | `claude_chat` | One reviewer turn; `id` is generated by the handler (`"msg-" + newUIReactionID()`), mirroring `ReactionSignal.ID`. `action` (validated by the handler before it ever reaches the workflow): `""` a plain read-only turn, `"edit"` lets Claude use its Edit tool against the conversation's own shadow worktree, `"commit"` lands that shadow's edits, fast-forward-only, on the PR's LOCAL pending ref (no `body` needed for `"commit"`; the push to GitHub is the separate `merge`/`"push"` request below — see `.claude/docs/pending-push.md`). See "claude_chat" in `.claude/docs/workflows-comments.md`. |
| `merge` | `ChatMergeRequest{conversationId?, turnId?, action?}` | `chat_merge` | The PR's own commit queue. `action` `""` = land one conversation's edit (only ever sent from inside `claudeChatWorkflow`'s Activity, never from the UI); `action: "push"` = push the PR's pending ref to GitHub, carries no conversation and comes straight from the reviewer's todo row (`pushPendingWork`, `src/home.mjs`). See `.claude/docs/pending-push.md`. |

**Not reachable from the UI, by design:** the `reanchor` and `avatar` actions
on `ReactionSignal` — the generic reply handler only accepts the `action`
values in its own switch (`""`/`edit`/`publish`/`unresolve`) and never decodes
`anchor`, so only a backend Activity can move a comment's anchor. A Playwright spec therefore can't drive that state
through the API; use `slash seed -comments <json>`.

`state` (pr_status) has no endpoint at all — it comes from the pollers only.

## Operational (stateless, allowed outside a workflow)

| Endpoint | Does |
|---|---|
| `POST /api/workflows/{runID}/heartbeat` | Marks a run as actively viewed → fast poll cadence. In-memory only, lost on restart. |
| `GET /api/ingest/progress?pr=N` | In-memory ingest stage (`worktrees`/`scan`/`relations`) for the generate button. |
| `GET /api/chat/progress?commentId=X` | In-memory snapshot of a RUNNING `claude_chat` turn (phase/tool/partial answer). The resync read for the stream below, not a poll target. |
| `GET /api/comment-batch?pr=N` | In-memory per-comment state of that PR's `comment_batch` run (`open`/`busy`/`done`/`skipped` + the running phase/tool). The resync read for the stream below. Deliberately kept after the run finished — the run leaves no durable per-comment trace — but dropped on restart. |
| `GET /api/events?pr=N` | The one multiplexed SSE stream per browser tab (`eventbus.go`). Pushes volatile notifications only; every consumer refetches its ordinary `GET` on (re)connect. See `.claude/docs/server-events.md`. |

Both are carve-outs from the write boundary because they touch nothing durable
— see `.claude/rules/workflows-write-boundary.md`.

## Read models

| Endpoint | Reads |
|---|---|
| `GET /api/workflows/{runID}` | Run status. |
| `GET /api/workflows?pr=N` | **All** runs of that PR (no trailing slash, so a different pattern than `/api/workflows/`): `RunsForPR` filters `engine.Runs()` on the `pr` field of each run's stored input — a per-repo tracker has no such field and therefore never appears. Newest-updated first. A `task_code_comment` run also carries a `comment` ref (`{file,label,gran,line,rowStart,rowEnd,snippet}`, parsed back out of its own immutable input) and a `code_warning` run a `warningsFound` count (from its stored result). Feeds the "Taken" card. |
| `GET /api/comments?pr=N` \| `?path=<prefix>` | Comments + reactions; the `path` form is the hierarchical prefix search (see `.claude/docs/tembed-workflows.md`). |
| `GET /api/approvals?pr=N` | Approved rows/call segments per block. |
| `GET /api/relations?pr=N` | Parent→child block relations. |
| `GET /api/callresolve?pr=N` | Resolved/searching call targets incl. their embedded code. |
| `GET /api/testcovers?pr=N` | Test↔method coverage rows. |
| `GET /api/explanations?pr=N` | Footer AI descriptions. |
| `GET /api/pr?pr=N` | `prmeta` (title/url/body/author/diffstat/headRef/summary/jira*/reviewDecision/checks*/reviewers). `{ok:false}` until stage 1 ran; a field of a not-yet-run stage is at its zero value. |
| `GET /api/tasks` | Task-inbox read model. |
| `GET /api/tasksnoozes` | `{taskId, until}` — expiry is checked client-side, `List` does not filter. |
| `GET /api/commentignores?pr=N` | `{ok, ignored}` — the ids of the PR-wide comments hidden from the block index. |
| `GET /api/chat?commentId=X` | The `claude_chat` transcript for the conversation hanging off that comment thread (`pr` isn't needed — the comment id already scopes it). |
| `GET /api/chat?pr=N` | Same handler, PR-wide variant: `{ok, conversations}` — only the ids of the PR's conversations that actually have turns, no bodies. One request per PR answers "does this unit already have a Claude conversation", which decides whether the chat column exists at all (see `.claude/docs/claude-chat-panel.md`). |
| `GET /api/chat/shadow-status?pr=N&commentId=X` | `{ok, exists, dirty, ahead}` — whether a conversation's agentic-edit shadow worktree has pending (uncommitted/locally-unpushed) work, purely local git plumbing (no fetch/gh). The check "Wis Claude-gesprek" runs before warning the reviewer it would discard that work (see `.claude/docs/workflows-comments.md`'s "Wis gesprek" section). |
| `GET /api/pending-push?prs=N[,N…]` | `{ok, pending}` — per PR the landed-but-unpushed chat edits: `{headRef, sha, ahead, files, state, pushRunId, error}`. Purely local git reads (`for-each-ref`/`rev-list`/`diff`), no fetch, no `gh`; `state` (`ready`/`pushing`/`failed`) is volatile/in-memory, git is the durable truth. Batch-shaped because the PR overview asks for several rows at once. See `.claude/docs/pending-push.md`. |
| `GET /api/problems` | `{failedRuns, logErrors}` — failed runs (repo-wide) + mirrored glue log lines. |
| `GET /api/me` | The authenticated GitHub user (`gh api user`, cached for the process lifetime). |
| `GET /api/names?logins=a,b` | Login → real name + avatar. See `.claude/docs/pages-and-routing.md`. |
| `GET /api/reviewers` | Collaborators sorted most-used-first. |
| `GET /api/inbox`, `/api/inbox/status`, `/api/prs*` | See `.claude/docs/pages-and-routing.md`. |
| `GET /api/blocks`, `/api/code`, `/api/blockstats`, `/api/approvalsummary`, `/api/langsiblings` | See `.claude/docs/blocks-and-ingest.md`. |
