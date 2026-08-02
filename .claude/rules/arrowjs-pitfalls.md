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

## LOCAL PATCH 1/2/2b in `src/vendor/arrow.js` — reapply on every upgrade

Three deliberate changes, each marked with a `LOCAL PATCH` comment in the
header. **On an arrow.js upgrade all three must be reapplied**; the comment
blocks in `vendor/arrow.js` hold the original lines and the exact restore
instructions.

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
`.claude/rules/underlying-code.md`).

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
`.claude/rules/drilling.md`.

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
and "No flicker on a gran/change step" in `.claude/rules/drilling.md`.

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
corrupt the slot pool.) See `.claude/rules/command-palette.md`.

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
