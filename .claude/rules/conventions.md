# Conventions (filled in by this scaffold — correct where needed)

- Frontend modules are `.mjs`, one component per file, PascalCase for
  component files (`Block.mjs`), lowercase for page modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) live in `src/vendor/` and are imported with a
  relative path, not via a CDN module. Tailwind is the exception (Play CDN).
  arrow.js is vendored in `src/vendor/arrow.js`.
- **Local patch to arrow.js (`src/vendor/arrow.js`)** — there is one deliberate
  change in the vendored arrow.js, marked with a `LOCAL PATCH` comment in the
  header: the template-expression evaluator `rt` skips a **released slot**
  (`typeof W[t]=="function"` guard) instead of calling it. Without that guard,
  a reactive effect that still fires in the microtask flush after its keyed
  node has been cleaned up crashes with `W[t] is not a function`
  (use-after-free) — among other places, during **drilling** (opening an
  Underlying-code child as its own column re-scopes the panel and tears down
  cards mid-flush). On an arrow.js upgrade this patch must be **reapplied**
  (see the comment for the original line).
- **Snapshot/compare a selection by stable ID across an async gap, never by raw
  array index — the list can reindex itself in between.** A "did anything move
  the selection while I was awaiting X?" guard is a recurring pattern (see
  `loadBlocks`' `pristineSelectedId`/`curSelectedId` in `home.mjs`, and the
  `?sel=`/`blockRef` mechanism in `CLAUDE.md`'s URL-state section, which exists
  for exactly the same reason). Comparing the raw index before/after the await
  is **not equivalent** to comparing identity: `recomputeLeftList` (and
  anything similarly id-preserving) can legitimately reindex an unchanged
  selection out from under you — e.g. a PR-wide comment item arriving and
  inserting itself at rank -1 shifts every existing block one slot to the
  right — and an index-only guard then wrongly concludes "the reviewer already
  moved the selection," silently skipping whatever the guard was meant to gate
  (here: `applyDefaultUnapprovedSelection`, which as a result never got to
  consider the very comment item it should have landed on). Symptom to watch
  for: a "fresh open" default/auto-selection that intermittently or
  consistently lands on the wrong item whenever an async, independently-loaded
  list (comments, in this case) can insert itself ahead of the current
  selection before your own guard re-checks it.
- **arrow.js pitfalls** (from practice): no HTML comments (`<!-- -->`) in an
  `html`` `` template (throws "Invalid HTML position"); a reactive attribute
  value must be the **entire** value (`class="${() => ...}"`, not
  `class="x ${...}"`). You inject raw HTML via the `.innerHTML` binding
  (`.innerHTML="${() => htmlString}"`) — arrow.js then sets the property
  instead of escaping. Make sure the string is safe (e.g. Prism.highlight,
  which escapes itself).
- **arrow.js — an attribute value with ANY `${...}` interpolation must be the
  whole value, even a PLAIN (non-function) one.** The "entire value" rule
  above is usually phrased for the reactive `${() => ...}` case, but it
  applies just as much to a bare, one-shot interpolation:
  `class="text-sm font-bold ${cls}"` (no `()=>`) ALSO throws "Invalid HTML
  position" — arrow.js's static template compiler can't handle a MIXED
  literal+dynamic attribute value at all, reactive or not. Found while
  building the TRANSLATION per-key overview (`translationDiff.mjs`): a badge
  class built as `` `shrink-0 rounded ... ${KIND_BADGE_CLS[u.kind]}` `` broke
  the whole surrounding template; fixed by moving the concatenation OUTSIDE
  the template into one `${wholeString}` slot
  (`` `${'shrink-0 rounded ... ' + KIND_BADGE_CLS[u.kind]}` ``). Symptom is
  identical to the HTML-comment case ("Invalid HTML position", thrown from
  deep inside `vendor/arrow.js`'s template parser) — if you see that error,
  audit every attribute for a partial `${...}` interpolation, not just
  looking for stray `<!-- -->`.
- **arrow.js — `?attr="${() => ...}"` (and `.attr=` for anything other than
  `value`/`checked`) does NOT toggle a boolean HTML attribute like `disabled`
  in this vendored build; use the PLAIN attribute name instead
  (`disabled="${() => cond}"`, no leading `?` or `.`).** lit-html's
  `?disabled=`/a bare property-assignment `.disabled=` convention doesn't
  apply here — this build has no special-casing for a `?`/`.` prefix at all
  outside `Tt` (the attribute-patch function in `vendor/arrow.js`)'s own
  narrow `value`/`checked`/dot-prefix branch. Root cause, confirmed by
  reading the template compiler directly (`We` in `vendor/arrow.js`): the
  attribute **name** captured from the parsed template is the literal
  string `"?disabled"` (HTML happily parses `?disabled="…"` as an attribute
  literally named `?disabled`) — so the binding ends up calling
  `element.setAttribute('?disabled', …)`/`removeAttribute('?disabled')`,
  never touching the real `disabled` attribute at all. Four buttons were
  found with this bug — `overview.mjs`'s `generate-page`/`regenerate-page`/
  `ready-confirm` and `BlockList.mjs`'s `ingest-btn` — all **silently
  non-functional** (never actually disabled, just visually dimmed via their
  own `class` ternary), untested at the time so it went unnoticed; all four
  are now fixed (plain `disabled="${() => ...}"`), with a regression test
  each (`tests/overview.spec.mjs`'s "generating/regenerating … is really
  disabled while busy", `tests/overview-ready-for-review.spec.mjs`,
  `tests/ingest-btn-disabled.spec.mjs`) asserting `toBeDisabled()` (native
  attribute, not just a CSS class) during the busy window. **What DOES
  work:** a plain, undecorated attribute name with a `${() => ...}` function
  binding — `disabled="${() => cs.busy}"` — because arrow's reactive
  attribute effect (`Tt`) removes the attribute entirely when the bound
  function returns exactly `false` and calls `setAttribute` (any truthy
  value) otherwise; since `disabled`/`checked` are HTML boolean attributes
  (presence-based, not value-based), that's enough to reliably toggle them —
  confirmed both via the DOM (`element.disabled` reflects correctly) and
  visually. This is also why the existing, working
  `checked="${() => blockApproved(b)}"` in `Block.mjs` uses no dot — bare
  `checked` already works via this same generic path, not via the `Tt`
  function's separate `e==="checked"`/dot-prefix special-casing.
  `.indeterminate="${...}"` (also in `Block.mjs`) is a **different** case
  that happens to still work with a dot: `indeterminate` has NO HTML
  attribute reflection at all, so even though the attribute name still ends
  up wrong (`.indeterminate` instead of `indeterminate`), the underlying DOM
  *property* — set via `Tt`'s `e[0]==="."` branch, which strips the dot and
  assigns `t[e]=n` directly on the element — still gets set correctly.
  `disabled`/`checked` DO have attribute reflection, which is exactly where
  a `?`/`.` prefix breaks down for them. See
  `tests/reaction-status-icon.spec.mjs` for a working example
  (`disabled="${() => cs.busy}"` on `reaction-send`/`reaction-status`/
  `comment-send`/`comment-detail-send`).
- **arrow.js — a single `html`` `` tag can only ever have ONE root element.**
  `` html`<p>a</p><p>b</p>` `` (two sibling top-level tags in one tagged
  template) also throws "Invalid HTML position" — build an ARRAY of two
  separately-tagged, `.key()`ed templates instead
  (`[html\`<p>a</p>\`.key('a'), html\`<p>b</p>\`.key('b')]`) and interpolate
  the array as an ordinary keyed-list slot. Came up in the same
  `translationBlockView` row (a 'changed' key shows both its old and new
  value as two `<p>`s).
