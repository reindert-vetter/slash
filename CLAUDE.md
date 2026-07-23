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

## Topics (deeper explanations in `.claude/rules/`)

This file is always loaded fully into context; the rest of the architecture
therefore lives in separate reference files under `.claude/rules/` that are
only loaded when the topic is relevant. Update the details there, not here.

- **Blocks & ingest** — a PR is turned into **blocks** (function/method level)
  with granular reviewer approval (block/group/line/call) and a
  worktree-based ingest pipeline (`gh` → `git diff` → PHP scanner →
  classify → SQLite). See `.claude/rules/blocks-and-ingest.md`.
- **Keyboard navigation** — command palette (`Enter`), PR-wide menu (`/`),
  list/diff modes and selection granularity (`f`/`d`/`s`, group/line/call),
  plus the footer inline preview. See `.claude/rules/keyboard-navigation.md`.
- **Detail layout & related panel** — the column layout next to the sidebar
  (block card + `RelatedPanel` with underlying code and a tasks/chat
  placeholder). See `.claude/rules/detail-layout.md`.
- **Pages, routing & PR inbox** — the two static shells (`/pr/<id>`,
  `/pr-overview`) and the read-only GitHub inbox that runs through the
  `pr_inbox` workflow. See `.claude/rules/pages-and-routing.md`.
- **Tembed: durable workflows** — the embeddable workflow engine (`tembed/`),
  the write-boundary rule, and the concrete workflows (`task_code_comment`,
  `pr_status`, `pr_inbox`, `build_relations`, `resolve_call` — which resolves
  method calls to their definition, Go-static with an LLM fallback —, and
  `approve`, which durably persists reviewer approval). See
  `.claude/rules/tembed-workflows.md` and the hard rules
  `.claude/rules/workflow-determinism.md` /
  `.claude/rules/workflows-write-boundary.md`.
- **Conventions** — file naming conventions, arrow.js pitfalls, Prism
  vendoring, Go conventions, language choice. See
  `.claude/rules/conventions.md`.

## URL state (refresh-restore & deep links)

The navigation position lives in the **query string** so that a refresh or a
shared link returns exactly where you were. `src/urlState.mjs` provides
`bindUrlState(state, fields, { ns })`: on load it restores the given keys from
the URL into the reactive `state` and afterwards writes back every change via
`history.replaceState` (an arrow.js `watch`, so no history spam). `home.mjs`
binds the main navigation (`blockRef`→`sel`, `mode`, `change`→`chg`,
`gran`→`gran`, `drillRef`→`drill`, `drillGran`→`dgran`, `drillChange`→`dchg`);
the **PR lives in the path** (`/pr/<id>`, see
`.claude/rules/pages-and-routing.md`), not in the query. A `default` value is
omitted from the URL so it stays short/canonical (so `gran` only appears for
`line`/`call`, not for the default `group`; `drill`/`dgran`/`dchg` only while
something is actually drilled into).
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
`.claude/rules/pages-and-routing.md`.
An open **drilled Underlying-code column** (`state.drill`/`drillCursor`, see
"Drilling" in `.claude/rules/detail-layout.md`) survives a refresh the same
way: `drillRef` mirrors each entry's stable `.id` (joined with `>`),
`drillGran`/`drillChange` mirror only the cursor (`{gran, change}`) of the
deepest (focused) column — every ancestor column collapses to a rail anyway,
so its own cursor is never visible. `drillRefPending`/`drillCursorPending`
snapshot the restore before their own mirror `watch` would overwrite it (same
pattern as `blockRefPending`), and `applyDrillRefRestore`/
`applyDrillCursorRestore` resolve them — only after `loadBlocks` has loaded
not just the blocks but also callresolve/testcovers (needed because the walk
reuses `relatedChildren` to find each path segment again). This path also
travels along in the `/pr-overview` round trip.
Every **extra window/panel** gets its own `ns` so its params sit alongside the
main navigation in the same URL without colliding. `RelatedPanel` really uses
this: `bindUrlState(cs, …, { ns: 'rel' })` binds the **panel cursor**
(`focus`→`rel.foc`, `codeSel`→`rel.code`, `sel`→`rel.csel`,
`threadPos`→`rel.thr`) so a refresh puts you back on the same Underlying-code
child / the same comment thread. Restored values that fall out of range due
to async loading are clamped (`loadBlocks` clamps `selected`, `ensureCode`
clamps `change` and falls back to `mode:'list'` for a block without changes —
but only from the rest position (`focusLevel === 0`, no open `state.drill`),
never while a drilled column is open, see
`.claude/rules/detail-layout.md`; the panel cursor is reapplied once after the
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

This `.claude/` directory (rules, templates, skills, agents) is part of the
project and must **grow along with it**. Whenever a new rule, convention,
architecture explanation, or recurring task comes up: update the
corresponding file under `.claude/rules/` (hard rules and descriptive
architecture references live there together), or create a new skill/
template/agent, in the same change. Don't leave conventions behind in chat
only.
