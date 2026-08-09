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

Proved in-page, independent of the app: **2000 `reactive()` calls whose result
is immediately dropped retain 52 bytes each after a forced GC; with one
`watch()` registered against each, 407 bytes each.** Nothing reclaims either.

**Corrected attribution (superseding an earlier guess in this file):** the
per-navigation-step trigger is **not** `re()`'s official component-mount path
(`F` → `Be` → `nt`, one `nt()` per `component()` instantiation) — a follow-up
session confirmed that path is **dead code in this app**: `Be`/`F` only run
for a value satisfying `b(o)` (arrow's own `component()`/`props()`/`pick()`
API), and grepping every `import … from './vendor/arrow.js'` in `src/*.mjs`
shows only `html`/`reactive`/`watch` are ever imported — never `component`,
`props`, or `pick` (see `.claude/rules/conventions.md`'s "components are
plain functions" convention). Every `${Component(state)}` embedding here goes
through the OTHER nested-value branch (`M(o)`, an `html`` `` template), which
never touches `Be`/`nt`.

Instrumenting `nt()` to capture a stack trace per call (temporarily, in the
harness's static copy only) on a live ↑/↓ loop instead pinpointed the real
mechanism: **`Ut`, the auto-wrap that promotes a plain nested object/array to
a nested `reactive()` the moment it's read off (`xe.get`) or written onto
(`xe.set`) an already-reactive proxy.** Every call site that reads/assigns a
*freshly created* plain object/array on/into reactive state mints a brand new,
never-reclaimed id on every run — observed call sites during a plain ↑/↓ loop:
`RelatedPanel.mjs`'s `setRelated`/`setCommentScope` (→ `recomputeView`),
`home.mjs`'s `ensureCode` and `blockApproveCount`/`Block.mjs`'s `blockRows`,
and `BlockList.mjs`'s `approvalPill`. `rt`/`watch`'s own id (`he`/`tt`) was
measured **flat** across the same loop — its existing dispose path already
unsubscribes and clears `tt[n]` correctly whenever a watch is torn down via an
owning chunk's cleanups, so (for this specific reported symptom) only `nt`'s
ids needed reclaiming, not `rt`'s.

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
- **Not app-level `reactive()` churn.** Every top-level, persistent `reactive()`
  call in `src/` is a module-level singleton except `openMenu`/
  `openOverviewMenu`'s swap — the actual per-step churn is `Ut`'s *auto*-wrap
  of transient nested values (see above), not an app-level `reactive()` call.
- **Not `re()`'s component-mount path (`F`/`Be`).** Confirmed dead code in this
  app (see above) — an earlier draft of this file wrongly attributed the leak
  to it before the call sites were actually traced.

## Status: diagnosed, a fix was attempted and found unsafe — still unfixed

A **LOCAL PATCH 3** was written and measured, then reverted (not committed)
after it was found to introduce a genuine, reproducible crash. Recorded here
in full so the next attempt doesn't repeat it.

**The attempt:** recycle `nt`'s ids instead of letting `me`/`X`/`et`/`$t`/`dt`
grow forever, but — learning from PATCH 2b's history (a manual "dispose on
teardown" hook can free an id while a stale, already-in-flight effect can
still touch it) — via a **`FinalizationRegistry`** registered on the returned
proxy `n`, so an id only re-enters the free-list once the JS engine has
*proven* nothing holds a live reference to that proxy anymore:
`const rf=[],rF=new FinalizationRegistry(e=>{et[e]=void 0,$t[e]=void
0,dt[e]=void 0,X[e]=void 0,rf.push(e)})`, `nt`'s allocation becomes
`const e=rf.length?rf.pop():++me`, and its final line adds `rF.register(n,e)`
before returning `n`.

**Measured result on the decisive nav loop (same harness as above, same PR):**
`me`/`X`/`et`'s array length stayed **perfectly flat** for the entire run
(confirmed via a temporary `window.__arrowCounters()` probe) across 1200 *and*
2000 ↑/↓ steps — no more monotonic growth at all. The heap trace changed from
the dead-straight climb (+2.9 KB/step) to a **bounded, noisy oscillation**:
0 → ~2000 steps ranged from 9538 KB to 9918 KB and ended at 9893 KB, i.e. a
non-monotonic ~0.18 KB/step average dominated by GC sawtooth, the same shape
as the idle/inert-keypress control loops (though not quite as flat as those —
see the open question below). On paper, this fixed the reported symptom.

**Why it was reverted anyway: a real crash, not a theoretical risk.** Running
the existing suite turned up a **reproducible, non-deterministic failure** in
`tests/drill-refresh-multi-level.spec.mjs` (~1 in 4 to ~1 in 20 runs, isolated,
`--workers=1`, no resource contention — confirmed absent in 12+ consecutive
runs of the *same* test against the unpatched vendor file). Capturing
`page.on('pageerror')` on a failing run surfaced:
`Cannot read properties of undefined (reading '6')` — a numeric-array-index
property read on `undefined`, i.e. `X[t]` (an already-disposed id's observer
registry, reset to `void 0` by the `FinalizationRegistry` callback) being
indexed into by something that still thought id `t` was live.

**Why a next attempt down this exact road will also fail:** `watch()`'s own dependency bookkeeping
(`tt[watchId]`, populated by `Ae`/`it`) stores a flat array of **raw reactive
ids** (plain numbers, e.g. `[6, 'someKey', 6, 'otherKey', …]`) — not object
references. A watch "depending" on a reactive this way holds no strong
reference the GC can see; only the *reactive's own proxy* being reachable
elsewhere keeps it alive. So a reactive can become genuinely GC-unreachable
(and thus, correctly per `FinalizationRegistry`'s contract, get its id
recycled) **while a watch that read it on some earlier run still has that
id sitting in its own stale `tt[]` array, not yet cleaned up** (cleanup only
happens on that watch's *own* next run, via `Jt`, which unsubscribes the
*previous* run's deps before recording the new ones). If that id gets reused
for an unrelated reactive before the watch's next run reaches `Jt`, the watch
corrupts the new owner's subscriber list; if the id is merely disposed but not
yet reused, `Jt`'s `Yt(X[t], …)` crashes exactly as observed. This is a
structural mismatch between "recycle via GC-provable unreachability" and
arrow.js's own dependency-tracking model (numeric ids, not object refs) — not
a one-line fix. A future attempt would need one of: making `tt[]` hold weak
object references instead of raw ids (a much larger change to the tracking
core), or eagerly walking every *watch* dependency array on disposal to strip
stale entries (requires a reverse index arrow.js doesn't maintain today), or
accepting a much more conservative recycling window (e.g. never recycle an id
that was ever read by ANY `watch()`, only ones that were only ever `nt()`'d
and never subscribed to — untested, may not cover the actual leak).

**No code from this attempt is committed.** `src/vendor/arrow.js` is
unchanged from before this investigation.

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
4. A fresh `/pr/<id>` load with no `?sel=` starts on stop 1 (the PR
   description) where plain `↑`/`↓` are a no-op (see the `sel`/URL-state
   section in `CLAUDE.md`) — press `ArrowRight` once first to actually enter
   the block index, or a "navigation" loop silently measures nothing and
   looks flat for the wrong reason (cost one round of bogus "already fixed"
   results while re-deriving this).
5. To attribute growth to a specific arrow.js registry rather than guessing:
   temporarily append `window.__arrowCounters=()=>({me,he,Xlen:X.length,
   etlen:et.length,ttlen:tt.length,Wlen:W.length,dtlen:dt.length});` right
   before the final `export{...}` statement in the harness's **static copy**
   of `src/vendor/arrow.js` (never the real one), and read it via
   `page.evaluate(() => window.__arrowCounters())` alongside each
   `Performance.getMetrics` sample. To find the exact call site responsible,
   temporarily wrap `nt`'s body start with
   `window.__ntStacks=window.__ntStacks||[];function nt(t){window.__ntStacks
   .push(new Error().stack); …` (again, static copy only) and read
   `window.__ntStacks` after a short burst of steps.
