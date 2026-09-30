# Tembed: durable workflows (`tembed/`)

The engine itself — the replay model, storage, recovery, and the hard rule that
only workflows write. What each individual workflow *does* lives in the three
files indexed at the bottom; how each is *reached* (endpoints, signals, read
models) lives in `.claude/docs/tembed-endpoints.md`.

`tembed/` is an **embeddable durable-workflow engine** — "Temporal, but a Go
package". It lives as a **git subtree** (prefix `tembed/`) and is at the same
time its own module (`github.com/reindert-vetter/tembed`), so other projects can
import it standalone. **`tembed/` is deliberately abstract** — it knows nothing
about PRs, blocks, or gh; keep it that way.

## Core

- **Subtree flow:** `git subtree add --prefix=tembed <url> main --squash`, push
  back with `git subtree push`, update with `git subtree pull`. slash imports it
  via a `replace … => ./tembed` in `go.mod`.
- **Replay:** append-only event history per run; the workflow function is re-run
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
- **`Engine.ResumeFailed(runID)`** restarts a **failed** run from the last step
  that actually succeeded — the only way a terminal run ever moves again. It
  cuts the run's **failure tail** (the terminal `WorkflowFailed` plus the
  contiguous `ActivityFailed`/`AsyncActivityFailed`/`ChildWorkflowFailed` events
  right before it, `failureTailStart`) off the history, sets the run back to
  `running`, relaunches any async activity whose result was cut away (the same
  `resumePendingAsync` pass `Recover` uses) and advances. Necessary because a
  plain replay would read the *recorded* activity failure straight back out of
  the history and fail identically, having re-executed nothing. Every surviving
  event keeps its seq, so the history stays a prefix of what it was and every
  recorded result is reused — only the failed step runs live again, so it must
  be idempotent. Refuses an unknown run, a run that is not `failed`, an
  unregistered Workflow Type, and a history with no failure tail. Backs
  slash's `POST /api/workflows/retry`/`retry-all`; the suffix cut itself is
  `Store.TruncateEvents`, the ONE method that removes events from a live run
  (implemented in all four stores; the JSONL one rewrites its events file via
  temp+rename, the single place that store is not append-only). Test:
  `TestResumeFailedContinuesFromLastGoodStep`.
- **`Engine.ResumeFailedInBackground(runIDs)`** is the same resume split in
  two: the validate/cut/`running` half runs synchronously per run (a refused
  one comes back in the per-ID error map), the drive happens afterwards in ONE
  `e.wg`-tracked goroutine, **serially**. This is what slash's retry endpoints
  actually call. Why: the plain `ResumeFailed` drove the failed step inline,
  and for a `resolve_call` that step is an LLM call behind the process-wide
  four-slot `resolveCallSemaphore`. Right after a restart `Recover` has
  hundreds of those runs queued on the same pool, so "Alles opnieuw proberen"
  sat on "Bezig met opnieuw proberen…" for as long as that whole backlog took.
  Serial rather than all at once, because a burst is the SQLITE_BUSY storm that
  caused most of these failures in the first place. Test:
  `TestResumeFailedInBackgroundReturnsBeforeTheStep`.
- **Storage** via `Store`: `MemoryStore`, `JSONLStore` (one readable file per
  run), `SQLiteStore` (pure-Go `modernc.org/sqlite`), and `MultiStore` to
  combine them. slash runs `MultiStore(SQLite data/workflows.db, JSONL
  data/workflows/)`, so a comment lives both in history and as jsonl.
- **Recovery:** `engine.Recover()` at startup re-drives every
  `running`/`waiting` run — **prioritised**, see below.
- **Start is two writes, repaired on the next request:** `startWorkflowID` does
  `CreateRun` then `AppendEvent(WorkflowStarted)`, not transactionally. If the
  second fails the run has no input; a repeat `StartWorkflowID` with the same
  (deterministic) ID now truncates that history and rewrites the start event
  instead of reusing it. `advanceLoaded` fails such a run with "has no start
  input" (never nil input -> JSON error), and retry reports the same reason.
