/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/@arrow-js/core@1.0.6/dist/index.mjs
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
/*
 * LOCAL PATCH 1 (slash) — re-apply after any arrow.js upgrade.
 * In the template-expression evaluator `rt(t,e)` (exported as watch), a binding
 * with a numeric slot `t` runs `W[t]()`. When a keyed node is torn down its slot
 * is freed (`ge` sets `W[t]=void 0`), but a reactive effect already queued for
 * that node can still fire in the microtask flush (`Vt`) *after* the slot is
 * gone, calling `W[t]()` on `undefined` → "W[t] is not a function". This use-
 * after-free crashes the drill flow (opening an Onderliggende-code child as its
 * own column re-scopes the panel and tears down cards mid-flush). The guard skips
 * a freed slot instead of calling it: `W[t]` only holds a non-function once its
 * slot has been recycled, so the effect is stale and its result is discarded
 * anyway. Original code was: `const d=i?W[t]():t();`
 */
/*
 * LOCAL PATCH 2 (slash) — re-apply after any arrow.js upgrade.
 * `re(t)` (the nested-render reconciler factory, exported upstream as
 * `createRenderFn(capture)`) is used by `Ve` (upstream `createNodeBinding`) at
 * its two call sites where an expression slot's value is itself a component /
 * array / `html` template — i.e. every `${() => someComponentCall(...)}` or
 * `${literalComponentCall(...)}` embedding (CommandMenu's rows, Block.mjs's
 * `${() => codeDiff(...)}`, RelatedPanel's related-item list, etc). `re()`'s
 * internal `e` (upstream `previous`) holds whatever is currently mounted for
 * that nested slot, but nothing ever disposes it when the *owning* node `n`
 * (upstream `parentChunk`) itself gets torn down via `Ft`/destroyChunk: `Ft`
 * only runs the cleanups in `n.u` that were registered directly against `n`
 * (its own attribute/event bindings) — it never cascades into a nested
 * reconciler's own currently-mounted subtree. That subtree (and every reactive
 * binding inside it — including ones reading globally-changing state like
 * `b.approvedRows`/`state.diffViewMode`) is left detached-but-referenced
 * forever: every navigation step that forces a fresh block-card key (see
 * detail-layout.md) permanently leaked its old card's nested diff-pane
 * subtree, which is what made memory grow unbounded on ordinary navigation
 * (confirmed via a heap-snapshot diff — see conventions.md's "disposal gap"
 * note for the numbers). The fix: `re(t)` now takes the owning node as `t` (an
 * existing parameter that upstream uses for its SSR-hydration `capture` flag —
 * dead in this build since esbuild tree-shook every `if(capture)` branch, so
 * `t` was provably unused here; confirmed by grepping the whole `re` body for
 * a standalone `t` token before repurposing it) and registers one cleanup on
 * it: `t&&(t.u??=[]).push(()=>{e&&qt(e,!0)})` — when `n` is destroyed, this
 * disposes whatever `e` (`previous`) currently holds via the SAME dispatch
 * (`qt`/removeUnmounted) that already tears down top-level content correctly
 * (cache-for-reuse vs. full destroy, chunk-or-array), so nested content now
 * gets exactly the disposal top-level content always got — nothing new, just
 * applied one level deeper, recursively (a nested reconciler's own nested
 * slots register their own cleanup on their own owner the same way, so this
 * cascades through arbitrarily deep embeddings without further changes). The
 * two call sites (`i=re()(r)` and `d=re()`) become `i=re(n)(r)` and `d=re(n)`
 * — `n` is `Ve`'s third parameter, already in scope at both sites.
 *
 * LOCAL PATCH 2b (slash) — part of the same one-line registration, kept
 * separate here because it fixes a crash the disposal above INTRODUCED.
 * Disposing `e` (`previous`) is not enough: the reconciler must also FORGET
 * it (`e=void 0`). `Ft`/destroyChunk nulls the chunk's own DOM boundaries
 * (`t.ref.f=t.ref.l=null`), so if the reconciler is ever invoked once more
 * after its owner was torn down — which happens for real, this is the same
 * class of late/queued effect LOCAL PATCH 1 guards against: a reactive
 * expression whose slot is still alive fires in the microtask flush after
 * the owning keyed node is gone — it takes the "replace what's mounted"
 * path on that dead chunk and does `B(o,c).after(...)`, where `B` returns
 * `o.ref.l` → null → "Cannot read properties of null (reading 'after')",
 * after which the whole reconciler is wedged (every later render of that
 * subtree throws, so navigation silently stops updating). Before PATCH 2
 * this was harmless (the chunk leaked but kept valid refs, so a late run
 * just patched a detached subtree — the documented leak); disposal turned
 * the leak into a use-after-free. With `e` cleared, a late run simply takes
 * the initial-mount path into the owner's own (detached) dom fragment and
 * throws nothing. Concretely reproducible before this: entering a block's
 * diff and pressing ↓ into a same-file neighbour block crashed on the
 * step-chevron slot's toggle and froze all further navigation — see
 * tests/step-preview-stability.spec.mjs and tests/diff-code-vs-title.spec.mjs.
 * Original PATCH 2 code was: `t&&(t.u??=[]).push(()=>{e&&(qt(e,!0),e=void 0)});` Verified
 * against the real (non-minified) upstream source for this exact version —
 * `createRenderFn`/`createNodeBinding`/`destroyChunk`/`removeUnmounted` in
 * https://cdn.jsdelivr.net/npm/@arrow-js/core@1.0.6/dist/index.mjs and
 * .../dist/chunks/internal-DchK7S7v.mjs — fetch those two files again to
 * re-verify this patch after an arrow.js upgrade (the chunk hash in the path
 * will differ per version). Original code was:
 * `function re(t){let e,n=Object.create(null);const i=function(o){...`
 * (no cleanup registration) and the two call sites above without the `n` arg.
 */
