# The diff card: widths, the `a` stands, and the look-ahead preview

How wide a block-diff card gets and why. The **keyboard** side of the `a` cycle
(the guards, the `viewModeIndicator` clicks, what `unified` restructures) lives
in "`a` — cycling the diff view" in `.claude/docs/keyboard-navigation.md`; this
file is the **width and render** side: `widthCls`/`contentWidthCls`/
`boundedWrapWidthCls` (`Block.mjs`), and the two rules that keep the look-ahead
preview card subordinate to the active one ("never wider", and collapsing away
entirely when the active diff doesn't fit).

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

**Reviewer request, explicitly confirmed:** all three `a` stands get the same
content-driven width — the earlier fixed 60%/full-split tiers for `split`/
`unified` are gone. `widthCls(b, viewMode, capFitChars, activeGroup)`
(`Block.mjs`) is the single entry point; the card's root `<article>`
concatenates its result into its class string. One branch, by file type: a
**PHP** file gets the uncapped, content-driven `contentWidthCls(b, ...)`;
anything else gets the fixed `boundedWrapWidthCls()` (see below for why the
two differ). `viewMode` no longer affects the WIDTH at all — it only decides
which/how many panes `codeDiff` renders (`effectiveOnly`, `unifiedCodeDiff`);
a same-file `a` toggle now changes the pane STRUCTURE (side-by-side → stacked
→ new-only) without the card resizing, unless the underlying selection window
itself changes.

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

## `contentWidthCls` — PHP only, uncapped upward, floored at 80 characters

Superseded `fitWidthCls` (the old name only applied to the `fit` stand; the
same formula now drives every stand for a PHP file). For a one-sided
(added/removed) block, or ANY block in `'fit'` (always one pane, see
`fitOnly`), only that single canonical side is measured, but **not the whole
block**: only a WINDOW around the current selection. A genuinely two-sided
(`modified`) block in `'split'`/`'unified'` measures BOTH sides and combines
them — see "`windowCharsForMode` — combining both sides for `split`/
`unified`" below.

### `selectionWindowLineChars` — the up to 2 neighboring changed rows on each side, but only if directly adjacent

Reviewer request: "kijk naar de 2 omliggende aangepaste rijen" — the chars
count comes from the reviewer's current navigation unit (a change group, a
single line, a call segment, or a Shift+arrow range — `Block()`'s own
`activeGroup` opt) **plus** the up to 2 CHANGED rows directly above it and the
up to 2 changed rows directly below — never the block's true longest line
wherever it happens to sit outside that window.

