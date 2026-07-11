# tembed

**Temporal, embedded.** A tiny, dependency-light durable-workflow engine you
link into your Go program — no server, no cluster. You write workflows and
activities as plain Go functions; tembed persists an append-only event history
per run and **replays it deterministically**, so a workflow survives a process
restart and never re-runs an activity whose result is already recorded.

This package is abstract and reusable — it knows nothing about any particular
application. (It is developed inside the `slash` repo as a git subtree and can be
pulled into any Go project as its own module: `github.com/reindert-vetter/tembed`.)

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

## Status & limitations

Intentionally minimal. No activity retries/heartbeats, no queries, no
child-workflows, single-process (advances are serialised per run). Good enough
for embedding a handful of long-lived, signal-driven workflows into an app.
