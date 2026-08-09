# Frontend memory: the measured leak, and how to measure it again

Reported symptom: approving a PR line by line makes the browser "loop vast"
eventually, and a Chrome DevTools **heap snapshot hangs** at "Snapshotting…".
This file records what that is, with numbers, so it doesn't have to be
re-derived — and so nobody looks for it in the wrong place.

The one-paragraph rule version lives in `.claude/rules/arrowjs-pitfalls.md`
(bottom of the "Orphan bindings" section). This file is the evidence.

## Measured leak

Real data (PR 13255, 115 blocks) served by an **isolated** server: its own
`-db`/`-data`, worktrees symlinked read-only, `SLASH_GITHUB=off
SLASH_CLAUDE=off`. That isolation is not optional — approving syncs GitHub's
"Viewed" checkbox (`setFileViewed` → `MarkFileViewed`), so measuring against
the live server would write to the real PR.

Every sample is taken after a **forced GC** (`HeapProfiler.collectGarbage`),
so nothing below is uncollected garbage — it is all genuinely retained.

| loop | per iteration | shape |
|---|---|---|
| idle (no input) | ~0.7 KB | sampling overhead, flat |
| inert keypress (F8) | ~1.4 KB | flat |
| `↑`/`↓` navigation between two blocks | **~2.9 KB** | **perfectly linear over 1200 steps** |
| palette open + close (Enter/Esc) | ~5 KB | linear over 300 cycles |
| Space = approve + go to next | ~27 KB | linear over 180 approvals |

The navigation row is the decisive one: 1200 steps between the **same two**
blocks (code long since cached, nothing legitimate accumulating) grew the heap
from 8.8 MB to 12.1 MB in a dead-straight line, while `Nodes` stayed at 3219
(+0) and `JSEventListeners` at 87 (+0) the entire run.

**So it is not detached DOM.** Retained JS objects only. That is also why the
DevTools snapshot hangs rather than merely being big: snapshot cost scales with
object *count*, and a real line-by-line pass is thousands of keystrokes, each
leaving behind a handful of small permanent objects.

The Space row is larger per iteration but partly legitimate — walking the tree
lazily fetches and caches each block's code (`ensureCode`), which is bounded by
the block count. Navigation is the clean, unbounded signal.

## Root cause: arrow.js's registries never reclaim

In `src/vendor/arrow.js`:

- `nt` (upstream `reactive`) takes a **new monotonic id** (`const e = ++me`)
  and does `X[e] = {}` — the observer registry, a plain **module-level array**
  slot. `Lt` is a `WeakMap`, so the proxied object itself can be collected, but
  `X[e]` (and `et[e]`, holding the parent links) is a **strong** reference from
  a module-level array that nothing ever clears.
- `rt` (upstream `watch`) does the same with `++he` into `tt`.
- `re()`'s component-mount path (`F` → `Be` → `nt`) allocates one such entry
  **per component instantiation**, so every component re-mount during ordinary
  navigation permanently grows those arrays.

Proved in-page, independent of the app: **2000 `reactive()` calls whose result
is immediately dropped retain 52 bytes each after a forced GC; with one
`watch()` registered against each, 407 bytes each.** Nothing reclaims either.

## What is NOT the cause (ruled out by experiment, don't re-test)

- **Not the `ms` swap.** Reusing one stable `ms` object across opens instead of
  `ms = reactive({...})` per open changed the curve by nothing (+1.8 MB vs.
  +1.7 MB over 300 cycles).
- **Not detached DOM / leaked listeners.** Both counters are constant to the
  node across every run.
- **Not the CommandMenu subtree alone.** Removing `${CommandMenu(ms, …)}` from
  `menuOverlay` does cut the *palette* loop from +1.7 MB to +0.5 MB per 300
  cycles — so ~80% of the palette's own leak is that subtree — but navigation,
  which opens no menu at all, still leaks at full rate. A menu-only fix would
  not help the reported flow.
- **Not app-level `reactive()` churn.** Every `reactive()` call in `src/` is a
  module-level singleton except `openMenu`/`openOverviewMenu`'s swap.

## Status: diagnosed, deliberately not fixed

The fix has to recycle those ids inside `src/vendor/arrow.js` — a **LOCAL PATCH
3** in the same family as PATCH 1/2/2b, on third-party reconciler internals
where getting it wrong corrupts rendering silently (see PATCH 2b's own history:
PATCH 2 turned a leak into a use-after-free that wedged a reconciler). That is
not a minimal change and was not attempted as part of the bug round this was
found in. It needs its own task, with the harness below as its pass/fail gate.

## Re-measuring

The harness is deliberately **not committed** — it is a throwaway script, and
the numbers above are the artifact worth keeping. To rebuild it:

1. `sqlite3 data/graph.db ".backup <tmp>/data/graph.db"`, then delete every
   `blocks`/`pr_ingest` row of other PRs; symlink that PR's two worktrees into
   `<tmp>/data/worktrees/`.
2. `SLASH_GITHUB=off SLASH_CLAUDE=off ./slash -db <tmp>/data/graph.db -data
   <tmp>/data -addr 127.0.0.1:8799 -static <tmp>/static`, with `<tmp>/static` a
   **copy** of the repo's `src/`+`*.html` so experiments never touch the live
   tree (and verify the copy is really being served — a failed restart silently
   measures the unmodified original, which cost one round of bogus results).
3. Drive it with Playwright + CDP: `Performance.enable` + `HeapProfiler.enable`,
   and per sample `HeapProfiler.collectGarbage` then `Performance.getMetrics`
   (`JSHeapUsedSize`, `Nodes`, `JSEventListeners`). Always include the **idle**
   and **inert-keypress** control loops — without them a per-iteration number
   means nothing.