/*
 * LOCAL PATCH 3 (slash) — re-apply after any arrow.js upgrade.
 *
 * WHAT: a reactive's id is no longer a monotonic counter but the RAW TARGET
 * OBJECT itself, and the four registries keyed by that id become WeakMap /
 * WeakSet. Upstream mints `const id = ++index` and stores `listeners[id]={}`
 * in a module-level ARRAY; `ids` is a WeakMap so the proxy can be collected,
 * but `listeners[id]`/`parents[id]` are STRONG references from an array that
 * nothing ever clears. Every plain object/array that lands on reactive state
 * gets auto-wrapped (`createChild` via the get/set traps), so every navigation
 * step minted ids that were never reclaimed — an unbounded leak on ordinary
 * navigation. Measured before: 2.10 new ids per ↑/↓ step, forever. After: 0.00,
 * with every internal counter (`me`/`X`/`et`/`he`/`tt`/`k`/`W`) flat over 800
 * steps. See .claude/docs/frontend-memory.md for the full measurements.
 *
 * WHY THIS SHAPE, and not id-recycling: an earlier attempt recycled ids via a
 * FinalizationRegistry and crashed reproducibly, because `watch`'s dependency
 * bookkeeping (`tt[watchId]`, filled by `it`/`Ae`) stores RAW NUMBERS, which
 * the GC cannot see — so a reactive could be collected and its id reused while
 * a watch still held that number. Making the id an object reference closes that
 * hole for free: `it(t,e)` does `k[at].push(t,e)`, so a watch's dep array now
 * holds its reactives strongly and the "collected while still referenced"
 * window cannot exist. No registry, no free-list, no recycling. Nothing else
 * needed changing because the rest of the code only ever passes an id around
 * and compares it with `===`/`==` — nothing anywhere does arithmetic on it.
 *
 * MEASURING IT: warm up for THOUSANDS of steps before sampling, or you will
 * measure V8's JIT warming up and conclude the leak is still there. A/B with an
 * identical 2500-step warmup, 1200 sampled steps: unpatched +293 B/step and
 * still monotone, patched -88 B/step, net negative and oscillating — the shape
 * of the idle/inert controls. The same patched build reads 403 B/step after
 * only a 200-step warmup, which was briefly written up as "a second,
 * arrow-independent leak"; a heap-snapshot diff by type|name disproved it (the
 * residual is code|system / InstructionStream + TrustedByteArray, with no
 * JS-object category growing at all). See .claude/docs/frontend-memory.md,
 * "The second leak that wasn't".
 *
 * THE 16 EDITS (original → patched). Each anchor occurs exactly once:
 *  1. `dt=[],X=[]`                       → `dt=new WeakSet,X=new WeakMap`
 *  2. `let me=-1,he=0`                   → `let he=0`            (drop `me`)
 *  3. `Et=[],$t=[],`                     → `Et=[],$t=new WeakMap,`
 *  4. `reverse:1},et=[];`                → `reverse:1},et=new WeakMap;`
 *  5. `return dt[q(i)]=!0,rt(`           → `return dt.add(q(i)),rt(`
 *  6. `const e=++me;X[e]={};`            → `const e=t;X.set(e,{});`
 *  7. `let r=$t[t];r||(r=$t[t]={});`     → `let r=$t.get(t);r||(r={},$t.set(t,r));`
 *  8. `z(_)&&dt[q(_)]&&pt(`              → `z(_)&&dt.has(q(_))&&pt(`
 *  9. `const y=et[q(d)];`                → `const y=et.get(q(d));`
 * 10. `s||e==="value"&&dt[r]`            → `s||e==="value"&&dt.has(r)`
 * 11. `return z(t)&&dt[q(t)]`            → `return z(t)&&dt.has(q(t))`
 * 12. `pt`: `const i=et[t];…else et[t]=[];et[t].push([e,n])`
 *          → `let i=et.get(t);…else et.set(t,i=[]);i.push([e,n])`
 * 13. `Gt`: `const f=X[t][e];`           → `const f=X.get(t)[e];`
 * 14. `Mt`: `const e=et[t];`             → `const e=et.get(t);`
 * 15. `Ce`/`we`: `X[q(this)]`            → `X.get(q(this))`   (both)
 * 16. `Ae`/`Jt`: `X[i[f]]` / `X[t[n]]`   → `X.get(i[f])` / `X.get(t[n])`
 * Note `Lt.set(t,e).set(n,e)` is unchanged in TEXT but changes in MEANING: `e`
 * is now `t`, so both the raw target and the proxy resolve to the same
 * canonical object key. `q` itself is untouched.
 *
 * TO RESTORE UPSTREAM: reverse the 16 above — the four registries back to `[]`
 * (`dt`/`X`/`$t`/`et`), reinstate `let me=-1`, and turn every `.get(x)`/
 * `.set(x,v)`/`.add(x)`/`.has(x)` on them back into `[x]`/`[x]=v`.
 *
 * VERIFY AFTER RESTORING OR UPGRADING: on the CODE line only (the last line of
 * this file — this comment block quotes the originals, so grepping the whole
 * file always false-positives), no bare `X[`, `et[`, `dt[` or `$t[` may remain
 * (they must all be map calls) and no identifier `me` may remain. Quick check:
 *   tail -1 src/vendor/arrow.js | grep -c 'dt=new WeakSet,X=new WeakMap'   # 1
 *
 * Minified ↔ upstream name map for this patch (traced against
 * `@arrow-js/core@1.0.6`, `dist/chunks/internal-DchK7S7v.mjs` — the chunk hash
 * differs per version, refetch it to re-verify):
 *   X  = listeners          et = parents         dt = computedIds
 *   $t = arrayMutationWrappers                   Lt = ids
 *   q  = getId              me = index           nt = reactive
 *   it = track              Ae = stopTracking    Jt = flushListeners
 *   Gt = emit               Mt = emitParents     pt = linkParent
 *   Ut = createChild        _e = trackArray      k  = trackedDependencies
 *   tt = watchedDependencies
 *
 * Note that 1.0.6 is the newest upstream release (published 2026-04-01) and
 * its source still has this leak, so there is currently nothing to upgrade to.
 */
/*
 * LOCAL PATCH 4 (slash) — re-apply after any arrow.js upgrade.
 *
 * `Gt(t,e,n,i,r)` (upstream `emit`) dispatches every listener subscribed to a
 * reactive property: when there are 2+ subscribers on the same property (the
 * common case for `state.drill`/`state.drillCursor`, which have both the
 * columns-render effect and the `?drill=`/`?dcur=` URL-mirroring watch
 * subscribed at once — see urlState.mjs's `bindUrlState`), `f` is an ARRAY and
 * `Gt` loops over it in place: `for(let d=0;d<f.length;d++)f[d](n,i)`. One of
 * those listener calls can, SYNCHRONOUSLY and as a side effect of its own
 * render (a nested reconciler subtree torn down via LOCAL PATCH 2's cascading
 * disposal, e.g. closing a drilled column), reach `Yt`/`Xt` (`stopTracking`'s
 * unsubscribe / `track`'s subscribe) for THIS SAME property — which mutate
 * `f` IN PLACE (`i.splice(r,1)` in `Yt`, `i.push(n)` in `Xt`). A splice mid-
 * loop shifts every later index down by one, so the loop's next `f[d]` can
 * read the element that was already invoked, skip one entirely, or land past
 * the new shorter length — observed as `TypeError: f[d] is not a function`
 * (a shifted slot lands on something that isn't a listener). Reported
 * symptom: "als ik diep zit, dan is de tree traag als ik een regel goedkeur"
 * — approving repeatedly did nothing because `applyNextUnapproved`'s
 * `state.drill = state.drill.slice(0, common)` crashed inside this dispatch,
 * silently aborting the rest of that function on every subsequent Space
 * press. Isolated to NOT be about drill depth at all (see
 * .claude/docs/frontend-memory.md's "The Gt dispatch-array crash" section for
 * the full depth-vs-churn measurements): plain `↓` (changing a drilled
 * column's own change-group cursor) inside ANY drilled column, repeated
 * ~10-40 times, reproduces it with zero Onderliggende-code panel interaction
 * and zero dependency on how many levels are drilled; the same repetition
 * count at drill depth 0 (no drilled column at all) never reproduces it,
 * because a top-level step's reactive fan-out is simpler and never grows a
 * same-property listener array to 2+ entries whose owners can dispose of each
 * other mid-dispatch. The fix: `Gt` snapshots the listener array with `.slice()`
 * before iterating, so a listener call that mutates the ORIGINAL array via
 * `Yt`/`Xt` can never affect the snapshot still being walked — mirrors `Vt`'s
 * own `const t=J;J=[]` snapshot-before-iterating pattern a few lines below,
 * just applied to `Gt`'s per-property array instead of the global microtask
 * queue. The `typeof c[d]=="function"` guard mirrors LOCAL PATCH 1's "skip a
 * released slot" style, defensively, even though a `.slice()` copy cannot
 * itself develop a hole — the guard is cheap and matches this file's existing
 * defensive style for a stale/mid-flight callback.
 * Original code was:
 * `function Gt(t,e,n,i,r){const f=X.get(t)[e];if(f)if(Array.isArray(f))for(let d=0;d<f.length;d++)f[d](n,i);else f(n,i);r&&Mt(t)}`
 * TO RESTORE UPSTREAM: replace the patched `Gt` body above with the original
 * one-liner quoted above (drop the `.slice()` snapshot and the
 * `typeof c[d]=="function"` guard, go back to iterating `f` directly).
 */
