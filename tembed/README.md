# tembed

**Temporal, embedded.** A tiny, dependency-light durable-workflow engine you
link into your Go program — no server, no cluster. You write workflows and
activities as plain Go functions; tembed persists an append-only event history
per run and **replays it deterministically**, so a workflow survives a process
restart and never re-runs an activity whose result is already recorded.

This package is abstract and reusable — it knows nothing about any particular
application. (It is developed inside the `slash` repo as a git subtree and can be
pulled into any Go project as its own module: `github.com/reindert-vetter/tembed`.)

## Install

```sh
go get github.com/reindert-vetter/tembed
```

## Features

- **Workflows & activities** as Go functions. Activities run once; their result
  is recorded and replayed.
- **Signals** — deliver external events into a running workflow
  (`SignalWorkflow` / `w.WaitSignal`). Signals are buffered: one that arrives
  before the workflow asks for it waits until it does.
- **Durable timers** — `w.Sleep(d)` records an absolute fire time and is
  rescheduled on recovery.
- **Side effects** — `w.SideEffect` / `w.Now` capture non-deterministic values
  (time, random) so replays reuse them.
- **Pluggable storage** — `MemoryStore` (tests), `JSONLStore` (one
  human-readable file per run), `SQLiteStore` (pure-Go `modernc.org/sqlite`,
  no cgo), and `MultiStore` to combine them (e.g. SQLite for queries + JSONL as
  an audit trail).
- **Crash recovery** — `engine.Recover()` re-drives every run that was mid-flight.

The only runtime dependency is `modernc.org/sqlite` (and only if you use the
SQLite store).

## How it works

Each run has an append-only history of events (`WorkflowStarted`,
`ActivityCompleted`, `SignalReceived`, `TimerStarted/Fired`, …). To make
progress, the engine **re-runs the workflow function from the top** against the
current history:

- an `ExecuteActivity` call whose result is already in history returns the
  recorded value; otherwise the activity runs *now* and the result is appended;
- a `WaitSignal` whose signal is in history returns it; otherwise the run
  *yields* (panics with an internal sentinel), is persisted as `waiting`, and is
  re-driven when the signal or timer arrives.

Because all non-determinism flows through the `*Workflow` handle, replay
reproduces exactly the same decisions. **Workflow code must be deterministic**
(no wall-clock `time.Now()`, no `map` iteration that affects control flow, no
direct I/O — use activities and `SideEffect`).

## Quick start

```go
store, _ := tembed.NewSQLiteStore("data/tembed.db")
engine := tembed.New(store)

engine.RegisterActivity("greet", func(ctx context.Context, in []byte) ([]byte, error) {
    var name string
    _ = json.Unmarshal(in, &name)
    return json.Marshal("hi " + name)
})

engine.RegisterWorkflow("hello", func(w *tembed.Workflow, input []byte) ([]byte, error) {
    var msg string
    if err := w.ExecuteActivity("greet", "Reindert", &msg); err != nil {
        return nil, err
    }
    var reply string
    w.WaitSignal("reply", &reply) // durably blocks until signalled
    return json.Marshal(msg + " / " + reply)
})

id, _ := engine.StartWorkflow("hello", nil) // runs greet, then waits
engine.SignalWorkflow(id, "reply", "thanks!")

var out string
_ = engine.Result(id, &out)
```

On startup, call `engine.Recover()` to resume any runs that were `running` or
`waiting` when the process stopped.

## Durable timers

`w.Sleep(d)` durably pauses a workflow: the fire time is recorded in history, so
the timer survives a restart and fires exactly once (`engine.Wait()` blocks
until any in-flight timer callbacks — e.g. before a test asserts the result —
have completed):

```go
engine.RegisterWorkflow("nap", func(w *tembed.Workflow, _ []byte) ([]byte, error) {
    w.Sleep(20 * time.Millisecond)
    return json.Marshal("awake")
})

id, _ := engine.StartWorkflow("nap", nil) // returns immediately, status "waiting"
engine.Wait()                             // let the timer fire

var got string
_ = engine.Result(id, &got) // "awake"
```

## Choosing a store

```go
// In-memory — tests and ephemeral runs, nothing survives a restart.
store := tembed.NewMemoryStore()

// JSONL — one human-readable file per run under dir.
store, err := tembed.NewJSONLStore("data/workflows")

// SQLite — pure-Go (modernc.org/sqlite), no cgo, one DB file.
store, err := tembed.NewSQLiteStore("data/workflows.db")
// or reuse an existing *sql.DB:
store, err := tembed.NewSQLiteStoreDB(db)

// Combine them: SQLite for querying + JSONL as a plain-text audit trail.
// This is exactly how slash wires its engine (tasks_api.go):
sq, _ := tembed.NewSQLiteStore(dataDir + "/workflows.db")
jl, _ := tembed.NewJSONLStore(dataDir + "/workflows")
engine := tembed.New(tembed.NewMultiStore(sq, jl))
```

`MultiStore` writes every event to all wrapped stores and reads from the first
(the primary).

## Status & limitations

Intentionally minimal. No activity retries/heartbeats, no queries, no
child-workflows, single-process (advances are serialised per run). Good enough
for embedding a handful of long-lived, signal-driven workflows into an app.
