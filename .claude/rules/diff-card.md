# The diff card: widths, the `a` stands, and the look-ahead preview

How wide a block-diff card gets and why. The **keyboard** side of the `a` cycle
(the guards, the `viewModeIndicator` clicks, what `unified` restructures) lives
in "`a` — cycling the diff view" in `.claude/rules/keyboard-navigation.md`; this
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
  `.claude/rules/underlying-code.md`.

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

**`singleSide(b)`** is status-driven, not code-driven: `added` → `'right'`,
`removed` → `'left'`, `modified` → `null`. Deliberately derived from `b.status`
rather than from `b.code`, so the width is **stable before the code has lazily
loaded** and the card never resizes underneath the reviewer when the fetch lands.
It is exported because `home.mjs` needs the same answer for the preview rule
below.

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

`<chars>` is **`codeMaxLineChars`** — the TRUE longest non-comment line of
whichever side `fitOnly(b)` renders (new/right for added+modified, old/left for a
removed block). The `ch` unit is exactly one monospace glyph, so this is
arithmetic on the already-loaded source string.

Two deliberate departures from every other width in the codebase, both explicit
reviewer decisions rather than oversights:

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
`.claude/rules/diff-render.md`).

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
`.claude/rules/underlying-code.md`.

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

## The look-ahead preview collapses when the active diff doesn't fit

`<main>` already scrolls and clips cleanly, so a too-tall active diff is never a
clipping bug — it is a **space-allocation** question (see
`.claude/rules/detail-layout.md` and `.claude/rules/footer.md`). The answer is to
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