- **arrow.js `watch(getter, cb)` — enumerate your reactive deps _inline_ in the
  getter.** If you hide all reads inside a called function with early
  returns/conditional paths (e.g. `watch(() => buildStuff(), …)`), the
  dependency set varies per run and the crystallized run can drop a key it
  previously subscribed to — the watch stops re-subscribing and stops firing.
  So list the state it must track literally
  (`() => [state.a, state.b, obj && obj.x]`) and do the actual work in the
  _callback_. That's how the `setCommentScope` and `setRelated` watches in
  `home.mjs` do it; an earlier `setRelated` watch that did **not** do this let
  the related panel freeze on the block that was selected at load time (see
  `.claude/rules/detail-layout.md`).
- **arrow.js — a `${() => …}` slot that switches between a single element and a
  keyed array (`.map()`) freezes after an empty render.** Observed in the
  comment list of `RelatedPanel.mjs`: the slot returned either
  `visibleComments().map(...)` (keyed rows) or a single
  `<p>No comments yet</p>`. Navigate to a block **without** comments (the slot
  renders the single `<p>`) and then back to a block **with** a comment, and
  the slot binding did re-run and returned a non-empty array, but arrow.js no
  longer rendered the rows — the list stayed empty while `cs.view` **was**
  populated (the comment still showed in the thread header, which returns a
  string). **Solution:** always emit **the same kind** from that slot — wrap
  the empty state in an **array of one**
  (`[html\`<p …>…</p>\`.key('no-comments')]`) so the slot's shape stably stays
  a keyed array. Re-keying the panel or a scalar version counter didn't help;
  only the stable array shape did.
- **arrow.js — never key a template whose entire body is one toggling
  expression (`` html`${() => cond ? sub() : ''}` ``).** Related to the
  single↔array pitfall above, but worse: arrow.js sets a chunk's DOM
  boundaries (`ref.f`/`ref.l`) only at **hydration**; if the nested reconciler
  later swaps that content (template ↔ `''`), it replaces the DOM **without**
  updating the owner chunk's `ref`. For a template whose expression is the
  entire body, that expression **is** the chunk boundary — the `ref` therefore
  points to removed nodes after one toggle. If such a template sits as a
  **keyed item in a list**, the keyed reconcile then derails step by step:
  `patchKeyedList` bails on the stale ref (parent `null`), the generic
  fallback path loses the chunk (a text placeholder instead of the chunk), and
  a subsequent run uses the stale ref as an **anchor** — newly mounted items
  end up in a detached fragment and disappear from view, after which two
  reconciler administrations fight over the same chunks (infinite microtask
  loop, tab freezes). That's how the look-ahead preview card disappeared
  under repeated ↓/↑ through same-file blocks: `stepChevronSlot` (`home.mjs`)
  was such a bare wrapper, keyed as `step-up`/`step-down` in the block column.
  (Unpatched upstream 1.0.6 already crashes on the same scenario earlier with
  `expressionPool[effect] is not a function` — LOCAL PATCH 1 masks that crash
  down to silent render corruption.) **Solution:** give such a slot a
  **stable element root** and toggle **inside** that root, e.g.
  `` html`<div class="contents">${() => cond ? sub() : ''}</div>` `` — the
  `ref` then points permanently to the element. The **static** `contents`
  class is doubly deliberate: `display:contents` removes the wrapper box from
  layout (content shows → it becomes the flex item itself; empty → **no**
  flex item, so no `gap` artifact either), and a static class avoids a
  reactive attribute binding that would be set again on every navigation step
  (the flicker test in `navigate.spec.mjs` requires zero attribute mutations
  per step). Regression test: `tests/step-preview-stability.spec.mjs`.
  **Side effect, separately confirmed:** the same derailment also corrupted a
  completely different, nested `${() => componentCall(...)}` embedding in the
  same block-column list — `Block.mjs`'s `${() => codeDiff(...)}` — with a
  visible, silent symptom: after a same-file ↓/↑ cycle the selected card
  showed the **correct title** (`class::method`, an ordinary reactive text
  binding, hence not affected itself) but the **code of the previously
  selected block** — no crash, just wrong content, unless you happened to also
  hit the previously described `Cannot read properties of null (reading
  'after')` crash. Confirmed by bracketing the exact fix commit with a
  git-worktree comparison (before/after) against the same real PR data:
  before the `stepChevronSlot` fix the mismatch + crash reproduced reliably,
  after it didn't — so **no separate fix needed**, the same stable-element
  root fixed it too. Regression test: `tests/diff-code-vs-title.spec.mjs`
  (the same ↓/↑ cycle as `step-preview-stability.spec.mjs`, but instead of
  checking for the preview card's presence, verifies that the rendered diff
  text of the selected card always belongs to that block's own `/api/code`
  source — never a neighboring block).
- **arrow.js — disposing a nested reconciler's mounted subtree must also FORGET
  it (`LOCAL PATCH 2b` in `src/vendor/arrow.js`).** LOCAL PATCH 2 (above) made
  `Ft`/destroyChunk cascade into nested `${() => componentCall(...)}` subtrees,
  which fixed the unbounded memory growth — but turned the old *leak* into a
  **use-after-free**: `Ft` nulls a chunk's own DOM boundaries
  (`ref.f`/`ref.l`), while the nested reconciler still held that chunk as its
  `previous`. The next time that reconciler ran — and it does run again, the
  same late/queued-effect window LOCAL PATCH 1 guards: a reactive expression
  whose slot is still alive fires in the microtask flush after the owning keyed
  node is gone — it took the "replace what's mounted" path on the dead chunk
  and did `insertionPoint(previous).after(...)`, where the insertion point is
  `previous.ref.l` → `null` → **`Cannot read properties of null (reading
  'after')`**. Worse than a one-off crash: the throw leaves that reconciler
  wedged, so the subtree stops updating entirely and the app silently freezes
  on whatever it last rendered. Concretely: entering a block's diff and
  pressing ↓ into a same-file neighbour block crashed on the step-chevron
  slot's toggle and froze **all** further keyboard navigation (the URL stopped
  changing, no error visible in the UI). The fix is one token — clear
  `previous` after disposing it (`e&&(qt(e,!0),e=void 0)`), so a late run
  mounts fresh into the owner's own detached fragment instead of patching a
  destroyed chunk. Regression tests:
  `tests/step-preview-stability.spec.mjs`, `tests/diff-code-vs-title.spec.mjs`
  (both walk a ↓/↑ same-file block cycle and assert zero page errors).
