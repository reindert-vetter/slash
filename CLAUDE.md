# PR Review Tree

A dashboard that builds a **function call graph** from a GitHub PR (for now
`plug-and-pay/plug-and-pay`) that you view as a tree in the browser. The tree
helps with reviewing: you see which functions are touched by the PR and how
they call each other.

## The stack is deliberately minimalist and build-step-free

This is a hard design choice, not an accident. Add **nothing** that requires a
bundler, transpiler, or build step. When in doubt: pick the more boring,
smaller solution.

### Runtime & server (Go)

- **Golang, no framework.** Our own small HTTP server.
- The server serves the repo **statically** + a thin **`/api/*` bridge** to
  local CLIs:
  - `gh` — for PR comments (reading/posting).
  - `claude` — for consultation and to have code changed.
- **Virtually no dependencies in production — only Go built-ins** (`net/http`,
  `os/exec`, `encoding/json`, `database/sql`, …). Want to add a new
  dependency? **Ask Reindert first.**
- **Approved exception:** `modernc.org/sqlite` — the pure-Go SQLite driver
  (no cgo, so no build step). This is the only allowed runtime dependency.
  (Would you rather use the cgo driver `mattn/go-sqlite3`? Discuss that first.)

### Frontend

- **Vanilla JS ES modules** in `src/` (`.mjs`). No React/Vue/bundler.
- **[arrow.js](https://www.arrow-js.com/)** for reactivity — components like
  `dashboard.mjs`, `home.mjs`, `Block.mjs`, etc.
- **Tailwind via Play CDN** (in-browser, no build step).
- **Prism** vendored under `src/vendor/` for code syntax highlighting.

### Data

- **SQLite** as storage for the call graph (nodes + edges), via `database/sql`
  + `modernc.org/sqlite`. One DB file under `data/` (e.g. `data/graph.db`).
- Advantage over loose JSON: updating one small piece is a simple row
  `UPDATE`/`INSERT` — you don't have to rewrite an entire file or reload
  everything. Serve deltas via the `/api/*` bridge, instead of dumping the
  whole graph.
- Schema template: `.claude/templates/schema.sql`.

### Test

- **Playwright** (`@playwright/test`) — the only real npm dependency, lives in
  `devDependencies`. Only for tests, never in production.

## Two documentation directories, and the difference matters

- **`.claude/rules/`** is **auto-loaded** into every session, in full, whatever
  the task is. Four files only, deliberately — the hard rules you cannot afford
  to miss because you didn't think to look them up:
  `arrowjs-pitfalls.md` (read it before writing any arrow.js template),
  `conventions.md`, `workflow-determinism.md`, `workflows-write-boundary.md`.
- **`.claude/docs/`** is **NOT auto-loaded**. It holds the architecture
  reference per topic. **Read the matching file below before touching that
  area** — the index here is intentionally just a pointer, never the full
  story, and the file is where the reasoning and the "don't reintroduce this"
  notes live. Update the details there, not here.

Adding a rule to `.claude/rules/` costs every future session its tokens, so
that set stays small on purpose; a new topic file belongs in `.claude/docs/`.

### Index of `.claude/docs/`

**Review-tree UI** (`src/`, arrow.js)

- `keyboard-navigation.md` — the left→right nav chain of stops, list/diff
  modes, selection granularity (`f`/`d`/`s`: group/line/call), Shift+↑/↓
  ranges, the `a` diff-view cycle. Start here for any keyboard change.
- `mouse-navigation.md` — the app-wide rules for click/hover: a click runs the
  same function a key runs, hover carries no state.
- `command-palette.md` — every menu (`Enter` block palette, `/` PR menu, the
  comment/compose/postApprove/review-submit follow-ups) and
  `findNextUnapproved`'s walk through the review tree, plus the **werkmap
  overlay** (`workDirOverlay.mjs`) — not a menu, but it owns the keyboard the
  same way.
- `detail-layout.md` — `<main>`'s horizontally scrolling column flow, the
  PR-info column (stop 1), the "Taken" block.
- `diff-card.md` — how wide a diff card gets: the `split`/`unified`/`fit`
  stands, the `narrow:` breakpoint, the look-ahead preview's width/collapse
  rules.
- `column-resize.md` — the manual, per-block, cookie-persisted column-width
  override on top of every column's auto width (drag handle, snap-back/
  dblclick reset, the accepted comment/Claude-row alignment trade-off).
