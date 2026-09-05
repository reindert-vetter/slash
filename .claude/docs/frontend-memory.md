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

## LOCAL PATCH 3 — LANDED, and it does fix the navigation leak

Object-reference ids + WeakMap registries. This is **in the tree** (see the
LOCAL PATCH 3 block in `src/vendor/arrow.js`). It removes arrow.js's own
registry growth completely, is proven safe, and — once the measurement is
corrected for JIT warmup, see below — takes the navigation loop to the flat,
non-monotonic shape of the control loops.

**Correction, recorded deliberately:** this was first reported as a *partial*
fix that left "a second, arrow-independent leak" behind. **That was wrong**, and
the mistake was measurement, not code: the 1200-step run was still inside V8's
JIT warmup. See "The second leak that wasn't" below. The patch was landed while
that wrong conclusion still stood, so the commit message for it also says
"partial fix" — this file is the corrected record.

(History note, so the git log reads sensibly: the code first reached `main` by
accident — commit `93bb173`, and after a revert again via `e3ac65e` — both
unrelated commits that swept the vendor file up while it was still under
measurement. It was reverted once in between, in `75e5a97`, when it failed its
gate. The deliberate landing is the commit that adds the LOCAL PATCH 3 comment
block and these docs.)

**The idea, in one line:** don't change *where* the ids live, change *what an id
is*. Instead of `const id = ++index`, the id becomes the **raw target object
itself** (`ids.set(data, data).set(proxy, data)`), and `listeners`/`parents`/
`computedIds`/`arrayMutationWrappers` become `WeakMap`/`WeakSet`. Every other
line is untouched, because the rest of the code already treats an id as an
opaque value it passes around and compares with `===`/`==` — nothing anywhere
does arithmetic on it.

**Why this closes the hole that killed the `FinalizationRegistry` attempt:**
`track()` does `trackedDependencies[trackKey].push(id, property)`. Once an id is
an object reference, a `watch`'s dependency array holds its reactives
**strongly** — visible to the GC. The situation that crashed the previous
attempt (a reactive collected while a watch still holds its id as a raw number)
becomes structurally impossible. No registry, no free-list, no recycling window.

**Size:** 16 exact string replacements, no control-flow change, no new function,
+86 bytes. Far smaller than the "much larger change to the tracking core" the
previous section assumed.

**Micro-benchmark (isolated page, two copies of the vendor file, forced GC):**
8 rounds × 8000 iterations *in one page*, bytes retained per iteration:

| test | build | r1 | mean r2–r8 |
|---|---|---|---|
| bare `reactive()`, dropped | before | 64.7 | **32.8** |
| | after | 47.3 | **0.04** |
| `reactive()` + disposed watch | before | 118.8 | **101.8** |
| | after | 37.5 | **7.4** |
| app-shaped (fresh array + object per step) | before | 124.1 | **112.3** |
| | after | 92.2 | **4.9** |

**Conformance:** 11 assertions (watch firing, nested auto-wrap, fresh-object
replacement, array mutation, array reassignment, `reactive(fn)` computed, nested
computed, `$on`/`$off`, dispose, `html` render + keyed list update, deep parent
propagation) run against both builds: **0 differences, 0 page errors**. A build
that had broken tracking would also "not leak", so this check is not optional.

**Performance:** +3.0% on a flat set/get hot path, +5.6% on a nested one
(300k ops, median of 15 interleaved reps). ~10–17 ns per iteration. Negligible.

**App-level result.** Rebuilt harness, PR 13255, 1200 steps, forced GC per
sample. Two runs, and the difference between them is entirely the **warmup**:

| warmup before sampling | before | after |
|---|---|---|
| 200 steps (JIT still warming) | 585 B/step, 92% climbing | 403 B/step, 83% climbing |
| **2500 steps (JIT settled)** | **+293 B/step, 83% climbing, monotone** | **−88 B/step, net NEGATIVE, oscillating** |

Controls for reference: idle 30 B/step / 25% climbing, inert F8 0 B/step / 0%.
`Nodes` and `JSEventListeners` are +0 in every run.

The second row is the honest one, and it is an A/B with everything else
identical. Unpatched still climbs monotonically after the JIT has settled;
patched ends *below* where it started and oscillates. That is the control
shape, so the gate is met.

**Safety, measured:** `tests/drill-refresh-multi-level.spec.mjs` **12/12** at
`--workers=1` with `pageerror` capture (plus 6 more later: 17/18, the one miss
being a `spawnSync tests/.tmp/slash ENOENT` from a concurrent rebuild, 0 page
errors) — this is the spec that exposed the `FinalizationRegistry` crash, so it
is the decisive one. Full suite in a **clean worktree at HEAD**: 460 passed /
1 failed **identically with and without the patch** (`overview.spec.mjs:82`,
pre-existing and unrelated). Zero regressions attributable to it.

**Attribution warning for anyone re-running the suite:** measure in a
`git worktree` at HEAD, not in a shared working tree. Another agent's
uncommitted edits to `src/Block.mjs`/`src/RelatedPanel.mjs` produced 16 and then
48 failures in the main tree during this work, which is noise that can easily be
mistaken for a regression — the clean worktree gave a stable 460/1 both ways.

## The second leak that wasn't — JIT warmup read as a leak

**This section used to claim a second, arrow-independent leak existed. It does
not.** Kept, corrected, because the false positive is instructive and the
evidence that killed it is the useful part.

The claim came from measuring 1200 nav steps after only a 200-step warmup: the
patched build still showed 403 B/step at 83% climbing, and an `ArrowRight
ArrowRight` entry state showed 146 B/step with 0.00 reactives/step, which looked
like a leak with the reactive component switched off.