- **arrow.js — a STATICALLY interpolated value that per instance is either a
  template or a string (`` ${cond ? html`…` : ''} `` without `() =>`) leaks
  the template function as text on chunk reuse.** Observed in the drill-hint
  chips of `RelatedPanel.mjs`: literally **`i=>je(n,i)`** appeared where the
  approval counter should be — that (in the vendored, minified build) is the
  template function itself: `html`` ` returns
  `const n=(i=>je(n,i)); n.isT=!0` (`bt` in `vendor/arrow.js`). Mechanism: if
  a chunk hydrates such a static slot with the **string** branch (`''`), `Ve`
  registers a **text-node binding** for that slot and the chunk stays
  reusable (`r` stays true); arrow caches chunks per template shape (`g`) and
  reuses such a cached chunk for a later instance with the same shape
  (`U`→`pe`). The static patch path `pe` knows only three cases —
  attribute, function binding, or **`textNode.data = value`** — so if the new
  value is a **template**, the template function gets written to `Text.data`
  and stringified. (If the template branch hydrates first, it sets `r=false`
  instead — which is why the bug is intermittent and a fresh first render
  doesn't show it.) **Solution, two allowed forms:** (1) make the slot
  **always a string** — precompute the text as a plain string on the
  descriptor (e.g. `approveText` in `nestedChangedKids`, `home.mjs`) and
  render it in an always-present element (hiding can use a precomputed
  whole-value class); or (2) turn it into a **`${() => …}` function binding**
  — arrow's reactive path (`re`) handles template↔`''` swaps correctly, and a
  closure that only reads a plain (non-reactive) descriptor object registers
  no deps and therefore can't co-subscribe to anything. Statically
  interpolating a template is only allowed if that slot is a template in
  **every** instance of that shape (like `testsBar`'s always-populated chip
  `.map()`). Regression test: the `=>` assertion in
  `tests/related-nested-chip.spec.mjs`.
- **arrow.js reuses a keyed node without re-running its function bindings —
  and sometimes drops an `.innerHTML`/attribute update for co-subscribers.**
  Two related pitfalls, both observed in the block cards of `DetailPanel`
  (`home.mjs`):
  1. If a keyed node switches role but its `.key(...)` stays the same (e.g. a
     block going from *preview* to *selected* on ↓/↑), arrow.js **moves +
     patches** the existing node instead of rebuilding it: the
     `${() => …}` function bindings inside don't re-run and a frozen binding
     (e.g. the `activeGroup` highlight) never fires for the new state.
  2. If **multiple** reactive consumers subscribe to the same property (e.g.
     the diff render reads `b.code` and a `watch` getter reads
     `curBlock().code`), arrow.js **intermittently** drops the
     `null→loaded` update of the diff binding — the diff stays stuck on
     "loading" while the code is already there.
  Solution (both): let non-navigation transitions force a **fresh** node via
  the key, and rebuild the card from the outside instead of relying on the
  fragile `b.code` binding. Concretely in `home.mjs`: the block-card key
  encodes role (`sel`/`prev`) **and** code status (`load`/`code`/`err`). The
  DetailPanel binding subscribes to `state.codeVersion` (bumped by
  `ensureCode` as soon as code arrives) — a counter alongside `b.code` — so
  it reliably re-runs and flips the key, which produces a **fresh** diff
  binding that reads the loaded code. The `setCommentScope`/`setRelated`
  watches still read `curBlock().code` (they have to, to follow the cursor);
  that makes them co-subscribers and is exactly why the diff binding itself
  can miss the update — hence rebuilding via the key instead of adding yet
  another `b.code` reader. See `.claude/rules/detail-layout.md`.
- **A `state.x` read that you call synchronously inside an outer array-building
  `${() => {...}}` closure (instead of in its own nested reactive slot) makes
  the ENTIRE closure depend on `state.x`** — even if the outcome itself only
  concerns one small element. Seen in `home.mjs`'s `DetailPanel`: the
  block-column closure that builds all `Block(...)` cards called
  `canStep(-1)`/`canStep(1)` (for the gray step chevron) **directly**;
  `canStep` reads `state.change`/`mode`/`focusLevel`. As a result, the entire
  closure — and thus every `Block()` call with **fresh**
  `activeGroup`/`hintsEnabled`/`diffActive`/etc. closures — re-ran on
  **every** ↑/↓ step. The `.key(...)` prevented a full DOM-node replacement
  (arrow matches it and reuses the node via `move+patch`), but every
  function-bound attribute slot (`class`, checkbox `.indeterminate`,
  category badge, etc.) still got **re-set** (`setAttribute` doesn't compare
  against the old value) — a measurable `MutationObserver` cascade over the
  ENTIRE card on every step, which read as visible flickering (not just the
  highlight shifting, the whole card "breathed" along). **Solution:** move
  the `state.change` read to its own nested
  `${() => canStep(...) ? … : ''}` binding (the same shape as the existing
  `${() => menu.open ? menuOverlay() : ''}` toggle) so only that small slot
  reacts to navigation state; the outer closure stays limited to the deps it
  explicitly names (`selected`/`codeVersion`/`focusLevel`). See
  `stepChevronSlot` in `home.mjs` and `.claude/rules/detail-layout.md`.
- **arrow.js doesn't fully clean up a dropped (conditionally rendered)
  subtree — its reactive expressions stay subscribed (use-after-free).** Seen
  in the **command menu** (`home.mjs` + `CommandMenu.mjs`): the overlay hangs
  off a `${() => menu.open ? menuOverlay() : ''}` binding. On close that
  returns `''` and the overlay disappears from the DOM, **but** the list/row
  bindings of that `CommandMenu` instance stay subscribed to the state object
  they were built against. If a **later** open mutates that object (a
  different `mode`, or entering a submenu that sets `sub`), those **orphan
  bindings** fire against expression slots that have since been released →
  arrow throws `W[t] is not a function` (a counter index in arrow's slot pool
  points to a recycled slot). Reopening in the same mode doesn't crash (no
  dep changes), cross-mode or a submenu does. It's a **latent** bug: the old
  flow never opened a second menu (Enter/`/` were swallowed while the
  composer was open), so it only became visible once the comment-kind
  `compose` mode opened a menu **over** the composer.
  **Solution:** split the menu state into a **stable** `menu` (only `open`,
  which the top-level binding hangs off) and a **disposable**
  `let ms = reactive({query, sel, sub, mode})` that `openMenu` **replaces**
  with a fresh object on **every** open. Orphan bindings from a previous open
  then point to the **old** `ms`, which we never touch again, so they never
  fire; only the live bindings (against the current `ms`) run. `closeMenu`
  only sets `menu.open=false` — it deliberately leaves `ms` alone.
  (Always-mounted-with-CSS-hiding does **not** work: then `CommandMenu` would
  already render at page load — before a block is selected — and the label
  functions that read `curBlock()` would throw anyway, corrupting the slot
  pool.) See `.claude/rules/keyboard-navigation.md`.
- **This same disposal gap is also a memory leak, not just a crash risk — and
  the `ms` swap above only fixes the crash.** The `ms` swap prevents an
  orphan binding from **crashing** (it hangs off an object that never
  changes again, so it never fires again), but arrow.js's `Ft` teardown
  (cleaning up a dropped keyed node) only cleans up the expression slots the
  node **itself directly** owns — it never cascades into a nested piece of
  template embedded via `${() => componentCall(...)}` (such as
  `${CommandMenu(ms, ...)}` in `menuOverlay()`, or `${() => codeDiff(...)}` in
  `Block.mjs`). Such a nested reconciler tree (every row, every `.innerHTML`
  binding in it) therefore stays a live, DOM-less (detached) piece of
  template **forever** — exactly "Detached `<span>`/`<div>`/Text" growth in a
  heap snapshot. That's already a (slowly growing, per-open) leak on its own,
  but it becomes an **active, ever-faster growing** problem as soon as an
  orphan binding depends **not only** on the discarded `ms` but **also** on
  **global, continuously changing** state: such a binding stays registered
  against that global property after closing and therefore re-evaluates on
  **every** subsequent, unrelated change — for **every** menu instance ever
  opened. Concretely found: `COMMANDS[0]`'s "Approve …" label (reads
  `curBlock()`/`state.mode`/`state.gran`/`state.change`/`b.approvedRows`/
  `b.approvedCalls`), plus similar labels in `COMPOSE_COMMANDS`/`PR_COMMANDS`
  — exactly the **standard, most-used** Enter palette, and the automatic
  postApprove follow-up menu after **every** group approval
  (`afterApproveAction`). Every open+close cycle left behind an ever more
  expensive ghost that recalculated on every subsequent
  navigation/approve step — a Playwright-measured, reproducible ~3.6×
  slowdown of 60 `f`/`s` keystrokes after 200 open/close cycles on the
  unpatched code (0.9–1.0× — flat, no growth — after the fix), which in
  practice manifested as "the tab eventually freezes" after enough
  approve+navigate cycles.
  **Fix (applied, low risk):** never let a `label` **function** reach the
  nested, never-cleaned-up `CommandMenu` tree. `resolveLabel`/
  `snapshotCommands` (`home.mjs`) call such a function **once** from
  ordinary, non-reactive code (`openMenu`, i.e. outside any arrow.js
  `Te()/Ae()` tracking bracket) and fix the result as a plain string on
  `ms.commands`/`ms.sub` — CommandMenu's own `${() => labelOf(c)}` binding
  then never sees anything but a string, so it registers no dependency on
  anything outside `ms`, and an orphan binding stemming from that never fires
  again (just like the existing `ms`-only bindings).
