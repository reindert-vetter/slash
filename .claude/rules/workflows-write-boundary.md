# Rule: only workflows mutate state

**Workflows are the only writers.** Every state change goes through a
tembed **Workflow Execution**. Everything else is **read-only from the
outside**.

This is a hard architecture rule for slash, not a suggestion.

## What is allowed to write

- **Workflow definitions** (`workflows.go`, Workflow Type `task_code_comment`, …).
- **Activities** driven by such a workflow — this is the **only** place where
  a **module** executes its write methods.

## What is read-only

- **Modules** (`modules/*`): their write methods (`Save`, `AddReaction`,
  `PostLineComment`, …) are called **exclusively** from a workflow Activity —
  never directly from an HTTP handler, CLI, or the UI. Their **read**
  methods (`List`, …) may be called from anywhere.
- **HTTP API**: writing is only possible via workflow endpoints — **starting**
  an Execution (`POST /api/workflows/<type>`) or sending a **Signal**
  (`POST /api/workflows/{runID}/signals/<signal>`). Every other endpoint is
  `GET` and read-only.
- **UI**: reads read-models (`GET /api/comments`, `GET /api/workflows/...`)
  and can only change state by starting or signaling a workflow. The UI never
  writes directly to a table or module.

## Exception: operational pings without state

An endpoint that mutates **no state** falls outside this rule, even if it's a
`POST`. Concretely: `POST /api/workflows/{runID}/heartbeat` only sets an
in-memory timestamp in the `TaskManager` (poll cadence), writes nothing to the
event history, a module, or a table, and doesn't survive a restart (it's
purely operational). Such a ping may therefore come directly from the UI.
**Not sure?** Does it touch anything durable (history/read-model/DB) → then
it must go through a workflow (start/signal); doesn't touch anything → then
it's allowed.

Second example: `GET /api/ingest/progress?pr=N` (`ingest_progress.go`) reads a
purely in-memory `map[int]string` (pr → current ingest stage: `worktrees`/
`scan`/`relations`) that the `prepareWorktrees`/`scanAndStoreBlocks`/
`buildRelations` Activities (`workflows.go`) update while they run. No
module, no read-model, no workflow-history write — purely cosmetic progress
for the "Generate review tree"/"Regenerate" button (`src/overview.mjs`,
polled while `POST /api/ingest` is in flight) and is lost on a restart, just
like the heartbeat timing.

Third example: the event bus behind `GET /api/events` (`eventbus.go`) and the
running-turn snapshot behind `GET /api/chat/progress` (`chat_progress.go`) —
an in-memory hub plus a per-conversation map that carry "what is happening
right now" to the browser. No module, no read-model, no workflow-history
write, and both are empty again after a restart. Safe **because an event is
never the source of truth**: a consumer treats it as "refetch me" and re-reads
the ordinary read-only `GET` on every (re)connect, so a dropped event costs a
refetch, never correctness. See `.claude/docs/server-events.md`.