/*
 * LOCAL PATCH 5 (slash) — re-apply after any arrow.js upgrade.
 *
 * WHAT: one throw inside a reactive callback no longer kills the reactive
 * graph. `Vt` (upstream `flush`, the microtask that drains the effect queue)
 * now wraps each queued effect AND each `nextTick` callback in its own
 * try/catch, and `Gt` (upstream `emit`, see LOCAL PATCH 4 right above) does
 * the same around every listener call in both of its branches. All four
 * catches only `console.error` — nothing is swallowed silently.
 *
 * WHY, and why "defensive" understates it: this is the difference between one
 * broken render and a permanently dead page. `ue` (upstream `queue`) marks an
 * effect as queued with `e[Ct]=!0` and only ever re-queues an effect whose
 * flag is false; `Vt` clears that flag one effect at a time, immediately
 * before invoking it. So an uncaught throw from effect n aborts the `for`
 * loop, and every effect from n+1 onward keeps `[Ct] === true` while nothing
 * holds it any more: `ue` will never queue it again, for the lifetime of the
 * page. The trailing `J.length&&queueMicrotask(Vt)` is skipped too. The
 * reported symptom was total: on PR 12112 stepping through the block index
 * stopped updating the diff column, the card title, AND the `?sel=` URL
 * mirror — `state.selected` was still being written by the keydown handler,
 * but not one subscriber ever heard it again. Measured A/B on that PR (same
 * fixture, same key sequence): unpatched 29 page errors and 1 distinct
 * selection over 6 ↓ presses; patched 7 distinct selections, effect queue
 * draining to 0, with the 8 load-time errors merely logged.
 *
 * The throw that exposed it was a duplicate `.key()` in the block index
 * (fixed at the same time in src/BlockList.mjs's `rowKey` — a comment index
 * item has no `file`/`side`, so two items with the same 60-char body snippet
 * keyed identically), but the fix here is deliberately NOT about that bug:
 * every entry in .claude/rules/arrowjs-pitfalls.md is a way for a render to
 * throw mid-flush, and none of them should be able to take navigation with
 * it. Same reasoning as LOCAL PATCH 1's "skip a released slot" guard, applied
 * one level up: keep going, log, and let the rest of the batch run.
 *
 * Original code was:
 * `function Vt(){const t=J;J=[];const e=wt;wt=[];for(let n=0;n<t.length;n++){const i=t[n],r=i._n,s=i._o;i._n=void 0,i._o=void 0,i[Ct]=!1,i(r,s)}for(let n=0;n<e.length;n++)e[n]();J.length&&queueMicrotask(Vt)}`
 * and (on top of LOCAL PATCH 4)
 * `function Gt(t,e,n,i,r){const f=X.get(t)[e];if(f)if(Array.isArray(f)){const c=f.slice();for(let d=0;d<c.length;d++)typeof c[d]=="function"&&c[d](n,i)}else f(n,i);r&&Mt(t)}`
 * TO RESTORE UPSTREAM: put those two one-liners back — i.e. drop all four
 * try/catch wrappers, returning `i(r,s)`/`e[n]()`/`c[d](n,i)`/`f(n,i)` to
 * bare calls. Note LOCAL PATCH 4's `.slice()` snapshot in `Gt` must SURVIVE
 * that; only the try/catch belongs to this patch.
 *
 * Minified ↔ upstream name map (same trace as PATCH 3/4): `Vt` = `flush`,
 * `ue` = `queue`, `Ct` = the "already queued" symbol, `J` = the effect queue,
 * `wt` = the nextTick queue, `Gt` = `emit`.
 */