- **Root-cause fix: `Ft` now cascades into nested-mounted reconciler subtrees
  (`LOCAL PATCH 2` in `src/vendor/arrow.js`).** The `CommandMenu` fix above is
  a targeted, app-level band-aid (never let a `label` function reach the
  tree); the same disposal-gap pattern also sat **under** the card re-render
  in `DetailPanel`/`Block.mjs` (every time a block card got a **new key** —
  preview→selected, code just loaded, focus-level switch, see
  `.claude/rules/detail-layout.md` — the old `<article>` was torn down, but
  its nested `${() => codeDiff(...)}` subtree, with its
  `b.approvedRows`/`state.diffViewMode`-reading `.innerHTML` bindings,
  hung around in the same way). That already happened on **plain
  navigation** (not just approving) and was the single biggest contributor
  to unbounded memory growth during a review session (measured with
  Playwright/CDP heap snapshots: +4600 detached DOM nodes per 60 card
  re-renders before the patch, vs. ±30 — noise — after; a second,
  timing-based experiment showed a ~7-8× slowdown of a bounded
  `b.approvedRows` mutation after 60 re-renders before the patch, vs.
  ~0.85-0.93× — flat — after). Instead of continuing to patch this per
  component (every new nested `${() => componentCall(...)}` embedding would
  reintroduce the same leak), the actual root cause was patched in arrow.js
  itself: `re(t)` (upstream `createRenderFn`, the reconciler factory that
  `Ve`/upstream `createNodeBinding` uses for **every** nested
  component/array/template value — `CommandMenu`'s rows, `Block.mjs`'s
  `${() => codeDiff(...)}`, `RelatedPanel`'s `.map()` lists, …) now
  registers, via its first parameter (upstream the SSR `capture` flag, dead
  in this build — esbuild tree-shook every `if(capture)` branch away,
  confirmed by grepping the whole function body for a standalone `t` token
  before it was reused), one cleanup on the **owner** node: as soon as that
  owner is torn down via `Ft`, this cleanup also cleans up whatever the
  reconciler is currently keeping mounted, via the **same** existing dispatch
  (`qt`/upstream `removeUnmounted` — cache-for-reuse vs. fully destroy,
  chunk-or-array) that top-level content already got. Purely additive (3
  small insertions, no existing line changed) and **automatically recursive:
  correct**: a nested reconciler that itself nests something else registers
  its own cleanup on its own owner the same way. Verified against the real,
  non-minified upstream source (`@arrow-js/core@1.0.6`,
  `dist/index.mjs` + `dist/chunks/internal-*.mjs` via jsDelivr) to trace the
  minified names (`re`=`createRenderFn`, `Ve`=`createNodeBinding`,
  `Ft`=`destroyChunk`, `qt`=`removeUnmounted`, `n.u`=`chunk.u`) with certainty
  rather than guessing from minified text — see the `LOCAL PATCH 2` comment
  block in `vendor/arrow.js` for the full mechanism and the exact restore
  instructions on an arrow.js upgrade.
- **A nested `@click` handler that synchronously mutates reactive state can
  remove its own ancestor's `stopPropagation` listener before native bubbling
  reaches it — call `e.stopPropagation()` FIRST, before the state mutation.**
  Seen in `overview.mjs`'s row popover (`popover(pr)`): the wrapping popover
  `<div>` has `@click="${(e) => e.stopPropagation()}"` so a click anywhere
  inside it never bubbles to the row's own `@click="${() =>
  togglePopover(pr.number)}"`. A **nested button** whose own click handler
  synchronously flips reactive state that unmounts that wrapping div (e.g.
  `closePopover()` setting `ui.openPopover = null`, which the `${() =>
  ui.openPopover === pr.number ? popover(pr) : null}` slot reacts to)
  apparently detaches the wrapper (and its `removeEventListener`'d
  stopPropagation handler) **synchronously, within the same click-event
  dispatch** — before the event finishes bubbling past it. The browser then
  finds no listener left on that node to call `stopPropagation()`, so the
  click keeps bubbling to the row, which immediately reopens the very popover
  the button just closed (`togglePopover` sees `ui.openPopover` is now `null`
  and flips it back open). **Fix:** call `e.stopPropagation()` in the
  button's *own* handler, before triggering the state mutation — `stopped`
  is then already set on the event by the time bubbling would reach the
  (about-to-be-removed) ancestor, regardless of DOM-removal timing. See the
  "Sluit menu" button in `popover()`. Symptom to watch for: a close/dismiss
  button inside a click-swallowing overlay that "does nothing" (or instantly
  reopens) — check whether its own handler also stops propagation, don't
  assume the ancestor's `stopPropagation` still fires.
- **`Element.scrollIntoView({block: 'nearest'|'center'})` also moves the
  horizontal axis if you omit `inline`** — that's the DOM default, not an
  arrow.js quirk, but it bit here because a vertical "keep this row in view"
  scroll (Underlying-code card, chips, Tasks, comment reactions) happens to
  sit inside `<main>`'s horizontally scrolling column flow: every ↓/↑/→ step
  in such a list could unintentionally shift `<main>`'s own `scrollLeft` and
  push the card holding keyboard focus (to the left of the panel) out of
  view — exactly the complaint "after → and then ← the selection is no
  longer fully in view". **Solution:** `scrollIntoViewVertical`
  (`RelatedPanel.mjs`, exported) walks up from the element to the first
  ancestor that actually scrolls vertically
  (`scrollHeight > clientHeight` — a horizontally scrolling `<main>` never
  matches that, so the walk naturally stops one level before it) and sets
  only its `scrollTop` — never call `scrollIntoView()` itself for a
  "stay-in-view-while-navigating-a-list" scroll. Used by
  `scrollCodeIntoView`/`scrollChipIntoView`/`scrollTaskIntoView`/
  `scrollReactionIntoView` (`RelatedPanel.mjs`) and the `scrollChangeIntoView`
  fallback (`home.mjs`). `scrollFocusIntoView` (which deliberately **does**
  align the focused column left with `inline:'start'` on a `←`/`→` focus
  switch) stays unchanged — that's the one place where a horizontal scroll
  is actually wanted. See `tests/scroll-focus-vertical-only.spec.mjs`.
- **Syntax highlighting:** Prism 1.29.0 is vendored as a single ES module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php,
  with `window.Prism={manual:true}` so it doesn't auto-highlight the whole
  page). The code panes in `Block.mjs` highlight PHP with
  `Prism.highlight(...)` and show the result via the `.innerHTML` binding.
  Prism's own container CSS is deliberately omitted; only the token colors
  live in the `<style>` of `index.html`, **scoped to the `.language-php`
  class** that every code fragment carries — so not just the diff panes but
  also the Underlying-code cards + the comment hint (`RelatedPanel.mjs`) and
  the footer get the same colors. (Was previously scoped to
  `[data-testid=code-diff]`, which left everything outside the diff panes
  colorless.)
