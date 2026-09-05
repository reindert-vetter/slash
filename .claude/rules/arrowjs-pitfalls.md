# arrow.js pitfalls (and the two DOM rules that live next to them)

Everything learned the hard way about the vendored arrow.js
(`src/vendor/arrow.js`), plus two non-arrow.js DOM rules that only ever bit us
inside arrow.js templates: the `scrollIntoView` axis rule and the nested
`@click`/`stopPropagation` ordering rule.

## The one root cause behind several entries below

**arrow.js's teardown (`Ft`/destroyChunk) only cleans up the expression slots a
node owns DIRECTLY — it never used to cascade into a piece of template embedded
via `${() => componentCall(...)}`** (`${CommandMenu(ms, ...)}` in
`menuOverlay()`, `${() => codeDiff(...)}` in `Block.mjs`,
`RelatedPanel.mjs`'s `.map()` lists). Such a nested reconciler subtree stayed a
live, detached piece of template forever — both a **memory leak** (detached
`<span>`/`<div>`/Text growth) and a **use-after-free** risk: a reactive
expression whose slot is still alive can fire in the microtask flush after its
owning keyed node is gone. LOCAL PATCH 1/2/2b (below) address this in the vendor
file; the "orphan bindings" and "bare toggling expression" entries below are the
app-level consequences of the same gap.

## LOCAL PATCH 1/2/2b/4/5/6/7/8 in `src/vendor/arrow.js` — reapply on every upgrade

Eight deliberate changes, each marked with a `LOCAL PATCH` comment in the
header (LOCAL PATCH 3, the separate memory-leak fix, is documented on its own
further down in this file — different failure mode, see "Arrow's registries,
before and after"). **On an arrow.js upgrade all eight must be reapplied**; the
comment blocks in `vendor/arrow.js` hold the original lines and the exact
restore instructions.

- **LOCAL PATCH 1** — the template-expression evaluator `rt` **skips a released
  slot** (`typeof W[t]=="function"` guard) instead of calling it. Without it, a
  reactive effect that still fires after its keyed node was cleaned up crashes
  with `W[t] is not a function` (use-after-free) — among other places during
  **drilling** (opening an Underlying-code child as its own column re-scopes the
  panel and tears down cards mid-flush).
- **LOCAL PATCH 2** — `Ft` now **cascades into nested-mounted reconciler
  subtrees**, the root-cause fix for the disposal gap above. `re(t)` (upstream
  `createRenderFn`, the reconciler factory `Ve`/upstream `createNodeBinding`
  uses for **every** nested component/array/template value) registers, via its
  first parameter (upstream's SSR `capture` flag, dead in this build — esbuild
  tree-shook every `if(capture)` branch), one cleanup on the **owner** node: as
  soon as that owner is torn down via `Ft`, this cleanup also disposes whatever
  the reconciler currently keeps mounted, through the **same** existing dispatch
  (`qt`/upstream `removeUnmounted`). Purely additive (3 small insertions, no
  existing line changed) and automatically recursive. Minified↔upstream name map
  (traced against `@arrow-js/core@1.0.6`, `dist/index.mjs` +
  `dist/chunks/internal-*.mjs`): `re`=`createRenderFn`,
  `Ve`=`createNodeBinding`, `Ft`=`destroyChunk`, `qt`=`removeUnmounted`,
  `n.u`=`chunk.u`.
- **LOCAL PATCH 2b** — disposing that subtree must also **FORGET** it. PATCH 2
  turned the leak into a use-after-free: `Ft` nulls a chunk's DOM boundaries
  (`ref.f`/`ref.l`) while the nested reconciler still held it as `previous`, so
  a late run took the "replace what's mounted" path and did
  `insertionPoint(previous).after(...)` on `null` → **`Cannot read properties of
  null (reading 'after')`**, which leaves that reconciler *wedged* (the subtree
  silently stops updating). The fix is one token: clear `previous` after
  disposing it (`e&&(qt(e,!0),e=void 0)`), so a late run mounts fresh into the
  owner's own detached fragment. Regression tests:
  `tests/step-preview-stability.spec.mjs`, `tests/diff-code-vs-title.spec.mjs`
  (both walk a ↓/↑ same-file block cycle and assert zero page errors).
- **LOCAL PATCH 4** — `Gt` (upstream `emit`, the property-write notify
  dispatcher) now **snapshots the listener array before iterating it**
  (`const c=f.slice();for(...)typeof c[d]=="function"&&c[d](n,i)`) instead of
  looping over the live array in place. A property with 2+ subscribers at
  once (`state.drill`/`state.drillCursor` normally has both the
  columns-render effect and the `?drill=`/`?dcur=` URL-mirroring watch, see
  `bindUrlState` in `urlState.mjs`/`home.mjs`) can have one listener's own
  execution synchronously dispose ANOTHER subscriber on the SAME property
  (PATCH 2's cascading disposal tearing down a drilled column's card as part
  of a re-render) — that disposal's `Yt` call splices the shared listener
  array while `Gt`'s own loop is still mid-iteration over it, corrupting the
  iteration: `TypeError: f[d] is not a function`. Reported symptom: "als ik
  diep zit, dan is de tree traag als ik een regel goedkeur" — every
  subsequent Space press inside a drilled column silently aborted
  `applyNextUnapproved` at its `state.drill = state.drill.slice(0, common)`
  line, so the reviewer's approve-and-continue simply stopped working, forever,
  with no visible error. **Not about drill depth** — isolated to plain `↓`
  (changing a drilled column's own change-group cursor) repeated ~10-40 times
  inside ANY drilled column (never at drill depth 0, and not reliably
  reproducible in a small synthetic fixture — needs a reactive graph as dense
  as a real, large PR to collide reliably); see "The Gt dispatch-array crash"
  in `.claude/docs/frontend-memory.md` for the full depth-vs-churn
  measurements and the before/after numbers. Regression test (a cheap
  smoke/guard, not a reliable repro — see its own doc comment):
  `tests/drill-listener-array-dispatch.spec.mjs`.
- **LOCAL PATCH 5** — `Vt` (upstream `flush`, the microtask draining the
  effect queue) wraps **each queued effect and each `nextTick` callback** in
  its own `try/catch`, and `Gt` does the same around every listener call in
  **both** of its branches. All four catches only `console.error`. This is the
  difference between one broken render and a permanently dead page: `ue`
  (upstream `queue`) marks an effect queued with `e[Ct]=!0` and only ever
  re-queues one whose flag is false, while `Vt` clears that flag **one effect
  at a time**, right before invoking it — so an uncaught throw from effect n
  aborts the loop and leaves every effect from n+1 onward flagged
  "already queued" with nothing holding it, forever. The trailing
  `J.length&&queueMicrotask(Vt)` is skipped too. Symptom (PR 12112): stepping
  through the block index stopped updating the diff column, the card title
  **and** the `?sel=` URL mirror, while the keydown handler kept writing
  `state.selected` — not one subscriber ever heard it again. Measured A/B,
  same fixture and key sequence: unpatched 29 page errors and 1 distinct
  selection over 6 ↓ presses, patched 7 distinct selections with the queue
  draining to 0. The throw that exposed it was a duplicate `.key()` (next
  section), but the patch is deliberately **not** about that one bug: every
  entry in this file is a way for a render to throw mid-flush, and none of
  them should be able to take navigation with it. Regression test:
  `tests/index-row-key-collision.spec.mjs` ("a throwing reactive subscriber").
- **LOCAL PATCH 6** — a one-line guard in `_`, the LIS-based keyed-array diff
  helper nested inside `re(t)`'s array branch (the same `re`/array-reconcile
  machinery LOCAL PATCH 2/2b/4 already patch). Its "zero shared keys between
  the old and new middle range" shortcut grabs two OLD-array boundary DOM
  nodes (`l`/`a`) and replaces the whole DOM range between them in one shot —
  via `Node.replaceChildren` when they're literally the parent's first/last
  child, otherwise via a `Range` (`setStartBefore`/`setEndAfter`/
  `deleteContents`/`insertNode`). Before this patch only `l.parentNode` was
  checked for truthiness to pick between those two paths; a falsy
  `parentNode` (i.e. `l` already detached, no parent at all) fell through to
  the `Range` branch instead of being treated as an error, and
  `Range.setStartBefore`/`setEndAfter` throw `Node has no parent` (or
  `insertNode` throws its own "the node itself" variant) on a parentless
  argument. The guard now returns `null` — an existing, already-exercised
  bail-out contract every other early-exit in `_` also uses (duplicate key,
  shape mismatch, …) — as soon as EITHER boundary node has no parent, before
  ever constructing the `Range`; the caller already falls back to `re`'s
  slower, general per-item reconcile path whenever `_` declines.
  **Reported symptom, under a large (601-block, 3770-unit) fixture PR at
  `gran=line` with drilled columns, and disproportionately under real CPU
  contention (several other browser sessions running at once) rather than a
  quiet repeat of the same key sequence:** 622 caught throws in
  `data/debug-log.jsonl` (581× `setStartBefore … Node has no parent`, 39×
  `setEndAfter …`, 2× `insertNode … from the node itself`), all with the
  same stack shape `_ ← i ← Vt` — each one a render LOCAL PATCH 5 caught and
  only `console.error`'d, i.e. invisible without debug mode.
  **ESTABLISHED** (static reading of this file): `setStartBefore`/
  `setEndAfter`/`insertNode` occur exactly once in the whole bundle, in this
  exact construction, so that error text with that stack shape can only
  originate here; nothing in this branch of `_` mutates the DOM before the
  `parentNode` read, so `l`/`a` must already have been parentless when `_`
  was entered — the stale state predates this call, in the reconciler's own
  `e`/`previous` closure (the same array LOCAL PATCH 2/2b already guards
  elsewhere for being used after disposal).
  **HYPOTHESIS, not verified against a captured live repro:** the leading
  theory is the same disposal-timing gap LOCAL PATCH 4 documents for `Gt`
  (2+ subscribers on one reactive array property, where one listener's own
  render synchronously disposes — via LOCAL PATCH 2's cascading disposal — a
  nested reconciler subtree a second, not-yet-run listener for the SAME
  property still references), here reaching a shortcut branch of `_` that
  had not been exercised/instrumented before. This was derived from reading
  the algorithm, not from an isolated Playwright repro or an inspected real
  stack trace (`data/debug-log.jsonl` in this checkout is empty — the
  testcampagne that found this ran against a separate instance/datadir).
  **Investigation to confirm or refute this is intended to follow this
  patch, not precede it** — see "The `_ ← i ← Vt` Range-boundary throws" in
  `.claude/docs/frontend-memory.md` for the outcome once it's done. This
  guard only stops the stale state from reaching a DOM API that throws on
  it (LOCAL PATCH 1's "skip stale state instead of crashing" philosophy) —
  it does not by itself fix whatever earlier event left `l`/`a` parentless.
  **UPDATE: root-caused and fixed — LOCAL PATCH 8 below.** The hypothesis
  above (a disposal-timing gap reaching `_`'s stale `e`/`previous`) pointed
  at the right neighbourhood but not the right mechanism — see PATCH 8's own
  entry for the proven cause and fix. This guard stays as a defense-in-depth
  net; it is not removed.
- **LOCAL PATCH 7** — a cycle guard in `L`, the chunk DOM mover (walks
  `ref.f .. ref.l` via `nextSibling`, `insertBefore`-ing each node into the
  target). With CORRUPTED chunk boundaries (`f`/`l` in different parents, or
  reversed within one), inserting each walked node can rewire the sibling
  chain into a CIRCLE, and upstream's walk then never exits: a genuine,
  permanent, 100%-CPU **main-thread freeze** — no throw, so LOCAL PATCH 5
  never sees it, no error anywhere, Chrome's "Page Unresponsive" dialog is
  the only symptom. Reproduced 5/5 against the 601-block fixture PR
  (`reindert-vetter/slash-test` #2): a plain approve-and-continue **Space
  sequence froze the tab hard at press ~190-203**, always on the same state
  (a `test_class` row with a two-level drill open, Space approving the last
  drilled unit — `applyNextUnapproved` peels `state.drill` while the block
  column swaps its `block-collapsed` rail in the same flush). Ten
  `Debugger.pause` samples during the freeze all sat in this exact loop
  (`L ← He ← qt ← Le`, the unmount-queue drain). Boundary-validation probes
  showed every STASH still valid — the refs get crossed while the chunk sits
  in the per-template reuse pool, i.e. two administrations sharing one
  chunk's DOM; the underlying corruption is NOT fixed by this patch (same
  status as PATCH 6's stale `l`/`a`). The guard: past 1024 iterations (no
  legitimate chunk has that many TOP-LEVEL nodes) start tracking visited
  nodes in a Set and abort with one `console.error` on the first repeat —
  hot path allocates nothing. Verified live: the previously-freezing Space
  sequence continues normally past the abort (4 aborts over 650 presses,
  zero freezes). Full evidence chain and repro recipe: "The Space-sequence
  freeze" in `.claude/docs/frontend-memory.md`. **UPDATE: root-caused and
  fixed — LOCAL PATCH 8 below.** Same "two administrations sharing one
  chunk's DOM" defect as PATCH 6, now traced to its exact source and closed
  at that one call site. This guard stays as a defense-in-depth net; it is
  not removed.
- **LOCAL PATCH 8** — the actual root cause behind PATCH 6 and PATCH 7,
  found and fixed: both were different symptoms of the SAME bug, a single
  wrong boolean at a single call site. `re(t)`'s owner-teardown cleanup
  (added by PATCH 2 — "when the OWNING chunk is destroyed, also dispose
  whatever the nested reconciler currently holds") called `qt(e,!0)`: the
  `!0` claims "this nested content's DOM was already removed from the
  document, just do the bookkeeping". That claim is false at the moment
  this cleanup runs — `Ft` (destroyChunk) runs every `t.u[i]()` cleanup
  (where this fires) BEFORE it physically removes the owner's own DOM range,
  so the nested content is still a live, attached descendant of the
  still-attached owner at that point. Believing the false claim,
  `He(chunk,true)` skips `L(chunk.ref,chunk.dom)` — the one call that
  physically detaches a chunk into its own fragment — yet still adds it to
  the shared, shape-keyed reuse pool `Q` as if it were safely stashed there.
  `Q` is one flat map shared by every reconciler in the app (nested or
  top-level), so the next unrelated mount of the same template shape pops
  this exact chunk and physically moves its (still-live-elsewhere) DOM into
  the new spot — ripping nodes out of whatever they were still part of.
  That's PATCH 6's parentless boundary node and PATCH 7's circular boundary
  chain: the same defect, surfacing as whichever of the two shapes of damage
  the timing happens to produce. **Proven, not hypothesized:** temporary
  instrumentation (`He`/`Re`/`qt`, not committed) against the
  `reindert-vetter/slash-test` PR #2 fixture, driving a repeated
  drill-in/approve/collapse Playwright script, captured the identical stack
  shape (`He ← qt ← Ft's cleanup-array call ← qt ← Le`) on every corrupted
  stash, and a direct counter on this one cleanup closure matched the
  corruption count 1:1 across repeated runs (thousands of fires, every one
  landing on a chunk still attached to a `parentNode !== chunk.dom` at the
  moment `He` marked it reusable) — zero corruption came from any other
  `qt(...,true)` call site, and every captured instance had the disposed
  value `e` be a SINGLE CHUNK, never an array. **The fix, deliberately
  narrow:** `qt(e,!0)` → `qt(e,Array.isArray(e))` — honest (`e=false`,
  actually calls `L`) only when `e` is a single chunk; an ARRAY still gets
  the original `e=true`. A single chunk now goes through the same verified
  path every other disposal uses — `He(e,false)` calls `L` first, physically
  moving the content into its own fragment before it's considered poolable.
  **Why the array case is deliberately left alone:** a first attempt made
  this unconditional (`qt(e)`, defaulting arrays to honest too) and DID close
  the corruption completely (0/0 including array content) — but broke four
  previously-passing tests (`drill-approve.spec.mjs`,
  `drill-approve-return-to-ancestor.spec.mjs`, `postapprove-menu.spec.mjs`,
  `postapprove-tree.spec.mjs`). The command palette's row list
  (`data-testid=command-list`) is one persistent container reused across
  every menu open; closing one menu and opening a follow-up coalesces both
  writes to `menu.open` before this cleanup's own (separately queued)
  disposal of the FIRST menu's now-stale row array runs — and when it does,
  `qt`'s array branch found the stale array's boundaries still matching the
  container's CURRENT first/last child (nothing else had touched it yet) and
  took its "wipe the whole container" fast path, confirmed live
  (`childElementCount` 6→0, the follow-up menu's just-rendered rows gone).
  `qt`'s array branch has no way to take the safe "detach each item via `L`"
  path without also risking that bulk wipe — the two share one boolean gate
  — so fixing the array case properly needs decoupling them, a deeper change
  than this session took on. **Verified:** re-ran the same instrumented
  stress script against the NARROWED fix — the single-chunk counters stayed
  at 0 across 60+ repeated drill/approve/collapse cycles (vs. 1600+ within
  the first cycle unpatched), and the full existing regression suite plus
  the approval/postApprove/drill-approve/navigate suite pass unchanged. The
  pool-integrity counter (which also catches array-content corruption)
  dropped from unbounded growth to a smaller but still nonzero residual
  (~4-5/cycle, 179 over 40 measured cycles) — the array-content share of
  this bug is NOT fixed. PATCH 6/7's own guards are deliberately left in
  place as a defense-in-depth net for whatever disposal-ordering bug (this
  residual one, or a future one) reaches the same two symptoms — this patch
  closes the single-chunk call site proven responsible for the majority of
  instances observed so far, not the general "a stale ref can reach
  `L`/`_`" class, and not (yet) the array-content share of it.

## Never give two entries of one keyed list the same `.key()`

arrow's keyed reconciler keeps a `_k` → chunk map (`n[R]` in `re`'s array
branch), so a duplicate key makes it **adopt one chunk for two entries** and
then insert against a node that has already moved: `Failed to execute 'after'
on 'CharacterData'`, `insertBefore … is not a child of this node`, or
`Cannot read properties of null (reading 'after')` — the same error text
LOCAL PATCH 2b's use-after-free produces, so **check for a duplicate key
before assuming a disposal bug**.

Real case: `BlockList.mjs` keyed every index row
`b.file + ':' + b.label + ':' + b.side`, which a **synthetic** item cannot
fill in. A comment index item (`commentRowItem`, `home.mjs`) has no `file` and
no `side`, and its `label` is only the first 60 characters of the body — so it
keyed as `undefined:<snippet>:undefined`, and two such items collided whenever
their snippet matched: two threads opening with the same ` ```suggestion `
fence, two identical generated short titles, or simply two empty-bodied PR
comments both falling back to the literal `'PR-comment'`. Consequences were
NOT local: one of the two rows silently failed to render, and the throw froze
the whole reactive graph (LOCAL PATCH 5 above).

**The rule:** key a list row by the item's own **stable id**, never by a
composite of display fields — `rowKey(b)` (`BlockList.mjs`) returns
`b.id || file + ':' + label`, plus `':' + (b.side || '')` because a block id
(`<pr>:<file>:<symbol>`, `model.go`) carries no side. Every item in that list
already has an id: real blocks from `/api/blocks`, `comment:<id>` and
`testclass:<file>::<class>` for the synthetic ones. Same reasoning as
"snapshot a selection by stable ID, never by raw array index" in
`.claude/rules/conventions.md`, applied to keys. Regression test:
`tests/index-row-key-collision.spec.mjs`.

## Template syntax rules

- **No HTML comments** (`<!-- -->`) inside an `html`` `` template — throws
  "Invalid HTML position".
- **A single `html`` `` tag can only have ONE root element.**
  `` html`<p>a</p><p>b</p>` `` also throws "Invalid HTML position". Build an
  **array** of separately-tagged, `.key()`ed templates instead
  (`[html\`<p>a</p>\`.key('a'), html\`<p>b</p>\`.key('b')]`) and interpolate
  that array as an ordinary keyed-list slot. Came up in
  `translationBlockView`'s row (a 'changed' key shows old + new as two `<p>`s).
- **An attribute value containing ANY `${...}` must be the WHOLE value — also a
  plain, non-function one.** `class="${() => ...}"` yes; `class="x ${...}"` no,
  and `class="text-sm font-bold ${cls}"` (no `()=>`) throws "Invalid HTML
  position" too — the static template compiler cannot handle a MIXED
  literal+dynamic attribute value at all, reactive or not. Fix by concatenating
  **outside** the template into one slot
  (`` `${'shrink-0 rounded ... ' + KIND_BADGE_CLS[u.kind]}` ``). Same symptom as
  the HTML-comment case, so on "Invalid HTML position" audit every attribute for
  a partial interpolation, not just for stray `<!-- -->`.
- **Raw HTML goes through the `.innerHTML` binding**
  (`.innerHTML="${() => htmlString}"`) — arrow.js sets the property instead of
  escaping, so the string must already be safe (e.g. `Prism.highlight`, which
  escapes itself).

## `?attr=` / `.attr=` do NOT toggle a boolean attribute — use the plain name

`?disabled="${() => ...}"` (and `.attr=` for anything other than
`value`/`checked`) does **not** work in this vendored build. lit-html's
`?disabled=` convention has no equivalent here: the template compiler (`We`)
captures the attribute **name** literally as `"?disabled"` (HTML parses it as an
attribute of that name), so the binding calls
`setAttribute('?disabled', …)`/`removeAttribute('?disabled')` and never touches
the real `disabled` attribute.

**What DOES work:** the plain, undecorated name with a function binding —
`disabled="${() => cs.busy}"`. Arrow's reactive attribute effect (`Tt`) removes
the attribute when the function returns exactly `false` and calls
`setAttribute` for any truthy value; since `disabled`/`checked` are
presence-based HTML boolean attributes, that reliably toggles them. This is why
the working `checked="${() => blockApproved(b)}"` in `Block.mjs` uses no dot.

`.indeterminate="${...}"` (also `Block.mjs`) still works **with** a dot only
because `indeterminate` has **no** attribute reflection at all: the attribute
name still ends up wrong, but `Tt`'s `e[0]==="."` branch strips the dot and
assigns the DOM *property* directly. `disabled`/`checked` do reflect, which is
exactly where a `?`/`.` prefix breaks for them.

Four buttons carried this bug and were **silently non-functional** (never really
disabled, only visually dimmed by their own `class` ternary):
`overview.mjs`'s `generate-page`/`regenerate-page`/`ready-confirm` and
`BlockList.mjs`'s `ingest-btn`. All fixed, each with a regression test asserting
`toBeDisabled()` (the native attribute, not a CSS class):
`tests/overview.spec.mjs`, `tests/overview-ready-for-review.spec.mjs`,
`tests/ingest-btn-disabled.spec.mjs`. Working example:
`tests/reaction-status-icon.spec.mjs` (`reaction-send`/`reaction-status`/
`comment-send`/`comment-detail-send`).

## `watch(getter, cb)` — enumerate reactive deps INLINE in the getter

If all reads hide inside a called function with early returns/conditional paths
(`watch(() => buildStuff(), …)`), the dependency set varies per run and the
crystallized run can drop a key it previously subscribed to — the watch stops
re-subscribing and stops firing. So list the state literally
(`() => [state.a, state.b, obj && obj.x]`) and do the work in the **callback**.
That is how `setCommentScope`/`setRelated` in `home.mjs` do it; an earlier
`setRelated` that did not froze the related panel on whichever block was
selected at load time (see "Reactivity" in
`.claude/docs/underlying-code.md`).

## A slot that switches between a single element and a keyed array freezes

Observed in `RelatedPanel.mjs`'s comment list: the slot returned either
`visibleComments().map(...)` (keyed rows) or a single `<p>No comments yet</p>`.
After the single-`<p>` render, a later non-empty array **did** come back from
the binding but arrow.js no longer rendered the rows. Re-keying the panel or a
scalar version counter did not help — only a stable shape does.

**Solution:** always emit the **same kind** from that slot — wrap the empty
state in an **array of one** (`[html\`<p …>…</p>\`.key('no-comments')]`).

## Never key a template whose entire body is one toggling expression

`` html`${() => cond ? sub() : ''}` `` — worse than the single↔array case.
arrow.js sets a chunk's DOM boundaries (`ref.f`/`ref.l`) only at **hydration**;
when the nested reconciler later swaps that content (template ↔ `''`) it
replaces the DOM **without** updating the owner chunk's `ref`. For a template
whose expression *is* the whole body, that expression *is* the chunk boundary,
so the `ref` points at removed nodes after one toggle. As a **keyed list item**
the keyed reconcile then derails (stale ref → `patchKeyedList` bails → the
fallback path loses the chunk → a later run uses the stale ref as an *anchor*):
newly mounted items land in a detached fragment and disappear, after which two
reconciler administrations fight over the same chunks — infinite microtask loop,
tab freezes. `stepChevronSlot` (`home.mjs`) was such a bare wrapper, keyed
`step-up`/`step-down` in the block column, and the look-ahead preview card
vanished under repeated ↓/↑ through same-file blocks. (Unpatched upstream 1.0.6
crashes earlier with `expressionPool[effect] is not a function`; LOCAL PATCH 1
masks that down to silent render corruption.)

**Solution:** give such a slot a **stable element root** and toggle **inside**
it: `` html`<div class="contents">${() => cond ? sub() : ''}</div>` ``. The
**static** `contents` class is doubly deliberate — `display:contents` removes
the wrapper box from layout (content shows → it becomes the flex item; empty →
no flex item, so no `gap` artifact), and a static class avoids a reactive
attribute binding that would be re-set on every navigation step (the flicker
test in `navigate.spec.mjs` requires zero attribute mutations per step).

**Same derailment, second symptom:** it also corrupted the neighbouring nested
`${() => codeDiff(...)}` embedding in `Block.mjs` — after a same-file ↓/↑ cycle
the selected card showed the correct **title** but the **code of the previously
selected block**, silently, with no crash. The same stable-element root fixed
that too; no separate fix. Regression tests:
`tests/step-preview-stability.spec.mjs`, `tests/diff-code-vs-title.spec.mjs`.

## A narrow event-listener-only child toggled bare — fixed defensively, root cause NOT fully proven

Reviewer-reported bug: `blockCloseColumnButton`'s own `@click` handler
(`Block.mjs`) fired with **`e === undefined`**, crashing on `e.stopPropagation()`
— reproducible **only** by selecting a PR-comment index item that auto-drills
its own anchor block open (`openCommentAnchorDrill`, see "The right-click
context menu"'s sibling doc `command-palette.md`), against a **real, live** PR
(13221) — never on a plain click of the button itself.

**What IS established** (temporary `console.log`/`console.trace`
instrumentation in `blockCloseColumnButton`, reverted after — not left in the
tree): the button mounts exactly **once**, and that *same, only* mounted
instance's own `@click` closure fires **within the same microtask as its own
mount**, via arrow.js's `Vt` (the reactive-recompute microtask flush) calling
its internal `rt` recompute function with **zero arguments** — not via
`ie`/`addEventListener` (which always passes the real DOM event). So this is
arrow.js's own internals invoking the closure, not a real click, and not a
second/stale instance from an earlier navigation.

**What is a STRONG HYPOTHESIS, not proof:** `We`'s `@`-prefixed (event
listener) branch is the **only** binding kind that never registers itself in
the `At`/`Pt` bookkeeping arrays `pe()` (arrow.js's chunk-reuse patcher) uses
to safely resync a recycled chunk — every other binding kind (reactive
attribute, reactive content) does, via `lt(...)`. That asymmetry means an
event-listener pool slot has no safety net if its numeric pool index is ever
shared with/handed to a differently-typed consumer. This was **not**
confirmed live (the captured JS stack is only 2 frames deep inside the
minified bundle — V8 can inline/hide intermediate frames — so an
alternative mechanism cannot be ruled out).

**What did NOT reproduce:** the exact same interaction (select a comment
whose anchor auto-drills open), built as an isolated Playwright fixture
(mocked single comment, `tests/comment-anchor-expanded-view.spec.mjs`'s own
`mockAnchoredComment` helper, PR 12903) — zero errors, every time. Whatever
extra ingredient PR 13221's real data/timing supplies was not isolated
within the time spent on this. **Do not assume this is fully understood** —
a future session hitting a similar symptom should re-open the investigation
rather than treat this as closed.

**The fix applied is deliberately defensive/precedent-matching, not a
root-cause fix:** the three Block.mjs-family templates whose **entire**
expression list is one-or-two bare event listeners (no other reactive
attribute/content binding at all) and which their own caller toggles bare
between the template and `''` — `blockCloseColumnButton`,
`blockMenuButton` (`Block.mjs`), and `resizeHandle` (`columnWidth.mjs`,
shared by 4 call sites) — each got (1) the same stable
`<div class="contents">` wrapper as `stepChevronSlot` above (matches the
established convention in this file even though the mechanism here isn't
proven to be the identical "keyed body IS the toggle" derailment — these
three are **not** separately `.key()`'d), and (2) a guard in the handler
(`if (!e) return`, or `onDown` wrapped as `(e) => e && onDown(e)`) that
turns a future misfire into a silent no-op instead of a crash. **Every
other** `${() => cond ? … : ''}` toggle in `Block.mjs` (40+ bindings
audited) was deliberately left alone: each either already has a reactive
attribute/content binding alongside its event listener (giving it an `At`
registration and thus the `pe()` safety net above), returns a consistently
one-shaped value (e.g. `pathPills` always returns an array), or is a
plain string↔string ternary with no template involved at all — none of
these share the narrow "nothing but event listeners" shape the hypothesis
above is about, and none showed any symptom.

## A statically interpolated template↔string slot leaks the template function as text

`` ${cond ? html`…` : ''} `` **without** `() =>`. Observed in
`RelatedPanel.mjs`'s drill-hint chips: literally **`i=>je(n,i)`** appeared where
the approval counter belonged — in the minified build that *is* the template
function (`html`` ` returns `const n=(i=>je(n,i)); n.isT=!0`, `bt` in
`vendor/arrow.js`).

Mechanism: if a chunk hydrates such a static slot with the **string** branch
(`''`), `Ve` registers a **text-node binding** and the chunk stays reusable (`r`
stays true); arrow caches chunks per template shape (`g`) and reuses one for a
later instance of the same shape (`U`→`pe`). The static patch path `pe` knows
only attribute / function binding / `textNode.data = value` — so a **template**
value gets written into `Text.data` and stringified. (If the template branch
hydrates first it sets `r=false`, which is why this is intermittent and a fresh
first render doesn't show it.)

**Two allowed forms:** (1) make the slot **always a string** — precompute the
text on the descriptor (e.g. `approveText` in `nestedChangedKids`, `home.mjs`)
and render it in an always-present element (hide via a precomputed whole-value
class); or (2) use a **`${() => …}` function binding** — arrow's reactive path
(`re`) handles template↔`''` correctly, and a closure reading only a plain
non-reactive descriptor registers no deps. Statically interpolating a template
is only allowed when that slot is a template in **every** instance of that shape
(like `testsBar`'s always-populated chip `.map()`). Regression test: the `=>`
assertion in `tests/related-nested-chip.spec.mjs`.

## A keyed node is reused without re-running its bindings — and co-subscribers can drop an update

Two related pitfalls, both from `DetailPanel`'s block cards (`home.mjs`):

1. If a keyed node switches role but its `.key(...)` stays the same (a block
   going *preview* → *selected* on ↓/↑), arrow.js **moves + patches** the
   existing node: the `${() => …}` bindings inside don't re-run, so a frozen
   binding (e.g. the `activeGroup` highlight) never fires for the new state.
2. If **multiple** reactive consumers subscribe to the same property (the diff
   render reads `b.code`, a `watch` getter reads `curBlock().code`), arrow.js
   **intermittently** drops the `null→loaded` update of the diff binding — the
   diff stays stuck on "loading" while the code is already there.

**Solution for both:** let non-navigation transitions force a **fresh** node via
the key, and rebuild the card from the outside instead of trusting the fragile
`b.code` binding. In `home.mjs` the block-card key encodes role (`sel`/`prev`)
**and** code status (`load`/`code`/`err`), and the DetailPanel binding
subscribes to `state.codeVersion` (bumped by `ensureCode`) so it reliably
re-runs and flips the key. The `setCommentScope`/`setRelated` watches still read
`curBlock().code` (they must, to follow the cursor) — their co-subscription is
exactly why the diff binding can miss the update, hence rebuilding via the key
rather than adding another `b.code` reader. See the card `.key()` rules in
`.claude/docs/drilling.md`.

**Third variant — never compare the render-loop's raw index, compare identity.**
`DetailPanel`'s `pair.forEach(({ b, i }) => ...)` (`home.mjs`) builds each
card's reactive opts (`activeGroup`/`hintsEnabled`/`diffActive`/`viewMode`) as
closures that used to compare the loop's own `i` against `state.selected`
(`i === state.selected`). The card's `.key(...)` deliberately does **not**
encode `i` — a still-selected row must not be torn down and rebuilt just
because its raw position in `state.blocks` shifted — so arrow.js correctly
**reuses** the mounted node across a pure reindex. But that reuse means the
closure's captured `i` is now a snapshot frozen at whichever render happened
to build the currently-mounted node, while `state.selected` is read fresh
every time the closure fires. `recomputeLeftList()` reindexing the
still-selected row (any of `loadRelations`/`loadCallResolve`/
`loadTestCovers`/the comment poll landing, all of which can fire moments
after a `?sel=`/`?tmethod=` restore) then desyncs the two **permanently** —
nothing else ever re-triggers that binding — so `i === state.selected` goes
stale forever and the active-row highlight vanishes with **no error at all**
(the closure just now legitimately, silently, evaluates to `false`/`null`).
Same root cause as the two variants above (a keyed node's bindings don't
re-run on reuse), but the fix here is the general rule from `conventions.md`
("snapshot a selection by stable ID, never by raw array index") applied to a
reactive *closure* rather than to a one-shot guard: compare `b`'s own object
IDENTITY against `curBlock()` (`isActiveCard(b)`, `home.mjs`) instead of the
frozen `i` — correct regardless of which render's closure ends up being the
one that stays mounted. Regression test:
`tests/testclass-restore-reindex.spec.mjs`.

**Fourth variant — this pattern has now reoccurred three times, don't
add a fourth.** `CodePreview.mjs`'s `codePreviewColumn`/`previewCard`
(the Claude-chat/PR-comment code-preview stack, `RelatedPanel.mjs`'s
`CodePreviewPanel`) took `isExpanded(i)`/`getLinkSel(i)` as INDEX-based
getters, and `RelatedPanel.mjs` re-derived the actual item on every call via
`combinedPreviewItems()[i]`. Once that list shrank or reordered (a fence
appearing/disappearing while a Claude turn streams, the pending-edits card
coming and going), a card whose keyed chunk was reused kept its FIRST-mount
`i`, which could point past the new, shorter array —
`combinedPreviewItems()[i]` came back `undefined`, and
`isPreviewExpanded(undefined)` threw reading `it.key`. Same underlying cause
as the first two variants (a reused keyed node's bindings never re-run), same
"only visible via debug mode" shape as the third: LOCAL PATCH 4/5 (see
"LOCAL PATCH 4/5" above) caught the throw and only `console.error`'d it,
never rethrew — so it was invisible to `window.onerror`, and because the
closure is frozen, EVERY subsequent trigger re-threw the identical error,
forever, for that one card (832 caught throws over ~7 minutes in the real
session that surfaced this, found via the debug-mode `console.error` hook —
see `.claude/docs/debug-mode.md`). Read as "the browser is frozen", even
though the rest of the reactive graph kept updating. Fixed the same way as
variant three, one step more direct: pass the already-available `it` (this
map iteration's own array element, guaranteed non-`undefined`) into
`isExpanded`/`getLinkSel` instead of re-deriving it via a captured index — no
identity comparison needed here, just no index at all. `isActive(i)` stays
index-based on purpose: `cs.previewPos` is a POSITION (a keyboard cursor), not
an item identity, so a stale `i` can only compare wrong, never dereference
anything. See the "MEASURED CRASH" comment above `CodePreview.mjs`'s
`previewCard`.
**Unrelated aside worth remembering:** the bug report that led here gave a
URL selecting a `test_class` row (`?sel=testclass:...&tcol=1`,
`.claude/docs/test-class-grouping.md`) — that column was NOT the cause. The
reviewer had a Claude-chat/PR-comment panel open alongside it, which is where
this card actually lives. A future "frozen" report carrying a similar
`testclass`/`tcol` URL should not be assumed to be a test-class-grouping bug
on that basis alone — check `data/debug-log.jsonl`'s `error` lines first,
they name the real file/line.

**Fifth variant — a keyed list embedded as a STATIC (non-`() =>`) slot inside
a template that itself only gets rebuilt by an outer toggling `${() => {...}}`
closure goes stale forever after its first render.** `CommentClaudeFooter`'s
"Andere chats in deze PR" list (`RelatedPanel.mjs`) used to be built like
this: `${() => { ...; return tasks.length ? html\`<div>...${tasks.map(c =>
claudeTaskRow(c))}...</div>\` : '' }}`, with `tasks` a plain local array
snapshotted once per closure run. The OUTER closure's own dependency tracking
worked correctly — the reviewer-request filter added to `otherClaudeChatsAll`
(auto-started / seen-and-answered exclusion, see that function's own doc
comment) recomputed on every relevant cache update, proven with a temporary
`console.log` right inside the closure and inside the `.filter()` callback:
both printed the CORRECT, up-to-date result on every run. But the DOM never
reflected it once mounted: after the very first hydration (when the wrapping
`html\`...\`` was freshly created), every LATER re-run of the outer closure
returned "the same template shape" again, and arrow.js's chunk-reuse path
patched the existing chunk instead of truly re-diffing it — and that static
patch path does not re-run the `${tasks.map(...)}` slot at all, because it
carries no `() =>` of its own; it was just a plain array value baked into the
template at construction time. One row (an automatically-started chat) DID
disappear correctly the first time the outer template went from
zero-then-nonzero items (a genuine template↔`''` toggle, which really does
remount), which is what made this look at first like ordinary working
reactivity — the staleness only showed up on a SECOND filtering change
against an already-mounted, non-empty list.

**Fix, combining two already-documented patterns:** (1) wrap the whole
toggle in its own stable `<div class="contents">` root (the "Never key a
template whose entire body is one toggling expression" fix above), and (2)
turn the list slot itself into its own `${() => otherClaudeChats().map(...)}`
FUNCTION binding rather than a bare `${tasks.map(...)}` snapshot — so the
list is reactively diffed on its own, independent of whether the outer
toggle's chunk gets reused. Regression test:
`tests/claude-other-tasks-hidden.spec.mjs`. General rule: never interpolate
a `.map(...)`ed keyed list as a STATIC value inside a template that a
`${() => cond ? html\`...\` : ''}` closure only conditionally (re)creates —
give the list its own `() =>` binding, always, even when it sits directly
inside an already-reactive parent slot.

## A `state.x` read inside an outer array-building closure couples the WHOLE closure

Reading `state.x` synchronously inside an outer array-building
`${() => {...}}` closure (instead of in its own nested reactive slot) makes the
entire closure depend on `state.x`, even when the outcome concerns one small
element. In `home.mjs`'s `DetailPanel` the block-column closure called
`canStep(-1)`/`canStep(1)` directly, and `canStep` reads
`state.change`/`mode`/`focusLevel` — so the whole closure, and thus every
`Block()` call with **fresh** `activeGroup`/`hintsEnabled`/`diffActive`
closures, re-ran on every ↑/↓ step. The `.key(...)` prevented a DOM-node
replacement, but every function-bound attribute slot was still **re-set**
(`setAttribute` doesn't compare) — a `MutationObserver` cascade over the whole
card that read as the entire card flickering, not just the highlight moving.

**Solution:** move the read into its own nested
`${() => canStep(...) ? … : ''}` binding (same shape as
`${() => menu.open ? menuOverlay() : ''}`) so only that small slot reacts to
navigation state; the outer closure stays limited to the deps it names
(`selected`/`codeVersion`/`focusLevel`). See `stepChevronSlot` in `home.mjs`
and "No flicker on a gran/change step" in `.claude/docs/drilling.md`.

## Orphan bindings of a dropped subtree: crash, then leak — and the `ms` swap

A conditionally rendered subtree (`${() => menu.open ? menuOverlay() : ''}`)
disappears from the DOM on close, **but** its list/row bindings stay subscribed
to the state object they were built against — the disposal gap at the top of
this file.

**Crash:** if a **later** open mutates that same object (a different `mode`, or
a submenu setting `sub`), those orphan bindings fire against expression slots
that have since been released → `W[t] is not a function` (a counter index into
arrow's slot pool points at a recycled slot). Reopening in the same mode is
fine; cross-mode or a submenu is not. Latent for a long time, because the old
flow never opened a second menu — it only surfaced once the comment-kind
`compose` mode opened a menu **over** the composer.

**Solution:** split the menu state into a **stable** `menu` (only `open`, which
the top-level binding hangs off) and a **disposable**
`let ms = reactive({query, sel, sub, mode})` that `openMenu` **replaces** with a
fresh object on every open. Orphan bindings then point at the **old** `ms`,
which is never touched again, so they never fire. `closeMenu` only sets
`menu.open=false` and deliberately leaves `ms` alone. (Always-mounted +
CSS-hiding does **not** work: `CommandMenu` would render at page load, before a
block is selected, and the label functions reading `curBlock()` would throw and
corrupt the slot pool.) See `.claude/docs/command-palette.md`.

**Leak, which the `ms` swap does NOT fix:** the detached subtree stays alive
forever. That is a slow per-open leak on its own, but becomes **actively
growing** as soon as an orphan binding also depends on **global, continuously
changing** state — it then re-evaluates on every subsequent unrelated change,
for every menu instance ever opened. Found on `COMMANDS[0]`'s "Approve …" label
(reads `curBlock()`/`state.mode`/`gran`/`change`/`b.approvedRows`/
`b.approvedCalls`) and similar labels in `COMPOSE_COMMANDS`/`PR_COMMANDS` — the
most-used Enter palette plus the automatic postApprove follow-up after **every**
group approval. In practice: "the tab eventually freezes" after enough
approve+navigate cycles.

**Fix:** never let a `label` **function** reach the nested tree.
`resolveLabel`/`snapshotCommands` (`home.mjs`) call it **once** from ordinary,
non-reactive code (`openMenu`, outside any arrow.js tracking bracket) and fix
the result as a plain string on `ms.commands`/`ms.sub`, so CommandMenu's
`${() => labelOf(c)}` only ever sees a string and registers no dependency
outside `ms`.

**A residual leak survives ALL of the above, and it is arrow.js's own, not
ours.** Measured against a real PR (see "Measured leak" in
`.claude/docs/frontend-memory.md` for the numbers, the repro and the ruled-out
suspects): plain `↑`/`↓` navigation leaks **~2.9 KB per keystroke**, perfectly
linearly, with the DOM node count byte-constant. The cause is that
`reactive()`/`watch()` bookkeeping lives in **module-level arrays** (`X`, `et`,
`tt`, `dt` in `src/vendor/arrow.js`) indexed by **monotonic counters** (`++me`
in `nt`, `++he` in `rt`) with **no reclamation path**. The actual per-step
trigger is `Ut`, the auto-wrap that mints a fresh `nt()` id every time a
*freshly created* plain object/array is read off or written onto reactive
state — **not** `re()`'s official component-mount path (`F`/`Be`, arrow's own
`component()`/`props()`/`pick()` API), which turned out to be dead code in
this app (only `html`/`reactive`/`watch` are ever imported from
`vendor/arrow.js` — see `.claude/rules/conventions.md`). So: **don't chase
this in app code, and don't assume a disposal fix (PATCH 2/2b) removes it** —
it doesn't, and no `.key()`/binding change will.

**LOCAL PATCH 3 now fixes that arrow-side growth — but read the next paragraph
before concluding the leak is gone.** The patch makes a reactive's id the **raw
target object** instead of `++me`, and turns `X`/`et`/`dt`/`$t` into
`WeakMap`/`WeakSet`, so a dropped reactive's registry entries die with it. 16
edits, no control-flow change; see the LOCAL PATCH 3 block in
`src/vendor/arrow.js` for the exact list and the restore instructions. Measured
with a counter probe over 800 `↑`/`↓` steps: `me`/`X.length`/`et.length` went
from **+2.10 per step, unbounded** to **0.00**, with every other internal
counter (`he`, `tt`, `k`, `W`, `At`, `Ht`, `Q`, `Et`) flat too.

**The nav loop is flat with it, but only measure that after the JIT has
settled.** A/B with an identical 2500-step warmup, 1200 sampled steps: unpatched
**+293 B/step still monotone**, patched **−88 B/step, net negative, oscillating**
— the shape of the idle/inert controls. Measured after only a 200-step warmup
the same patched build reads 403 B/step at 83% climbing, which was briefly (and
wrongly) written up as "a second, arrow-independent leak". A heap-snapshot diff
by `type|name` settled it: the residual is V8 `code|system / InstructionStream`
+ `TrustedByteArray`, i.e. the optimizing compiler, with **no JS-object category
growing**. Warm up for thousands of steps and confirm with a category breakdown
before calling anything a leak — see `.claude/docs/frontend-memory.md`,
"The second leak that wasn't".

Why this shape and not id-recycling: an earlier PATCH 3 attempt recycled ids via
`FinalizationRegistry` and **crashed** (`Cannot read properties of undefined
(reading '<n>')`, roughly 1-in-4 to 1-in-20 runs of
`tests/drill-refresh-multi-level.spec.mjs`). `watch()`'s dependency bookkeeping
(`tt[watchId]`) stores raw ids as **plain numbers**, so the GC can correctly
prove a proxy unreachable and recycle its id while a watch still holds that
number uncleaned. Making the id an object reference closes that hole for free:
`it` pushes the id into the dep array, so a watch now holds its reactives
**strongly** and the race cannot exist. The landed patch is 12/12 clean on that
same spec at `--workers=1`, and a clean-worktree A/B of the full suite was
460 passed / 1 failed **identically with and without it**. Full writeup, all
before/after numbers, the measurement trap that nearly sank it, and the open
second leak: `.claude/docs/frontend-memory.md`.

## `watch(getter, cb)` fires even when the write reassigns the SAME value

The vendored proxy's `set` trap (`src/vendor/arrow.js`, the `xe.set` handler)
calls its notify function (`Gt`) **unconditionally** on every property
assignment — there is no `oldValue !== newValue` guard anywhere in that path.
So `state.x = state.x` (or any reassignment that happens to compute back to
the current value) still re-runs every `watch(() => state.x, ...)` subscribed
to it, exactly as if the value had actually changed.

This bit `home.mjs`'s `watch(() => state.selected, ...)` (the one that
releases `RelatedPanel`'s comment/thread/Claude state on a real navigation):
`recomputeLeftList()` unconditionally does `state.selected = at` on every
call, including a same-index no-op — and it runs every 5s while a PR-comment
index item is selected, because `RelatedPanel.mjs`'s comment-poll
`refreshTimer` reassigns `cs.list` on that same cadence, which re-triggers the
`indexComments()` watch, which calls `recomputeLeftList()`. Every 5s tick then
re-ran the selection watch's body for the SAME item and unconditionally closed
whatever the reviewer had just opened on it (a reply field via "Beantwoorden",
an open thread, an open Claude chat) — reported bug: the just-opened
PR-comment reply field disappeared within a few seconds, before the reviewer
could type anything.

**Fix pattern:** don't rely on the watch firing meaning "it changed" — snapshot
the value/identity you actually care about in a plain (non-reactive) module
variable and compare against it yourself inside the callback, short-circuiting
when nothing really moved. See `lastFiredSelectionRef` next to
`lastSelectedBlockRef` in `home.mjs`. Any `watch` whose callback has a
visible, hard-to-reverse side effect (closing a panel, canceling a draft,
firing a network call) is a candidate for this if something else in the app
can reassign one of its dependencies on a timer/poll without an actual
navigational change.

## Nested `@click`: call `e.stopPropagation()` FIRST, before the state mutation

A nested `@click` handler that synchronously mutates reactive state can remove
its own ancestor's `stopPropagation` listener before native bubbling reaches it.

Seen in `overview.mjs`'s row popover (`popover(pr)`): the wrapping popover
`<div>` has `@click="${(e) => e.stopPropagation()}"` so a click inside never
bubbles to the row's own `@click="${() => togglePopover(pr.number)}"`. A
**nested button** whose handler synchronously flips state that unmounts that
wrapper (e.g. `closePopover()` setting `ui.openPopover = null`, which the
`${() => ui.openPopover === pr.number ? popover(pr) : null}` slot reacts to)
detaches the wrapper — and its `removeEventListener`'d stopPropagation handler —
**synchronously within the same click dispatch**, before the event finishes
bubbling past it. The browser then finds no listener left to call
`stopPropagation()`, the click reaches the row, and `togglePopover` sees
`ui.openPopover === null` and reopens the very popover the button just closed.

**Fix:** call `e.stopPropagation()` in the button's *own* handler, **before**
triggering the state mutation — `stopped` is then already set on the event
regardless of DOM-removal timing. See the "Sluit menu" button in `popover()`.
Symptom to watch for: a close/dismiss button inside a click-swallowing overlay
that "does nothing" or instantly reopens — check whether its own handler stops
propagation; don't assume the ancestor's listener still fires.

**Same class of bug, `@keydown` variant: a nested handler that OPENS a menu
must `stopPropagation()` before doing so.** A document-level `keydown`
listener (`home.mjs`'s `onKeydown`) that has its own "the menu is already
open → this key runs/enters the highlighted command" branch will reinterpret
the SAME keydown event that a nested element's own handler just used to open
that menu — `menu.open` flips to `true` synchronously, then the event
continues bubbling into that top-level listener, which now sees an open menu
and acts on it. Symptom: the menu pops open already one level too deep (e.g.
straight into a confirm submenu) instead of showing its root list. Fix is the
same as the click case, same ordering requirement: call
`e.stopPropagation()` in the nested handler *before* calling whatever opens
the menu. See `ClaudeChat.mjs`'s composer `@keydown` (the `else` branch
calling `callbacks.onEmptyEnter?.()`) and "Comment hiervan maken' on an empty
Claude input" in `.claude/docs/claude-chat-panel.md`.

## `scrollIntoView` also moves the horizontal axis if you omit `inline`

`Element.scrollIntoView({block: 'nearest'|'center'})` moves the horizontal axis
too — the DOM default, not an arrow.js quirk, but it bit here because a vertical
"keep this row in view" scroll (Underlying-code card, chips, Tasks, comment
reactions) sits inside `<main>`'s horizontally scrolling column flow: every
↓/↑/→ step could shift `<main>`'s own `scrollLeft` and push the card holding
keyboard focus out of view ("after → and then ← the selection is no longer fully
in view").

**Solution:** `scrollIntoViewVertical` (`RelatedPanel.mjs`, exported) walks up
to the first ancestor that actually scrolls vertically
(`scrollHeight > clientHeight` — a horizontally scrolling `<main>` never
matches, so the walk stops one level before it) and sets only its `scrollTop`.
**Never call `scrollIntoView()` itself for a
"stay-in-view-while-navigating-a-list" scroll.** Used by
`scrollCodeIntoView`/`scrollChipIntoView`/`scrollTaskIntoView`/
`scrollReactionIntoView` (`RelatedPanel.mjs`) and the `scrollChangeIntoView`
fallback (`home.mjs`). `scrollFocusIntoView` deliberately **does** align the
focused column left with `inline:'start'` on a `←`/`→` focus switch and stays
unchanged — that is the one place a horizontal scroll is wanted. Test:
`tests/scroll-focus-vertical-only.spec.mjs`.