/*
 * LOCAL PATCH 6 (slash) — re-apply after any arrow.js upgrade.
 *
 * WHAT: a defensive guard, one line, in the keyed-array reconciler's LIS-diff
 * helper (called `_` in this build — nested inside `re(t)`'s array branch,
 * the same `re`/array-reconcile machinery LOCAL PATCH 2/2b/4 already patch).
 * Its "no shared keys at all between the old and new middle range" shortcut
 * (`if(!$){...}`) grabs two boundary DOM nodes from the OLD array (`l`, the
 * first node of `o[D]`; `a`, the last node of `o[g]`) and tries to replace
 * the whole DOM range between them in one shot — via `Node.replaceChildren`
 * when they're literally the parent's first/last child, otherwise via a
 * `Range` (`setStartBefore`/`setEndAfter`/`deleteContents`/`insertNode`).
 * Before this patch, only `l.parentNode` was checked for truthiness to
 * choose between those two paths — a falsy `parentNode` (i.e. `l` already
 * detached, no parent at all) fell through to the `Range` branch instead of
 * being treated as an error, and `Range.setStartBefore`/`setEndAfter` throw
 * `Node has no parent` (or `insertNode` throws when the fragment being
 * inserted contains the context node itself) when their argument has no
 * parent. The guard now bails (`return null`) as soon as EITHER boundary
 * node (`l` or `a`) has no parent, before ever constructing the `Range` —
 * `_` returning `null` is an existing, already-exercised contract: every
 * other early-exit in `_` (duplicate key, shape mismatch, …) does exactly
 * this, and the caller (`re(t)`'s array branch) already falls back to its
 * slower, general per-item reconcile path whenever `_` declines. Original
 * code was:
 * `const I=l.parentNode;if(I&&l===I.firstChild&&a===I.lastChild)I.replaceChildren(x);else{const A=document.createRange();A.setStartBefore(l),A.setEndAfter(a),A.deleteContents(),A.insertNode(x)}`
 * Patched code is:
 * `const I=l.parentNode;if(!I||!a.parentNode)return null;if(l===I.firstChild&&a===I.lastChild)I.replaceChildren(x);else{const A=document.createRange();A.setStartBefore(l),A.setEndAfter(a),A.deleteContents(),A.insertNode(x)}`
 *
 * WHY (established vs. hypothesis — read both, they are not the same thing):
 * ESTABLISHED, from reading this file: `setStartBefore`/`setEndAfter`/
 * `insertNode` occur exactly once in this whole bundle, in this exact
 * construction, so a caught throw with that error text and the stack shape
 * `_ ← i ← Vt` (an array-reconcile helper called from the per-slot
 * reconciler closure `i`, called from the microtask flush `Vt` — see LOCAL
 * PATCH 4/5's own name map for `i`/`Vt`) can only originate here. Nothing
 * in this `_`-branch mutates the DOM before the `parentNode` read (the
 * key-overlap scan above it, computing `R`/`V`/`$`, only reads), so for `l`/
 * `a` to already be parentless the STALE state must come from before `_`
 * was even called — i.e. from the reconciler's own `e`/`previous` closure
 * (the same array LOCAL PATCH 2/2b already had to guard elsewhere for being
 * used-after-disposal).
 * HYPOTHESIS, NOT verified against a captured live repro: the leading
 * theory is that this is the same disposal-timing gap LOCAL PATCH 4
 * documents for `Gt`/emit (2+ subscribers on one reactive array property,
 * where one listener's own render synchronously disposes a nested
 * reconciler subtree — LOCAL PATCH 2's cascading disposal — that a SECOND,
 * not-yet-run listener for the same property still references), just
 * reaching a shortcut branch of `_` that nobody had exercised/instrumented
 * before. It plausibly explains every reported observation (near-zero
 * throws on a quiet repeat of the same key sequence — this exact "zero
 * shared keys in one flush tick" shape is rare under normal navigation;
 * a burst of throws under real CPU contention with other browser sessions —
 * a slower main thread lets more unrelated listeners pile up on the same
 * property before this one runs, and `gran=line`'s much larger keyed lists
 * inside a drilled column make a full, disjoint key-set swap far more
 * reachable) — but this was derived from reading the reconciler algorithm
 * statically, not from an isolated Playwright repro or an inspected real
 * stack trace (the debug-log this was reported from was recorded against a
 * separate throwaway instance/datadir, not this checkout). Investigation
 * (a CPU-throttled stress repro against a large fixture, plus temporary
 * instrumentation confirming or refuting exactly which prior disposal made
 * `l`/`a` parentless) is intended to follow this patch, not precede it —
 * see the "under investigation" note this points to for the outcome.
 *
 * WHAT THIS GUARD DOES NOT DO: it does not fix whatever earlier event left
 * `l`/`a` parentless — it only stops that state from reaching a DOM API that
 * throws on it, the same "skip/bail on stale state instead of crashing"
 * philosophy as LOCAL PATCH 1's released-slot guard. If the hypothesis above
 * is right, the real fix (if one turns out to be needed beyond this bail)
 * would live in the disposal-ordering machinery LOCAL PATCH 2/2b/4 already
 * touch, not here.
 *
 * TO RESTORE UPSTREAM: replace the patched one-liner above with the quoted
 * original (drop the `if(!I||!a.parentNode)return null;` guard).
 *
 * Minified ↔ upstream name map: NOT independently re-verified against a
 * freshly fetched `@arrow-js/core@1.0.6` source for this patch (no network
 * access at the time of writing) — `_`'s upstream name is inferred from
 * position/behavior only (the LIS-based keyed-array diff helper inside
 * `re`/`createRenderFn`'s array branch), not traced the way PATCH 2/3/4/5's
 * maps were. Re-verify against the real upstream source on the next
 * arrow.js upgrade, same as the other patches.
 */
/*
 * LOCAL PATCH 7 (slash) — re-apply after any arrow.js upgrade.
 *
 * WHAT: a cycle guard in `L` (the chunk DOM mover: walks a chunk's node range
 * `ref.f .. ref.l` via nextSibling and insertBefore's each node into the
 * target container). Upstream's walk is `for(;;){const s=i===r?null:
 * i.nextSibling; if(e.insertBefore(i,n||null),!s)return; i=s}` — it
 * terminates only when the walk reaches `ref.l` or a null nextSibling. When a
 * chunk's boundaries are CORRUPTED (`ref.f` and `ref.l` in different parents,
 * or reversed within one parent), inserting each walked node into `e` can
 * make the walk re-encounter nodes it already moved — appending node X into
 * `e` rewires X.nextSibling to whatever was appended after it earlier, so the
 * chain becomes CIRCULAR and the loop never exits: a genuine, permanent,
 * 100%-CPU main-thread freeze (Chrome's "Page Unresponsive" dialog; even a
 * trivial CDP evaluate blocks forever).
 *
 * MEASURED, not theoretical: against the reindert-vetter/slash-test PR #2
 * fixture (601 blocks), a plain approve-and-continue Space sequence froze the
 * tab HARD at press ~190-203, 5/5 runs, always on the same navigation state
 * (a test_class row with a two-level drill open, Space approving the last
 * unit of the drilled subtree — applyNextUnapproved peeling state.drill while
 * the block column collapses/expands its rail in the same flush). Ten
 * Debugger.pause samples during the freeze all landed inside this exact loop
 * (`L` ← `He` ← `qt` ← `Le`, i.e. the unmount-queue drain stashing a chunk
 * whose boundaries had been corrupted earlier — first corruption observed on
 * the `block-collapsed` rail chunk while a keyed list adopted pooled chunks:
 * boundary-validation probes showed every STASH still valid, so the refs get
 * crossed while the chunk sits in the reuse pool, i.e. two administrations
 * (a mounted template and the pool) sharing one chunk's DOM. See
 * "The Space-sequence freeze" in .claude/docs/frontend-memory.md for the
 * full evidence chain and the repro recipe.)
 *
 * THE GUARD: count iterations; past 1024 (no legitimate chunk has >1024
 * TOP-LEVEL nodes — a template's top-level node count is its static shape,
 * the app's biggest is a handful; the diff panes are single-element
 * .innerHTML bindings) start recording visited nodes in a Set and abort with
 * one console.error the moment a node repeats. The hot path (every mount/
 * stash of every chunk) allocates nothing and gains two integer ops; only a
 * walk that is already pathological pays for the Set. Like LOCAL PATCH 5
 * this does NOT fix the underlying corruption — it converts "the tab is
 * permanently dead, work lost" into "one rail renders wrong once and the
 * next re-render rebuilds it" (verified live: the frozen Space sequence
 * continues normally past the abort). The console.error line is deliberate:
 * debug mode's console.error hook (src/debugLog.mjs) writes it to
 * data/debug-log.jsonl, so a live occurrence is diagnosable afterwards.
 *
 * TO RESTORE UPSTREAM: replace the patched `L` with the quoted original
 * above (drop `c`/`f` and the cycle check).
 *
 * Minified ↔ upstream name map: `L` is the chunk-range DOM mover used by
 * `He` (stash-for-reuse) and `je` (template mount/remount); inferred from
 * behavior, not re-traced against upstream source (same caveat as PATCH 6).
 */
