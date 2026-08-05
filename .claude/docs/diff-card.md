# The diff card: widths, the `a` stands, and the look-ahead preview

How wide a block-diff card gets and why. The **keyboard** side of the `a` cycle
(the guards, the `viewModeIndicator` clicks, what `unified` restructures) lives
in "`a` — cycling the diff view" in `.claude/docs/keyboard-navigation.md`; this
file is the **width and render** side: `widthCls`/`fitWidthCls`/
`boundedWrapWidthCls`/`narrowed` (`Block.mjs`), the `narrow:` breakpoint, and the
two rules that keep the look-ahead preview card subordinate to the active one
("never wider", and collapsing away entirely when the active diff doesn't fit).

Everything here is a **pure character-count / already-known-counts calculation**
— never a live DOM measurement (`scrollWidth`/`getBoundingClientRect`), which
would race the very render it feeds. That is the same discipline
`RelatedPanel.mjs`'s `relatedColumnWidthCls` and `Footer.mjs`'s `footerBoxPx`
follow.

## One global stand, every visible card

`state.diffViewMode` (`home.mjs`, ephemeral — **not** in the URL, like
`showDescription`/`showApproved`) holds one of `DIFF_VIEW_CYCLE`'s three stands,
`['split', 'unified', 'fit']`, and **every** visible diff card reads the same
value through its `viewMode` opt: the selected card, the look-ahead preview, and
every open drilled column. There is no per-card stand.

`toggleDiffView` (`a`) steps to the next stand, `setDiffViewMode` (a click on the
`viewModeIndicator` icons) jumps straight to one; both funnel through
**`applyDiffViewMode`**, which — besides setting the field — does two follow-ups
that are easy to forget and both load-bearing:

- **`scrollChangeIntoView(false)`** — every pane's HTML is rebuilt from scratch
  (`codeDiff` writes through `.innerHTML`), which resets each pane's `scrollTop`
  to 0. Without re-centring, toggling jumps to the top of the function instead of
  staying on the active change. Not a navigation step, so no glide (`false`).
- **`resettleCallArrows()`** — a stand switch resizes every card without touching
  `state.selected`/`mode`/`gran`/`change`, so the `setRelated` watch that
  normally drives the call-arrow overlay never fires while the geometry it drew
  against has changed underneath it. See "Call-arrow overlay" in
  `.claude/docs/underlying-code.md`.

`applyDiffViewMode` early-returns on an unknown stand and on the stand already
being active, so a repeated click is genuinely free.

## What decides the width: `widthCls`

`widthCls(b, viewMode)` (`Block.mjs`) is the single entry point; the card's root
`<article>` concatenates its result into its class string. Two branches:

- **`fit`** routes on file type: a **PHP** file gets the uncapped, content-driven
  `fitWidthCls(b)`, anything else gets the fixed `boundedWrapWidthCls()` (see
  below for why the two differ).
- **`split`/`unified`** keep a binary choice between two fixed tiers:

  | condition | width |
  |---|---|
  | `narrowed(viewMode) \|\| singleSide(b)` | `w-[42rem] narrow:w-[28rem] 2xl:w-[49.2rem]` |
  | otherwise (a two-sided block in `split`) | `w-[70rem] narrow:w-[42rem] 2xl:w-[82rem]` |

**`singleSide(b)`** is status-driven, not code-driven: `modified` → `null`
(genuinely two different sides to compare), `removed` → `'left'`, everything
else (`added`, and the synthetic `unchanged` status, see below) → `'right'`.
Deliberately derived from `b.status` rather than from `b.code`, so the width is
**stable before the code has lazily loaded** and the card never resizes
underneath the reviewer when the fetch lands. It is exported because
`home.mjs` needs the same answer for the preview rule below.

**Deliberately an allowlist of the one status that needs both panes
(`modified`), not a denylist of the ones that don't.** It used to be
`added`→`'right'`/`removed`→`'left'`/everything else→`null` — which silently
put the synthetic `'unchanged'` status (a drilled call-frame pointing at a
file this PR doesn't touch, `resolveChildBlock` in `home.mjs`, old === new) on
the two-sided branch: it showed both (identical) panes and rendered at the
wide `70rem`/`82rem` tier. Reported live: a drilled `added` method's own card
stayed narrow while an `'unchanged'` call target (`RuleData::__construct`)
beneath it rendered wide, nearly touching the Onderliggende-code column.
Backend blocks only ever carry `added`/`removed`/`modified` (`model.go`); the
allowlist means a status this file hasn't been taught about yet also defaults
to single-pane here, rather than silently falling through to the wide tier
again. Regression test:
`tests/preview-matches-active-width.spec.mjs`'s "an unchanged block renders
single-pane and narrow" test.

**`narrowed(viewMode)`** is simply `viewMode() === 'unified'`. Since the unified
stand collapses a two-sided block into ONE "old above new" column
(`unifiedCodeDiff`), a full split width would be mostly empty — so `unified`
reuses the exact same 60% tier a one-sided block already has. It applies to
**every** card in lockstep (modified, added, removed, preview, drilled column),
which is what keeps a column flow from looking ragged mid-toggle. It deliberately
**excludes** `fit`: that stand has its own, content-based width instead of this
fixed one.

## `fit`: two behaviours, split by file type (`isPhpFile`)

`fit` renders exactly **one** pane (`fitOnly(b)` = `singleSide(b) || 'right'`), so
there is no two-pane width branch left to account for. What differs is how that
one pane's width is chosen.

### `fitWidthCls` — PHP only, uncapped upward

```
w-[max(42rem,calc(<chars>ch_+_2rem))]  2xl:w-[max(49.2rem,calc(<chars>ch_+_2rem))]
```

`<chars>` is, in order of precedence: **`activeUnitLineChars`** — the longest
non-comment line among ONLY the rows of the currently selected/highlighted
navigation unit (`Block()`'s own `activeGroup` opt — a change group, a single
line, a call segment, or a Shift+arrow range, whichever `{start,end}` row range
is currently landed on) — falling back to **`codeMaxLineChars`** — the TRUE
longest non-comment line of the WHOLE block, on whichever side `fitOnly(b)`
renders (new/right for added+modified, old/left for a removed block) — when
there is no active unit (a preview/collapsed card, list mode without changes,
or a caller that doesn't pass `activeGroup` at all). The `ch` unit is exactly
one monospace glyph, so this is arithmetic on the already-loaded source string.

**Follow-up, on explicit reviewer request:** the block's own true longest line,
wherever it happens to sit, must not dictate the width while the reviewer is
looking at (and has selected) a genuinely short line elsewhere in the same
block — reported: a `Cart::applyPromotion` card ballooned to ~1330px in `fit`
because of one long line elsewhere in the method, while the actively selected
line (`$hasRestrictions = …`) was short. `activeUnitLineChars` (`Block.mjs`)
restricts the scan to the active unit's own row range, on the same side
`fitOnly(b)` renders, with the same comment-line exclusion as
`nonCommentLineLengths`. Home.mjs feeds it the exact same unit its own
`activeGroup` opt already highlights with — `topLevelActiveUnit(b)` for the
top-level selected card, `focusedActiveUnit()` for a focused drilled column
(both pulled out of the existing inline `activeGroup` closures, no behavior
change there) — so highlighting and width always agree on which unit is
"selected". A unit whose rows carry no measurable text on the rendered side
(e.g. landing on a pure-deletion line at `line` granularity within a `fit`-
hidden-old modified block — there is nothing to show on that pane for that
row) falls back to the whole-block `codeMaxLineChars`, never to a 0-width
card.

**The preview cap moves in lockstep.** `fitCapCharsFor(b, unit)` (the "preview
must never be wider than the active card" mechanism, see below) takes the same
optional unit and applies the identical `activeUnitLineChars` restriction
before its own `codeMaxLineChars` fallback — otherwise a preview capped at the
active card's OLD (whole-block) width could again render wider than the active
card's new, usually narrower, selected-line width. Both call sites
(`home.mjs`) pass the matching unit: `topLevelActiveUnit(curBlock())` for the
top-level look-ahead preview, `focusedActiveUnit()` for the drill-preview
column.

Two further deliberate departures from every other width in the codebase, both
explicit reviewer decisions rather than oversights:

- **The true maximum, not the 75th percentile.** `codeGrowthChars` (the
  non-ballooning percentile technique `relatedColumnWidthCls` still uses) plus a
  ceiling is precisely what let a genuinely long line get silently clipped —
  reported: a 168-character `throw new RuntimeException(...)` cut off mid-word in
  `fit`, identically to `split`. A stand whose whole stated purpose is "width
  follows the code" must not hide code.
- **A floor but no ceiling** (`max()`, not `clamp()`): floored at the 60% tier so
  `fit` is never narrower than `unified`, unbounded above so the widest real line
  is always fully visible without wrapping and without an invisible horizontal
  scroll.

Both `codeMaxLineChars` and `codeGrowthChars` run over `nonCommentLineLengths`,
which skips blank lines, a leading PHPDoc block, `//`/`#` lines and `*`
continuations — free-form prose must never drive a width, only real code lines
may.

### `boundedWrapWidthCls` — everything that is not PHP

A plain `w-[42rem] 2xl:w-[49.2rem]`, i.e. the same 60% tier again, and
**deliberately not content-based**. The uncapped guarantee backfires for non-code
text: a markdown bullet or a prose paragraph reads perfectly fine wrapped, so an
isolated long line has no business ballooning the card — reported, a
336-character markdown bullet grew it to roughly 6800px. Instead of growing the
card, `codeDiff` sets its `wrap` flag (`viewMode() === 'fit' && !isPhpFile(b)`)
and the rows wrap within this bounded width.

`isPhpFile` is a plain `.php` extension check on `b.file`. A PHP statement loses
nothing by staying on one physical line but reads terribly split mid-expression;
prose/config is the opposite — that asymmetry is the entire justification for the
split.

**Scope, stated so it isn't read as a bug:** only `fit` guarantees a long line is
fully visible. `split` and `unified` keep their fixed widths and can still clip a
very long line, for every file type. That was a discussed choice, not an
omission.

An **SVG** block needs nothing of its own here: `svgSlot` replaces the text diff
with rendered `<img>` previews and never reads `viewMode`, and an `.svg` file is
by construction not a PHP file, so it already gets `boundedWrapWidthCls` in the
`fit` stand exactly like markdown/JSON (see "SVG blocks" in
`.claude/docs/diff-render.md`).

## Narrow viewport (`narrow:`, < 1400px)

`index.html`'s `tailwind.config` defines a custom **max-width** screen
`narrow: { max: '1399px' }` — a hard cutoff, not a gradually scaling vw formula.
Tailwind emits a screen's CSS after the corresponding unprefixed utility (the
same source-order mechanism `2xl:` already relies on), so a `narrow:` class
alongside a base class wins below 1400px with no specificity conflict, and at or
above 1400px nothing changes at all.

`widthCls` drops **both** of its fixed tiers there: `70rem`/`82rem` → `42rem`,
and `42rem`/`49.2rem` → `28rem`. The upper tier reuses the number the narrow tier
already had above 1400px, and the lower one drops in step, so the ~60% ratio
survives and a same-file `a` toggle (split vs. unified) still visibly differs at
this viewport too — pinned by the ratio assertion in `tests/diffview.spec.mjs`.

This is **scoped to `widthCls`'s own two tiers on purpose**: `fit`'s
content-driven width (`fitWidthCls`/`boundedWrapWidthCls`) is untouched. It is an
opt-in stand that already routinely exceeds every fixed width by design, so it
was never going to reliably fit at ~1378px regardless, and narrowing its floor
would only put the many `fit`-specific assertions at risk for no product gain.
The matching shrink on the neighbouring column, and the width budget the numbers
were measured against, live in "Narrow viewport (< 1400px)" in
`.claude/docs/underlying-code.md`.

Note that Playwright's default viewport (1280×720) is itself below 1400px, so
effectively the whole suite exercises the narrow tiers.

## The look-ahead preview must never be wider than the active card

A one-sided (`added`/`removed`) selected card is already narrow and single-pane
on its own; a genuinely two-sided block previewed next to it would render at its
own natural full split width and be **wider than the thing that owns the
keyboard** — which reads as the preview being the main event.

Both preview sites therefore compute `activeSingleSided = !!singleSide(<active
block>)` and pass
`viewMode: () => (activeSingleSided ? 'unified' : state.diffViewMode)` for the
preview card only:

- `DetailPanel`'s `pair.forEach` (`home.mjs`) for the top-level look-ahead
  preview, resolving the active block through **`curBlock()`** (not a raw
  `state.blocks[sel]` read) so a selected `test_class` row resolves to its active
  method;
- `drillPreviewColumns` for the preview stacked under the focused drilled column,
  using `focusedBlock()`.

Three properties of this rule are deliberate:

- **It reuses the `narrowed()` knob** the `a` toggle already owns, just
  conditioned per render instead of only on the global stand — no fourth width
  computation.
- **One-directional.** A two-sided active card never forces a one-sided preview
  to *widen*; only narrowing happens.
- **It is a WIDTH guarantee only.** Since the second stand was reworked from
  "hide the old pane" into "stack old above new in one column", a two-sided
  preview forced into `unified` still shows its own removed (`-`) lines — just
  narrow and stacked. The older, stronger "the preview shows nothing the active
  card doesn't have" guarantee was consciously dropped, not lost.

The selected/active card itself is never given this override. Test:
`tests/preview-matches-active-width.spec.mjs` (fixture PR 105).

**Why a two-sided (`modified`) ACTIVE card needs no override of its own.**
When `activeSingleSided` is `false` (the active card is itself `modified`),
the preview's `viewMode` closure falls through to the same
`state.diffViewMode` the active card reads — so in `split`/`unified` both
cards resolve `widthCls`'s binary tier from the identical `narrowed(viewMode)`
value and their own `singleSide(b)`; a `modified` active card always has
`singleSide(active) === null`, so it always sits on the wide `70rem`/`82rem`
tier itself, which is the ceiling every fixed-tier width in `split`/`unified`
can reach. A preview can therefore never render **wider** than a `modified`
active card in those two stands — only narrower or equal — with no fourth
mechanism needed; this was verified in code (not just asserted) after a
suspected gap here turned out to already be closed by the two mechanisms
above (`activeSingleSided` and `singleSide`'s own allowlist fix). Only `fit`
has genuinely per-card, content-driven widths — see `fitCapCharsFor` next —
which is why the cap below is scoped to that one stand. Regression test:
`tests/preview-matches-active-width.spec.mjs`'s "a modified active card is
never smaller than a wider modified preview, in every stand" (loops all three
`a` stands with a preview whose own code is deliberately much longer).

### The `fit` stand needed a SECOND mechanism: `fitCapCharsFor`/`capFitChars`

The `activeSingleSided` override above only narrows a preview by forcing
`viewMode` to `'unified'` — it does nothing for the `fit` stand (which never
reads `narrowed()`, see `widthCls` above) and nothing when **both** the active
and preview card are two-sided (`modified`) PHP files: reported, a `modified`
preview (`ContractsExport::headings`) rendered wider than the `modified`
active card next to it (`ContractsExport::map`) in `fit`, because each card's
`fitWidthCls` is otherwise entirely its own content's business — the single
longest non-comment line of the block it happens to render, with no notion of
its neighbour.

`fitCapCharsFor(b)` (`Block.mjs`, exported) answers "what chars-count would
`b`'s own `fit` width be capped at" — its own `codeMaxLineChars` for a PHP
file, `0` for a non-PHP file (whose `fit` width is the fixed
`boundedWrapWidthCls` floor anyway, so capping a preview at `0` chars
collapses it to that exact same floor via `fitWidthCls`'s `max(42rem, …)`).
`fitWidthCls`/`widthCls` take an optional `capFitChars` — a `() =>
number|null` — and clamp their own computed `chars` down to it before
building the `max(...)` class string; absent (every non-preview card) means
no cap, unchanged from before.

Both preview call sites pass `capFitChars: () => fitCapCharsFor(<active
block>)` (`curBlock()` at the top level, `focusedBlock()` for
`drillPreviewColumns`) — the exact same lazy-closure discipline as `collapsed`
right next to it (a function, read from Block's own nested reactive slot,
never resolved in the outer array-building closure). One-directional and
purely additive, same as `activeSingleSided`: it only ever narrows a preview,
never widens the active card, and is a no-op whenever the preview's own chars
already happen to be the smaller number.

**Does not fight a manual column-width override** (mouse-drag or the `c`/`v`
keyboard resize, see `.claude/docs/column-resize.md`): both write an inline
`style="width:...px"` on the card, which always wins over any Tailwind
`w-[...]` class regardless of how that class was computed — `capFitChars` only
changes the **class**, so an explicit reviewer resize on either card still
wins exactly as it already does over `activeSingleSided`/every other
auto-width rule (the same accepted trade-off already documented in
`column-resize.md`).

## The look-ahead preview collapses when the active diff doesn't fit

`<main>` already scrolls and clips cleanly, so a too-tall active diff is never a
clipping bug — it is a **space-allocation** question (see
`.claude/docs/detail-layout.md` and `.claude/docs/footer.md`). The answer is to
take the space back from the preview: when the active card's own diff doesn't fit
the available height, the preview shrinks to just its header + meta row
(category/title/status, `file:line` + approve pill) — no description, no diff
body.

`Block()`'s **`collapsed`** opt drives that: a `() => boolean`, only ever passed
truthy for a **preview** card, read from the card's own nested `${() => …}` slot
(mirroring `activeGroup`/`hintsEnabled`) and defaulting to "never collapse".

`previewTooTallForActive(activeBlock)` (`home.mjs`) is the estimator, built
entirely from already-known counts:

```
needed    = ACTIVE_CARD_CHROME_PX (150) + blockRows(active).length * PREVIEW_ROW_PX (18)
available = state.viewportH - MAIN_TOP_PX (24) - footerReservePxSnapshot - PREVIEW_HEADER_RESERVE_PX (110)
```

`PREVIEW_ROW_PX` mirrors `Footer.mjs`'s own per-code-row estimate (the same
`text-[11px] leading-relaxed`), `ACTIVE_CARD_CHROME_PX` is a rough allowance for
everything above the active card's diff body, and `PREVIEW_HEADER_RESERVE_PX` is
the room the collapsed preview's own header + the connector between the two cards
still need. A block whose code hasn't loaded returns `false` (never collapse on
missing information).

Two reactivity constraints, both bought with real bugs:

- **The call sites pass a FUNCTION, never a resolved value.** The *available*
  side genuinely depends on the live window size and on the footer's current
  height — which itself varies with the focused unit, so it changes on every
  navigation step. Calling `previewTooTallForActive` directly inside the outer
  array-building closures (`pair.forEach`, the drilled-columns `.map()`) would
  couple those whole closures — and thus every `Block()` card and all its Prism
  highlighting — to that fast-changing state: the "outer closure vs. nested
  reactive slot" pitfall in `.claude/rules/arrowjs-pitfalls.md`. `Block()`
  invokes the closure from its own small slot instead.
- **It reads `footerReservePxSnapshot`, a PLAIN module-level variable** — never
  `state.footerVisible`/`footerUnit`/`footerExplain`, and not a reactive state
  field merely *derived* from them either. This function runs from inside a
  preview card's nested slot, and such a card can be torn down and rebuilt
  mid-navigation (`drillToSibling` replacing a drilled column). A first attempt
  stored it reactively, set from `updateFooter()` — itself a watch callback that
  fires reentrantly as part of that very cascade — and crashed arrow.js outright
  (`f[d] is not a function`, the LOCAL PATCH class of use-after-free), not merely
  missed an update. A plain variable can never be a reactive dependency, exactly
  like `codeRequested`/`blockRowsCache` elsewhere. **Accepted trade-off:** the
  decision only re-evaluates when something else already re-runs that slot (a
  resize bumping `state.viewportH`, or the card rebuilding), so the snapshot has
  a small staleness window. Don't "fix" that by making it reactive.

`state.viewportH` exists for the same reason and is kept in sync by a
module-level `resize` listener; it is read only from inside passed-in function
opts, so a resize never forces the outer closures to rebuild.

Test: `tests/preview-collapse-when-active-tall.spec.mjs` (a fabricated 60-row
active block collapses the preview; a short one leaves it fully expanded).