Fourth example: the failure buffer behind `GET /api/problems`
(`run_errors.go`) — an in-memory ring buffer that mirrors the glue log lines
(`TaskManager.logf`, the tembed engine's own logger) so a poller/startup error
reaches the UI instead of only the terminal. No module, no read-model, no
workflow-history write, and it resets on a restart. The other half of that same
endpoint — the failed **workflow runs** — is a plain read of the tembed store,
so it needs no carve-out at all. Making either of them durable would have to go
through a workflow.

Fourth example: the **event bus** behind `GET /api/events` (`eventbus.go`) and
the in-memory progress snapshot of a running Claude chat turn
(`chat_progress.go`, read via `GET /api/chat/progress`). An Activity publishes
into the hub while it runs, but nothing is stored: no module, no read model, no
workflow history, and the hub is empty again after a restart. That is exactly
why an event may never be the source of truth — every consumer refetches the
ordinary read-only `GET` — see `.claude/docs/server-events.md`.

Fifth example: the in-memory pending-push status behind
`GET /api/pending-push` (`pending_push.go`, `pendingPushStatus`) — a
`map[int]…` saying "a push is running right now" / "the last one failed,
because …". No module, no read-model, no workflow-history write, and empty
again after a restart. Safe because it is not the source of truth about
anything: git is — the PR's pending ref either still exists (not pushed) or it
doesn't, and the handler reads that live. The push itself is a real write and
goes through the `chat_merge` queue's `"push"` Signal, never through this
handler. See `.claude/docs/pending-push.md`.

Sixth example: the per-comment batch progress behind `GET /api/comment-batch`
(`comment_batch_progress.go`) — an in-memory `map[int]…` saying which comment the
one `comment_batch` agent is working on and which ones it already handled. No
module, no read-model, no workflow-history write, and empty again after a
restart. Safe because it is not the source of truth about anything: the run only
edits code (it never replies to or resolves a thread), so the durable state is
the comments themselves plus the landed pending ref. It is deliberately KEPT
after the run finished — see "comment_batch" in
`.claude/docs/workflows-comments.md`.

Seventh example: `POST /api/chat/cancel` (`chat_cancel.go`, `handleChatCancel`
in `tasks_api.go`) — stopping the ONE running `claude_chat` turn right now.
This could NOT be a Signal in the first place: `Engine.SignalWorkflow`
(`tembed/engine.go`) takes the run's own lock and drives the whole turn
**inline**, so a Signal aimed at the SAME run would simply block for exactly
as long as the turn it is trying to interrupt. The endpoint instead calls an
in-memory `map[conversationID]context.CancelFunc` (`chatCancelByConv`) —
registered by `runOneClaudeTurn` for the lifetime of its own Activity,
cancelling only a child context used for the turn's OUTBOUND work (the claude
CLI subprocess, the write-turn-slot wait, the git/gh checkout prep), never the
Activity's ability to persist a message. No module, no read-model, no
workflow-history write, and empty again after a restart — the same shape as
`chatProgressByConv` right above. Safe because it is not the source of truth
about anything: the durable outcome of a cancel is the ordinary
`chat.KindCancelled` message the Activity itself saves once its context
actually cancels — exactly like any other terminal turn result, written the
usual way, through the workflow's own Activity, not through this endpoint.
See "Cancelling a running turn" in `.claude/docs/claude-chat-panel.md`.

Eighth example: `GET /api/auth/status` (`auth_status.go`) — "is `gh`/`acli`
still logged in, and is the Jira API token still accepted?". It runs two
read-only status commands plus one minimal feed call and keeps the verdict in
one in-memory struct with a 60s TTL (`?refresh=1` bypasses it). No module, no
read-model, no workflow-history write, and empty again after a restart. Safe
because it is not the source of truth about anything: the CLIs' own credential
stores are, and this only reports what they answer right now. The FIX is a real
write and goes the sanctioned way — the settings page signals the `app_settings`
tracker (Kind `"jiraCreds"`), whose Activity writes `.env`.

## Exception: the Claude chat turn may act through a shell

Deliberately granted by Reindert, overriding the rule above for this one path.
A `claude_chat` turn (`runOneClaudeTurn`, `chat_workflow.go`) may run with
`Read/Grep/Glob/Edit` **plus `Bash`**, in the conversation's own shadow
worktree (`chat_shadow.go`) — so Claude can run `git`, `gh` and `acli` itself
when the reviewer asks for it in the message, instead of the reviewer clicking
a dedicated button.

What this deliberately gives up, recorded here so nobody "fixes" it back by
accident:

- A `gh`/`acli` write from inside the turn bypasses `modules/github` and its
  bookkeeping (`github_id` dedup, the comment↔runID link), so such a write
  updates no module read-model and cannot be replayed from one.
- The turn's Activity is one history step, but the number and kind of external
  side effects inside it are not individually recorded — unlike every other
  write path, where each external write is its own idempotent Activity.
- No confirmation is left before a real push. The only gate is Claude's reading
  of the typed message; the git-level guarantees in `chat_merge.go`
  (fast-forward only, never force, `merge --abort` on conflict) still hold.

This carve-out covers **only** the chat turn. Everywhere else the rule stands
unchanged: no module write outside a workflow Activity, no direct write from an
HTTP handler or the UI.

## Why

The workflow event history is the **source of truth**: durable, replayable,
survives a restart, and records the order of decisions. A module table
(e.g. `comments.db`) is a **derived read-model** that an Activity updates. By
bundling writes into workflows you keep a single auditable source and can
replay behavior deterministically.

## Review checklist

- Does an HTTP handler call a module write? → **wrong**, route it through a
  workflow (start/signal) instead.
- Does the UI/JS write directly anywhere (other than a start/signal POST, or
  a stateless operational ping like `heartbeat`)? → **wrong**.
- Is there new mutation logic outside a workflow/Activity? → move it.

See also `workflow-determinism.md`.
