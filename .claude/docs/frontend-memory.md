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
