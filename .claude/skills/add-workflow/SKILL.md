---
name: add-workflow
description: Add a new durable task as a tembed Workflow (a Workflow Type) with its Activities and Signals, plus its POST /api/workflows/<type> endpoint. Use when adding a new long-lived, signal-driven task to slash (like task_code_comment). Enforces the workflows-only-write and determinism rules.
---

# Adding a new workflow (Workflow Type)

A slash **task** is a tembed **Workflow**. Terminology follows Temporal:
**Workflow Type** (the name), **Workflow Execution** (a running instance, with
a **Run ID**), **Activity** (side-effect work), **Signal** (external input).

**Read first** `.claude/rules/workflow-determinism.md` and
`.claude/rules/workflows-write-boundary.md` — those are binding.

## Steps

1. **Copy** `.claude/templates/workflow.go` as a starting point (new file or
   into `workflows.go`). Pick a snake_case **Workflow Type**, which is
   immediately the endpoint segment: `POST /api/workflows/<type>`.
2. **Define input/Signal payloads** as small JSON structs.
3. **Register Activities** on the engine (`engine.RegisterActivity("name", fn)`).
   An Activity is the **only** place a module may write or talk to the
   outside world. Best-effort side effects (e.g. `gh`) may fail without
   killing the workflow — catch the error and return a sentinel.
4. **Write the Workflow function** (`func(w *tembed.Workflow, in []byte)
   ([]byte, error)`): deterministic, all side effects via `w.ExecuteActivity`,
   external input via `w.WaitSignal`, time via `w.Now`/`w.Sleep`.
5. **Register** the workflow (`engine.RegisterWorkflow(type, fn)`), usually in
   a `NewXxxManager(engine, modules...)` that also wires the Activities.
6. **Endpoints** (`tasks_api.go`, see skill `add-api-endpoint` for the server
   conventions):
   - `POST /api/workflows/<type>` → `StartWorkflow` → `{ "runId": ... }`.
   - `POST /api/workflows/{runID}/signals/<signal>` → `SignalWorkflow` (UI write).
   - `GET /api/workflows/{runID}` and read-models are read-only.
7. **Bootstrap & recovery**: build the engine in `newTasks(...)`, call
   `engine.Recover()` at startup, and resume per-Execution background work
   (pollers) via `Runs()` + `Input()`.
8. **Poller/heartbeat** (optional): to periodically check something (e.g.
   GitHub every minute), do that **outside** the workflow in a goroutine that
   feeds new facts in as a **Signal** — not with a busy loop **inside** the
   workflow.
9. **Test** (`*_test.go`): use `tembed.NewMemoryStore()` + a module fake,
   shrink poll intervals, and cover at least one replay/restart path
   (`engine.Recover()` must never re-run an Activity).

## Hard rules

- Workflow body deterministic (see `workflow-determinism.md`).
- Only workflows/Activities write (see `workflows-write-boundary.md`).
- No new dependency without discussion; SQLite = `modernc.org/sqlite`.
- Restart the server after a backend change (Go has no hot reload).
