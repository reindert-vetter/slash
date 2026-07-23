---
name: add-api-endpoint
description: Add a new /api/* bridge endpoint to the Go HTTP server that shells out to a local CLI (gh, claude) or reads/writes the SQLite graph. Use when the frontend needs a new server capability. Enforces the no-dependency, safe-exec conventions.
---

# New `/api/*` endpoint

The Go server serves the repo statically plus a thin `/api/*` bridge.
Endpoints do one of two things: shell out to a local CLI (`gh`, `claude`) or
read/write the SQLite call graph.

## Steps

1. Copy `.claude/templates/api_handler.go` as a starting point.
2. Register the handler on the `ServeMux` under an `/api/<feature>` path.
3. Choose the source:
   - **CLI bridge** (`gh`/`claude`): use `exec.CommandContext` with **separate
     args**, never a shell string. Set a timeout via `context`.
   - **SQLite**: `database/sql` + `modernc.org/sqlite`. Use parameterized
     queries (`?`), never string concatenation. Prepared statements for hot
     paths.
4. **Validate/whitelist all input** before using it in a subprocess or query
   (method, required fields, numeric ranges, allowed values).
5. Respond with JSON; set `Content-Type: application/json`. Serve deltas, not
   the whole graph.
6. Add a Playwright test that hits the endpoint via the UI flow.
7. **Restart the server** and verify the endpoint (see below). A browser
   refresh alone doesn't load the new route.

## Restart after a backend change (required)

The Go server has **no hot reload**. A running server keeps running the old
binary; a new or changed `/api/*` path therefore doesn't exist there and falls
through to the static file server → **404** ("code load failed: 404" etc.). A
browser refresh doesn't help — you have to rebuild and restart the process:

```sh
# find + stop the old server (example address :8765)
pkill -f 'slash .*-addr 127.0.0.1:8765' || true
# rebuild and restart on the same address/DB
go build -o tests/.tmp/slash . && \
  tests/.tmp/slash -db data/graph.db -addr 127.0.0.1:8765 -static . &
# verify the path now exists (200, not 404)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8765/api/<feature>?...'
```

Symptom that you forgot this: the UI shows a 404 for an endpoint that locally
(on a fresh build) does return 200.

## Hard rules

- No new dependency without discussion (see CLAUDE.md). SQLite driver =
  `modernc.org/sqlite`, that is the only allowed runtime dependency.
- Never pass raw user input into a shell command or SQL string.