**What it actually was.** A heap-snapshot diff across the loop (survivors of a
forced GC, aggregated by `type|name`) showed the growth is almost entirely V8's
own JIT output — `code|system / InstructionStream` ~200 B/step,
`TrustedByteArray` ~70, `ProtectedFixedArray` ~29 — and **no JS-object category
grew at all**. Re-run after a 3000-step warmup, only the code categories were
left (123 + 54 B/step) and total surviving growth was *negative*. Then the
decisive A/B, same 2500-step warmup on both builds: unpatched +293 B/step still
monotone, patched −88 B/step oscillating.

So the residual was the optimizing compiler still generating code for functions
the loop had only just made hot, plus GC sawtooth. Nothing was retaining it.

**The lesson, which is the same one as the WeakMap-capacity trap below:** a
per-step byte figure taken before the workload reaches steady state is not a
leak measurement. Warm up until the JIT has settled — thousands of steps, not
hundreds — and confirm with a snapshot diff that a *JS-object* category is
actually growing before calling anything a leak. A category breakdown costs one
extra script and would have prevented this entirely.

**Still genuinely untested:** only the nav loop was re-measured this way. The
approve (`Space`, ~27 KB/step) and palette open/close (~5 KB/step) loops from
"Measured leak" above have not been re-run since the patch, and the approve one
has a known legitimate component (`ensureCode` caching, bounded by block count).
If a leak is ever reported again, re-measure those two the same way before
assuming anything.

## Arrow's registries, before and after — the direct counter evidence

Independent of any heap number: a `window.__arrowCounters` probe (see
"Re-measuring") over 800 nav steps shows every internal counter flat after the
patch.

| counter | before | after |
|---|---|---|
| `me` / `X.length` / `et.length` | **+2.10 per step**, unbounded | **0.00** |
| `he`, `tt.length`, `k.length`, `W.length`, `At.length`, `Ht`, `Q.size`, `Et.length` | 0.00 | 0.00 |

This is the cleanest single proof that the mechanism is gone, and it needs no
GC, no snapshot and no warmup — which is exactly why it should be the *first*
thing checked next time, before any byte-per-step figure is trusted.

## Two routes that are closed — do not re-litigate them

- **Periodically compacting the registries at a "quiescent" moment.** Requires
  proving an id is unused, and the only evidence arrow has is the raw-number
  `tt[]` arrays — exactly what crashed the `FinalizationRegistry` attempt. It
  re-adopts that unprovability *and* adds timing non-determinism, making the
  failure harder to reproduce. Worst possible combination for this codebase.
- **Shallow reactivity (deleting the auto-wrap in `Ut` entirely).** Mints zero
  ids, so the leak vanishes at the source — but the app reads deep
  (`b.approvedRows` on an element of `state.blocks`, and many more), so those
  reads stop tracking and the UI silently stops updating. The stille-wedge
  failure mode across the whole app.

## Upstream is a dead end (checked, don't re-check)

`@arrow-js/core` `dist-tags.latest` is **1.0.6** — exactly what is vendored,
published 2026-04-01. The upstream repo (`standardagents/arrow-js`) has had
**one** commit since the v1.0.6 release tag, and it is a docs footer credit. And
the 1.0.6 *source* still does `const id = ++index; listeners[id] = {}` with
`track()` pushing raw numbers, i.e. **the leak is unchanged in the newest
upstream code**. There is nothing to upgrade to.

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
6. **Warm up before the first sample.** The first pass through a block lazily
   fetches and renders its code/diff — legitimate, bounded growth that is not
   the leak. Without a warmup the first sample is dominated by it (measured:
   8102 B/step with `Nodes` +1884 over the first 50 steps, versus 471 B/step
   with `Nodes` +0 once warm). Drive ~150–200 steps *before* sampling starts.
   Check `Nodes` is +0 across the run; if it isn't, you are still measuring
   cache-fill, not the leak.
7. **Judge the SHAPE, not the per-step number.** Report "% of samples higher
   than the previous one" alongside bytes/step. A leak is ~90–100% climbing;
   the idle and inert controls sit at ~17–33% (GC sawtooth around a flat mean).
   A per-step number without that shape is not interpretable — the controls
   themselves measure 14–102 B/step depending on the run.

### The measurement trap that cost a round: a fresh page cannot distinguish a WeakMap from a leak

If a candidate fix stores things in a `WeakMap`, **do not measure it with one
fresh page per data point.** A `WeakMap` entry has a real one-time cost (V8's
EphemeronHashTable, roughly 16 B per slot; a reactive takes 3–8 entries across
the registries). A fresh page per measurement pays that build-up *every time*,
so it shows up as a constant bytes-per-iteration that is indistinguishable from
a genuine leak no matter how you vary N. This is exactly what happened: scaling
N over 2000/8000/32000 in fresh pages said the WeakMap change "barely helped"
(~92–129 B/iter, flat) and nearly got the whole direction discarded.

**What actually separates them: repeated identical rounds inside ONE page.** A
true leak charges the same amount every round forever; reclaimed-but-not-shrunk
capacity is paid once in round 1 and reused afterwards. Same data, correct
reading: round 1 cost 92.2 B/iter, rounds 2–8 averaged 4.9. Always include a
no-arrow control loop (allocate and drop a plain object) to establish the floor
— it decays to ~0.1 B/iter, which is how you know the harness itself is sound.

Corollary worth keeping: "flat" for a WeakMap-based fix means **flat after a
one-time capacity cost**, never a literal zero on first exposure to new content.

## A separate CPU stall, not a leak: Space felt "traag" on a large PR