const Ct=Symbol();let J=[],wt=[],ut=null;function ce(t){return J.length?new Promise(e=>wt.push(()=>{t?.(),e()})):Promise.resolve(t?.())}function M(t){return typeof t=="function"&&!!t.isT}function v(t){return t!==null&&typeof t=="object"}function z(t){return v(t)&&"$on"in t}function j(t){return v(t)&&"ref"in t}function ue(t){const e=t;return(n,i)=>{e[Ct]||(e[Ct]=!0,e._n=n,e._o=i,J.length||queueMicrotask(Vt),J.push(e))}}function Vt(){const t=J;J=[];const e=wt;wt=[];for(let n=0;n<t.length;n++){const i=t[n],r=i._n,s=i._o;i._n=void 0,i._o=void 0,i[Ct]=!1;try{i(r,s)}catch(f){console.error("arrow: reactive effect threw",f)}}for(let n=0;n<e.length;n++)try{e[n]()}catch(f){console.error("arrow: nextTick callback threw",f)}J.length&&queueMicrotask(Vt)}function Wt(t){const e=ut;return ut=t,e}function le(t){ut?.push(t)}function de(t){const e=ut;if(!e)throw Error("onCleanup needs component");let n=1;const i=()=>n--&&(e.splice(e.indexOf(i),1),t());return e.push(i),i}function Tt(t,e,n){e===".innerhtml"&&(e=".innerHTML"),(e==="value"&&"value"in t||e==="checked"||e[0]==="."&&(e=e.slice(1)))&&(t[e]=n,t.getAttribute(e)!=n&&(n=!1)),n!==!1?t.setAttribute(e,n):t.removeAttribute(e)}const W=[],At=[],Pt=[],Ht=[];let St=0;function ae(t){const e=Ht[t],n=e?.length?e.pop():St;return W[n]=t,n===St&&(St+=t+1),n}function pe(t,e,n=0){const i=W[e];for(let r=1;r<=i;r++){const s=t[n+r-1],f=e+r;if(Object.is(W[f],s))continue;W[f]=s;const d=At[f];if(!d)continue;const _=Pt[f];_!==void 0?Tt(d,_,s):typeof d=="function"?d(s):d.data=s||s===0?s:""}}function lt(t,e,n){At[t]=e,Pt[t]=n}function ge(t){const e=W[t];if(e!==void 0){for(let n=0;n<=e;n++)W[t+n]=void 0,At[t+n]=void 0,Pt[t+n]=void 0;(Ht[e]??=[]).push(t)}}const Lt=new WeakMap,dt=new WeakSet,X=new WeakMap,q=t=>Lt.get(t);let he=0,at=0;const k=[],tt=[],Et=[],$t=new WeakMap,ye={push:1,pop:1,shift:1,unshift:1,splice:1,sort:1,copyWithin:1,fill:1,reverse:1},et=new WeakMap;function nt(t){if(typeof t=="function"){const i=nt({value:void 0});return dt.add(q(i)),rt(t,r=>i.value=r),i}if(z(t))return t;if(!v(t))throw Error("Expected object");const e=t;X.set(e,{});const n=new Proxy(t,xe);return Lt.set(t,e).set(n,e),n}function _e(t,e,n,i){if(typeof i=="function"&&ye[e]){let r=$t.get(t);r||(r={},$t.set(t,r));let s=r[e];return s||(s=(...f)=>{const d=Reflect.apply(i,n,f);return Mt(t),d},r[e]=s),s}return zt(i)?Qt(i,t,e):(e!=="length"&&typeof i!="function"&&it(t,e),i)}const xe={has(t,e){return e in Bt?!0:(it(q(t),e),e in t)},get(t,e,n){const i=q(t);if(e in Bt)return Bt[e];const r=Reflect.get(t,e,n);let s;v(r)&&!z(r)&&(s=Ut(r,i,e),t[e]=s);const f=s??r;return Array.isArray(t)?_e(i,e,t,f):zt(f)?Qt(f,i,e):(it(i,e),f)},set(t,e,n,i){const r=q(t),s=!(e in t),f=v(n)&&!z(n)?Ut(n,r,e):null,d=t[e],_=f??n;z(_)&&dt.has(q(_))&&pt(q(_),r,e);const C=Reflect.set(t,e,_,i);if(d!==_&&z(d)&&z(_)){const y=et.get(q(d));if(y){let S=-1;for(let w=0;w<y.length;w++){const[T,F]=y[w];if(T==r&&F==e){S=w;break}}S>-1&&y.splice(S,1)}pt(q(_),r,e)}return Gt(r,e,n,d,s||e==="value"&&dt.has(r)),Array.isArray(t)&&e==="length"&&Mt(r),C}};function Ut(t,e,n){const i=nt(t);return pt(q(t),e,n),i}function zt(t){return z(t)&&dt.has(q(t))}function Qt(t,e,n){const i=q(t);return it(e,n),pt(i,e,n),it(i,"value"),t.value}function pt(t,e,n){let i=et.get(t);if(i)for(let r=0;r<i.length;r++){const[s,f]=i[r];if(s===e&&f===n)return}else et.set(t,i=[]);i.push([e,n])}function Gt(t,e,n,i,r){const f=X.get(t)[e];if(f)if(Array.isArray(f)){const c=f.slice();for(let d=0;d<c.length;d++)if(typeof c[d]=="function")try{c[d](n,i)}catch(m){console.error("arrow: listener threw",m)}}else try{f(n,i)}catch(c){console.error("arrow: listener threw",c)}r&&Mt(t)}function Mt(t){const e=et.get(t);if(e)for(let n=0;n<e.length;n++){const[i,r]=e[n];Gt(i,r)}}function Ce(t,e){Xt(X.get(q(this)),t,e)}function we(t,e){Yt(X.get(q(this)),t,e)}const Bt={$on:Ce,$off:we};function it(t,e){at&&k[at].push(t,e)}function Te(){k[++at]=Et.pop()??[]}function Ae(t,e){const n=at--,i=k[n],r=tt[t],s=r?.length;if(s&&s===i.length){let f=!0;for(let d=0;d<s;d++)if(r[d]!==i[d]){f=!1;break}if(f){tt[t]=r,i.length=0,Et.push(i),k[n]=void 0;return}}Jt(r,e);for(let f=0;f<i.length;f+=2)Xt(X.get(i[f]),i[f+1],e);tt[t]=i,k[n]=void 0}function Jt(t,e){if(t){for(let n=0;n<t.length;n+=2)Yt(X.get(t[n]),t[n+1],e);t.length=0,Et.push(t)}}function Xt(t,e,n){const i=t[e];if(!i){t[e]=n;return}if(Array.isArray(i)){i.includes(n)||i.push(n);return}i!==n&&(t[e]=[i,n])}function Yt(t,e,n){const i=t[e];if(i){if(Array.isArray(i)){const r=i.indexOf(n);if(r<0)return;if(i.length===2){t[e]=i[r?0:1];return}i.splice(r,1);return}i===n&&delete t[e]}}function rt(t,e){const n=++he,i=typeof t=="number";let r=ue(s);function s(){Te();const d=i?(typeof W[t]=="function"?W[t]():void 0):t();return Ae(n,r),e?e(d):d}const f=()=>{Jt(tt[n],r),tt[n]=void 0,i&&lt(t),r=null};return i||le(f),i&&lt(t,s),[s(),f]}const Pe=(async()=>{}).constructor;function Se(t){return this.k=t,this}const Ee={get(t,e){return t[0]?.[e]},has(t,e){return e in(t[0]||{})},ownKeys(t){return Reflect.ownKeys(t[0]||{})},getOwnPropertyDescriptor(t,e){const n=t[0];return n&&{configurable:!0,enumerable:!0,writable:!0,value:n[e]}},set(t,e,n){return!!t[0]&&Reflect.set(t[0],e,n)}},Me={get(t,e){return t.k.includes(e)?t.s[e]:void 0},set(t,e,n){return t.k.includes(e)?Reflect.set(t.s,e,n):!1}};function Zt(t,...e){return e.length?new Proxy({k:e,s:t},Me):t}function vt(t,e){if(e||t.constructor===Pe)throw Error("Async runtime missing.");return((n,i)=>({h:t,k:void 0,p:n,e:i,key:Se}))}function b(t){return!!t&&typeof t=="object"&&"h"in t}function Be(t,e,n){const i=nt({0:t,1:e,2:n}),r=((s,f)=>{const d=i[2]?.[s];typeof d=="function"&&d(f)});return[new Proxy(i,Ee),r,i]}const gt=Symbol();let ot=-1;const st=[],Dt=[],Kt="\xA4",mt=`<!--${Kt}-->`,kt=1024,te=new WeakMap,Ot=new WeakMap,ft=new Map,Q=new Map;let G,De=0;ne(kt);function L(t,e,n){let i=t.f;if(!e||!i)return;const r=t.l;let c=0,f=null;for(;;){if(++c>1024&&(f||(f=new Set),f.has(i))){console.error("arrow: chunk boundary cycle detected, move aborted");return}f&&f.add(i);const s=i===r?null:i.nextSibling;if(e.insertBefore(i,n||null),!s)return;i=s}}function Rt(t,e){return e.g===ht(t).g}function ht(t){const e=t._p;return e||(t._p=ee(t._s))}function ee(t,e){const n=document;let i=e?void 0:Ot.get(t);const r=i?.get(n);if(r)return r;const s=t.join(mt),f=e?`${Kt}${s}`:s;let d=te.get(n);d||(d={},te.set(n,d));const _=d[f];if(_)return e||(i??=new WeakMap,i.set(n,_),Ot.set(t,i)),_;const C=document.createElement("template");if(e){C.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`;const F=C.content.firstChild;if(F){const u=C.content;for(;F.firstChild;)u.appendChild(F.firstChild);u.removeChild(F)}}else C.innerHTML=s;const y=$e(C.content);Ue(C.content);const S=t.length-1;let w=0;for(let F=0;F<y[0].length;)F+=(y[0][F+1]??0)+3,w++;if(w!==S)throw Error("Invalid HTML position");const T={template:C,paths:y,g:f,expressions:S};return e||(i??=new WeakMap,i.set(n,T),Ot.set(t,i)),d[f]=T,T}function U(t,e,n=!1){if(e._t===t){e.k=t._k,e.i=t._i,t._h=e,t._m=n;return}if(e._t&&e._t!==t){const i=e._t;i._h===e&&(i._m=!1,i._h=void 0)}e._t=t,e.k=t._k,e.i=t._i,t._h=e,t._m=n,pe(t._a,e.e)}function Nt(t){const e=t._t;e._h===t&&(e._m=!1,e._h=void 0)}function ne(t){let e,n;for(let i=0;i<t;i++){const r={paths:[[],[]],dom:null,ref:{f:null,l:null},_t:null,e:-1,g:"",b:!1,r:!0,st:!1,u:null,v:null,s:void 0,k:void 0,i:void 0,bkn:void 0,next:void 0};n?n.next=r:e=r,n=r}n&&(n.next=G),G=e}function Ke(t){t.next=G,G=t}function Oe(t,e,n){t.paths=e.paths,t.g=e.g,t.dom=e.template.content.cloneNode(!0),t.ref.f=t.dom.firstChild,t.ref.l=t.dom.lastChild,t.e=ae(e.expressions),t.b=t.st=!1,t.r=!0,t.u=t.v=null,t.s=t.bkn=void 0,U(n,t)}function Re(t){const e=ht(t),n=ft.get(t._i);if(n){if(n.g!==e.g)throw Error("shape mismatch");if(n.r)return It(n),U(t,n),n}const r=Q.get(e.g)?.h;if(r)return It(r),U(t,r),r;G||ne(kt);const s=G;return G=s.next,s.next=void 0,Oe(s,e,t),s}function It(t){if(!t.st)return;const e=Q.get(t.g);if(e){let n,i=e.h;for(;i&&i!==t;)n=i,i=i.bkn;i&&(n?n.bkn=i.bkn:e.h=i.bkn,e.h||Q.delete(t.g))}t.i!==void 0&&ft.get(t.i)===t&&ft.delete(t.i),t.st=!1,t.bkn=void 0}function ie(t){const e=this[gt]?.[t.type];!e||!e.c._t._m||W[e.p]?.(t)}function ct(t){return b(t)?t.k:t._k}function bt(t,...e){const n=(i=>je(n,i));return n.isT=!0,n._a=e,n._c=Ie,n._m=!1,n._s=t,n.key=be,n.id=Fe,n}function Ne(t,...e){const n=bt(t,...e);return n._p=ee(t,!0),n}function Ie(){let t=this._h;return t||(t=Re(this),this._h=t),t}function be(t){return this._k=t,this._h&&(this._h.k=t),this}function Fe(t){return this._i=t,this._h&&(this._h.i=t),this}function je(t,e){const n=t._c();return t._m?(L(n.ref,n.dom),e?e.appendChild(n.dom):n.dom):(t._m=!0,n.b?(L(n.ref,e??n.dom),e??n.dom):qe(n,e))}function qe(t,e){const n=t.e,i=W[n],[r,s]=t.paths,f=ot+1;let d=0;Dt[0]=t.dom;for(let C=0;C<i;C++){const y=r[d++];let S=r[d++],w=y,T=Dt[w];for(;S--;)T=T.childNodes[r[d++]],Dt[++w]=T;st[++ot]=T,st[++ot]=r[d++]}const _=ot;for(let C=f,y=n+1;C<_;C++,y++){const S=st[C],w=st[++C];w?We(S,s[w-1],y,t):Ve(S,y,t)}return st.length=f,ot=f-1,t.b=!0,e?e.appendChild(t.dom)&&e:t.dom}function Ve(t,e,n){let i;const r=W[e],s=t.nodeType===3?t:null;if(b(r)||M(r)||Array.isArray(r))n.r=!1,i=re(n)(r);else if(typeof r=="function"){let f=s,d=null;const[_,C]=rt(e,y=>{if(!d){if(b(y)||M(y)||Array.isArray(y)){n.r=!1,d=re(n);const w=d(y);return f&&(f.parentNode?.replaceChild(w,f),f=null),w}f||(f=document.createTextNode(""));const S=Y(y);return f.nodeValue!==S&&(f.nodeValue=S),f}return d(y)});(n.u??=[]).push(C),i=_}else{let f=s??document.createTextNode("");f.data=Y(r),i=f,lt(e,f)}if(t===n.ref.f||t===n.ref.l){const f=i.nodeType===11?i.lastChild:i;t===n.ref.f&&(n.ref.f=i.nodeType===11?i.firstChild:i),t===n.ref.l&&(n.ref.l=f)}i!==t&&t.parentNode?.replaceChild(i,t)}function We(t,e,n,i){if(t.nodeType!==1)return;let r=t;const s=W[n];if(e[0]==="@"){const f=e.slice(1),d=r[gt]??={};d[f]={c:i,p:n};const _=[r,f];r.addEventListener(f,ie),r.removeAttribute(e),(i.v??=[]).push(_)}else if(typeof s=="function"&&!M(s)){const[,f]=rt(n,d=>Tt(r,e,d));(i.u??=[]).push(f)}else Tt(r,e,s),lt(n,r,e)}function re(t){let e,n=Object.create(null);t&&(t.u??=[]).push(()=>{e&&(qt(e,!0),e=void 0)});const i=function(o){if(!e){if(b(o)){const[c,m]=F(o);return e=S(c,m),c}if(M(o)){const c=o();return e=S(c,o._h),c}if(Array.isArray(o)){const[c,m]=r(o);return e=m,c}return e=document.createTextNode(Y(o))}if(Array.isArray(o))if(Array.isArray(e)){let c=0;const m=o.length,h=e.length;if(m&&h===1&&!j(e[0])&&!e[0].data){const[g,p]=r(o);e[0].replaceWith(g),e=p;return}if(m===h){const g=new Array(m);for(;c<m;c++){const p=o[c];if(b(p)&&p.k!==void 0||M(p)&&p._k!==void 0){c=-1;break}const R=e[c];if(M(p)&&j(R)&&R._t===p&&p._h===R&&p._m){g[c]=R;continue}if(M(p)&&j(R)){const V=p,$=V._p??ht(V);if(R.g===$.g){U(V,R,!0),g[c]=R;continue}}g[c]=C(p,R)}if(c===m){e=g;return}c=0}const E=_(o,e);if(E){e=E;return}if(m>h&&h){for(;c<h;c++){const g=o[c],p=e[c];if(!(M(g)&&j(p)&&p._t===g&&g._h===p&&g._m)){c=-1;break}}if(c===h){const g=document.createDocumentFragment(),p=e.slice();for(c=h;c<m;c++)p[c]=y(o[c],g);B(e[h-1]).after(g),e=p;return}c=0}let P;const N=[],D=++De,O=m>h?document.createDocumentFragment():null;for(;c<m;c++){let g=o[c];const p=e[c];let R;if(M(g)&&(R=g._k)!==void 0&&R in n){const $=n[R];Rt(g,$)&&(U(g,$,!0),g=$._t)}if(c>h-1){N[c]=y(g,O);continue}if(M(g)&&j(p)&&p._t===g&&g._h===p&&g._m){P=B(p),N[c]=p,p.mk=D;continue}const V=C(g,p,P);P=B(V),N[c]=V,V.mk=D}if(m)m>h&&P?.after(O);else{const g=N[0]=document.createTextNode(""),p=oe(e),R=p&&se(e,g);R||B(e).after(g),n=Object.create(null),p?qt(e,R):H(e),e=N;return}for(c=0;c<h;c++){const g=e[c];g.mk!==D&&(T(g),H(g))}e=N}else{const[c,m]=r(o);B(e).after(c),T(e),H(e),e=m}else Array.isArray(e)&&(n=Object.create(null)),e=C(o,e)};i.adopt=()=>{};function r(u){const o=document.createDocumentFragment();if(!u.length){const m=document.createTextNode("");return o.appendChild(m),[o,[m]]}const c=new Array(u.length);for(let m=0;m<u.length;m++)c[m]=y(u[m],o);return[o,c]}function s(u,o){return o.s?.[1]!==u.h?!1:(o.s[0]!==u.p&&(o.s[0]=u.p),o.s[2]!==u.e&&(o.s[2]=u.e),!0)}function f(u,o){return b(u)?s(u,o):Rt(u,o)?(U(u,o,!0),!0):!1}function d(u,o,c){if(c){L(u.ref,c.parentNode,c.nextSibling);return}const m=B(o,void 0,!0);L(u.ref,m.parentNode,m)}function _(u,o){const c=u.length,m=o.length;if(!c){const l=document.createTextNode(""),a=oe(o),x=a&&se(o,l);return x||B(o).after(l),n=Object.create(null),a?qt(o,x):H(o),[l]}const h=new Array(c),E=B(o[0]).parentNode;if(!E)return null;let P=0;const N=Object.create(null);for(;P<m&&P<c;P++){const l=o[P];if(!j(l)||l.k===void 0)return null;const a=u[P];if(!b(a)&&!M(a))return null;const x=ct(a);if(x===void 0||x!==l.k)break;if(N[x]=1,!(M(a)&&l._t===a&&a._h===l&&a._m)&&!f(a,l))return null;h[P]=l}if(P===m){if(P===c)return h;const l=document.createDocumentFragment();for(let a=P;a<c;a++){const x=u[a];if(!b(x)&&!M(x))return null;const I=ct(x);if(I===void 0||I in N)return null;N[I]=1,h[a]=y(x,l)}return E.insertBefore(l,m?B(o[m-1]).nextSibling:null),h}if(P===c){for(let l=P;l<m;l++){const a=o[l];T(a),H(a)}return h}let D=P,O=P,g=m-1,p=c-1;for(;D<=g&&O<=p;){const l=o[D],a=o[g],x=l.k,I=a.k,A=u[O],K=u[p],_t=b(A)||M(A)?ct(A):void 0,xt=b(K)||M(K)?ct(K):void 0;if(_t===void 0||xt===void 0)return null;if(x===_t){if(!(M(A)&&l._t===A&&A._h===l&&A._m)&&!f(A,l))return null;h[O++]=l,D++;continue}if(I===xt){if(!(M(K)&&a._t===K&&K._h===a&&K._m)&&!f(K,a))return null;h[p--]=a,g--;continue}if(x===xt){if(!(M(K)&&l._t===K&&K._h===l&&K._m)&&!f(K,l))return null;L(l.ref,E,B(a).nextSibling),h[p--]=l,D++;continue}if(I===_t){if(!(M(A)&&a._t===A&&A._h===a&&A._m)&&!f(A,a))return null;L(a.ref,E,B(l,void 0,!0)),h[O++]=a,g--;continue}break}if(O>p){for(let l=D;l<=g;l++){const a=o[l];T(a),H(a)}return h}if(D>g){const l=document.createDocumentFragment();for(let a=O;a<=p;a++){const x=u[a];if(!b(x)&&!M(x))return null;h[a]=y(x,l)}return E.insertBefore(l,p+1<c?B(h[p+1],void 0,!0):null),h}const R=Object.create(null);for(let l=D;l<=g;l++){const a=o[l];if(!j(a)||a.k===void 0)return null;const x=a.k;if(x in R)return null;R[x]=l+1}const V=Object.create(null);let $=0;for(let l=O;l<=p;l++){const a=u[l],x=b(a)||M(a)?ct(a):void 0;if(x===void 0||x in V)return null;V[x]=l+1,x in R&&$++}if(!$){const l=B(o[D],void 0,!0),a=B(o[g]),x=document.createDocumentFragment();for(let A=O;A<=p;A++){const K=u[A];if(!b(K)&&!M(K))return null;h[A]=y(K,x)}const I=l.parentNode;if(!I||!a.parentNode)return null;if(l===I.firstChild&&a===I.lastChild)I.replaceChildren(x);else{const A=document.createRange();A.setStartBefore(l),A.setEndAfter(a),A.deleteContents(),A.insertNode(x)}for(let A=D;A<=g;A++){const K=o[A];T(K),Ft(K,!0)}return h}for(let l=D;l<=g;l++){const a=o[l],x=V[a.k];if(x===void 0){T(a),H(a);continue}const I=u[x-1];if(!f(I,a))return null;h[x-1]=a}let Z=p+1<c?B(h[p+1],void 0,!0):B(o[m-1]).nextSibling;for(let l=p;l>=O;l--){const a=h[l];if(!a){const I=u[l];if(!b(I)&&!M(I))return null;const A=document.createDocumentFragment(),K=y(I,A);h[l]=K,E.insertBefore(A,Z),Z=B(K,void 0,!0);continue}const x=B(a,void 0,!0);(x.parentNode!==E||x.nextSibling!==Z)&&L(a.ref,E,Z),Z=x}return h}function C(u,o,c){const m=o.nodeType??0;if(b(u)){const E=u.k;if(E!==void 0&&E in n){const O=n[E];if(s(u,O))return O===o?o:(d(O,o,c),O)}else if(j(o)&&s(u,o))return o.k!==u.k&&(T(o),o.k=u.k,w(o)),o;const[P,N]=F(u),D=S(P,N);return B(o,c).after(P),T(o),H(o),w(N),D}if(!M(u)&&m===3){const E=Y(u);return o.data!==E&&(o.data=E),o}if(M(u)){const E=u,P=E._k;if(P!==void 0&&P in n){const p=n[P];if(Rt(E,p))return U(E,p,!0),p===o?o:(d(p,o,c),p)}const N=ht(E);if(j(o)&&o.g===N.g)return U(E,o,!0),o;const D=u(),O=E._h,g=S(D,O);return B(o,c).after(D),T(o),H(o),w(O),g}const h=document.createTextNode(Y(u));return B(o,c).after(h),T(o),H(o),h}function y(u,o){if(b(u)){const[m,h]=F(u);return o.appendChild(m),w(h),S(o,h)}if(M(u)){u(o);const m=u._h;return w(m),S(o,m)}const c=document.createTextNode(Y(u));return o.appendChild(c),c}function S(u,o){if(o.ref.f)return o;const c=document.createTextNode("");return u.appendChild(c),c}function w(u){u.k!==void 0&&(n[u.k]=u)}function T(u){j(u)&&u.k!==void 0&&n[u.k]===u&&delete n[u.k]}function F(u){const[o,c,m]=Be(u.p,u.h,u.e),h=[],E=Wt(h);let P,N;try{P=u.h(o,c),N=P()}finally{Wt(E)}const D=P._c();return h.length&&(D.u??=[]).push(...h),D.r=!1,D.s=m,D.k=u.k,[N,D]}return i}let yt=[];function Ft(t,e=!1){if(t.st&&It(t),Nt(t),t.v)for(let i=0;i<t.v.length;i++){const[r,s]=t.v[i],f=r[gt];if(f){delete f[s];let d=!1;for(const _ in f){d=!0;break}d||delete r[gt]}r.removeEventListener(s,ie)}if(t.u){for(let i=0;i<t.u.length;i++)t.u[i]();t.u=null}t.e+1&&(ge(t.e),t.e=-1);let n=t.ref.f;if(!e&&n){const i=t.ref.l;if(n===i)n.remove();else for(;n;){const r=n===i?null:n.nextSibling;if(n.remove(),!r)break;n=r}}t.dom.textContent="",t.ref.f=t.ref.l=null,t.k=t.i=t.s=void 0,t.u=t.v=null,t.b=t.st=!1,t.r=!0,t.g="",Ke(t)}function He(t,e=!1){if(e||L(t.ref,t.dom),Nt(t),t.st||!t.r)return;t.st=!0;let n=Q.get(t.g);n||(n={},Q.set(t.g,n)),t.bkn=n.h,n.h=t,t.i!==void 0&&ft.set(t.i,t)}let jt=!1;function oe(t){for(let e=0;e<t.length;e++){const n=t[e];if(j(n)&&!n.r)return!1}return!0}function se(t,e){if(!t.length)return!1;const n=B(t[0],void 0,!0),i=B(t[t.length-1]),r=n.parentNode;return!r||n!==r.firstChild||i!==r.lastChild?!1:(r.replaceChildren(e),!0)}function qt(t,e=!1){if(j(t)){t.r?He(t,e):Ft(t,e);return}if(Array.isArray(t)){if(!e&&t.length){const r=B(t[0],void 0,!0),s=B(t[t.length-1]),f=r.parentNode;if(f){if(r===f.firstChild&&s===f.lastChild)f.textContent="";else{const d=document.createRange();d.setStartBefore(r),d.setEndAfter(s),d.deleteContents()}e=!0}}let n,i="";for(let r=0;r<t.length;r++){const s=t[r];if(j(s)){if(!s.r){Ft(s,e);continue}if(e||L(s.ref,s.dom),Nt(s),s.st)continue;s.st=!0,i!==s.g&&(i=s.g,n=Q.get(i),n||(n={},Q.set(i,n))),s.bkn=n.h,n.h=s,s.i!==void 0&&ft.set(s.i,s)}else e||s.remove()}return}e||t.remove()}function Le(){jt=!1;const t=yt;yt=[];for(let e=0;e<t.length;e++)qt(t[e]);yt.length&&fe()}function fe(){jt||(jt=!0,queueMicrotask(Le))}function H(t){t&&(yt.push(t),fe())}function Y(t){return t||t===0?t:""}function B(t,e,n){return j(t)?n?t.ref.f:t.ref.l:Array.isArray(t)?B(t[n?0:t.length-1],e,n):t}function $e(t){const e=[],n=[],i=[],r=[],s=_=>{const C=i.length,y=r.length,S=C<y?C:y;let w=0;for(;w<S&&r[w]===i[w];)w++;e.push(w,C-w);for(let T=w;T<C;T++)e.push(i[T]);e.push(_?n.push(_):0),r.length=C;for(let T=0;T<C;T++)r[T]=i[T]},f=_=>{if(_.nodeType===1){const y=_.attributes;for(let S=0;S<y.length;S++){const w=y[S];w.value===mt&&s(w.name)}}else(_.nodeType===8||_.nodeType===3&&_.nodeValue===mt)&&s();const C=_.childNodes;for(let y=0;y<C.length;y++)i.push(y),f(C[y]),i.pop()},d=t.childNodes;for(let _=0;_<d.length;_++)i.push(_),f(d[_]),i.pop();return[e,n]}function Ue(t){const e=n=>{const i=n.childNodes;for(let r=0;r<i.length;r++){const s=i[r];if(s.nodeType===8&&s.data===Kt){n.replaceChild(document.createTextNode(""),s);continue}s.nodeType===3&&s.nodeValue===mt&&(s.nodeValue=""),s.firstChild&&e(s)}};e(t)}export{vt as c,vt as component,bt as html,ce as nextTick,de as onCleanup,Zt as pick,Zt as props,nt as r,nt as reactive,Ne as svg,bt as t,rt as w,rt as watch};
