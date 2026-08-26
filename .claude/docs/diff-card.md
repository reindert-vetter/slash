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

## Landing on an all-single-line block auto-jumps the INITIAL stand to `unified`

Reviewer request (2026-08-18, screenshot of `SubscriptionReader::
recurringMutations`, whose diff is a scatter of separate one-line changes
throughout the function): "als er in een blok elke keer maar 1 regel is
aangepast, laat dan gelijk de -/+ view zien niet de side-by-side." Confirmed
explicitly as the BROAD reading: every change GROUP in the block spans
exactly one row — including a block with only ONE such group (not just a
block with several).

**An IMAGE block is excluded from this jump** (`isImageFile(b)` → the watch
returns early): its whole diff is ONE generated placeholder line
(`imagePlaceholderSide`, `image_asset.go`), which satisfies
`allChangesAreSingleLine` trivially and would flip the GLOBAL stand — for every
code block visited afterwards too — every time the reviewer merely lands on an
image. Its own stands mean something different anyway (side by side / overlay
at 50% / only the new one, see "IMAGE blocks" in
`.claude/docs/diff-render.md`), so `split` stays its default and `a` still
cycles by hand.

`allChangesAreSingleLine(b)` (`home.mjs`) is `changeGroups(blockRows(b))`
every entry of which has `start === end`, and at least one group (an empty
diff is not "single-line", there's nothing to show either way). A `watch` on
`[state.selected, state.mode, state.focusLevel, state.classMethodSel,
state.blocks, curBlock() && curBlock().code]` (mirroring the setCommentScope/
setRelated watches' "list every reactive dep inline" rule) fires
`applyDiffViewMode('unified')` the first time such a block's code is loaded
and visible in the TOP-LEVEL diff (`state.focusLevel === 0` — never while a
drilled Onderliggende-code column owns the keyboard, since `state.diffViewMode`
is the one global stand every card shares, and auto-jumping it while drilled
would also flip column(s) this request never mentioned).

**Only the INITIAL stand, never a permanent override** — explicitly confirmed
as option 2 of two offered: `autoUnifiedForBlockRef` (plain module state, keyed
like `lastSelectedBlockRef`/`lastFiredSelectionRef` above — by `file:line`, or
a `test_class` row's own id for its active method) marks a block as "already
decided" the moment its code loads, so the watch never re-fires for the SAME
block — the reviewer can freely cycle away with `a`/the indicator afterward
and it sticks for as long as that block stays selected. Since
`state.diffViewMode` is one shared global value with no per-block memory,
this also means: once the reviewer visits ANY single-line-only block, the
stand stays `'unified'` for every ordinary (multi-line) block visited
afterward too, until manually cycled away again — an accepted trade-off of
"one global stand", not a bug.

**Known, accepted race:** the ref is only marked once the code has actually
arrived (the `!b.code` guard inside the watch returns before that point), so
a manual `a`/indicator click that lands WHILE the code is still fetching can
be silently overridden the moment this watch gets its first real look at the
freshly-loaded code. Not fixed — in practice code arrives well before a
reviewer could reach for the toggle. Every Playwright spec that lands on a
single-line block and needs `'split'` for its own (unrelated) assertions
first waits for the code to render, THEN clicks `diffview-split` — see
`tests/diffview.spec.mjs`, `tests/mouse-approve.spec.mjs`,
`tests/navigate.spec.mjs`, `tests/drill-focus.spec.mjs`,
`tests/comment-range-bar.spec.mjs`, `tests/command-menu.spec.mjs`,
`tests/select-all-shortcut.spec.mjs` for the pattern (a couple of them twice —
`comment-range-bar.spec.mjs` reloads the page mid-test, which resets the
plain-module `autoUnifiedForBlockRef` and re-triggers the auto-jump).

**This is exactly the shape of PR 12903's own shared anchor fixture**
(`tests/_setup.mjs`'s `materializeMainWorktrees`): both of its two blocks
carry a single one-row change group each — so entering either one's diff now
starts at `'unified'` by default, which is why so many otherwise-unrelated
specs anchored on that fixture needed the "force split back" step above.

### A second, independent trigger: a `modified` block whose diff is additions only

Reviewer request (2026-08-20, screenshot of
`modules/Statistics/Config/config.php`): "als er alleen dingen zijn
toegevoegd... wil ik de unified diff zien." The block's own `status` was
`modified` (real old+new source on disk), but its diff added a whole new
config section with no removed/replaced line anywhere — `'split'` still
rendered its usual two equal-width panes, so the left/old pane sat empty
from the very first changed row on while every added line on the right ran
off the edge of its half-width column. `allChangesAreSingleLine` doesn't
cover this: a run of several new lines is one multi-row `changeGroups` unit,
not several single-row ones.

`allChangesAreAdditionsOnly(b)` (`home.mjs`, next to `allChangesAreSingleLine`)
answers this directly off `diffStat(blockRows(b))` — `{add, del}` — instead of
`changeGroups`: `add > 0 && del === 0`, i.e. at least one inserted line and
NO removed/replaced line anywhere in the block's diff. Guarded by
`!singleSide(b)` first: an `added`/`removed`-status block already renders
single-pane in every stand via `effectiveOnly` (`codeDiff`, `Block.mjs`), so
there is nothing to fix there and the function returns `false` before even
touching `blockRows`.

**Shares the exact same watch, the exact same `autoUnifiedForBlockRef` guard,
and the exact same trade-offs as the single-line trigger above** — the
landing watch's condition is simply
`allChangesAreSingleLine(b) || allChangesAreAdditionsOnly(b)`. So: INITIAL
stand only (the reviewer can still cycle away with `a`/the indicator and it
sticks for that block), one shared global `state.diffViewMode` (landing on
EITHER kind of block marks it "already decided" the same way and can leave
`'unified'` active for an ordinary block visited afterward too), and the same
known "code still loading" race. Test:
`tests/diffview-additions-only.spec.mjs` (fixture PR 123,
`materializeAdditionsOnlyWorktrees` in `tests/_setup.mjs` +
`tests/fixtures/additionsonly-blocks.json` — a `modified` block whose one
change GROUP spans 4 lines, deliberately not single-line, so the test can
only pass via this second trigger).

## What decides the width: `widthCls`

**Reviewer request, explicitly confirmed:** all three `a` stands get the same
content-driven width — the earlier fixed 60%/full-split tiers for `split`/
`unified` are gone. `widthCls(b, viewMode, capFitChars, activeGroup)`
(`Block.mjs`) is the single entry point; the card's root `<article>`
concatenates its result into its class string. One branch, by file type: a
**code** file (`.php`, `.ts`, `.js`, `.go`, … — anything that isn't a
prose/config format, see `isProseFile` below) gets the uncapped,
content-driven `contentWidthCls(b, ...)`; a **prose/config** file
(markdown, JSON, YAML/YML, plain text, and `.svg` — see below) gets the
fixed `boundedWrapWidthCls()` (see below for why the two differ). `viewMode`
no longer affects the WIDTH at all — it only decides
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

## `contentWidthCls` — every code file, uncapped upward, floored at 80 characters

Superseded `fitWidthCls` (the old name only applied to the `fit` stand; the
same formula now drives every stand for a code file). For a one-sided
(added/removed) block, or ANY block in `'fit'` (always one pane, see
`fitOnly`), only that single canonical side is measured, but **not the whole
block**: only a WINDOW around the current selection. A genuinely two-sided
(`modified`) block in `'unified'` measures BOTH sides and combines them;
`'split'` measures only the canonical side (see "`windowCharsForMode` —
`unified` combines both sides; `split` no longer measures the non-canonical
side at all" below).

### `selectionWindowLineChars` — the unit's own rows, capped at 5

**Superseded (2026-08-18):** an earlier version of this also reached up to 2
CHANGED rows PAST the unit's own boundary on the canonical side ("kijk naar
de 2 omliggende aangepaste rijen") — a directly-adjacent-only neighbor walk,
with all the adjacency/measurability guards described in this section's
history below. Reviewer decision reversed that: **"kijk niet naar omliggende
rijen, maar alleen naar de huidige geselecteerde regel/groep/call, met een
maximum van 5 lines"** — the neighbor extension outside the unit is gone
entirely; only the unit's OWN rows (a change group, a single line, a call
segment, or a Shift+arrow range) ever count, capped at
`SELECTION_UNIT_MAX_SCAN_ROWS` (5, was `GROUP_INTERIOR_FULL_SCAN_ROWS` = 20)
— see the next section for what that cap does once a unit is larger than 5
rows. Applies uniformly to every granularity now, not just the old
wholly-added/removed-function edge case.

**Falls back to the whole-block `codeMaxLineChars` ONLY when there's no
active unit at all, OR the block/side has zero changed rows at all**
(`selectionWindowLineChars` returns `null` in both cases) — a preview/
collapsed card, list mode without changes, or a drilled-in block whose only
changed row sits on the other side/elsewhere. That's the one case with
genuinely no cursor position to measure a window around. When a unit IS
present, has a changed row to anchor on, but nothing in the window carries
measurable text on the rendered side (e.g. the cursor sits deep inside a
multi-row old-side-only deletion run at `line` granularity),
`selectionWindowLineChars` returns `0` — not `null` — so the card instead
floors to `MIN_CONTENT_WIDTH_CHARS`, never the block's true global longest
line (which would reintroduce the original width-spike bug this window
exists to prevent).

### A changed comment line INSIDE the selection window counts too

Reported (2026-08-20/21, screenshot of `FindSessionStateActivity::run`): the
reviewer's selected unit was two `// …` comment lines, and both rendered cut
off at the card's right edge — along with an unrelated, unselected code line
still visible further down the same (now too-narrow) card. Cause:
`measurableLen` (the small per-row helper inside `selectionWindowLineChars`)
used to exclude any row starting with `//`/`#`/`*`/`/*`, mirroring
`nonCommentLineLengths`'s prose-exclusion — but it applied that exclusion
even to a row **inside the reviewer's own active unit**. A unit consisting
only of a long changed comment therefore measured `0` chars (the "nothing
measurable nearby" case), which floors the whole card to
`MIN_CONTENT_WIDTH_CHARS` (80) — too narrow for the comment line itself, and
for any other, unrelated line still rendered in the same pane.

**Fix: `measurableLen` no longer excludes a comment-shaped row.** A changed
`//`/`#`/`*`-line sitting inside the selection window is real diff content
the reviewer is looking at right now — not the unrelated, unselected prose
`nonCommentLineLengths` exists to keep out of the WHOLE-BLOCK fallback scan
(`codeMaxLineChars`/`codeGrowthChars`/`fallbackCodeMaxLineChars`, used only
when there's no unit at all or the block has zero changed rows anywhere,
see `NO_CHANGE_MAX_WIDTH_CHARS` above). That whole-block scan is untouched
and still skips comments — this fix is scoped to the in-window measurement
only. Test: `tests/diff-card-comment-line-width.spec.mjs`, asserting directly
on the exported pure function `fitCapCharsFor` with a synthetic block (no PR
data, no rendered card needed).

### The zero-changed-rows fallback is CAPPED, unlike every other "floor but no ceiling" path

Reported bug (2026-08-19, live PR 13392, `FillStats::handle`'s drilled-in
`<class-header>` child): the class header shown as unchanged CONTEXT (only a
nearby property changed) has no changed row of its own, so
`selectionWindowLineChars` returned `null` regardless of cursor position, and
`windowOrFallbackChars`/`fitCapCharsFor` fell back to the whole-block
`codeMaxLineChars` — the TRUE longest line of the entire class header,
uncapped. That header happened to contain a 185+ character
`$signature`-adjacent doc-comment/property line, so the card (and every
column after it in `<main>`'s horizontal flow) stretched far past the
viewport for code the reviewer wasn't even looking at.

This is a **narrower exception**, not a reversal of "floor but no ceiling"
(the section above/below): that guarantee — never hide a real diff line
behind an invisible horizontal scroll — only holds once the BLOCK has at
least one changed row somewhere. The gate is deliberately **not** "no active
unit was passed" — a block with real changes but no unit (e.g. list mode, or
a fresh mount before a cursor lands) must keep the existing uncapped
fallback, since it genuinely has something changed to guarantee visibility
for; only a block with ZERO changed rows anywhere (a pure-context card, like
the class-header example above) has nothing being reviewed on that side at
all. `blockHasChangedRow(b)` (`Block.mjs`) is the actual gate;
`fallbackCodeMaxLineChars(b, code)` applies it, clamping the whole-block
`codeMaxLineChars` fallback at `NO_CHANGE_MAX_WIDTH_CHARS` (100 —
reviewer-chosen, above the `MIN_CONTENT_WIDTH_CHARS` floor of 80) only when
`blockHasChangedRow` is false. The code pane's own `overflow-auto` absorbs
the rest as an internal horizontal scrollbar, same as any other over-width
pane — no new wrap logic. The cursor-driven window path (a unit WITH at
least one changed row) is untouched and stays genuinely uncapped, and so
does the no-unit fallback for a block that DOES have changed rows elsewhere.

<details>
<summary>History: the removed neighbor-extension mechanism</summary>

The original version reached up to 2 CHANGED rows past the unit's boundary,
with a neighbor only counting when DIRECTLY ADJACENT (one real row index at a
time, stopping the instant a row didn't qualify) — this fixed a reported bug
where a comment/filler gap let the window jump to the nearest changed row
however far away (a cursor on an old-side-only deletion row picked up a
far-away 135-char line from a different `if`-block). That whole mechanism —
and the bug class it guarded against — no longer applies now that there is no
neighbor reach at all: nothing outside the unit's own rows is ever measured,
adjacent or not.

</details>

### A unit that balloons past `SELECTION_UNIT_MAX_SCAN_ROWS` (5) only has its edges measured

A `gran=group` unit is normally a handful of contiguous changed lines — but
for a **wholly-added or wholly-removed** block, `changeGroups` finds exactly
ONE group spanning the ENTIRE function body, because there's no unchanged
context row anywhere inside it to end the run early. Originally reported bug
(back when the threshold was 20 and the unit itself was the only thing this
capped): a 42-row added function's own 169-character line (row ~31, nowhere
near either edge, out of the visible viewport) drove the whole card's width
the moment the reviewer drilled into it.

`SELECTION_UNIT_MAX_SCAN_ROWS` = 5 (lowered from the original 20 on reviewer
decision, see the previous section — now the ONLY thing bounding a large
`gran=group`/`call`/Shift-range unit, since there's no neighbor extension left
to have its own separate restriction). A unit at or under that size is
scanned in full, unchanged. A LARGER unit gets the "within `WINDOW_EDGE_ROWS`
(2) of a boundary" treatment — rows more than 2 away from BOTH `unit.start`
and `unit.end` are treated as out of view. One shared mental model: "only
what's within 2 rows of a boundary you're actually near counts".

### `windowCharsForMode` — `unified` combines both sides; `split` no longer measures the non-canonical side at all

Originally (screenshots): a selected group whose OLD side carried a much
longer line than its NEW side ran off the right edge of a `'unified'` card
(only the new/right side was ever measured); and a `'split'` card's own two
panes truncated content that individually would have fit, because the total
card width was sized for ONE pane's own chars, then halved into two equal
`w-1/2` panes. Reviewer: "2 sides diff mag ook breder" (split may grow for
this) — `'split'` and `'unified'` both started measuring BOTH sides and
combining them, `'split'` at `2 * Math.max(left, right)` (both panes equal,
neither clips).

**Superseded for `'split'` (2026-08-18):** reviewer report — a screenshot
where the canonical (new/right) side carried one much longer SQL-ish line
than the old/left side, and the old *EQUAL-width* split stretched the
old/left pane to match it uselessly wide, mostly padding. Reviewer: "de
linkerkant in de diff kan altijd op minimaal blijven, iets van 80
characters." `'split'` no longer reads the non-canonical (old/left, for a
`modified` block) side's own content AT ALL: `windowCharsForMode`'s `'split'`
branch is now `Math.min(MIN_CONTENT_WIDTH_CHARS, canonicalChars) +
canonicalChars` — only the canonical side is measured, and the
non-canonical side's contribution is capped at the shared 80-char floor
instead of tracking the (possibly much longer) canonical side. Whenever
`canonicalChars <= MIN_CONTENT_WIDTH_CHARS` (the common case) this reduces to
`2 * canonicalChars` — IDENTICAL to the pre-existing `2 * Math.max(...)`
total for that case, so an ordinary short two-sided block's `'split'` card is
completely unaffected; only once the canonical side's own chars exceed 80
does the non-canonical pane stop growing with it.

`'unified'` is untouched by this change: it still measures BOTH sides via
`Math.max(canonicalChars, otherChars)` (unaffected — it stacks old above new
in ONE column, so it still needs whichever side is wider). A one-sided block
(`singleSide(b)` truthy) or `'fit'` (always forces a single pane, see
`fitOnly`) still measures only that one canonical side — unaffected, mirrors
`codeDiff`'s own `effectiveOnly` gate exactly, including the removed-block
exception.

**`SPLIT_LEFT_PANE_WIDTH_CLS` reproduces that formula using only STATIC
CSS**, deliberately not a per-render `${() => ...}` computation on the pane
itself: `'w-1/2 max-w-[<80 * CODE_CHAR_PX + 16>px] shrink-0'` (it was a
literal `max-w-[calc(80ch_+_1rem)]` until the `ch` unit was replaced, see
"The chars → px conversion" below) — plain `w-1/2` (the
original mechanism) capped at a static `max-w`. Since the card's own total is
`2 * canonicalChars` whenever `canonicalChars <= 80`, `w-1/2` alone already
equals `canonicalChars` and the cap never engages; only once the total grows
past that (canonical > 80) does 50% exceed 80 and the cap clamp in, matching
`Math.min(80, canonicalChars)` exactly. The canonical (new/right) pane gets
`flex-1 min-w-0` instead of its own `w-1/2` — it simply fills whatever the
capped left pane doesn't claim.

Two alternatives were tried and rejected for this pane, both instructive:

- **`w-max` (CSS `width:max-content`)**, sizing the pane off its own rendered
  text directly (no JS chars computation needed at all): rejected because it
  needs an actual browser layout pass, which visibly lagged behind the code's
  async load/highlight by roughly a second in testing — the pane resized
  after the initial render, moving whatever sat in the canonical pane out
  from under a reviewer's cursor mid-hover
  (`tests/diff-row-mouse-select.spec.mjs`). This file is pure character-count
  arithmetic everywhere else specifically to avoid exactly that class of bug.
- **A CSS custom property** (`--split-canon-ch`) set via the article's own
  `style` attribute, read by the pane's class via `var()`: rejected because
  it still mutates a SECOND attribute (`style`, not just `class`) on the
  article's own already-reactive step, colliding with
  `tests/column-resize.spec.mjs`'s assertion that an unresized card's
  `style` attribute is exactly `''`. A reactive `class` binding on the pane
  itself was rejected too, for the more general reason below.

**Only the ARTICLE's own `class` may depend on content/selection.** Both
rejected alternatives — and a reactive class directly on the pane — would
make a SECOND element's attribute mutate on a same-block navigation step
(`tests/navigate.spec.mjs`'s "only the highlight moves, not the whole card"
guarantee, which asserts every mutation record is `class` on the `ARTICLE`
tag specifically). `w-1/2` + a static `max-w` needs neither: both are plain,
unconditional, content-independent Tailwind utilities baked into
`codeDiff`'s own template once, never re-evaluated per step.

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
w-[<contentWidthPx(chars)>px]     // chars * CODE_CHAR_PX + CARD_CHROME_PX
```

`<chars>` is `selectionWindowLineChars` (see above), falling back to
**`codeMaxLineChars`** — the TRUE longest non-comment line of the WHOLE block,
on whichever side `fitOnly(b)` renders — only when there is no active unit at
all (a preview/collapsed card, list mode without changes, or a caller that
doesn't pass `activeGroup`); a present unit with nothing measurable nearby
instead yields `0`, which the same `Math.max(MIN_CONTENT_WIDTH_CHARS, …)` call
floors to the plain 80-character minimum. It stays arithmetic on the
already-loaded source string — never a live measurement of the rendered text
itself.

### The chars → px conversion: `CODE_CHAR_PX`, not the CSS `ch` unit

**Superseded (2026-08-20):** the class used to be
`w-[calc(<chars>ch_+_2rem)]`. CSS `ch` is one glyph of whichever font the
element carrying the class has — here the card's own `<article>`, which
inherits the page's PROPORTIONAL `ui-sans-serif` at 16px, **measured 10.08px
per `ch`** — while the code it is sizing for renders in `font-mono
text-[11px]`, **measured 6.62px per character**. Every card was therefore
~34% wider than its own content. Reported with a screenshot of a test method
whose card filled nearly the whole screen: "dit mag ongeveer 25% kleiner. de
rechterkant van de blok moet rechts aansluiten aan de laatste character."
Measured on that exact card (PR 13431, a 206-char selection window): 2108px
wide with **731px of empty space** to the right of its last character.

`contentWidthPx(chars)` (`Block.mjs`, exported) is now the single chars → px
conversion every content-driven width goes through:

- **`CODE_CHAR_PX`** = `11 * 0.6023` ≈ 6.63px — the code panes' fixed
  `text-[11px]` font-size times the advance ratio of the monospace stack they
  use (measured 0.6020 for macOS `ui-monospace`/SF Mono; Menlo/DejaVu Sans
  Mono 0.6023, Courier New 0.60, Consolas 0.55). Deliberately rounded **up**:
  a narrower real font only leaves a hair of slack, a wider one would clip
  the longest line behind an invisible horizontal scroll — exactly what the
  "floor but no ceiling" rule exists to prevent. Still a pure arithmetic
  constant, never a live DOM measurement.
- **`CARD_CHROME_PX`** = 64 (4rem), replacing the old `+2rem`: 26px of real
  chrome (the rows' own `px-3` padding, 2 × 12px, plus the card's 2 × 1px
  border) plus ~38px reserved for the absolutely-positioned per-row chip at
  the right edge of a diff row (`lineSummaryBadge`, the "onderliggende code"
  ✓ n/n pill). Without that reserve, a card sized flush to the last
  character puts the chip straight on top of the longest line's tail.
  Reviewer-approved number; a chip that also carries comment avatars
  (measured up to 62px) can still overlay the tail of the single longest line
  in view, which is the same designed-for overlay its own translucent pill
  background has always handled (any row outside the measured window can
  already be longer than the card). **Deliberately unconditional**, not "only
  when this block actually has chips": the presence of a chip per row is only
  known from `home.mjs`'s `lineChildSummaries` (a full pass over the block's
  rows + call sites), and reading that from the card's own `class` binding
  would both couple the width to comment/approval state (the card jumping 2rem
  when a relation lands) and re-run that pass on every navigation step.

Measured result on the reported card: **2108px → 1429px (−32%)**, with the
last character 52px from the card's right edge — i.e. exactly the reserved
chrome. Walking 22 navigation steps through PR 13431, every step where the
selected unit owns the block's longest visible line lands on that same 51-52px
slack, and the selected unit's own last character is never clipped
(`unitSlack >= 51` at every step). The 80-character floor moved with it (a
floor of "80 characters" now really is 80 code characters): a minimum card is
**838px → 595px**, an explicit reviewer decision ("alles krimpt mee"), which
also shrinks the collapsed look-ahead preview (`NARROW_FIXED_WIDTH_CLS`) and
the `'split'` left-pane cap in lockstep.

Because the chars-count no longer appears in the class, a Playwright spec
can't read it off the DOM any more. `contentWidthPx`/`contentWidthChars` are
exported for exactly that, and `tests/_fixtures.mjs`'s
`widthPx`/`widthClsRe`/`widthCharsOf` wrap them, so a spec keeps expressing
its expectation in CHARACTERS instead of hardcoding a pixel number that would
rot the next time either constant moves (`tests/diffview.spec.mjs`,
`tests/preview-matches-active-width.spec.mjs`).

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

### `boundedWrapWidthCls` — every prose/config file, and `.svg`

A plain `w-[42rem] 2xl:w-[49.2rem]`, i.e. the same 60% tier again, and
**deliberately not content-based**. The uncapped guarantee backfires for prose
text: a markdown bullet or a prose paragraph reads perfectly fine wrapped, so an
isolated long line has no business ballooning the card — reported, a
336-character markdown bullet grew it to roughly 6800px. Instead of growing the
card, `codeDiff` sets its `wrap` flag (`viewMode() === 'fit' && isProseFile(b)`)
and the rows wrap within this bounded width.

**Superseded (2026-08-26):** the discriminator used to be `isPhpFile` (a plain
`.php` extension **allowlist** — PHP got the content-driven width, literally
everything else, including every other programming language, got this bounded
one). Reported live: a `.ts` test file's diff card stayed at this fixed width
in `split`/`unified` (not just `fit`), where `wrap` was never even enabled (it
only turns on in `fit`) — so a long `import { ... } from "..."` line just ran
off the pane's right edge into an invisible `overflow-auto`/`no-scrollbar`
horizontal scroll, reading as the diff being clipped. `isProseFile` (`Block.mjs`)
flips this to a **denylist**: `.md`/`.markdown`, `.json`, `.yml`/`.yaml`
(`isYamlFile`), `.txt`, `.svg` and the raster image extensions (`isImageFile`)
are prose/config-or-not-text-at-all and stay on this bounded, wrapped width; **every other extension is treated as code** and gets the uncapped
`contentWidthCls` instead — a `.ts`/`.js`/`.go`/… statement is exactly as
unbreakable as a PHP one, and reads exactly as badly split mid-expression.

**Scope, stated so it isn't read as a bug:** only a code file's `contentWidthCls`
guarantees a long line is fully visible, and only within its own selection
window — a prose/config file's fixed `boundedWrapWidthCls` never grows regardless
of stand.

An **SVG** block needs nothing of its own here: `svgSlot` replaces the text diff
with rendered `<img>` previews and never reads `viewMode`, but `isProseFile`
explicitly includes `.svg` (via `isSvgFile`) anyway — its raw XML source can
carry an extremely long single-line path `d=` attribute, and without the
explicit inclusion it would fall on the "everything else is code" side of the
new denylist and get an unwanted uncapped `contentWidthCls`. So it still gets
`boundedWrapWidthCls` in the `fit` stand exactly like markdown/JSON (see "SVG
blocks" in `.claude/docs/diff-render.md`).

A **raster image** (`isImageFile`: png/jpg/jpeg/gif/webp/avif/ico) is in
`isProseFile` for the mirror-image reason: `imageSlot` replaces the text diff
with the picture itself, and the block's "source" is a single short generated
placeholder line (`imagePlaceholderSide`, `image_asset.go`), so a
content-driven width would shrink the card to that line's length instead of
giving the preview images room. It DOES read `viewMode` (unlike `svgSlot`), but
only to pick side-by-side / overlay / new-only — never a width. See "IMAGE
blocks" in `.claude/docs/diff-render.md`.

## Narrow viewport (`narrow:`, < 1400px) — no longer a `widthCls` concern

`index.html`'s `tailwind.config` still defines the custom **max-width** screen
`narrow: { max: '1399px' }` (used elsewhere, e.g. `boundedWrapWidthCls`'s
prose/config width and the neighbouring Onderliggende-code column — see "Narrow
viewport (< 1400px)" in `.claude/docs/underlying-code.md`), but a code file's
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
whenever both cards are two-sided (`modified`) code files with a different
longest line in view — `fitCapCharsFor` closes it uniformly, not just for
`fit`.

`fitCapCharsFor(b, unit)` (`Block.mjs`, exported) answers "what chars-count
would `b`'s own content-driven width be capped at" — `selectionWindowLineChars`
(falling back to `codeMaxLineChars` only when there's no unit at all; a
present unit with nothing measurable nearby yields `0`, same as below) for a
code file, `0` unconditionally for a prose/config file (whose width is the
fixed `boundedWrapWidthCls` floor anyway, so capping a preview at `0` chars
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

### The MAIN-COLUMN look-ahead preview also gets a FIXED width, never content-driven

Scope: **only** the top-level look-ahead preview in the block column
(`DetailPanel`'s `pair.forEach`, `i !== sel`, `home.mjs`) — **not**
`drillPreviewColumns`' preview under a drilled Underlying-code column, which
keeps its existing content-driven-but-capped width unchanged (see
`fitCapCharsFor`/`capFitChars` below). Reviewer decision: since this preview
always collapses to just its header anyway (above — no diff body ever
renders, so its own longest line is never even visible), there's no reason
for its width to follow its own content at all any more. It now gets a flat
`MIN_CONTENT_WIDTH_CHARS` (80) + the same `CARD_CHROME_PX` chrome every
content-driven card uses — `w-[<contentWidthPx(80)>px]`, 595px at the current
constants — for every file type, regardless of content or of the active
card's own width.

`Block()`'s **`narrowFixed`** opt drives this: a `() => boolean`, checked
FIRST in `widthCls` (`Block.mjs`), before the `isProseFile`/`contentWidthCls`/
`boundedWrapWidthCls` branch — so it short-circuits for any file type, not
just one. Only `DetailPanel`'s `pair.forEach` passes
`narrowFixed: i !== sel ? () => true : undefined`; every other card
(including `drillPreviewColumns`') defaults to never-fixed, unaffected.

**Supersedes the `activeSingleSided`/`capFitChars`/`fitCapCharsFor` mechanism
for this ONE call site** (the "preview must never be wider than the active
card" guarantee, see `fitCapCharsFor`/`capFitChars` below) — a flat, content-
independent width can never exceed anything, so the cap is now unreachable
dead code there and was removed (`capFitChars` no longer passed at this call
site). `drillPreviewColumns` still needs the older, content-driven-but-capped
mechanism (its own preview is NOT scoped by this decision) and is otherwise
unchanged.

## A big-enough diff body gets a viewport-relative minimum height

`Block()`'s description strip (`block-description`, above the diff) is now
capped at **2 visual lines** (`line-clamp-2`) unless the reviewer opens it from
its own keyboard stop — see "The block description is an extra ↑ stop above the
first change" in `.claude/docs/keyboard-navigation.md`. It used to have no
height cap at all, and a long PHPDoc/AI-generated docblock then squeezed the
diff body's `flex-1` share of the card down to a sliver (a handful of visible
rows behind a `scrollHint`), even though the diff itself held far more code than
that. Reported: a 25-row diff rendered ~9 rows tall under a long description.
The floor below stays load-bearing regardless — an **expanded** strip can still
be arbitrarily tall.

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
whatever comes after it (the look-ahead preview card) further down the page.
This floor applies to every card that goes through
`codeDiff`/`unifiedCodeDiff`/`translationBlockView`, selected or preview alike
— though every preview already collapses to just its header regardless (see
above), so this floor only ever visibly stretches the active/selected card.

### The floor has no ceiling: the card also grows to fill the column, up to the footer

Reviewer request (2026-08-20/21, screenshot of a drilled
`SessionEnricher::utmValues` card): a big function's diff only ever got the
fixed `min-h-[45vh]` floor above, even though its column (the top-level
block-column, or a drilled column's own wrapper) already stretches to the
full height `<main>` has left above the footer (`AppColumns`' own `bottom`
offset already accounts for the footer's real height, see
`.claude/docs/detail-layout.md`) — on a shorter/lower-resolution window, 45vh
is well under what's actually free, and the leftover room just sat empty
below the card (eaten by the look-ahead preview/connector) instead of
showing more of the diff. "Ik wil in de hoogte alles zien zolang de footer er
niet overheen gaat."

The card itself (`<article>`, its class binding right above the width
formula) now also gets **`flex-1`**, under the exact same
`blockRows(b).length >= DIFF_FLOOR_MIN_ROWS` gate `diffFloorCls` already
uses — never for a preview card (`preview` is always true there, and every
preview stays collapsed to its header anyway, see above). `min-h-[45vh]` on
`code-diff` stays as the FLOOR; `flex-1` on the card is the "no ceiling"
half: it lets the card grow into whatever height its column has left, and
the already-existing `flex-1` on `code-diff` itself is what actually claims
that extra height once the card offers it. A diff under the row threshold is
completely unaffected — it stays exactly as compact as before, per the
"don't stretch a short diff into empty space" rule two paragraphs up.

For a **drilled** column specifically, the growth has to be threaded through
one more real box: unlike the top-level card (wrapped in a bare
`class="contents"` div, which drops out of the layout tree entirely, so the
card's own `flex-1` reaches the block-column directly), a drilled column
wraps its card in an actual `<div class="relative flex min-h-0 flex-col">`
(alongside the absolutely-positioned `drill-left-hint` chevron) — that
wrapper needed `flex-1` added too, or the card's own `flex-1` would have
nothing above it to grow into. That wrapper only ever renders while the
column is focused (the unfocused branch collapses to a rail instead, see
`.claude/docs/drilling.md`), so the class is unconditional there.

Whatever comes after the now-taller card (the look-ahead preview card, the
file connector) simply sits further down the column — that is now the
*intended* effect of the diff actually using the room it has, not merely an
incidental side effect of a fixed floor.