Reported symptom (PR 13255, 166 blocks, 45 top-level rows): pressing Space to
approve-and-continue occasionally froze the tab for a beat. Not the heap leak
above — a genuine main-thread **longtask**, ~700-800ms, that only showed up
when a Space press happened to land near the 5s comment/chat/workflows poll
tick.

**Measured with Playwright + CDP `Profiler`** (not the heap tooling above —
`Profiler.start`/`Profiler.stop` around a burst of Space presses, plus a page-
side `PerformanceObserver({entryTypes:['longtask']})`) against the **live**
dev server (read-only repro: pressing Space does write an approval signal, so
prefer an isolated server per the heap-measurement recipe above for a repeat
run). The CPU profile's self-time was dominated by `directChildBlocks`
(`home.mjs`) and the arrow.js proxy `get` trap underneath it; the call tree
traced it to `commentScopeKeys` → `nestedPrBlocks` (recursive) →
`directChildBlocks`, i.e. the **`state.commentActivity` watch**
(`RelatedPanel.mjs`'s comment poll bumps `commentListSnapshot()`, which this
watch depends on) re-walking every top-level row's WHOLE subtree on every poll
tick. `subtreeApproveCount`'s `state.approvalSummaries` watch calls the exact
same `nestedPrBlocks`/`directChildBlocks` pair for the same reason (on every
`state.codeVersion` bump instead) — same cost, different trigger; that watch's
own counting logic is `prWideApproveTotal`'s territory, untouched here.

**Root cause:** `directChildBlocks` rebuilt a fresh `new
Map(state.allBlocks.map(...))` on every call, and `callRows`/`testCoverRows`
plus its own relations lookup were plain `.filter()`/`for...of` linear scans
over `state.callResolve`/`state.testCovers`/`state.relations` — each called
again from scratch for every node visited by the recursive walk. With ~45 top-
level rows each re-walking their own subtree, these four O(n) scans ran
hundreds of times per single watch trigger. **Fixing only the id-Map build
first barely moved the profile** — the filter/loop scans cost just as much;
all four needed the same treatment.

**Fix:** four memoized reverse-indexes (`allBlocksById`,
`relationsByParentId`, `callResolveByCallerId`, `testCoversByTestId`,
`home.mjs`, next to `referenceRowsCache`) — the same reference-identity cache
shape as `referenceRowsCache` (`home.mjs`) and `blockRowsCache` (`Block.mjs`):
`state.allBlocks`/`state.relations`/`state.callResolve`/`state.testCovers` are
always wholesale-reassigned, never mutated in place, so comparing the stored
array reference is a correct, exact invalidation check. Result: the same
25-Space-press burst that reliably produced a 1+ longtask now produces zero,
and `directChildBlocks`' self-time in the profile dropped from ~200-370ms to
~12ms. **Don't rebuild one of these Maps inline again** — reuse the shared
accessor instead, at any new call site that needs an id/caller/parent/test
lookup into these four arrays.

## A second instance of the same shape: `nestedPrBlocks`/`subtreeApproveCount` in the Underlying-code panel

