# Rendering a block's body

How the old/new source of a block becomes the rows the reviewer sees: line
alignment, performance measures for huge blocks, char-level marking, and the two
categories that **replace** the text diff entirely (TRANSLATION, SVG). Split out
of `.claude/docs/blocks-and-ingest.md`. For the card's width/`a`-toggle stands
see `.claude/docs/diff-card.md`.

## Old/new line alignment (`blockRows`/`alignRows`/`diffLines`)

`GET /api/code?pr=N&file=..&class=..&name=..` returns the old + new source of one
block from the base/head worktrees. `Block.mjs` aligns them **line by line** with
its own LCS line diff (`alignRows`/`diffLines`, pure JS — no AI): matching lines
share a row, a removed line leaves an empty filler row on the right, an added
line an empty filler row on the left, and changed lines get red (old) / green
(new). Both panes render the same number of rows at the same row height, so they
align vertically for free.

The line diff matches **whitespace-insensitively** (`diffLines` compares on
`s.replace(/\s+/g,'')`, à la `git diff -w`): a line that was only re-indented
still pairs with its counterpart and shows as a whitespace-only re-alignment
(`wsOnly`) — only the shifted whitespace gets a soft tint, the word itself is
never char-marked. Without that, the positional del/ins pairing would shift and
unchanged words would be marked as changed.

## `blockRows(b)` is memoized (`blockRowsCache`, a `WeakMap`)

`blockRows` has 20+ call sites (every diff render, every navigation unit, and —
worst — `home.mjs`'s `approvalSummaries` watch, which recomputes
`subtreeApproveCount`/`blockRows` for **all** top-level blocks on every
`state.codeVersion` bump, i.e. on every code load including a look-ahead
preview). Without a cache, `diffLines`'s O(n·m) DP table is refilled every time —
unnoticeable for a normal PHP block, crippling for a non-PHP whole-file-fallback
block of several thousand lines.

The cache is a **module-level `WeakMap` in `Block.mjs`, outside reactive state**
(same pattern as `codeRequested` in `home.mjs`), so it never triggers an arrow.js
reactive-proxy notify on something nothing reads reactively. Its key is the
**reference identity of `b.code`**: `ensureCode` always sets `b.code` wholesale,
never mutating in place, so a changed reference is an exact invalidation check.

## Huge blocks: prefix/suffix trim + context collapsing

Two measures for a whole-file fallback block of thousands of lines
(`collapsePlan`/`collapsedRunHTML` in `Block.mjs`):

1. **`diffLines` trims the common prefix/suffix** (whitespace-insensitively, the
   same `key` as its DP) before building the LCS table, so the first-contact
   spike collapses to the changed middle.
2. Blocks over **`COLLAPSE_MIN_ROWS` (300 rows)** collapse runs of ≥
   **`COLLAPSE_MIN_RUN` (10)** unchanged rows into one **clickable** "⋯ N
   ongewijzigde regels" spacer (`data-testid=collapsed-run`). Smaller blocks
   render byte-identically to before.

The plan is a pure function of (rows, commented set, expanded runs) —
**deliberately not** of the active cursor: ↑/↓ never changes which rows exist in
the DOM, and both panes collapse identically (row-for-row alignment). Changed
rows + **`COLLAPSE_CONTEXT` (3)** context rows and commented rows are always
kept, so every metadata-carrying row (`data-change-active`, ✓, 💬,
`data-changed`, call-site `data-row`) is by construction rendered —
navigation/approve/comments/`scrollChangeIntoView`/`updateHints`/`callArrows`
needed no changes.