**A neighbor only counts when it sits DIRECTLY ADJACENT to the unit's own
boundary** — reviewer decision: "alleen omliggende gewijzigde rijen meetellen
als het direct ernaast staat". The walk steps outward one **real row index**
at a time (`start-1`, `start-2` / `end+1`, `end+2` — not "the next entry in
`changedRows`, however far away") and **stops the instant a row doesn't
qualify** — either it isn't itself a changed row, or it has no measurable text
on the rendered side (blank, or comment-only, same exclusion as the whole-block
scan) — it never skips past a disqualified row to keep searching further out.
Without this, a comment/filler gap right next to the cursor let the window
jump to the nearest changed row **however far away** and let that one distant
row dictate the whole card's width — reported bug: a cursor on an
old-side-only deletion row (no measurable text on the rendered/new side) had
its window skip straight past several unrelated rows to a 135-char line in a
completely different `if`-block, ballooning the card far past its neighbors
(chg=5: 88ch, chg=6: 135ch, chg=7: 89ch, for the same block).

**Falls back to the whole-block `codeMaxLineChars` ONLY when there's no
active unit at all** (a preview/collapsed card, list mode without changes) —
that's the one case with genuinely no cursor position to measure a window
around. When a unit IS present but neither its own rows nor either
directly-adjacent neighbor carry any measurable text on the rendered side
(the exact old-side-only-deletion-run scenario above),
`selectionWindowLineChars` returns `0` — not `null` — so the card instead
floors to `MIN_CONTENT_WIDTH_CHARS`. **This distinction was added after an
initial attempt at just the adjacency fix (above) fell back to the
whole-block max for that second case too**: since a long same-side deletion
run has NO measurable neighbor within reach for almost every row inside it
(each row's immediate neighbor is itself another unmeasurable deletion row),
that first attempt turned the original single-row spike (chg=6 → 135ch) into
a **multi-row** spike (chg=5 through chg=8 all → 135ch) — strictly worse for
the reported complaint. Falling back to the plain floor instead of the
block's true global longest line for this specific case fixed that.

### A unit that balloons past `GROUP_INTERIOR_FULL_SCAN_ROWS` (20) only has its edges measured

Reviewer decision (option 2 of 3 offered for this case): a `gran=group` unit
is normally a handful of contiguous changed lines — but for a **wholly-added
or wholly-removed** block, `changeGroups` finds exactly ONE group spanning
the ENTIRE function body, because there's no unchanged context row anywhere
inside it to end the run early. Reported bug: a 42-row added function's own
169-character line (row ~31, nowhere near either edge, out of the visible
viewport) drove the whole card's width the moment the reviewer drilled into
it, since the in-selection scan had no size limit of its own — only the
neighbor extension OUTSIDE the unit was adjacency-restricted (above).

`GROUP_INTERIOR_FULL_SCAN_ROWS` = 20 (deliberately generous — comfortably
above any ordinary multi-line modified-block change run, so this never
narrows a normal group). A unit at or under that size is scanned in full,
unchanged. A LARGER unit gets the exact same "within `WINDOW_EDGE_ROWS` (2)
of a boundary" treatment its outside neighbors already get — rows more than
2 away from BOTH `unit.start` and `unit.end` are treated as out of view, same
as a too-far neighbor. One shared mental model: "only what's within 2 rows
of a boundary you're actually near counts", whether that boundary is the
edge of the unit itself or the unit's edge as seen from OUTSIDE it.

### `windowCharsForMode` — combining both sides for `split`/`unified`

Reported bugs (screenshots): a selected group whose OLD side carried a much
longer line than its NEW side ran off the right edge of a `'unified'` card
(only the new/right side was ever measured); and a `'split'` card's own two
panes truncated content that individually would have fit, because the total
card width was sized for ONE pane's own chars, then halved into two equal
`w-1/2` panes. Reviewer: "2 sides diff mag ook breder" (split may grow for
this).

A one-sided block (`singleSide(b)` truthy) or `'fit'` (always forces a
single pane, see `fitOnly`) still measures only that one canonical side —
unaffected, mirrors `codeDiff`'s own `effectiveOnly` gate exactly, including
the removed-block exception. A genuinely two-sided (`modified`) block in
`'split'`/`'unified'` calls `selectionWindowLineChars` TWICE — once per side
— and combines the results: `'unified'` stacks old above new in ONE column,
so it takes `Math.max(left, right)`; `'split'` shows both side by side in
two EQUAL-width panes, so it takes `2 * Math.max(left, right)` — sized so
EITHER pane can fit the wider side, at the cost of some unused slack on the
shorter side (accepted trade-off, not a bug).

**Only the CANONICAL side (`fitOnly(b)`) gets the neighbor extension** — the
other side passes `includeNeighbors: false` to `selectionWindowLineChars`,
restricting it to the unit's own in-selection rows only. Discovered while
building this fix: giving the non-canonical side the same 2-row neighbor
reach as the canonical one let an unrelated, unselected line just past the
boundary (structurally 2 rows away, not semantically related) inflate a
`'split'` card to roughly 4x its needed width — worse than the very
narrowness bug being fixed. The canonical side keeps its full neighbor
window (unchanged, still the side selection/approval tracks, see "Only the
new/right pane drives selection" in diff-render.md); the other side is only
shown for context and only guaranteed to fit what's actually selected.

**The snap-back resize baseline (`parseAutoWidthPx`, `columnWidth.mjs`) must
call `widthCls` with the exact same arguments as the card's own class
binding** — `capFitChars`/`activeGroup` included, not just `viewMode` — so
the "auto width" a drag compares itself against always matches what's
actually on screen. Omitting the unit falls back to the whole-block,
un-windowed chars on both sides, which used to differ from the window-scoped
on-screen width by only a few px for most real content, but the `'split'`
doubling above made that gap large enough to break a same-position (+3px)
drag's snap-back (`tests/column-resize.spec.mjs`).

```
w-[calc(<chars>ch_+_2rem)]
```

`<chars>` is `selectionWindowLineChars` (see above), falling back to
**`codeMaxLineChars`** — the TRUE longest non-comment line of the WHOLE block,
on whichever side `fitOnly(b)` renders — only when there is no active unit at
all (a preview/collapsed card, list mode without changes, or a caller that
doesn't pass `activeGroup`); a present unit with nothing measurable nearby
instead yields `0`, which the same `Math.max(MIN_CONTENT_WIDTH_CHARS, …)` call
floors to the plain 80-character minimum. The `ch` unit is exactly one glyph
of whichever font the card's own `<article>` happens to inherit, so this is
arithmetic on the already-loaded source string — never a live measurement of
the rendered text itself.

**The card genuinely grows/shrinks live as the reviewer navigates** — explicit
reviewer request/confirmation ("de blok mag groter en kleiner worden ... de
kaart beweegt live mee per navigatie-stap"). `home.mjs` feeds
`selectionWindowLineChars` the exact same unit its own `activeGroup` opt
already highlights with — `topLevelActiveUnit(b)` for the top-level selected
card, `focusedActiveUnit()` for a focused drilled column — so highlighting and
width always agree on which unit is "selected". A unit whose rows (and
directly-adjacent neighbors) carry no measurable text on the rendered side
floors to `MIN_CONTENT_WIDTH_CHARS`, never to a 0-width card and never to the
block's true global longest line either — see the fallback split above.
**Trade-off, accepted:** since the
card's own `class` attribute now depends on `activeGroup()`, a same-block
navigation step (e.g. `f`/`d`/↓ within the same group) legitimately mutates
the active card's (and its look-ahead preview's) `class` attribute every step
— the minimal, intentional footprint of "the card resizes as you navigate",
not the old "whole card rebuilds" flicker bug (badges/description/approve
checkbox never move) — see `tests/navigate.spec.mjs`'s own regression test.

**The preview cap moves in lockstep.** `fitCapCharsFor(b, unit)` (the "preview
must never be wider than the active card" mechanism, see below) takes the same
optional unit and applies the identical `selectionWindowLineChars` restriction
before its own `codeMaxLineChars` fallback — otherwise a preview capped at the
active card's OLD (whole-block) width could again render wider than the active
card's new, usually narrower, selected-window width. Both call sites
(`home.mjs`) pass the matching unit: `topLevelActiveUnit(curBlock())` for the
top-level look-ahead preview, `focusedActiveUnit()` for the drill-preview
column. This cap is what actually keeps a preview narrower than the active
card now that every stand shares one width formula — `activeSingleSided`
forcing a preview's `viewMode` to `'unified'` (see below) no longer changes
its width by itself.

**The true maximum, not the 75th percentile.** `codeGrowthChars` (the
non-ballooning percentile technique `relatedColumnWidthCls` still uses) plus a
ceiling is precisely what let a genuinely long line get silently clipped —
reported: a 168-character `throw new RuntimeException(...)` cut off mid-word.
A width that's supposed to "follow the code" must not hide code. **A floor but
no ceiling**: floored at `MIN_CONTENT_WIDTH_CHARS`, unbounded above so the
widest real line in the selection window is always fully visible without
wrapping and without an invisible horizontal scroll.

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

**Scope, stated so it isn't read as a bug:** only a PHP file's `contentWidthCls`
guarantees a long line is fully visible, and only within its own selection
window — a non-PHP file's fixed `boundedWrapWidthCls` never grows regardless of
stand.

An **SVG** block needs nothing of its own here: `svgSlot` replaces the text diff
with rendered `<img>` previews and never reads `viewMode`, and an `.svg` file is
by construction not a PHP file, so it already gets `boundedWrapWidthCls` in the
`fit` stand exactly like markdown/JSON (see "SVG blocks" in
`.claude/docs/diff-render.md`).

## Narrow viewport (`narrow:`, < 1400px) — no longer a `widthCls` concern

`index.html`'s `tailwind.config` still defines the custom **max-width** screen
`narrow: { max: '1399px' }` (used elsewhere, e.g. `boundedWrapWidthCls`'s
non-PHP width and the neighbouring Onderliggende-code column — see "Narrow
viewport (< 1400px)" in `.claude/docs/underlying-code.md`), but a PHP file's
`contentWidthCls` no longer has a `narrow:`-specific tier: it was always
content-driven at every viewport once `fit`-only, and now that every stand
shares that formula, the earlier `70rem`/`82rem` → `42rem` /
`42rem`/`49.2rem` → `28rem` narrow-viewport shrink (which only ever applied to
the fixed tiers `split`/`unified` used to have) has nothing left to act on —
removed along with those tiers, not overlooked.

## The look-ahead preview must never be wider than the active card

A one-sided (`added`/`removed`) selected card is already narrow and single-pane
on its own; a genuinely two-sided block previewed next to it would render at its
own natural full split width and be **wider than the thing that owns the
keyboard** — which reads as the preview being the main event.

**Since every stand's width is content-driven now (`contentWidthCls`), this
guarantee lives ENTIRELY in `fitCapCharsFor`/`capFitChars` (below) — there is
no separate `viewMode`-based override left.** Historically (before the "all
three stands are content-driven" change) a first mechanism,
`activeSingleSided` (`!!singleSide(<active block>)`, forcing a one-sided
active card's preview into `viewMode: 'unified'`), narrowed a preview by
riding the `split`/`unified` fixed-tier width `unified` used to have; that
tier is gone, so this override no longer changes a preview's WIDTH by itself
— `drillPreviewColumns`/`DetailPanel`'s `pair.forEach` still pass it (mirrors
the active card's own stand for the preview's pane STRUCTURE, e.g. hiding the
old pane the same way the active card does), but the actual width guarantee
is `fitCapCharsFor`'s job below, unconditionally, for every stand.

The selected/active card itself is never given this cap. Test:
`tests/preview-matches-active-width.spec.mjs` (fixture PR 105).

### `fitCapCharsFor`/`capFitChars` — the one mechanism, every stand

Reported (back when this was `fit`-only): a `modified` preview
(`ContractsExport::headings`) rendered wider than the `modified` active card
next to it (`ContractsExport::map`), because each card's content-driven width
is otherwise entirely its own content's business — the longest non-comment
line in ITS OWN selection window, with no notion of its neighbour. Now that
every stand shares that formula, the same gap exists in `split`/`unified` too
whenever both cards are two-sided (`modified`) PHP files with a different
longest line in view — `fitCapCharsFor` closes it uniformly, not just for
`fit`.

`fitCapCharsFor(b, unit)` (`Block.mjs`, exported) answers "what chars-count
would `b`'s own content-driven width be capped at" — `selectionWindowLineChars`
(falling back to `codeMaxLineChars` only when there's no unit at all; a
present unit with nothing measurable nearby yields `0`, same as below) for a
PHP file, `0` unconditionally for a non-PHP file (whose width is the fixed
`boundedWrapWidthCls` floor anyway, so capping a preview at `0` chars
collapses it to that exact same floor via `contentWidthCls`'s own
`Math.max(MIN_CONTENT_WIDTH_CHARS, …)`).
`contentWidthCls`/`widthCls` take an optional `capFitChars` — a `() =>
number|null` — and clamp their own computed `chars` down to it before
flooring/building the class string; absent (every non-preview card) means no
cap, unchanged from before.

**`fitCapCharsFor` deliberately stays single-side/canonical**, even now that
a two-sided block's own width (`windowCharsForMode` above) combines both
sides for `'split'`/`'unified'`: it doesn't need to know the active card's
current stand at all, because a smaller cap only ever narrows a preview
further — it can never make the preview exceed the active card, which is the
one guarantee this mechanism exists for. Keeping it simple here was a
deliberate choice to avoid threading `viewMode` through every `fitCapCharsFor`
call site in `home.mjs` for a guarantee that already holds without it.

Both preview call sites pass `capFitChars: () => fitCapCharsFor(<active
block>, <active unit>)` (`curBlock()`/`topLevelActiveUnit(curBlock())` at the
top level, `focusedBlock()`/`focusedActiveUnit()` for `drillPreviewColumns`)
— the exact same lazy-closure discipline as `collapsed` right next to it (a
function, read from Block's own nested reactive slot, never resolved in the
outer array-building closure). One-directional and purely additive: it only
ever narrows a preview, never widens the active card, and is a no-op whenever
the preview's own chars already happen to be the smaller number.

**Does not fight a manual column-width override** (mouse-drag or the `c`/`v`
keyboard resize, see `.claude/docs/column-resize.md`): both write an inline
`style="width:...px"` on the card, which always wins over any Tailwind
`w-[...]` class regardless of how that class was computed — `capFitChars` only
changes the **class**, so an explicit reviewer resize on either card still
wins exactly as it already does over `activeSingleSided`/every other
auto-width rule (the same accepted trade-off already documented in
`column-resize.md`).

## The look-ahead preview always collapses to just its header

Reviewer request ("laat blokken onder de huidige actieve blok alleen de
header zien, dus niet de code zelf, maar de rest wel, gewoon ingeklapt enzo,
dus ook veel kleiner"): every card visible below/next to the active one — the
top-level look-ahead preview AND a drilled column's own preview
(`drillPreviewColumns`) — shows only its header + meta row (category/title/
status, `file:line` + approve pill), never the description or the diff body,
**unconditionally**, regardless of how tall the active card next to it is.

`Block()`'s **`collapsed`** opt drives that: a `() => boolean`, only ever
passed for a **preview** card, read from the card's own nested `${() => …}`
slot (mirroring `activeGroup`/`hintsEnabled`) and defaulting to "never
collapse" for every other card. Both preview call sites (`home.mjs`'s
`DetailPanel` `pair.forEach` and `drillPreviewColumns`) pass
`collapsed: () => true` — still a function, for parity with the other opts,
even though the value itself is now constant.

**Superseded, on purpose:** this used to be conditional —
`previewTooTallForActive(activeBlock)` estimated whether the active card's own
diff would fit the screen (from `blockRows(active).length`, `state.viewportH`,
and a plain-module-variable footer-height snapshot) and only collapsed the
preview when it didn't. That whole estimator
(`previewTooTallForActive`/`PREVIEW_ROW_PX`/`ACTIVE_CARD_CHROME_PX`/
`PREVIEW_HEADER_RESERVE_PX`/`MAIN_TOP_PX`, `footerReservePxSnapshot`,
`state.viewportH`) is removed now that every preview collapses unconditionally
— there's nothing left to estimate.

Test: `tests/preview-collapse-when-active-tall.spec.mjs` (both a fabricated
60-row active block and a short one leave the preview collapsed to just its
header).

## A big-enough diff body gets a viewport-relative minimum height

`Block()`'s description strip (`block-description`, above the diff) has no
height cap of its own — a long PHPDoc/AI-generated docblock used to squeeze
the diff body's `flex-1` share of the card down to a sliver (a handful of
visible rows behind a `scrollHint`), even though the diff itself held far more
code than that. Reported: a 25-row diff rendered ~9 rows tall under a long
description.

**`diffFloorCls(rowCount)`** (`Block.mjs`, one shared helper used by all five
`data-testid="code-diff"` wrapper `<div>`s — the two single-pane branches, the
removed-file banner's inner pane, the default two-pane split, and
`unifiedCodeDiff`/`translationBlockView`'s own wrapper) gives that wrapper
`min-h-[45vh]` — a **viewport-relative** floor via a plain CSS `vh` unit, not a
fixed px value and not a live window-size read — once `rowCount` (the same
`blockRows(b).length`/`translationRowUnits(b).length` each branch already
computes) reaches `DIFF_FLOOR_MIN_ROWS` (20); below that it stays `min-h-0`,
same as before. **Deliberately conditional on content size:** a genuinely
short diff (e.g. a 3-line constructor) must never be stretched to fill 45% of
the screen just because it sits under a long description — that would trade
one bad look (squeezed code) for another (a mostly-empty card). 20 rows is a
rough gate, not a live measurement: at `DIFF_FLOOR_ROW_PX` (18, mirroring
`Footer.mjs`'s own per-row estimate) a 20-row diff already reaches roughly
45vh's own height unaided on a modest laptop screen, so the floor only ever
kicks in for a diff that would want that much room anyway.

Since `rowCount` is a stable content fact (computed once per `codeDiff()`
call, not live window size), this needs no reactive slot — it's a plain string
concatenated into the wrapper's otherwise-static `class` (the same
"concatenate outside the template" pattern as `narrowed`/`widthCls`, see the
attribute-interpolation rule in `.claude/rules/arrowjs-pitfalls.md`).

`<main>` already scrolls/clips cleanly (see "The look-ahead preview always
collapses…" above), so growing the active card's diff this way simply pushes
whatever comes after it (the look-ahead preview card) further down the page —
an accepted, deliberate trade-off, not a layout bug. This floor applies to
every card that goes through `codeDiff`/`unifiedCodeDiff`/`translationBlockView`,
selected or preview alike — though every preview already collapses to just its
header regardless (see above), so this floor only ever visibly stretches the
active/selected card.