- `diff-render.md` — old/new line alignment, huge-block trim/collapse, char
  diff, and the three renders that replace the text diff (TRANSLATION, SVG,
  and IMAGE — a raster image shown as the picture itself, its three `a`
  stands, and the `/api/image` endpoint behind it).
- `drilling.md` — opening an Underlying-code child as its own column
  (`state.drill`/`focusLevel`), rails, the enter/return animations.
- `underlying-code.md` — the `RelatedPanel` card: which children it shows, the
  cursor scoping, drill-hint chips, the call-arrow overlay, its column width.
- `comments-panel.md` — PR-wide comments as navigable sidebar rows, the inline
  comment threads, composer, drafts, the focus-token discipline.
- `claude-chat-panel.md` — the embedded Claude conversation column (stop 5b):
  its state machine, SSE-driven live progress, and its render contract.
- `footer.md` — the inline preview of the active unit, its content-driven
  height, and the AI description.
- `frontend-memory.md` — the measured heap leak (per-keystroke numbers, the
  arrow.js registry root cause, the ruled-out suspects) and how to re-measure
  it, plus a separate measured CPU longtask on Space (the `allBlocksById`/
  `relationsByParentId`/`callResolveByCallerId`/`testCoversByTestId` memoized
  reverse-indexes and why the id-Map alone wasn't enough), plus the measured
  `Vt` flush-abort freeze (one uncaught throw permanently orphans every effect
  queued behind it, which reads as "navigating no longer updates the diff
  column"). Read it before investigating "the tab gets slow / freezes / stops
  reacting".
- `approval.md` — reviewer approval: the granular row/call model, persistence,
  the tree rollup and its counters/indicators.
- `test-class-grouping.md` — grouping TEST blocks per class (`test_class` rows
  and the methods column, stop 2b).

**Pages & routing**

- `pages-and-routing.md` — the three routes and their static shells, plus the
  state that travels between the review tree and the PR overview.
- `plan-page.md` — the `/plan/<JIRA-KEY>` planning page: the ticket + its own
  running workflow tasks, the multiple-choice questions (each choice with its
  own input) plus the "wat er moet gebeuren" list, the example-code blocks and
  their arbitrarily deep drilled columns, the two gates before generation (a
  main task's subtask scope, a bug's hotfix/base-branch question) and the
  `plan` tracker behind it.
- `pr-overview.md` — the `/pr-overview` GitHub inbox in full (sections, the
  per-row popover, filters, failed tasks, its client).
- `debug-mode.md` — the settings-page "Debug mode" switch: it records every
  navigation/click (starting with the page you open) into
  `data/debug-log.jsonl` so a later Claude session can replay a reported bug,
  why the preference is localStorage but the log a workflow write, and why the
  write is a one-shot Execution per batch instead of a tracker.
- `settings-page.md` — the `/settings` general settings page: the shared
  gear-icon entry buttons, the `?from=` back-navigation round trip, the
  keyboard-navigable row list, and the per-setting source/write-path table
  (including the new `app_settings` tracker for mention aliases and
  praise-words).
  Also the **per-type language settings** (`lang_pref` tracker: interface,
  AI explanations, GitHub replies — code/commits are always English) and the
  `t()` interface-language layer (`src/i18n.mjs`, `src/i18n/en.mjs`).

**Go backend**

- `blocks-and-ingest.md` — a PR becomes **blocks** (function/method level) via
  the worktree-based pipeline (`gh` → `git diff` → PHP scanner → classify →
  SQLite), plus the display transforms on a block's source.
- `tembed-workflows.md` — the durable-workflow engine (`tembed/`): replay,
  storage, recovery priority, and which workflow is documented where.
- `tembed-endpoints.md` — the endpoint surface: starting an Execution,
  Signals, the operational carve-outs, and every read model.
- `pending-push.md` — a landed chat edit that is not pushed yet: the local
  `refs/slash/pending/…` ref, the immediate ingest refresh at that local SHA,
  the `"push"` Action, and the todo row at the bottom of the index. The
  live, pre-landing "wordt aangepast" pill lives in `claude-chat-panel.md`
  instead — a different signal, before this file's own subject even starts.
- `workflows-comments.md` — `task_code_comment`, the GitHub comment import,
  and `claude_chat`/`chat_merge` (the embedded conversation, its agentic
  edits and their serialized commits).
- `workflows-test-run.md` — `test_run` ("Tests laten draaien"): Claude itself
  picks which existing tests are relevant, no Edit tool, the shared
  `chat_write_gate.go` slot, cancel via `chat_cancel.go`, and the age-based
  residue sweep in the `cleanup` workflow.
- `workflows-analysis.md` — the workflows deriving the review tree
  (`build_relations`, `resolve_call`, `resolve_test_covers`) and the two
  LLM passes (`explain_code`, `code_warning`).
- `workflows-trackers.md` — the long-lived trackers (`pr_status` incl. ingest
  refresh + the re-anchor pass, `pr_inbox`, `approve`, `jira_inbox`, `jira_issues`) and the one-shot operational ones (`ingest`, `cleanup`, …).
- `server-events.md` — the one multiplexed SSE stream per tab: an event is
  never the source of truth, which is why it sits outside the write boundary.

**Tests**

- `testing-playwright.md` — the harness contract: per-worker server/DB
  isolation, the hand-written worktree fixtures, `seededPr`, and the
  spec-writing rules. Read it before adding or debugging a spec.

## URL state (refresh-restore & deep links)

The navigation position lives in the **query string** so that a refresh or a
shared link returns exactly where you were. `src/urlState.mjs` provides
`bindUrlState(state, fields, { ns })`: on load it restores the given keys from
the URL into the reactive `state` and afterwards writes back every change via
`history.replaceState` (an arrow.js `watch`, so no history spam). `home.mjs`
binds the main navigation (`blockRef`→`sel`, `mode`, `change`→`chg`,
`gran`→`gran`, `drillRef`→`drill`, `drillGran`→`dgran`, `drillChange`→`dchg`,
`drillCursorRef`→`dcur`, `testMethodRef`→`tmethod`,
`testColumnFocused`→`tcol`); the **PR lives in the path** (`/pr/<id>`, see
`.claude/docs/pages-and-routing.md`), not in the query. A `default` value is
omitted from the URL so it stays short/canonical (so `gran` only appears for
`line`/`call`, not for the default `group`; `tcol` only while the methodes-kolom
really has the keyboard, see `.claude/docs/test-class-grouping.md`;
`drill`/`dgran`/`dchg`/`dcur` only
while something is actually drilled into).
`sel` encodes the **block reference** `${file}:${line}` — not the raw index in
`state.blocks` — because that index shifts whenever the left-hand list
reorders (searching, or a block that moves to "Underlying code" via a
relation/call-resolve reload); `file:line` survives that. A `watch` on
`state.selected`/`state.blocks` re-derives `state.blockRef` on every selection
change (`home.mjs`); on load, `blockRefPending` snapshots the reference
restored from the URL before that same watch (with `state.blocks` still empty)
would overwrite it, and `applyBlockRefRestore` resolves it — analogous to
`RelatedPanel.applyRelRestore` — once to an index as soon as `loadBlocks` has
populated the blocks; not found (expired/shared link) → the existing
index-clamp (to 0) stays in place. Unlike `gran`/`mode`/`chg`, `sel` has no
"default" that disappears from the URL once a block is loaded: every block
(even the first) has a real `file:line`, so `sel` is structurally present in
the URL as soon as the PR is loaded. That same `sel` also travels along in the
`/pr-overview` round trip (`←`/"Back to PR overview" →
"Open review tree"/`→`), so you land on the same block when you return — see
"`?sel=` travels along in the same round trip" in
`.claude/docs/pages-and-routing.md`.
An open **drilled Underlying-code column** (`state.drill`/`drillCursor`, see
"Drilling" in `.claude/docs/drilling.md`) survives a refresh the same way:
`drillRef` mirrors each entry's stable `.id` (joined with `>`),
`drillGran`/`drillChange` mirror only the cursor (`{gran, change}`) of the
deepest (focused) column (kept for an older shared link/the round-trip's
convenience pair), and `drillCursorRef` mirrors **every** level's own cursor
(`${gran}:${change}` per entry, joined with `>`, index-aligned with
`drillRef`'s id path) — including an ancestor column, even though it's
collapsed to a rail and its cursor is never itself visible on screen: a
"return to an unapproved ancestor" (see "Finishing a drilled column's subtree
returns to an unapproved ancestor" in `.claude/docs/drilling.md`) reads that
exact saved cursor once the reviewer pops back out of a finished subtree, so
it must survive a refresh too, not just the deepest column's own.
`drillRefPending`/`drillCursorPending`/`drillCursorRefPending` snapshot the
restore before their own mirror `watch` would overwrite it (same pattern as
`blockRefPending`), and `applyDrillRefRestore`/`applyDrillCursorRestoreAt`
resolve them per level as the path is walked back in — only after `loadBlocks`
has loaded not just the blocks but also callresolve/testcovers (needed
because the walk reuses `relatedChildren` to find each path segment again).
This path also travels along in the `/pr-overview` round trip.
Every **extra window/panel** gets its own `ns` so its params sit alongside the
main navigation in the same URL without colliding. `RelatedPanel` really uses
this: `bindUrlState(cs, …, { ns: 'rel' })` binds the **panel cursor**
(`focus`→`rel.foc`, `codeSel`→`rel.code`, `sel`→`rel.csel`,
`threadPos`→`rel.thr`, `claudePos`→`rel.cpos`) so a refresh puts you back on the
same Underlying-code child / the same comment thread / the same turn of the
embedded Claude conversation. Restored values that fall out of range due
to async loading are clamped (`loadBlocks` clamps `selected`, `ensureCode`
clamps `change` and falls back to `mode:'list'` for a block without changes —
but only from the rest position (`focusLevel === 0`, no open `state.drill`),
never while a drilled column is open, see
`.claude/docs/detail-layout.md`; the panel cursor is reapplied once after the
data push, see `RelatedPanel.applyRelRestore`).
See skill `url-state`.

## Done with a task

Once you're done with a task, **ask whether you should**:

1. **commit** the changes,
2. **merge** the branch into `main`, and
3. **clean up** the worktree.

Don't perform these steps unprompted — ask first, and only once they say yes:
commit → merge → clean up the worktree. We work in a git worktree (an
isolated copy), so cleanup is part of wrapping up.

## Keeping `.claude/` up to date

This `.claude/` directory (rules, docs, templates, skills, agents) is part of
the project and must **grow along with it**. Whenever a new rule, convention,
architecture explanation, or recurring task comes up: update the corresponding
file under `.claude/docs/` (the architecture reference) or `.claude/rules/`
(only for a hard rule that must hold in every session — see the two-directory
split above), or create a new skill/template/agent, in the same change. Don't
leave conventions behind in chat only.

A **new** `.claude/docs/` file also needs one line in the index above —
otherwise it is unreachable: nothing auto-loads it and nothing points at it.