Expanding runs through click delegation on the pane's `<code>` (`onPaneClick` —
the spacer lives in an `.innerHTML` string, so it can't carry an arrow.js
binding): the run lands in `expandedRunsByRows` (a non-reactive `WeakMap` keyed on
the memoized `rows` array, ephemeral — resets on a code reload) and a reactive
`collapseUi.v` bump re-renders exactly the subscribed big-block panes (a small
block's `collapsePlan` early-returns before that read, so it never subscribes).
Test: `tests/diff-trim-collapse.spec.mjs`.

## Char diff: line background only, no word background

A truly changed line (paired del/ins, not `wsOnly`) gets its red/green **line**
background only. The individual changed characters/words within it get **no**
background of their own — that produced a double, darker "pill" on top of the
line tint. `highlightChanges` (`Block.mjs`) renders such a line plainly; the
token-granular `charDiffSides`/`tokenize`/`diffChars` pass (LCS on `[A-Za-z0-9]`
runs, à la git word diff) now runs **only** for a `wsOnly` row, to mark the
shifted whitespace itself (the soft `bg-rose-200`/`bg-emerald-200` tint).

The **call underline** (`UNDERLINE_CLS`, indigo, the active segment at
`gran==='call'`) is a separate layer on the same `markChars` pass and works
unchanged, also on a line without a word background.

## TRANSLATION blocks

### Category

A PHP Laravel lang file (`resources/lang/<locale>/<name>.php`,
`lang/<locale>/<name>.php`, or a module's own
`modules/<Name>/Resources/lang/<locale>/<name>.php` — any `.php` path with a
`/lang/` segment) classifies as **`TRANSLATION`** (`classify.go`,
`categoryRules`), placed **before** the `MODULE` rule (so a module's lang file
isn't swallowed by the broader `modules/` match) and before the `OTHER` fallback.
Its own yellow `CATEGORY_STYLE` badge.

### Changes-only key overview

Such a file has no functions, so it stays one whole-file block. Instead of the
line-based `codeDiff`, `Block.mjs` renders it via `translationSlot` →
`translationBlockView` (`src/translationDiff.mjs`) as a **changes-only key
overview**: only added / removed / changed keys (dotted `file.a.b` form, old→new
value), unchanged keys hidden.

`translationDiff.mjs` is a small, tolerant, quote-aware PHP-`return [...]`-array
parser (nested arrays, single/double-quoted strings with escapes, `//`/`#`/`/* */`
comments). **Out of v1 scope:** legacy `array( ... )` and numeric/list arrays —
plug-and-pay lang files use `[...]` with string keys. Values render as plain text
(arrow.js escapes them), so HTML in a translation shows literally.

### Sibling locales as extra columns in the same card

Every OTHER locale that has the same lang filename gets its own read-only column,
appended to every per-key row: `key | <own locale value(s)> | <sibling 1> | …`,
one column per locale actually present under the lang root (not capped).

**Visual only, not a structural merge.** Navigation, approve and comment all stay
scoped to the SELECTED block's own rows (its own `translationChangeUnits`); a
sibling column shows that locale's *current* value (or a "missing in `<locale>`"
marker) and never gets its own cursor/approve state, and the row list is never a
union/intersection across locales. Concretely: the sidebar still shows **one row
per lang file** (both `nl/checkout.php` and `en/checkout.php` if both changed) —
no combined entry, no new `?sel=` scheme,
`recomputeLeftList`/`applyBlockRefRestore` unaffected — and **approve stays keyed
to the selected file's own block id** in `approvals.db`.

`siblingColumnHTML(sib, key)` renders them. The primary column (key + value(s),
`translation-primary-col`) and every sibling column share the row width
**equally** (each `min-w-0 flex-1`): 1 sibling → 50/50, 2 → 33/33/33, etc. The row
always fills exactly the card's own width — a fixed `w-56 shrink-0` sibling column
was tried and left the primary column disproportionately wide; don't reintroduce
it. The card itself never grows to fit more locales.

Data comes from the read-only `GET /api/langsiblings?pr=N&file=<lang file>`
(`langsiblings.go`, reads the head worktree like `/api/code`, within the write
boundary), fetched by `ensureLangSiblings` (`home.mjs`) regardless of whether that
other locale is itself a changed PR block. See also "Resolving translation keys"
in `.claude/docs/workflows-analysis.md` for the resolved `trans()`-child render
(the second, untouched render mode).

**Superseded design:** a separate companion card per sibling locale
(`companionCard`, `data-testid=translation-companion`, "two separate cards, never
merged") was built and then reversed on explicit request in favour of the columns
above; `companionCard`/`translationSiblingView` are gone. Don't reintroduce.

**Two keyed-node fixes are load-bearing for late-arriving siblings:**

- `ensureLangSiblings`'s fetch-then-render must also bump `state.codeVersion` —
  reassigning `state.langSiblings` alone has been observed to intermittently not
  re-notify a dependent closure (the "multiple reactive consumers of the same
  property" pitfall, `.claude/rules/arrowjs-pitfalls.md`).
- That bump alone is not enough: `Block()`'s `<article>` is embedded via a plain,
  statically interpolated `${inner}`, inside a card whose `.key(...)` didn't
  change — so arrow.js reused the mounted node (move+patch) and never re-applied
  that interpolation. The card `.key(...)` therefore folds in, for a TRANSLATION
  block only, `state.langSiblings[b.id].length` (`langSibKeyPart`) — the same "key
  encodes the async-loaded state" idiom as its `code`/`load`/`err` and
  `foc`/`unfoc` components. `translationBlockView`'s own per-row `.key(...)` folds
  in a signature of the sibling locales as a second line of defence.

### Per-key navigation, approve and comment (`translationRowUnits`)

The reviewer navigates a TRANSLATION block **per changed key**: `↑`/`↓` step
through the key rows (indigo inset bar, like the diff's active-row highlight);
`f`/`d`/`s` are a deliberate no-op (a key is always exactly one step).

This **reuses the existing row-indexed approve/comment infrastructure** instead of
a parallel system. `translationRowUnits(b)` (`Block.mjs`) maps each
changed/added/removed key (`translationChangeUnits`, `translationDiff.mjs`, which
now carries a 1-based source line per key — the parser records each leaf entry's
key-token byte offset and converts it) onto the **aligned-diff row** `blockRows(b)`
already computes (via a `newLineToRow`/`oldLineToRow` index built once from
`blockRows`, since aligned rows carry no line numbers).

Once a key has a `row` it slots into everything that operates on `{start, end}`
row ranges: `b.approvedRows` (the existing `changedRows`-based "approve X/Y"
counter — **deliberately not** ported to `blockstats.go`, since each key falls on
its own row in the common case and the existing counter already reflects per-key
approval), `unitLineRange`/`commentTarget` (a changed/added key anchors on its
**new** line, a removed key on its **old** line, like any code comment), and the
"next unapproved" walk.

`home.mjs`'s **`navUnitsOf(b, rows, gran)`** is the one dispatch point (used by
`unitsOf`/`groupsFor`/`commentTarget`/`approveTargetRows`/
`firstUnapprovedOwnUnit`/`openTask`): for a TRANSLATION block it always returns
the per-key unit list regardless of `gran` (which stays pinned at `'group'`, since
`setGran`/`extendRange` early-return for this category); every other block keeps
the granularity-based `unitsFor`.

Each unit carries its own **`idx`** (index into `translationRowUnits`) alongside
`{start, end}`, because two different keys can share one aligned row (an added key
directly followed by a removed one gets zipped into one del+ins row by
`alignRows`) — `row` alone is not a reliable way back to "which key", so
`translationSlot` reads `idx` directly.

Active/approved state per row lives in **each row's own nested `${() => …}`
binding**, not resolved once up front: `translationBlockView`/`translationSlot`
are only re-invoked on a `codeVersion`/focus change, not on every `↑`/`↓`, so a
one-shot computation would freeze the highlight (the "outer closure vs. nested
reactive slot" pitfall, `.claude/rules/arrowjs-pitfalls.md`). Test:
`tests/translation-navigation.spec.mjs`.

### Scrolling + hints reuse the code-diff mechanism

A lang file with many changed keys scrolls like a tall code diff, by reusing the
**same** mechanism. `translationBlockView`'s outer
`[data-testid=translation-overview]` div carries an explicit `overflow-auto` (both
axes) + `min-h-0 flex-1 no-scrollbar` so it actually shrinks within its card,
mirroring `codePane`'s own scrolling div, plus:

- the existing `data-scrollsync` attribute,
- `data-changed="1"` on every row (a changes-only list — every visible row *is* a
  change),
- a reactive `data-change-active`/`data-change-active-end` on the active row (both
  on the SAME row, since a key unit always spans exactly one row, like a
  single-row `line`/`call` unit).

Those are exactly the attributes `home.mjs`'s `scrollChangeIntoView` and
`Block.mjs`'s `updateHints`/`scrollHint` already look for — neither needed a line
of TRANSLATION-specific logic. (Before this the vertical scroll existed only as an
unintended side effect of the sibling columns' `overflow-x-auto`, with nothing
ever moving the scroll position.)

`translationSlot` wraps the return value in the **same shell** `codeDiff`'s
single-pane branches use (`data-testid="code-diff"` + a reactive `data-hints`,
driven by the same `hintsEnabled` opt) plus the two unmodified
`scrollHint('up')`/`scrollHint('down')` chevrons, and threads an `opts.onScroll`
callback into `translationBlockView` (same shape as
`opts.activeIndex`/`opts.approvedRowSet` — keeps `translationDiff.mjs` free of a
circular import) that calls the unmodified `updateHints` on manual scroll.

Reusing the `code-diff` testid pays off twice for free: `home.mjs`'s
`refreshHints()` (window resize) already sweeps every `[data-testid="code-diff"]`,
and `menuAnchor()`'s `[data-change-active-end]` fallback now anchors the command
palette on the active key row instead of the whole card. Safe with wide sibling
columns: `menuAnchor()`/`positionMenu()` only read `top`/`bottom`, never
`left`/`width` — the palette's width/left comes from `menuRegion()`, which for a
TRANSLATION card falls back to the whole block column (no `[data-pane]` exists in
this render). See `.claude/docs/command-palette.md`.

## SVG blocks

`isSvgFile`/`svgSlot` (`Block.mjs`) **replace** the raw text diff with rendered
old/new `<img>` previews — the same "replace, don't add alongside" precedent as
`translationSlot`. A changed `.svg` file has no PHP function to scan, so it's a
whole-file `OTHER` block (the `ScanBlocks` whole-file fallback).

Old + new render side by side; a one-sided (`added`/`removed`) block shows only
the side it has (`singleSide(b)`, the same pane choice `codeDiff` uses).

**Deliberately unaffected by the `a` split/unified/fit toggle** — that toggle
controls how much code TEXT is visible and how wide a line is, which this preview
has no stake in, so `viewMode` is never read here. The card width is untouched
too: an `.svg` file is not a PHP file, so it already gets the non-PHP treatment
(`boundedWrapWidthCls`) in every stand — see `.claude/docs/diff-card.md`.

**Security — never render the SVG source via `.innerHTML` (no inline `<svg>` in
the DOM).** The content comes from the PR, so it is untrusted and could carry a
`<script>`, an `onload=`/`onerror=` handler, or a `<foreignObject>`. `svgDataUri`
turns the raw text into a `data:image/svg+xml;base64,...` URI for a plain `<img>`
— a browser disables script execution and event handlers for an SVG rendered as
an image. It returns `''` (→ a muted "geen preview" placeholder) for empty content
or anything without an `<svg` tag.

**No raw-text fallback:** deliberately no toggle back to the plain text diff (the
source stays reachable via `GET /api/code` / "Open on GitHub") — that would need
new ephemeral or URL state for a narrow case. Test: `tests/svg-preview.spec.mjs`
(fixture PR 109, `svg-blocks.json` + `materializeSvgWorktrees`, including a
hostile `<script>`/`onload=` payload that never fires).