- Tests: `tembed/*_test.go`.

## Recovery priority (don't let slow LLM work block startup)

`advance()` runs an activity **inline** when its result isn't in history, and
`Recover()` re-drives every mid-flight run at startup. So a run killed
**mid-activity** re-executes that activity live on recovery — and for the LLM
workflows (`resolve_call` makes one `claude` call per unresolved call;
`code_warning` a whole agentic Opus pass) that is dozens of ~30s subprocess
calls, serially, on the startup goroutine *before* `ListenAndServe`. That once
wedged the server entirely. Hence a **priority** mechanism (still abstract — it
knows nothing about LLMs):
- **Start is two writes, repaired on the next request:** `startWorkflowID` does
  `CreateRun` then `AppendEvent(WorkflowStarted)`, not transactionally. If the
  second fails the run has no input; a repeat `StartWorkflowID` with the same
  (deterministic) ID now truncates that history and rewrites the start event
  instead of reusing it. `advanceLoaded` fails such a run with "has no start
  input" (never nil input -> JSON error), and retry reports the same reason.

- **`Priority`** — Low/Normal/High. Affects **only** recovery; live
  `StartWorkflow`/`SignalWorkflow` are unaffected.
- **`SetWorkflowPriority(name, p)`** — Normal/High runs are re-driven
  synchronously (High first); **Low** runs drain on a **single** background
  goroutine (serially, to avoid a herd of subprocess calls), covered by `Wait()`.
  slash marks the pure-LLM types Low: `resolve_call`, `resolve_test_covers`,
  `explain_code`, `code_warning`, plus `claude_chat` (every turn is a real
  `claude` subprocess call) and `chat_merge` (its Activity can run one on a
  conflict).
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

## Split out of this file: which workflow lives where

| Workflow Type | Documented in |
|---|---|
| `task_code_comment` (+ GitHub comment import) | `.claude/docs/workflows-comments.md` |
| `claude_chat` (embedded Claude conversation panel) | `.claude/docs/workflows-comments.md` |
| `chat_merge` (serializes concurrent "commit deze wijziging" pushes per PR) | `.claude/docs/workflows-comments.md` |
| `chat_steer` (hands a message to the turn that is running RIGHT NOW) | `.claude/docs/claude-chat-panel.md` |
| `build_relations` | `.claude/docs/workflows-analysis.md` |
| `resolve_call` | `.claude/docs/workflows-analysis.md` |
| `resolve_test_covers` | `.claude/docs/workflows-analysis.md` |
| `explain_code` | `.claude/docs/workflows-analysis.md` |
| `code_warning` | `.claude/docs/workflows-analysis.md` |
| `pr_status` (metadata, merge detection, ingest refresh, re-anchor pass) | `.claude/docs/workflows-trackers.md` |
| `pr_inbox` | `.claude/docs/workflows-trackers.md` |
| `approve` | `.claude/docs/workflows-trackers.md` |
| `ignore_comment` | `.claude/docs/workflows-trackers.md` |
| `ingest` | `.claude/docs/workflows-trackers.md` |
| `submit_review` | `.claude/docs/workflows-trackers.md` |
| `ready_for_review` | `.claude/docs/workflows-trackers.md` |
| `remove_reviewer` | `.claude/docs/workflows-trackers.md` |
| `cleanup` | `.claude/docs/workflows-trackers.md` |
| `ignore_runs` (delete the failures the reviewer chose to ignore) | `.claude/docs/tembed-endpoints.md` |

Also in `.claude/docs/workflows-trackers.md`: "Surfacing failures"
(`run_errors.go` + `GET /api/problems`) — how a best-effort Activity's silent
failure still reaches the UI.

The shared CLI-bridge modules are documented where they are first driven:
`modules/comments`/`modules/github`/`modules/jira` in `workflows-comments.md`,
`modules/claude` in `workflows-analysis.md`.
