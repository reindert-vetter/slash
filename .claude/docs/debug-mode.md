# Debug mode: recording navigation so Claude can reproduce a bug

A switch on the settings page (`settings-row-debug`) that records what the
reviewer navigates and clicks into a durable file, so a later Claude session can
**read the recording and replay the bug** instead of asking "what did you do?".

Off by default. With it off nothing at all happens — no listeners are
registered and no request is made.

## The two halves, and why they store state differently

| Half | Where | Why |
|---|---|---|
| The **preference** ("is debug mode on?") | `localStorage['debugMode']` (`src/debugLog.mjs`) | Frontend-only, exactly like `theme.mjs`. The server never needs to read it — it only ever receives the events the client chooses to send — so there is nothing for a workflow Signal to be the source of truth about (this is the opposite of `autowarn.mjs`, whose value a backend Activity must read at trigger time). |
| The **recording** itself | `<dataDir>/debug-log.jsonl` (`debug_log.go`) | It must survive a server restart (explicit reviewer choice), which makes it a durable write — so it goes through a workflow Activity, per `.claude/rules/workflows-write-boundary.md`. Deliberately **not** an in-memory ring buffer like `run_errors.go`'s. |

Gitignored next to `settings.json`/`praise-words.json`: it is one reviewer's own
session history.

## A recording always starts with a page open

`initDebugLog()` (called once from `home.mjs`, `overview.mjs` and
`settings.mjs`) logs a `session` event carrying the **complete `location.href`**
and flushes it immediately. That is the point: a reproduction begins with "open
this URL", and opening the review tree (or the overview) is where a reviewer's
bug story starts. Every following line of that page carries the same
`session` id, so a multi-page story (overview → tree → settings) stays readable.

## Event schema

One JSON object per line, oldest first. The server adds `at` (its own
timestamp), `session` and `page`; the rest comes from the client:

| Field | Meaning |
|---|---|
| `t` | client clock in ms — the *gap* between two events is what matters, and only the client sees it accurately |
| `type` | `session` \| `nav` \| `key` \| `click` \| `action` (a whitelist, `debugLogKinds`) |
| `url` | the full URL (`session`/`nav`/`click`) |
| `key` / `mods` | the pressed key and `cmd+shift`-style modifiers |
| `target` | the `data-testid` of the element (or its nearest ancestor that has one) — the same handle the Playwright specs use — else the tag name |
| `detail` | free-form: a click's short text, an action's argument, `in-text-field` for a key typed into an input |

A `nav` line is the one that makes a recording *replayable*: the whole
navigation position lives in the query string (`bindUrlState`, see `CLAUDE.md`),
so opening a `nav` URL puts you exactly where the reviewer was. It is logged on
the next macrotask after a key/click, only when the URL really changed.

## Instrumentation: own listeners, not per-page nav code

`debugLog.mjs` registers its **own** capture-phase `keydown`/`click` listeners
plus `pagehide`/`visibilitychange`. So a page module needs one import and one
`initDebugLog()` call, and `home.mjs`'s `onKeydown` (or the nav chain in
`keyboard-navigation.md`) is not touched at all. It never calls
`preventDefault`/`stopPropagation` and never touches the DOM — so it cannot
influence navigation, and `tests/navigate.spec.mjs`'s "zero attribute mutations
per step" contract is unaffected.

**The one hand-placed hook** is `logAction('command', …)` at the top of
`runCommand` (`home.mjs`): which command an `Enter` ran cannot be read back from
the recorded keystroke. Everything else is covered generically.

## Delivery: batched, one one-shot Execution per batch

Buffered client-side and flushed at 25 events or 1.5s, plus on
`pagehide`/hidden. Each flush is `POST /api/workflows/debug_log`
(`{kind:"append", session, page, events}`), validated at the door
(`validateDebugLogInput`: unknown kind/event type, empty or oversized batch →
400) and then run as **one one-shot `debug_log` Execution** whose single
Activity appends the lines.

**Why one-shot and not a long-lived tracker** (the `app_settings` shape): tembed
replays a workflow from the beginning at every step, so a `WaitSignal` loop
would replay every earlier batch on every new one — quadratic, and
`SignalWorkflow` drives that replay inline under the run lock. Don't "simplify"
this into a tracker.

**The unload flush uses `navigator.sendBeacon`**, not `fetch`. A plain fetch —
even with `keepalive` — is routinely aborted by the very navigation that
triggered it (measured: `ERR_ABORTED` on every gear-icon/back navigation), which
silently lost the tail of a session. The short flush timer keeps this path rare
anyway.

The completed run records are worthless once the lines are on disk, so the
`cleanup` workflow sweeps them (`sweepDebugLogRuns`, `cleanup.go`, completed
runs older than `debugLogRunAge`). It never touches the log file. A **failed**
log write is deliberately left in place, so it shows up in "Mislukte taken".

## Reading it back (this is the whole point)

- `cat data/debug-log.jsonl` — the primary path for a Claude session.
- `GET /api/debug/log?format=jsonl` — the same content over HTTP; `?limit=N`
  for the newest N lines. Without `format` it answers
  `{ok, total, events:[…]}`, which is what the settings row's
  "N gebeurtenissen opgenomen" counter reads. Pure read, no workflow.

The file is bounded: past `debugLogMaxBytes` the next append rewrites it keeping
the newest `debugLogKeepLines` lines (atomic temp-file + rename). "Log wissen"
on the settings row empties it through the same workflow (`kind:"clear"`) so a
reviewer can start a clean reproduction.

## Tests

- `tests/debug-mode.spec.mjs` — the switch, the recorded session/key/nav lines
  for a real tree navigation, `Enter` on the row doing what the click does, and
  that nothing is recorded while it is off.
- `debug_log_test.go` — append across sessions, the tail read, clear, the
  size-cap trim keeping the newest line, and the validation door.