- **Markdown rendering:** `snarkdown` (v2.0.0, MIT, ~1kb) is vendored as an ES
  module in `src/vendor/snarkdown.js` (verbatim upstream algorithm, only a
  vendoring header comment added) — used exactly as it comes out of the box:
  headings, lists, bold/italic/strike, blockquotes, inline code, links,
  images, `---`. `src/markdown.mjs` is a thin wrapper
  (`renderMarkdown(text) -> safeHtmlString`) that adds two things around it:
  (1) fenced code blocks are extracted **before** anything else and rendered
  with the same Prism `highlight()` as the diff panes (`Block.mjs`) instead
  of snarkdown's own bare `<pre><code>` — hence also the `.language-php`
  class on every code fragment (same CSS scope as above); (2) an XSS safety
  layer: the **entire** raw Markdown text is first fully HTML-escaped
  (`escapeHtml`, `&<>"`) before it goes to snarkdown — snarkdown itself does
  **not** escape loose HTML in the source text, only the attribute values it
  builds itself (link/image URLs) — and link/image URLs then also pass
  through `sanitizeUrls`, which neutralizes a `javascript:`/`vbscript:`/
  `data:text/html` scheme as an extra layer (snarkdown's own `encodeAttr`
  already escapes the quote in a URL, so an `<img src>` can't inject a loose
  `onerror=` attribute anyway). Used in `prInfoCard` (`home.mjs`) for the PR
  summary/description/Jira description via the `.innerHTML` binding; a small
  `.markdown-body` style block in `index.html`
  (headings/lists/links/blockquote/code/images) is the hand-written
  typography layer — Tailwind Play CDN has no typography plugin without a
  build step. **No** GFM tables or task checklists (`- [ ]`) — deliberately
  kept out of scope, snarkdown doesn't support them and no extension has been
  built for them.
  **Comment bodies also render as Markdown** (`RelatedPanel.mjs`):
  `commentBody(c)` is the **only** place that renders a comment body
  (`() => renderMarkdown(c.body)`, `.innerHTML` binding) — reused by
  `commentRow` (the comment-row preview), `reactionBubble` (every thread
  bubble, both the block-scoped comment panel and the PR-wide `prWideItem`),
  and therefore automatically also a future fourth render point. The input
  (composer `<textarea>`/`<input>`) is a bare text field with no
  restriction — "supporting markdown input" was thus already free, only the
  display was missing `renderMarkdown`. **Deliberately kept outside
  `commentBody`:** the single-line, `truncate`/`line-clamp` title contexts
  where formatted structure adds little and a half-cut-off `**`/code fence
  looks uglier than plain text — the thread-header title
  (`selComment().body`) and `workflowNote`'s Tasks snippet therefore stay
  plain text.
  **Long words/URLs break within the word (`[overflow-wrap:anywhere]`):**
  each of the three `.innerHTML="${commentBody(...)}"` containers
  (`commentRow`'s preview span, `reactionBubble`'s bubble `<div>`,
  `prWideItem`'s body span) carries this arbitrary-value Tailwind class next
  to its existing `truncate`/`line-clamp`/no-wrap class. Without this class,
  text only breaks at word boundaries (`break-words`/browser default), so a
  long, spaceless token (URL, hash, concatenated path) can stick out of the
  card/bubble; `overflow-wrap:anywhere` only breaks such a word on overflow,
  mid-word, without wrapping normal text any differently.
- **Shared avatar helper (`src/avatar.mjs`), author+avatar on every
  comment/reply.** `avatarHTML(name, avatarUrl, sizeCls, extraCls)` is
  extracted from `overview.mjs`'s `reviewerAvatar` (the reviewer avatars in
  the PR list): an `<img>` if there's an `avatarUrl`, otherwise an initials
  circle (first two letters, uppercase) — exactly the same colors/shape as
  the PR list. `reviewerAvatar` now calls it itself for its own circle (the
  approved/changes-requested badge around it stays local to `overview.mjs`).
  An `<img>` falls back to the same initials circle on a load error via a
  static `onerror` attribute string (no reactive binding needed — that's not
  an arrow.js pitfall, `onerror` is never set by arrow.js itself here) so
  that an unreachable/offline image (e.g. `SLASH_GITHUB=off` tests) never
  leaves a broken-image icon behind. `RelatedPanel.mjs` uses it in
  `commentRow` (comment row, `h-4 w-4`), `reactionBubble` (every thread
  bubble — the synthetic opening and every reaction, both already carry an
  `author`, see `threadMessages`) and `prWideItem` (the PR-wide comments):
  author name + avatar on their own line above the body/kind badge
  (`data-testid=comment-author`/`reaction-author`/`pr-wide-author`, plus the
  corresponding `*-author-line` wrapper). **Data-model note: a
  github-sourced comment/reply carries a real avatar URL, an app-placed one
  doesn't.** `modules/github` threads the author's `user.avatar_url` (a shared
  `ghUser` sub-struct) through `Reply`/`ReviewComment`/`GeneralComment`;
  `comment_import.go`/the reply poller carry it on
  `CodeCommentInput.AvatarURL`/`ReactionSignal.AvatarURL`, and the existing
  `saveComment`/`saveReaction` Activities store it in the `avatar_url` column
  of both `comments` and `reactions` (light `ALTER TABLE … ADD COLUMN`
  migration) → `Comment.AvatarURL`/`Reaction.AvatarURL` → `avatarUrl` in
  `/api/comments`. The frontend needed no change for this: `avatarHTML`
  already renders an `<img>` as soon as a URL is present. Deliberately the
  **real API field**, never a URL derived from the login — a GitHub App bot
  (`kilo-code-bot[bot]`) has no `github.com/<login>.png` shorthand, and those
  bot avatars are exactly the ones a reviewer wants to recognize.
  **An own (`source: 'ui'`) comment/reply gets the local reviewer's identity at
  DISPLAY time (`identityOf`/`ensureMe`, `avatar.mjs`), not from the read-model.**
  The UI posts a placeholder author (`'reviewer'`) and no avatar for a message
  written in this app, so such a bubble used to sit as a bare `RE` initials
  circle next to real profile pictures. `avatar.mjs` therefore fetches the
  authenticated user once from the read-only **`GET /api/me`**
  (`handleMe` → `TaskManager.CurrentUser` → `github.Client.CurrentUser`, i.e.
  `gh api user`, cached in-memory for the process lifetime — the same
  operational carve-out as the heartbeat map/the avatar image cache, see
  `workflows-write-boundary.md`) and `identityOf(source, author, avatarUrl)`
  substitutes `{name, avatarUrl}` for `source === 'ui'` (or missing) only;
  every other message renders exactly what it carries.
  **`identityOf` treats a missing `source` the same as `'ui'`
  (`(source || 'ui') === 'ui'`), because a genuinely in-app-placed comment's
  own `Source` field is stored empty and Go's `json:"source,omitempty"` then
  drops it from the API response entirely — so the raw value reaching
  `identityOf` for such a comment is `undefined`, not the literal string
  `'ui'`.** A bare `source === 'ui'` check therefore never matched a placed
  comment's own root message and it kept showing the bare `RE`
  initials-circle + the literal name `"reviewer"` instead of the reviewer's
  real avatar/first name — every OTHER call site in the codebase that reads
  a comment's `source` already normalizes this the same way
  (`c.source || 'ui'`, see `threadMessages`'s synthetic opening message and
  `commentActivitySummary` in `RelatedPanel.mjs`); `identityOf` itself had
  been overlooked. A genuinely foreign message (`github`/`ai`) always
  carries a real, non-empty `source`, so this normalization can never
  misclassify one as an own message. Call sites: `reactionBubble`,
  `compactConversation` and `commentDetailCard` (`RelatedPanel.mjs`) — always
  for **both** the avatar and the name text, so they never name different
  people. Deliberately display-time instead of a write-time author/avatar
  column: it also fixes every own comment/reply **already** stored with
  `'reviewer'`, which a write-time fix could only repair through a per-thread
  backfill Signal. **Timing is load-bearing:** `loadComments`
  (`RelatedPanel.mjs`) `await ensureMe()`s before pushing `cs.list`, because
  `me` is a plain non-reactive object and arrow.js reuses a keyed comment node
  without re-running its bindings (see the keyed-node pitfall above) — a late
  arrival would otherwise never repaint. A failed lookup (offline,
  `SLASH_GITHUB=off` → `{ok:false}`) leaves `me` empty, which makes
  `identityOf` a no-op, so an own comment then keeps the
  initials circle, as does every offline/`SLASH_GITHUB=off` test run. The
  author line itself is deliberately roomy (avatar `h-5 w-5`, name
  `text-[11px]`; `h-6 w-6`/`text-sm` on the PR-comment detail card) so a
  long login/bot name isn't cramped next to its badges. See
  `tests/comment-author-avatar.spec.mjs`, plus `TestAvatarURLRoundTrip`
  (`modules/comments`) and `TestImportCarriesAuthorAvatars`
  (`comment_import_test.go`) for the backend chain.
  **The same module also resolves a login to a REAL NAME** (`ensureNames`/
  `fullNameOf`/`firstNameOf`/`displayNameOf`/`avatarUrlOf`) so the UI can say
  "Dennis" instead of "dennissloove", fed by the read-only `GET /api/names`
  (local `names.json` override → GitHub profile `name` → the bare login). It
  lives here rather than in a module of its own because it is the same "who is
  this" question `identityOf` already answers, and it shares `ensureMe`'s exact
  timing rule: **await it before pushing the rows that render the name**, since
  `names` is likewise a plain non-reactive `Map`. Full mechanism (precedence,
  caching, skip-list, the write-boundary carve-out): "Real names instead of
  logins" in `.claude/rules/pages-and-routing.md`.
  **`identityOf` itself resolves the name, so every existing call site got real
  first names for free** — the comment/reply bubbles, the compact conversation,
  the PR-comment detail card (`RelatedPanel.mjs`), the comment-activity avatars
  in `BlockList.mjs` and `Block.mjs`, and the task-inbox thread
  (`src/inbox.mjs`). Only the places that read a raw `author` field instead of
  going through `identityOf` needed touching: `BlockList.mjs`'s
  `categoryOrAvatar` (the comment-index row), `RelatedPanel.mjs`'s
  `lastReplyNote`, and `inbox.mjs`'s thread message + `pr_review` meta line.
  `identityOf` also falls back to `avatarUrlOf(author)` when the message carries
  no avatar of its own, so a comment stored before the `avatar_url` column
  existed — and the task-inbox thread, whose stored messages have no avatar
  field at all — now shows a real picture. The **await** lives in
  `loadComments` (`RelatedPanel.mjs`, right after the existing `await
  ensureMe()`, over `commentAuthors(list)`) and in `loadTasks` (`inbox.mjs`,
  over `taskAuthors(tasks)`) — one batched request per list, cached after that,
  so the comment poll costs nothing extra. An author that is not a GitHub login
  at all (`AI check`, the `reviewer` sentinel) resolves to nothing and is
  therefore shown verbatim, unchanged.
  **`Block.mjs` stays on `avatarHtmlString`** (its pane HTML is a plain string
  assigned via `.innerHTML`, so an arrow.js template would leak as text — see
  the pitfall above); it needed no change, because the name reaching it is
  already a plain string from `identityOf`.