Reported symptom (PR 13613, `ActionMessageService::dispatch`, a call site
resolving to 14 targets): Chrome's own "Page Unresponsive" dialog — a genuine
main-thread hang, not a caught error — while browsing `mode=diff` with that
call selected (`?sel=…ActionMessageService.php:45&mode=diff`), the
Underlying-code panel open with several cards. `data/debug-log.jsonl` had
nothing for this session (debug mode wasn't on), so this one was diagnosed
straight from a reviewer screenshot plus reading the code, not the log.

Same root cause shape as the fix directly above, a different call chain that
predates it and was never touched: `nestedPrBlocks(b)`
(`home.mjs`, the transitive PR-block closure under `b`, used to roll up
`subtreeApproveCount`) was called **from scratch, with a fresh `seen` Set,
every single time** — once per chip in `relatedChildren`, again inside
`nestedChangedKids`' own sort comparator (`Array.prototype.sort` calls a
comparator multiple times per element, so `subtreeApproveCount(x)` re-walked
`x`'s whole subtree on every comparison it took part in, not once), and again
recursively at every one of `nestedChangedKids`' `NESTED_DEPTH` (2) levels. On
a real, densely-connected PR (many call sites resolving into a small set of
shared helper methods — exactly the "one helper called from twenty blocks"
case `prWideApproveTotal`'s own comment already calls out) that redundant
re-walk multiplies badly and reads as the tab freezing solid, not as a
one-off slow frame.

**Fix:** `nestedPrBlocksCached(b)` (`home.mjs`, next to `nestedPrBlocks`) —
the same reference-identity cache shape as the four Maps above, keyed by
`b.id` this time. Safe because `nestedPrBlocks` depends only on the
`directChildBlocks` graph (those same four arrays), never on per-block
approval state, so caching its result needs no approval-aware invalidation.
Deliberately wraps **only** a genuine top-level call (the exported-shape
`nestedPrBlocks(b)` with the default fresh `seen`); the **internal**
recursive call `nestedPrBlocks(kid, seen)` inside `nestedPrBlocks` itself is
untouched, still threads its own explicit `seen`, and keeps its exact
per-call cycle/dedup semantics — so this cache changes nothing about which
blocks end up counted, only how many times the same subtree gets re-walked.
Every existing top-level call site (`recomputeLeftList`'s
`fileUnderlyingCount`, `prWideApproveTotal`, `subtreeApproveCount`,
`commentScopeKeys`) now goes through `nestedPrBlocksCached` instead. **Don't
call `nestedPrBlocks(b)` directly at a new top-level call site** — use
`nestedPrBlocksCached` the same way the four Maps above are reused rather
than rebuilt inline.

Verified live against the real PR 13613 server (not a synthetic fixture — the
freeze is data-shape-dependent, same caveat as the `Gt` crash below):
replaying the reported navigation (`f` to call granularity, a 20-press Space
burst, then `→`) with a `PerformanceObserver({entryTypes:['longtask']})` and a
CDP `Profiler` capture around it showed zero longtasks and a fully responsive
`page.evaluate` round trip afterwards.

## The `Gt` dispatch-array crash: "traag" was a silent crash, not a longtask

Reported symptom (PR 13451, real ~300-block PR, a deeply drilled review
session): "als ik diep zit, dan is de tree traag als ik een regel goedkeur" —
pressing Space deep inside a drilled Onderliggende-code column appeared to do
nothing, repeatedly.

**Not a CPU-bound longtask.** A CDP `Profiler` capture around the crashing
Space press showed under 2ms of actual self-time (`Gt` ~1.3ms, Prism ~1.3ms, a
`pf` helper ~1.3ms) — nowhere near longtask territory. It was a genuine,
100%-reproducible **crash**:

```
TypeError: f[d] is not a function
    at Gt (src/vendor/arrow.js:170:3332)
    at Object.set (src/vendor/arrow.js:170:2837)
    at applyNextUnapproved (src/home.mjs:11022:15)
    at src/home.mjs:11370:7
```

`src/home.mjs:11022` is `applyNextUnapproved`'s `state.drill =
state.drill.slice(0, common)`. `Gt` (upstream `emit`) dispatches every
listener subscribed to a reactive property by looping over its listener ARRAY
in place — `state.drill`/`state.drillCursor` normally has 2+ subscribers at
once (the columns-render effect that maps over `state.drill`, plus the
`?drill=`/`?dcur=` URL-mirroring watch, see `bindUrlState` in
`urlState.mjs`/`home.mjs`). One listener's own execution (the render effect,
rebuilding the drilled-columns list) can synchronously dispose ANOTHER
subscriber on the SAME property — LOCAL PATCH 2's cascading disposal tearing
down a drilled column's card as part of that very re-render — and that
disposal's `Yt` call splices the SAME shared listener array `Gt`'s own loop is
still mid-iteration over, corrupting the iteration. After the crash,
`applyNextUnapproved` aborts mid-function (the lines after 11022 —
`state.drillCursor`, `state.focusLevel`, `state.mode`, the scroll — never
run), so every subsequent Space press repeats the exact same crash: the
reviewer's approve-and-continue simply stops working, forever, with no visible
error (only a console `pageerror`) — which reads as "traag"/stuck, not as a
crash.

**Isolated to have nothing to do with drill depth.** A depth-vs-churn matrix,
measured against an isolated copy of PR 13451's real data (see "Re-measuring"
below for the harness, `SLASH_GITHUB=off SLASH_CLAUDE=off`, its own `-db`/
`-data`, worktrees symlinked read-only from `data/worktrees/pr-13451-*`):

| scenario | actions | pageerrors |
|---|---|---|
| drill depth 0, 80× `ArrowDown` | plain top-level group stepping | **0** |
| drill depth 1, `→`/`Esc` only, 40×, never `ArrowDown` | open/close the panel, same group | **0** |
| drill depth 1, only `ArrowDown`, 40×, panel never opened | plain `↓` inside the drilled column | **5** (same stack every time) |
| drill depth 1, `→`/`Esc`/`↓` mixed, 12-40× | panel + group-step churn | 2 → 35, scaling with rep count |
| drill depth 1, `→`/`Esc`/`↓`, only 9× | (below the threshold) | 0 — Space even auto-descended to depth 3 via approve-and-continue, working correctly |
| drill depth 2/3/6, ~9-40× mixed churn | any depth ≥ 1 | crashes reliably |
| a **fresh page load** restoring the exact same depth-6 state via `?drill=`/`?dcur=` (no interactive churn) | — | **0** — Space just works |

So: plain `↓` (changing a drilled column's own change-group cursor) repeated
roughly 10-40 times inside **any** drilled column (depth 1 is enough)
reproduces it, with **zero** Onderliggende-code-panel interaction required;
the identical repetition count at drill depth 0 never reproduces it. Depth
itself only matters insofar as reaching a deep drill session naturally
involves more of this churn (searching through many change groups per level
while hunting for the next resolved call) — it is not itself the trigger. A
freshly-loaded page landing directly on the same deep state via URL restore
never crashes, because it never repeated the churn that mutates the listener
array mid-dispatch.

**Fix:** LOCAL PATCH 4 in `src/vendor/arrow.js` — `Gt` snapshots the listener
array with `.slice()` before iterating (mirrors `Vt`'s own
`const t=J;J=[]`-before-iterating pattern a few lines below, just applied to
`Gt`'s per-property array instead of the global microtask queue), with a
`typeof c[d]=="function"` guard in the same defensive style as LOCAL PATCH 1.
See the LOCAL PATCH 4 entry in `.claude/rules/arrowjs-pitfalls.md` for the
exact before/after code and the restore instructions.

**Before/after, measured on the isolated PR-13451 harness** (5 runs × 40
`ArrowDown` presses at drill depth 1, fresh page per run, `pageerror` count):

| | run 1 | run 2 | run 3 | run 4 | run 5 | total |
|---|---|---|---|---|---|---|
| before (unpatched) | 4 | 4 | 4 | 4 | 4 | 20 |
| after (LOCAL PATCH 4) | 0 | 0 | 0 | 0 | 0 | **0** |

End-to-end confirmation on the exact reported repro (drill 6 levels deep along
`SessionFlow::run → drain → SessionConversion::rows → viewedByConverted →
ActivityOccurredData::__construct → deriveUtmMedium`, then press Space twice):
before the patch, every Space press threw and the URL/state never advanced;
after the patch, zero errors and the URL genuinely progresses (`dcur`'s last
segment moved from `group:0` to `group:14`, the drill path shrank by one
level) — the approve-and-continue actually works again.

**Regression test:** `tests/drill-listener-array-dispatch.spec.mjs` — the
cheap version (drill ONE level deep on the small synthetic PR 126 fixture,
hammer `ArrowDown` 40×, assert zero `pageerror`s), not a 6-level
reconstruction. **Important honesty note, so a future session doesn't
over-trust it:** this exact minimal fixture (2 blocks, one relation) does
**not** reliably reproduce the crash pre-patch — confirmed by reverting the
patch and running it (0/5 failures), even after raising the repetition count
to 150, adding a mocked comment-poll that changes its payload every tick
(simulating independent background reactive churn), and trying the richer
existing PR 100 (a real 3-level resolved-call chain: `execute` → `arrowHelper`
→ `arrowNested`) and PR 12903 (11 blocks) fixtures instead. Whatever makes the
disposal-triggered unsubscribe collide with `Gt`'s own dispatch loop needs a
reactive graph considerably denser than any of these — only the real
~300-block PR 13451 dataset reproduced it, reliably, within 10-40 presses.
**Don't spend more time trying to shrink the fixture further without new
evidence of what the missing ingredient is** — the spec is kept as a cheap
smoke/guard test for this interaction shape (drill one level, hammer `↓`,
column must survive) rather than as proof the bug reproduces there. The real
verification is the before/after table above, against the real, isolated
data.

### The `?dcur=`/`?drill=` "6→1 terugval" — investigated, NOT a bug

While isolating the crash above, replaying the task's own literal repro URL
(`?drill=...&dcur=group:7>3>1>0>14>...`) against a fresh page load only
restored 1-2 of its 6 drilled levels, which looked at first like a restore
mechanism bug (see "Bug found and fixed: a two-level-deep restore could
silently drop to one level" above — this looked like a deeper version of the
same class). **It is not.** A **self-consistent round trip** — drill the same
6 levels interactively, capture the resulting `?drill=`/`?dcur=` from that live
session, then reload the page with that EXACT URL — restores all 6 levels
correctly, every time. The literal task URL's group index (`group:7` for the
`SessionFlow::run → drain` step) simply did not match this dataset's actual
group index for that call site (found instead at group 8, 11, or 13 by
scanning) — most likely because PR 13451 has active `claude_chat`/pending-push
workflow runs (many `chat-gh-*`/`chatmerge-13451` entries in its workflow
store), so its head worktree content can genuinely move between when a link is
captured and when it's replayed later. Raw `?dcur=` group indices carry no
anchor (unlike an approval, see "An approval carries the CODE it approved"
above) — this is a **known, accepted** limitation of a shared drill link
against a moving PR, not a defect in `applyDrillRefRestore`'s own logic.
**Don't re-investigate this from a hand-typed/stale URL** — only distrust the
restore mechanism itself if a *freshly self-captured* round trip fails.

## The `Vt` flush-abort freeze: "ik zie het resultaat niet rechts" was a dead reactive graph

Reported symptom (PR 12112, real ~106-block PR): "Ik ben aan het navigeren in
blokken index … maar ik zie het resultaat niet rechts in code blok diff."
Sibling of the `Gt` crash above — same "an exception in the reactive dispatch
path is silent and permanent" family, one level up: not the per-property
listener array, but the **global microtask flush**.

**Measured, not inferred.** Headless Chromium against the live server, same key
sequence (`Escape`, `→`, then 6× `↓`), 0-error control PRs alongside:

| build | page errors at load | distinct `?sel=` over 6 ↓ |
| --- | --- | --- |
| PR 12112, unpatched | 10-29 (varies with timing) | **1** — frozen |
| PR 12112, `Vt` hardened | 8, logged only | **7** — normal |
| PR 12112, both fixes | **0** | 7 |
| PR 13455 / 13360 (control) | 0 | normal |

**Mechanism.** `ue` (upstream `queue`) marks an effect as queued with
`e[Ct]=!0` and re-queues only an effect whose flag is false. `Vt` clears that
flag **one effect at a time**, immediately before invoking it. So one uncaught
throw aborts `Vt`'s `for` loop and every effect behind it in that batch keeps
`[Ct] === true` while nothing holds it any more — never queued again, for the
lifetime of the page. The trailing `J.length&&queueMicrotask(Vt)` is skipped as
well. That is why the freeze looked like "the diff column doesn't follow" but
was actually total: the card title, the diff, and the `?sel=` URL mirror all
stopped, while `state.selected` was still being written on every keypress.

**Two things to take from this when a future symptom looks like this:**

1. **A frozen UI with no visible error is a flush casualty, not a render bug.**
   Check the browser console for ANY earlier throw — the effect that stopped
   updating is usually not the one that threw. `J.length` is 0 afterwards
   (nothing is queued), so an "is the queue stuck?" probe is misleading; the
   real evidence is the orphaned `[Ct]` flags.
2. **The trigger was data-dependent, so bisecting on block content lies.**
   Deleting the non-PHP whole-file blocks, or all TEST blocks, from a COPY of
   `graph.db` each "fixed" it once and then failed to reproduce with the same
   set — the throw is a timing race, and only the throw's own cause (a
   duplicate `.key()`, see `.claude/rules/arrowjs-pitfalls.md`) is
   deterministic. Bisect on the ERROR, not on the freeze.

Fixed by **LOCAL PATCH 5** (`Vt` + `Gt` per-callback `try/catch`, logging via
`console.error`) plus the app-level duplicate-key fix in `BlockList.mjs`'s
`rowKey`. Regression tests: `tests/index-row-key-collision.spec.mjs`.

## The `_ ← i ← Vt` Range-boundary throws — guard landed (LOCAL PATCH 6), root cause NOT reproduced

Reported from a large stress campaign (601-block, 3770-unit fixture PR,
`reindert-vetter/slash-test` PR #1, `pr/all-cases-1` — 276 changed files):
622 caught throws in `data/debug-log.jsonl` (581× `setStartBefore … Node has
no parent`, 39× `setEndAfter …`, 2× `insertNode … from the node itself`), all
with the identical stack shape `_ ← i ← Vt`. Every one was already caught by
LOCAL PATCH 5's `try/catch` (only `console.error`d), so each was invisible
without debug mode — but each is still one aborted render.

**ESTABLISHED, from reading `src/vendor/arrow.js` (see LOCAL PATCH 6 in
`.claude/rules/arrowjs-pitfalls.md` for the full writeup):**
`setStartBefore`/`setEndAfter`/`insertNode` occur exactly once in the whole
bundle, inside `_` — the LIS-based keyed-array diff helper nested in `re(t)`'s
array branch — in its "zero shared keys between the old and new MIDDLE range"
shortcut. That shortcut grabs two boundary DOM nodes from the OLD array
(`l`/`a`) and replaces the whole DOM range between them in one shot; before
this patch, only `l.parentNode` being falsy (from *either* it being genuinely
detached *or* it just not being the parent's first/last child) routed to a
`Range` call that throws when its argument has no parent at all. **LOCAL
PATCH 6** makes that guard explicit: bail with `return null` (the same
already-used bail-out contract every other early-exit in `_` uses) as soon as
either boundary node has no parent, before ever constructing the `Range`.

**HYPOTHESIS going in, INVESTIGATED, NOT CONFIRMED:** the leading theory was
the same disposal-timing race LOCAL PATCH 4 documents for `Gt`/emit (2+
subscribers on one reactive array property, one listener's render
synchronously disposing — via LOCAL PATCH 2's cascading disposal — a nested
subtree a second, not-yet-run listener for the SAME property still
references), landing in this specific, previously unexercised branch of `_`.

**What was actually tried** (all against the real `reindert-vetter/slash-test`
PR #1 fixture — 601 blocks, matching the reported order of magnitude,
ingested into a throwaway datadir/port, never touching the shared :8765
instance):

1. A temporary probe (`console.warn`, not committed) at the top of `_`'s
   `if(!$){...}` branch and inside the new guard, to see how OFTEN this
   branch is even reached and whether the guard would have fired.
2. Plain heavy navigation at `gran=line` (hundreds of `↓`/`↑` through the
   488-block index, repeated drilling into an Onderliggende-code child and
   hammering its own cursor) under a CDP `Emulation.setCPUThrottlingRate`
   slowdown (8x, then 20x) applied AFTER load — **0 guard fires** over ~3500
   keystrokes, even though the probe showed the `if(!$)` branch itself firing
   constantly and safely (~20-40 times per run, on small 2-5-item related-item
   lists that differ per block).
3. The same navigation, this time with **4 real separate browser tabs**
   running genuine CPU-bound busy-loops in the SAME browser process (actual
   OS-level contention, not just per-page throttling, to mirror "4 other
   browser sessions running" as literally as possible) — **0 guard fires**
   across 8 rounds (~5600 keystrokes), branch still hit safely every round.
4. Hammering the block-index **search box** with rapidly alternating queries
   (`Controller`→`Factory`→`a`→…→``, each producing a wildly different
   filtered subset) under the same 4-tab contention — the branch was hit only
   at load time, not during search filtering at all (search apparently keeps
   the underlying array shape stable rather than removing rows from it), so
   this angle produced no new samples.
5. One genuinely large sample: the ONE `oldLen:1 → newLen:471` hit captured
   during step 2's very first page load — BlockList's own top-level array
   transitioning from a 1-item loading/empty placeholder to the full,
   491-block list. This is a real full disjoint swap on a LARGE array (unlike
   the small per-block related-item lists), so 25 repeated fresh page loads
   (`page.goto` in a loop) under the SAME 4-tab contention plus CPU throttle
   applied THROUGH the load itself were run to resample this specific
   transition — **384 branch hits, 0 guard fires**.

**Conclusion, stated as plainly as the evidence allows:** the vulnerable
branch is not rare in absolute terms — it fired safely **~450 times** across
these campaigns, on both tiny (2-5 item) and one large (471-item) array, under
real multi-tab CPU contention — yet not once did a boundary node already lack
a parent. This weakens (without ruling out) the LOCAL PATCH 4-style
multi-subscriber race as the whole story: if a hit's crash probability were
even moderately independent-random, ~450 real hits should very plausibly have
surfaced at least one failure the way the reported campaign's presumably much
larger and longer run did. The gap between "622 throws in a real campaign"
and "0 throws in ~450 reproduced hits here" was **not closed** in this
session. Candidates not yet tried, for a future session picking this back up:
a genuine multi-PR/long-duration soak (hours, not minutes) rather than one
fixture in one sitting; real GitHub API latency (this repro ran with local
`gh`/network access but no sustained comment/ingest-refresh polling activity
layered on top); an actual second real browser process (not just extra tabs
in the same browser) contending for the OS scheduler; or a genuinely
different code path this session didn't stumble into (something that leaves a
disposed chunk's *individual* object reachable from a reconciler's own `e`
array without the whole reconciler being torn down — LOCAL PATCH 2/2b guards
the latter, not necessarily the former).

**What to do if the guard fires in production:** it will show up as a
`console.error`-free, silent `return null` today (the guard itself doesn't
log) — falling back to `_`'s slower general per-item path, which the existing
duplicate-key bail-outs already rely on and which is exercised on every
`Playwright` run. If it's ever suspected to be firing (e.g. a list that
should reorder doesn't, right after a burst of activity), temporarily restore
a `console.warn` at the guard site (see LOCAL PATCH 6's own comment in
`src/vendor/arrow.js` for the exact probe used here) rather than assuming
silence means it never fires.

No regression test added for the crash itself, since it was never
reproduced; LOCAL PATCH 6 is covered indirectly by the existing arrow.js
regression suite (`tests/step-preview-stability.spec.mjs`,
`tests/diff-code-vs-title.spec.mjs`, `tests/drill-listener-array-dispatch.spec.mjs`,
`tests/index-row-key-collision.spec.mjs`, `tests/related-nested-chip.spec.mjs`,
`tests/claude-other-tasks-hidden.spec.mjs` — all still pass unchanged with the
guard in place, confirming it doesn't alter any exercised behaviour).

## The Space-sequence freeze: `L`'s boundary-cycle walk — guard landed (LOCAL PATCH 7)

The cousin of LOCAL PATCH 6's stale-boundary throws, found during the
navigation-latency campaign against `reindert-vetter/slash-test` **PR #2**
(601 blocks, 3770 approvable units, 276 files) — and, unlike PATCH 6's class,
**reproduced deterministically, 5 out of 5 runs**. Very likely the same bug
the reviewer hits live regularly ("het kan zijn dat het vastliep in de
browser ... dat heb ik live ook heel vaak").

**Symptom:** a plain approve-and-continue **Space sequence** (synthetic
keydowns, one per settled predicate, ~15ms gap) froze the tab **hard** at
press ~190-203, every run, always on the same navigation state:
`?sel=testclass:tests/Feature/CartServiceTest.php::CartServiceTest&mode=diff&
tcol=1&chg=1&drill=…CartService::__construct>…PricingCalculator::__construct&
dcur=group:0>group:0&tmethod=…` — i.e. Space approving the last unit of a
two-level drilled subtree under a test-class method, the moment
`applyNextUnapproved` peels `state.drill` back while the block column swaps
between its cards and its `block-collapsed` rail in the same flush. "Hard"
means: renderer at 100% CPU forever, `page.evaluate(() => 1 + 1)` never
returns, no `pageerror`, no `console.error` — LOCAL PATCH 5 catches throws,
but this is not a throw.

**Evidence chain (in scratchpad harnesses, deliberately not committed — the
recipe below rebuilds them):**

1. A native `sample` of the frozen renderer: main thread 100% busy in JIT
   frames. Ten CDP `Debugger.pause` interrupts during the freeze: **all ten**
   landed on the identical 4-frame stack `L ← He ← qt ← Le` — the
   unmount-queue drain (`Le`) stashing a chunk for reuse (`He`), whose DOM
   move (`L`) never terminates.
2. Counter probes ruled out the queue itself: neither an `Le` re-queue chain
   (>400 chained drains) nor a `qt` call storm (>150k calls) ever fired —
   the loop is **inside one `L` call**.
3. A cycle detector inside `L` fired and captured the state: the chunk's
   `ref.f` and `ref.l` both detached text nodes, in **different parents**
   (or reversed within one parent at the first corruption, caught via a
   reachability pre-walk) — so the `f → nextSibling → … → l` walk never
   finds `l`, and because each visited node is `insertBefore`'d into the
   target as it goes, the sibling chain rewires into a **circle**.
4. The corrupted chunk was identified via its template/key: the
   **`block-collapsed` rail** (`railButtonHTML`, `collapsedRail.mjs` — the
   same template shape as the `drill-collapsed` rails, so they share one
   per-template reuse pool bucket).
5. A validation probe at STASH time (`He` entry) never fired across a full
   run: every chunk enters the reuse pool with **valid** boundaries. The
   refs get crossed **while the chunk sits in the pool** — i.e. its DOM is
   also still referenced/moved by a second administration (a mounted
   template), the "two administrations fight over the same chunks" class
   already described under "Never key a template whose entire body is one
   toggling expression" in `.claude/rules/arrowjs-pitfalls.md`. The first
   corrupt `L` call's stack ran through the keyed reconciler's
   disjoint-keys fast path adopting pooled chunks
   (`Vt ← s(rt effect) ← Ve-binding ← i ← _ ← y ← template ← je ← L`).

**What landed: LOCAL PATCH 7** (`src/vendor/arrow.js`) — `L` counts its
iterations; past 1024 it starts tracking visited nodes in a `Set` and aborts
with one `console.error("arrow: chunk boundary cycle detected, move
aborted")` on the first repeat. Hot path: two integer ops, zero allocation.
Verified live against the same fixture: the identical Space sequence ran
**650+ presses straight through the old freeze point**, with 4 bounded
aborts logged and navigation continuing normally after each — the
corrupted rail is rebuilt by the next re-render. The `console.error` is
deliberate: debug mode's console hook (`src/debugLog.mjs`) writes it to
`data/debug-log.jsonl`, so any live occurrence is now diagnosable instead
of being an unexplained dead tab.

**NOT fixed:** the underlying double-administration that corrupts the pooled
chunk's boundaries — same open status as PATCH 6's parentless `l`/`a`. If
that root cause is ever taken on, start from evidence point 5 above (stash
always valid, corruption in the pool) and the disposal-ordering machinery
PATCH 2/2b/4 already touch. And check `data/debug-log.jsonl` for the
`chunk boundary cycle` line first — its frequency in real sessions tells
whether the corruption is common (masked) or rare.

**Repro recipe:** isolated server on the PR #2 fixture datadir, fresh page,
`?sel=` at block 0, `→` into diff mode, then dispatch Space via
`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:' ',
bubbles:true}))` in a loop that waits per press for a DOM-signature change
(selected index row + `[data-change-active]` anchors + `location.search`)
with a 1.5s stuck-timeout and an `ArrowDown` recovery press on timeout.
Freeze (before the patch) lands within ~200 presses. Detect it from outside
the page: `Promise.race([page.evaluate(...), timeout])` — a frozen page
times out even on `1+1`.

## Navigation latency: the 200ms budget, measured per kind (Sep 2026 campaign)

Reviewer requirement: **every navigation action under 200ms**, measured from
keydown to the frame that paints the new content — distributions, never
averages. Fixture: `reindert-vetter/slash-test` PR #2 (601 blocks, 3770
units, 276 files), isolated server, 2500-step warmup before sampling (the
JIT trap above), machine at load average ~2-3 (moderate — an idle-machine
rerun of a suspicious number is cheaper than a wrong conclusion, see "pariteit,
geen regressie" in the earlier campaign).

**Measurement recipe (harness deliberately not committed, same policy as the
heap harness):** dispatch a synthetic `KeyboardEvent` in-page, then poll each
`requestAnimationFrame` until a DOM SIGNATURE changes — the signature is
(selected index row's `data-idx` + every `[data-change-active]` anchor's
`data-row` + `location.search`). Two traps this recipe exists to avoid,
both of which produced convincing-looking garbage first:
- **`location.search` alone is NOT a sufficient predicate**: an added/removed
  pair shares one `file:line`, so a real step between the two sides reads as
  "stuck"; and diff-mode `↓` legitimately stops at a file boundary, so a
  no-op press then "measures" whatever unrelated mutation (the 5s poll)
  lands next — that artifact read as "p90 948ms in diff mode", which was
  entirely false (real p90 with the signature predicate: 105ms, before any
  fix).
- **Space measurements MUST exclude no-op presses and use per-chunk stats**:
  the interesting failures only appear hundreds of presses in.

**Result after the fixes below (600-press Space run + 250-step runs per
kind): every kind p90 < 200ms.** list ↓/↑ p50 ~17ms; long jumps (far index
click) max 45ms; diff ↓ group p50 30 / p99 119ms; gran=line/call p99 < 55ms;
list↔diff, panels ↔, drill in/uit, search keystrokes all p99 < 110ms. Space:
p50 45-165ms depending on region (heaviest diffs ~165), p90 < 200 in every
100-press chunk, 8/600 presses in 200-227ms. Holding Space at key-repeat
rate (400 presses, 30ms interval): ~12 processed approvals/s, worst frame
gap 290ms, drain after release < 300ms, no freeze (LOCAL PATCH 7 above).

**What made Space slow (all fixed, worst first):**

1. **The freeze** — see "The Space-sequence freeze" above (LOCAL PATCH 7).
2. **`findNextUnapproved` re-walked every already-approved block with an
   awaited `ensureCode` each** — press latency grew linearly with approvals
   (p50 46 → 196ms after ~400 approvals; 0.7-1.5s over long approved
   stretches). Fixed in `firstUnapprovedInSubtree` (home.mjs): a subtree
   whose `state.approvalSummaries` entry says done === total is skipped
   without fetching code. Post-fix p50 is flat across 600 presses.
3. **One approve-signal POST per press starved the connection pool.** The
   approve tracker's history makes each `signals/set` O(history) server-side
   (measured ~0.9s/signal at 6.5k events / 49MB payloads, curl against an
   idle server): several such POSTs in flight exhausted the browser's 6
   connections and the NEXT press's `/api/code` fetch sat queued behind them
   (server read itself sub-ms from a separate connection, so this was purely
   client-side head-of-line blocking). Fixed twice: `approveSignalQueue`
   (home.mjs) serializes to one in-flight signal and coalesces per key
   (latest full-state body wins — that's the tracker contract), and
   `Engine.SignalWorkflow` (tembed) now passes its already-loaded history to
   `advanceLoaded` instead of a second full `LoadRun`, halving per-signal
   cost. NOT fixed (recommendation): the tracker history's unbounded growth
   itself — a real fix needs history compaction/continue-as-new in tembed,
   an architecture decision. With coalescing the growth is far slower, but a
   very long review still degrades the (async, off-path) signal drain.
4. **Render-path costs of the landing** (~180 → ~155ms on the heaviest
   blocks): `updateHints` measured a rect per changed row on every scroll
   event (now: first+last row only, coalesced to one rAF per frame, and
   style writes are skipped when unchanged — an unconditional write dirtied
   layout and made every scroll-tween frame's `scrollTop` assignment force a
   full re-layout); Prism re-tokenised every row on each pane rebuild (now:
   `highlight` memo per (lang, text), Block.mjs); and a cross-block landing
   glided a freshly mounted pane from scrollTop 0 (now: a fresh pane jumps,
   only steps within an already-visible card keep the glide —
   `scrollChangeIntoView`'s freshPane/`glidPanes`).

**What remains above the line, with numbers:** ~1.3% of Space presses on the
very heaviest diff blocks land at 200-227ms. The residual per-press CPU
there is the genuine rebuild of a large diff card: ~50ms layout under the
scroll tween/paint, ~36ms Tailwind Play-CDN MutationObserver scan of the
freshly-built class-carrying rows (irreducible without a build step — the
known ~20% post from the earlier campaign), ~30ms arrow.js flush, ~25ms
paneHTML string build. Getting those presses under 200ms would need
virtualizing/trimming the biggest diff DOMs — a design change, not a tweak.
