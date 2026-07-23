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
