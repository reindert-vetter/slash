---
name: add-module
description: Add a new module/service under modules/ that a workflow can drive as an Activity (like comments or github) — its own storage/behaviour, write methods for workflows only, read methods for the UI. Use when a workflow needs a new capability (a new store, an external system, a side effect).
---

# Adding a new module (`modules/<name>`)

A **module** is "a thing that can happen inside a workflow": a capability
with its own storage and/or external communication. `modules/comments` (own
SQLite read-model) and `modules/github` (talks to `gh`) are the examples.

**Read first** `.claude/rules/workflows-write-boundary.md`: a module is
called **only** by workflow Activities to write; read methods may be called
by the UI/API.

## Steps

1. **Copy** `.claude/templates/module.go` to `modules/<name>/<name>.go`,
   `package <name>`. Module path becomes `slash/modules/<name>`.
2. **Own storage**: a module owns its own state. For SQLite: its own
   `data/<name>.db` + schema constant, opened with `Open(path)` (or `New(db)`
   to share an existing `*sql.DB`). Driver = `modernc.org/sqlite`.
3. **Split the API** clearly:
   - **Write** (workflow-only): `Save`, `Add…`, `Post…` — mutate state or talk
     to the outside world. Make idempotent where possible
     (`INSERT OR IGNORE`/`REPLACE`) so replay is safe.
   - **Read** (UI/API): `List`, `Get` — pure reads.
   "Do your own thing" belongs in the write methods (updating derived fields,
   making an external call), not in the workflow.
4. **Interface + fake**: export a `Client` interface for the behavior and a
   `Fake` (in-memory) so workflows/tests can inject the module without
   network or DB. See `modules/github` (`Client` + `Fake`).
5. **Wiring**: the module gets wrapped as an Activity in
   `NewXxxManager(...)` (`engine.RegisterActivity(...)`) and opened + `Close`d
   in `newTasks(...)`.
6. **No import cycle**: modules don't import `package main`. Sharing a type
   with the workflow? Define it in the module and let `main` import it.

## Hard rules

- Module writes only from a workflow Activity (write-boundary rule).
- No new runtime dependency without discussion; SQLite = `modernc.org/sqlite`.
- Validate/whitelist input before a subprocess (`gh`) or query
  (parameterized, never string concatenation).