- **Theme: system/light/dark, with a manual cycle button
  (`src/theme.mjs`).** The theme once followed **exclusively** the system
  setting (`prefers-color-scheme`, Tailwind `darkMode:'media'`, no own
  toggle); that choice has been reverted — a reviewer sometimes wants to
  deliberately force light/dark, independent of the OS setting.
  `src/theme.mjs` is the shared (not a component, a pure utility, like
  `urlState.mjs`) module for both pages:
  - **Three states**, not a binary on/off: `theme.pref` ∈
    `'system'|'light'|'dark'` (default `'system'`). A binary toggle would
    give a reviewer who clicked "light" while the OS is on dark no way back
    to "follow system" without changing the OS setting itself.
  - **Tailwind runs on `darkMode: 'selector'`** (no longer `'media'`, in the
    same `tailwind.config` `<script>` before the CDN styles) — every
    existing `dark:` utility keeps working unchanged, only the trigger
    changes from the media query to the **presence of a `.dark` class** on
    `<html>`.
  - `theme.mjs`'s `applyTheme(pref)` sets that `.dark` class **plus** a
    `data-theme="light"|"dark"` attribute on `<html>` (for the separate CSS
    below, which can't read a class), computed as
    `pref==='system' ? matchMedia(...).matches : pref==='dark'`.
    `initTheme()` (called as a module side effect from both `home.mjs` and
    `overview.mjs`) applies it initially, subscribes a
    `watch(() => theme.pref, applyTheme)` (the toggle) and a
    `matchMedia('(prefers-color-scheme: dark)')` `'change'` listener that
    only intervenes as long as `pref === 'system'` — so "system" also keeps
    following **live** if the OS setting changes while the page is open.
  - **Anti-flash:** before the Tailwind CDN `<script>`, both shells
    (`index.html`/`overview.html`) have an **inline** `<script>` that
    duplicates the same localStorage-read + class/attribute-set logic (not
    imported — ES modules load async, and this has to run before the first
    paint). `theme.mjs`'s `initTheme()` then simply takes over reactively;
    no visible flash of the wrong theme at page load.
  - **The button** (`themeToggleButton(cls)`, `data-testid=theme-toggle`, one
    shared component function that both pages import): a click cycles
    `system → light → dark → system` (`cycleTheme()`, persists immediately to
    `localStorage`) and shows a monitor/sun/moon icon for the current state.
    Location on `/pr/<id>`: a **narrow row in `prInfoCard`** (`home.mjs`,
    `data-testid=pr-info-theme-row`), directly before the PR summary
    (`data-testid=pr-info-summary`) — **no longer** its own, always-visible
    `position:fixed` corner element (the older `ThemeToggleCorner`,
    `bottom-6 left-6 z-30`, has been removed) and also not in `Footer.mjs`
    (that footer has recently only shown itself when there's actually
    something to preview, `state.footerVisible`, see "Footer" in
    `.claude/rules/keyboard-navigation.md` — no reliable place for a
    permanently reachable button). Deliberate consequence: `prInfoCard` only
    exists while `state.showDescription` is true (stop 1 of the
    left→right navigation chain, see `detail-layout.md`), so the button is
    **no longer** visible by default — that has been explicitly agreed here,
    unlike the earlier `ThemeToggleCorner` solution, which was introduced
    precisely to make the button *always* reachable (the button used to sit
    in the top-right corner of the footer strip and was therefore
    unreachable in list mode — see `tests/theme.spec.mjs`, which now
    conversely presses `←` to stop 1 first before expecting the button). On
    `/pr-overview` (no footer, no `state.mode`) the button stays unchanged in
    the **overview header** (`overview.mjs`'s `headerBlock`, next to the
    existing PR-count pill) — that page has no `showDescription` gating.
  - **Persistence:** `localStorage.getItem/setItem('theme', ...)` —
    deliberately **outside** `bindUrlState`/the query string (not a
    navigation position, doesn't belong in a shareable link) but also not
    ephemeral like `state.showApproved` (a theme choice is something you want
    remembered across a refresh).
  `overview.html` once had a **forced** dark mode (`<html class="dark">` +
  `darkMode:'class'`, and `overview.mjs` used bare `zinc-*` classes without
  any `dark:` variant); that has been removed — `overview.mjs` got a light
  base class before every previously bare dark class (the latter got a
  `dark:` prefix), symmetric with how `index.html`/`home.mjs`/`Block.mjs`/
  `BlockList.mjs`/`RelatedPanel.mjs`/`CommandMenu.mjs`/`Footer.mjs`
  (previously light-only) got a `dark:` variant behind every existing color
  class.
  **Color palette:** neutrals map 1-to-1 between the two families that
  already existed in the codebase — light `slate-*`
  (`bg-white`/`bg-slate-50/100/200`, `text-slate-900..400`,
  `border-slate-100/200/300`) ↔ dark `zinc-*`
  (`bg-zinc-900/950/800/700`, `text-zinc-100..500`, `border-zinc-800/700`,
  usually with a `/NN` opacity suffix for a subtler card tint than the solid
  `overview.mjs` dark tints). Semantic accent colors (emerald/rose/amber/sky/
  red/the category-badge hues in `BlockList.mjs`'s `CATEGORY_STYLE`) keep
  their hue but get a contrast-appropriate shade per mode: a light card tint
  (`bg-emerald-50`/`text-emerald-700`) becomes
  `dark:bg-emerald-500/15 dark:text-emerald-300`, and vice versa
  (`overview.mjs`'s `text-emerald-300`-on-dark becomes light
  `text-emerald-700`). Solid, saturated accent buttons/badges (`bg-indigo-500`,
  `bg-emerald-600` with `text-white`) and low-opacity rings
  (`ring-emerald-500/30` etc.) work in both modes without change and are
  deliberately left untouched — only backgrounds/text areas that sit *on the
  page or card background* need a separate light/dark shading.
  **What can't use a Tailwind `dark:` variant** (separate CSS, not a utility
  class): the Prism token colors and the `.markdown-body` typography in
  `index.html`'s `<style>` block. Those live in **two** matching blocks: the
  existing `@media (prefers-color-scheme: dark) { … }` block (fallback for
  the moment before `theme.mjs` has run) and a
  **`:root[data-theme="dark"] …` mirror** next to it (every selector
  literally duplicated with that attribute prefix — deliberately **no** CSS
  nesting, for maximum browser compatibility) that actually wins once the
  manual toggle overrides the OS setting. Both share the same palette: a
  GitHub-dark-inspired Prism palette + the zinc/indigo colors of the rest of
  dark mode. **Every selector inside the `@media` block carries a
  `:root:not([data-theme='light'])` gate** (in `index.html` AND `inbox.html`
  — keep it when editing): a media query only sees the OS preference, so
  without the gate an OS on dark + the manual **light** toggle
  (`data-theme="light"`, no `.dark` class — all Tailwind renders light)
  still applied these dark Prism/markdown colors, leaving near-black `pre`
  blocks and lavender inline-code pills inside white cards. With the gate
  the media block stays the pre-JS/no-JS fallback (attribute absent → OS
  wins) but loses to an explicit light choice.
  **Diff-row backgrounds** (`Block.mjs`, `paneHTML`) are arbitrary-value hex
  classes (`bg-[#fed7dc]` etc., "20% toward white" mixed with the
  Tailwind rose/emerald shade — see `blocks-and-ingest.md`); those got a
  `dark:bg-{color}-500/{opacity}` counterpart (e.g. `dark:bg-rose-500/25` for
  the active del row, `dark:bg-rose-500/10` for the filler tint) instead of a
  second hardcoded hex — simpler and consistent with the rest of the dark
  palette.
  **arrow.js-compliant:** wherever a class string runs through a reactive
  `class="${() => ...}"` function binding, the `dark:` class simply sits **in
  the same template string** as the rest of that value (no separate loose
  binding) — so no new pitfall on top of the existing
  "whole-value-in-one-binding" rule further down this file.
- Go: `net/http` `ServeMux`, handlers per feature. The `/api/` bridge shells
  out to `gh`/`claude` via `os/exec` — always validate input before handing
  it to a subprocess.
- **Code (Go + JS) is English** — comments, log messages, and identifiers. The
  docs in `.claude/` and `CLAUDE.md` are also English.
- **Git worktrees are allowed** — Claude/agents are welcome to set up a git
  worktree to work isolated or in parallel on a task (e.g. the Agent tool
  with `isolation: worktree`). An earlier agreement forbade this; that is
  hereby withdrawn. (Not to be confused with the **app's own** base/head
  worktrees under `data/worktrees/` from the ingest pipeline — those stay as
  described in `.claude/rules/blocks-and-ingest.md`.)

## Playwright test infra (per-worker isolated server)

- The Go binary is built **once** in `globalSetup` (`tests/_setup.mjs` →
  `go build -o tests/.tmp/slash .`), never per test.
- There is **no shared `webServer`** anymore. Each Playwright worker gets its
  **own** seeded SQLite DB and its **own** server on
  **port `4200 + workerIndex`** via the worker-scoped fixture in
  **`tests/_fixtures.mjs`**. Because `newTasks` places **all** module DBs
  (comments/workflows/relations/callresolve/inbox/prmeta) **next to** the
  `-db` path (`filepath.Dir`), one `-db tests/.tmp/w<n>/test.db` immediately
  isolates **all write state** per worker. The read-only base/head worktrees
  live under **`tests/.tmp/data`** (`TEST_DATA_DIR` in `tests/_setup.mjs`) and
  stay shared across workers; every worker server is started with
  **`-data tests/.tmp/data`**, so **a test run never touches the live `data/`
  tree at all**. The server's data dir is therefore no longer hardcoded: it
  comes from the `-data` flag / `SLASH_DATA` env, defaulting to `"data"`
  (`dataDirPath` in `main.go`, mirroring `dbPath`/`-db`/`SLASH_DB`). This
  removes both the cross-worker **write races** (comment/workflow SQLite
  contention previously gave an empty `runId`) and the page-load contention
  that made the suite flaky.
- **Spec imports:** every spec imports `{ test, expect }` from
  **`./_fixtures.mjs`** (not `@playwright/test`), so `page.goto('/pr/…')` hits
  its own worker server (the fixture overrides `baseURL`).
- **Workers = 4** on this 8-core box: each worker runs a Go server **plus** a
  Chromium, so higher (6+) saturates the machine and gave flaky assertion
  timeouts. The `expect` timeout is set to **15s** (room for a slow render
  during a startup spike; passing tests stay under 1s) and `retries: 1`
  catches the remaining cold-start **mount race** (a few specs mount a
  component via a dynamic `import()` inside `page.evaluate()` against the
  live app page — needed for `index.html`'s Tailwind/Prism CSS — and the
  app's `history.replaceState` burst during load can briefly disturb that
  mount). A real failure fails both attempts.
- **Never anchor a test on real, ingested `gh`/`git` data — every worktree the
  suite reads is hand-written in `globalSetup`.** All diff content
  (`/api/code`, `/api/blockstats`, `/api/langsiblings`) comes from the
  `materialize*Worktrees` functions in `tests/_setup.mjs`, which write
  `tests/.tmp/data/worktrees/pr-<n>-{base,head}` before the workers start
  (shared + read-only across workers, rebuilt on every run — `tests/.tmp` is
  gitignored, so the fixture *content* is committed as code in `_setup.mjs`
  while the materialized tree is a build artifact, exactly like
  `tests/.tmp/slash`). Use `worktreeWriter(pr)` for a new one.
  **This replaces the old arrangement**, where the main anchor fixture (PR
  12903) was a real ingest of the actual plug-and-pay PR sitting in the live
  `data/` tree. That was (a) unreproducible — a fresh checkout/CI never had
  it, and the on-disk pair had drifted away from the PR's real base/head SHAs,
  so its diff shape existed nowhere but that one machine — and (b) **deletable
  out from under the suite**: the daily `cleanup` workflow purges the data of
  PRs merged over a week ago, which is exactly what wiped it (54 specs failed
  at once). The fixture PR numbers are real, long-merged PR numbers, so the
  `-data` split above — not renaming them — is what keeps `cleanup` away from
  them.
  `materializeMainWorktrees` (PR 12903) is the one to read first: its own
  comment spells out the diff shape the specs depend on (exactly two blocks
  with one single-row change group each, the changed line at absolute line 67,
  everything else byte-identical between base and head) and why each of those
  properties is load-bearing. Small per-feature fixture PRs (90/91/92/93/94)
  deliberately have **no** worktree at all — their specs only exercise
  child-listing/drill mechanics.
- **Shared fixture state is reset per test, not per worker
  (`_cleanApprovals`, an auto fixture in `tests/_fixtures.mjs`).** A worker's
  DB lives for the whole worker, so a durable approval (or a PR-wide comment)
  written by one spec leaks into every spec that lands on that worker
  afterwards — and both change what the sidebar renders: a fully approved
  top-level block is hidden (`state.showApproved`), and a PR-wide comment adds
  a synthetic "Start" row (`commentBlockItem`). Whichever spec then clicked
  `[data-idx="1"]` or counted rows failed, seemingly at random, depending on
  the scheduler. The fixture wipes the stored approvals of every fixture PR a
  spec approves (`APPROVAL_RESET_PRS`) plus the anchor PR's comments before
  each test, through the sanctioned write paths (the approve workflow's `set`
  Signal with an empty set; a comment's own `delete` Signal). **Add a PR to
  `APPROVAL_RESET_PRS` as soon as a new spec approves anything on it.**
  Related rule of thumb: **give a spec that seeds comments its own synthetic
  PR number** (the `97xxxx` range) rather than sharing one — a shared number
  makes any exact comment-count assertion order-dependent.
- **The `97xxxx` range (and the small single-digit/90-109 fixture PR numbers)
  is reserved for Playwright fixtures — never reuse one for manual/ad-hoc
  testing against the live server** (`./slash-bin`/`.claude/scripts/
  restart-server.sh`, which deliberately runs with no `-db`/`-data` override
  and therefore reads/writes the real `data/` tree). Two synthetic PRs
  (`970099`, `970001`) once ended up there this way: `970099` via real
  `POST /api/workflows/...` calls made straight against the live server while
  reproducing a comment-thread scenario, `970001` via a bare
  `slash seed -comments <fixture>` run from the repo root without `-db`
  (falling back to the default `data/graph.db`, see `dbPath` in `main.go`).
  Neither PR exists on GitHub, so every subsequent server start logged
  repeated `gh api .../pulls/970099/comments: exit status 1`-style noise from
  `pr_status`'s ingest-refresh check and the comment importer, forever. Fixed
  once via `slash cleanup -force 970099,970001` (see "Daily data cleanup" in
  `tembed-workflows.md`); prevented going forward by requiring `slash seed`'s
  `-db` flag (no silent fallback to the live tree — see below) — but a
  manual `curl`/browser session against the live server can still start a
  real workflow for any PR number you type in, so: **use a number nobody else
  is depending on and that is obviously not a real PR** when reproducing
  something by hand, not one already claimed by a fixture.
- **`slash seed` requires `-db` explicitly — no silent fallback to
  `SLASH_DB`/the default `data/graph.db`.** `seed` is a test/fixture-only
  tool (every legitimate call site, `tests/_fixtures.mjs`, already passes
  `-db <worker-db>`); running it bare from the repo root used to silently
  write straight into the live tree (see the `970001` incident above). `slash
  ingest`/`slash relations`/the server itself keep their existing
  `-db`-optional-with-a-default behavior unchanged — only `seed` was
  tightened, since defaulting to live data is never actually intended there.
- **The harness always forces offline, regardless of the shell environment:**
  the worker fixture (`tests/_fixtures.mjs`) starts every server with
  **both `SLASH_GITHUB=off` and `SLASH_CLAUDE=off`** hardcoded in the
  `spawn` `env` (`{ ...process.env, SLASH_GITHUB:'off', SLASH_CLAUDE:'off', … }`)
  — it does spread the rest of `process.env`, but these two are fixed.
  Without the hardcoded `SLASH_CLAUDE=off`, a worker started from a shell
  without that var would really shell out to the `claude` CLI for the
  automatic call-resolution search (`resolve_call`); that stalls/times out
  and made comment-flow specs (e.g. `repro-live-comment.spec.mjs`)
  non-deterministically fail, depending on how the suite happened to be
  invoked. No spec expects a real (non-Fake) `claude` client — the
  LLM-resolved paths are tested via seed fixtures
  (`tests/fixtures/callresolve.json`) — so forcing the Fake everywhere is
  safe. **So never run the suite with loose `SLASH_GITHUB`/`SLASH_CLAUDE` env
  vars to get it offline** — the harness already does that; those vars are
  only still relevant for `go run .`/`slash` outside Playwright.
- **Mount a component through `evaluateSettled` (exported from
  `tests/_fixtures.mjs`), never a bare `page.evaluate`.** ~14 specs mount a
  component by dynamically importing a module *inside* `page.evaluate()`
  against the live app page (they need `index.html`'s Tailwind/Prism CSS for
  computed-style and geometry assertions, so a bare fixture page won't do).
  Two load-timing errors hit that pattern: `home.mjs`'s `bindUrlState` watches
  fire a burst of `history.replaceState` during load which can tear down the
  execution context the evaluate is running in ("Execution context was
  destroyed"), and under 4 parallel workers the dynamic import can lose its
  race with a briefly saturated server ("Failed to fetch dynamically imported
  module"). `waitForLoadState('networkidle')` does **not** guarantee the burst
  is over. `evaluateSettled` retries the whole evaluate (up to 4 attempts) on
  exactly those two messages, waiting for idle in between — a targeted retry
  instead of leaning on the config's `retries: 1`, which would also hand a
  free retry to a genuine, unrelated failure elsewhere in the same spec and
  hides how often the race fires. It started as a local helper in
  `approval.spec.mjs` (where three of its own four mounting evaluates never
  used it — that gap is what flaked); it's shared now, so **use it for every
  mounting evaluate**. Requirement to keep it safe: put the `await import(...)`
  calls **first** in the body, before creating the host element — a context
  torn down at the import hasn't mounted anything yet, so a retry can't leave a
  duplicate host behind (which would trip Playwright's strict-mode locator).
- **Open a `/pr/<id>` spec with `await leaveSearchBox(page)` (exported from
  `tests/_fixtures.mjs`), never a bare `page.keyboard.press('Escape')`.**
  `home.mjs` focuses the sidebar search box from a
  `requestAnimationFrame(focusSearchBox)` on load (a list-mode convenience so
  the reviewer can type a filter straight away). A bare `Escape` sent before
  that frame runs is handled with nothing focused, and the rAF then focuses the
  box **anyway** — after which every later key goes through `onKeydown`'s
  `searchActive` branch, which does something different from the
  nothing-focused path (`ArrowRight` there means "step into the diff", not the
  navigation the spec was driving). The helper waits for the load-time focus,
  presses `Escape`, and asserts the box released focus, so the keyboard
  genuinely belongs to the app's nav handler from then on. ~70 sites used the
  bare form; it flaked `comment-index-items.spec.mjs` (a `→` that never entered
  the comment thread, so the thread's focus ring never appeared).
- **Never assert a TRANSIENT intermediate state — assert the end state.** A
  Playwright assertion polls, so it can only observe a state that lasts long
  enough to be sampled; anything the app passes *through* on its way somewhere
  else is a race by construction. Concretely:
  `tests/range-select.spec.mjs` clicked the palette's approve item and then
  asserted `expect(menu).not.toBeVisible()` — `runCommand` (`home.mjs`) does
  close the menu before running the action, but this particular approve
  finishes the block, so `afterApproveAction` immediately reopens the palette
  as the **postApprove follow-up menu** (see "Enter — command palette" in
  `keyboard-navigation.md`). How long the closed frame lasts is purely how
  fast `findNextUnapproved`'s awaited `ensureCode` fetch resolves, and the
  reopen regularly won that race. Fix: wait for the follow-up menu's own
  identifying content ("Ga door") instead. Rule of thumb —
  before asserting that something is gone/closed/absent, check whether the
  same user action also starts an async follow-up that brings it back; if so,
  assert what distinguishes the follow-up instead.
- **A test that drives the UI with the MOUSE also parks a pointer somewhere,
  and a later layout change can then fire a genuine `mouseenter` from it.**
  A `.click()` moves the real pointer and leaves it there for the rest of the
  test, so any subsequent DOM/scroll change that slides a hoverable element
  under it behaves exactly like the reviewer hovering that element — which
  bit `tests/overview-selection-identity.spec.mjs` (see the
  `scheduleRepaint`/`hoverEnabled` paragraph in `pages-and-routing.md` for the
  app-side fix). Whether it triggers depends on scroll position, so it
  presents as order-dependent flakiness: passing alone, failing a few runs in
  eight at 4 workers. When a spec's subject is *not* hover, prefer a
  `dispatchEvent('click')` (drives the handler without moving the pointer)
  over `.click()`.
