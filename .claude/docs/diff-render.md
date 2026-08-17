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

### A collapsed run in a yaml/yml file shows its key hierarchy as a breadcrumb

A whole-file yaml/yml fallback block (e.g. an OpenAPI spec) can collapse a run
of unchanged sibling keys right before a changed line — the reviewer then sees
e.g. a changed `description:` with no clue it sits under
`paths > /products/{id}/clone > post`. `isYamlFile(b)` (mirrors
`isPhpFile`/`isSvgFile`, a plain `.yml`/`.yaml` extension check on `b.file`)
gates an extra line inside the spacer itself (`collapsedRunHTML`'s
`breadcrumb` param, `data-testid=collapsed-run-breadcrumb`): the ' > '-joined
key hierarchy, e.g. `Pad: paths > /products/{id}/clone > post`. `isYaml` is
computed once in `codeDiff` and threaded through every `codePane`/
`unifiedCodeDiff` call site into `paneHTML`/`unifiedHTML`, exactly like the
existing `wrap`/`diffActive` flags.

Deliberately **not** a real YAML parser — `yamlBreadcrumbsForSegs` (`Block.mjs`)
is a single forward pass over every row (hidden rows included; they're still
present in `rows`, just not rendered) maintaining a depth-ordered stack of
`{depth, key}` via `YAML_KEY_RE` (indentation + optional `- ` list-item prefix
+ a quoted-or-not mapping key). A new key pops every stack entry at or above
its own depth, then pushes itself — plain indentation tracking, no nesting
grammar beyond that.

**The snapshot for a collapsed run is the ancestor chain of the NEXT VISIBLE
row, not simply "the stack right after the run's last hidden row"** — that
last hidden row's own key is typically a SIBLING of the next visible line
(both at the same depth), not its ancestor, so a naive snapshot would show
`paths > /products/{id}/clone > post > key299` instead of stopping at `post`.
The fix peeks one row ahead (`yamlRowKey(rows, end + 1)`) and pops anything at
or above that row's own depth BEFORE snapshotting — the same pop the main loop
performs anyway once it actually reaches that row, just done one row early.

One run of unchanged text in a non-yaml huge block (locale JSON, etc.) never
computes this at all — `isYaml` short-circuits `yamlBreadcrumbsForSegs` before
any regex work, so the existing performance profile for the huge-block case
this whole mechanism was built for (see above) is unaffected. Test:
`tests/yaml-collapse-breadcrumb.spec.mjs`.

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

## Line selection: click and browser text selection

Reviewer request: "ik wil dat huidige manier van selecteren in de diff met
mijn muis weg gaat [...] ik wil de browser selectie manier gebruiken" — the
mouse used to reimplement its own click-count-based line/group/whole-block
scheme and its own hand-rolled drag range, fighting the browser's native text
selection the whole time (`preventDefault()` on every row mousedown). That is
gone: the diff is now **ordinary selectable text**, and the app only
translates whatever the browser ends up selecting into a navigation unit,
once, right after the gesture finishes.

Three follow-up answers shaped the exact translation rule:

1. **A real (non-collapsed) selection always rounds up to whole LINES** —
   "afronden op hele regels: elke aangeraakte regel wordt meegenomen" — `gran`
   is unconditionally forced to `'line'` (never `'group'`/`'call'`), and there
   is no "unchanged line → no interaction" exception here: any real selection
   resolves to *some* line range, each end snapped to the nearest real unit
   exactly like a gran switch already does (`unitAtRow`).
2. **A genuine click (no drag at all)** selects a call-segment if the click
   landed on one, else the exact line/reference unit under it, else — "als er
   geen line is aangepast, dan wil ik daar geen interactie van zien" —
   **absolutely nothing**: no focus steal, no scroll, no state change. This is
   the one place a click is *stricter* than before: the old scheme snapped to
   the NEAREST unit regardless of where exactly the click landed.
3. **Native double-/triple-click keep their browser-native meaning**
   ("native (woord/regel)") rather than a custom group/whole-block meaning —
   this falls out of rule 1 for free, see below. **Shift+click is the one
   exception**: it is resolved deterministically via app state
   (`resolveShiftClickSelection`), never via the browser's own native
   selection-extend behaviour — see why below.

- **Hover (CSS only, no state, unchanged):** `rowCellHTML`'s non-active row
  branch gets a `hover:` grey inset bar (same colour family as the dimmed
  cursor bar, `#94a3b8`/`#71717a`) plus `cursor-pointer`, but only while
  `focused` (this card already owns, or could take over, the keyboard —
  mirrors `diffActive()`): a look-ahead preview/testClass card never shows it.
- **Mousedown only SEEDS the gesture** — one delegated `@mousedown` on the
  whole card (`Block()`'s own `<article>`, `onBlockMouseDown` in `Block.mjs`)
  rather than threading a callback through
  `codeDiff`/`codePane`/`unifiedCodeDiff`/`paneHTML`'s already long positional
  parameter lists — a row div lives inside whichever pane's `<code>` is
  currently rendered, and `data-row` (only on the canonical metadata-carrying
  line, see `rowCellHTML`'s own doc comment) already uniquely identifies it.
  In a **split** diff that canonical line is now, unconditionally, the
  new/right pane's own row — a click landing in the old/left pane finds no
  `data-row` ancestor at all and is a no-op — see "Only the new/right pane
  drives selection" below. `onBlockMouseDown` no longer calls
  `preventDefault()` for this (the seg-dot approve branch, below, still does —
  that is a small, isolated click target, not a text-selection surface) and
  passes `(row, segStart, cardEl, shiftKey)` to `home.mjs`'s
  `beginMouseSelection` (`cardEl` is the mousedown's own `e.currentTarget`),
  which only records a plain, non-reactive `pendingMouseSelection = { level,
  b, i, row, segStart, cardEl, shiftKey }` — `level` 0 = top-level diff, >0 =
  a drilled column's own focus level. Nothing in `state` changes yet: at
  mousedown time it isn't known whether the gesture will end up a plain
  click or a real selection.
- **Resolution happens exactly once, on the next `mouseup`**
  (`resolvePendingMouseSelection`, the same document-level listener
  `schedulePassiveMenu` already deferred to — see its own doc comment further
  down):
  - **`shiftKey` is checked FIRST, before `window.getSelection()` is ever
    read** → `resolveShiftClickSelection(pending)`: extends
    `state.rangeAnchor`/`state.change` (or the drilled column's own
    `drillCursor` entry) to the clicked row, mirroring the OLD
    keyboard-driven `extendRange`'s own row-index logic verbatim (just
    resolved once here instead of continuously on every mousemove of a
    drag). **Deliberately never resolved via the browser's own native
    selection-extend behaviour**, unlike everything else on this list —
    every diff pane is one big `.innerHTML` string, reassigned WHOLESALE on
    every `state.change`/`gran` write (`codePane`/`paneHTML`), so the very
    state mutation a PRECEDING plain click just made destroys every row's
    DOM node, including whichever one held the browser's native caret. A
    following native Shift+click then has no valid anchor left to extend
    from — observed in testing: Chrome doesn't cleanly collapse the
    selection in that case, it silently reassigns the anchor to the FIRST
    node of the new container instead, several rows away from where the
    reviewer actually clicked. Falls through to `resolveClickSelection`
    when the clicked card doesn't already own the keyboard (no earlier
    selection there to extend from). Test: `tests/shift-click-range.spec.mjs`.
  - **No selection, or a COLLAPSED one** → `resolveClickSelection(pending)`:
    rule 2 above. A call-segment first (`segStart != null`, looked up in
    `navUnitsOf(b, rows, 'call')` the same way as before), else the exact
    line/reference unit the row belongs to
    (`units.findIndex((u) => u.start <= row && row <= u.end)` — deliberately
    **not** the nearest-fallback `unitAtRow`, so an unchanged, non-landable row
    resolves to `-1` and the function returns immediately, before even calling
    `ensureTopLevelDiffFocus`). TRANSLATION blocks are excluded from the
    call-segment branch (their `gran` stays pinned at `'group'` — see
    `navUnitsOf`/`setGran`/`extendRange`'s own exclusion) — every click there
    keeps landing on the one key-row it always did.
  - **A real, non-collapsed selection whose two ends (`sel.anchorNode`,
    `sel.focusNode`) both resolve to a `[data-row]` inside the SAME `cardEl`
    the gesture started on** (`rowOfNode`, which returns `null` rather than
    guessing when a selection spilled outside that card) →
    `resolveRangeSelection(pending, startRow, endRow, snapshot)`: rule 1 above — always
    `gran: 'line'`, both ends snapped via the ordinary nearest-fallback
    `unitAtRow`, `state.rangeAnchor`/`state.change` (or the drilled column's
    own `drillCursor` entry) set directly from the two resolved unit indices.
    Never for a TRANSLATION block (same exclusion as above) — a selection
    there just falls back to a plain click on its own start row. Deliberately
    does **not** try to refocus a different card: a selection that spilled
    outside the originating card resolves to `null` ends and is treated as a
    plain click on the mousedown's own row instead.
  - This is also what makes **native double-click** (word select) and
    **native triple-click** (paragraph select — browsers scope this to the
    nearest block-level ancestor, which is the row's own `<div>` here, so
    `startRow === endRow`) resolve correctly with **zero** extra code: each
    simply produces a genuine, non-collapsed `Selection` self-contained
    within one row, and `resolveRangeSelection` doesn't care how that
    selection came to exist. Unlike Shift+click, neither of these depends on
    a PRIOR selection surviving a render, which is exactly why they're safe
    to read natively.
  - **The native selection is actively RESTORED afterwards, exact character
    for character — it does not just "stay in place".** Bug report: "ik kan
    niet normaal met een muis een selectie doen ... want na een fractie van
    een seconde is het niet meer geselecteerd". Root cause:
    `resolveRangeSelection`'s own `state.gran`/`change`/`rangeAnchor` write
    (right above) triggers the SAME wholesale `.innerHTML` reassignment that
    makes a native Shift+click unreliable (see that bullet above) — the row
    DOM the reviewer's own real selection pointed into gets destroyed within
    the same tick, so without intervention the visible/copyable selection
    collapses to nothing a fraction of a second after the reviewer releases
    the mouse, well before `resolveRangeSelection` even finished running in
    the OLD, pre-fix behaviour.

    The fix: `resolvePendingMouseSelection` calls `captureSelectionSnapshot`
    on the real `sel` BEFORE dispatching to `resolveRangeSelection` — for
    each of `sel.anchorNode`/`sel.focusNode` it resolves the owning row
    (`closestRowEl`) and the ROW-RELATIVE CHARACTER OFFSET of that boundary
    point (`rowRelativeOffset`, a throwaway `Range.setEnd(...)` +
    `toString().length` — the standard "text offset within a container"
    trick), giving `{ anchorRow, anchorOffset, focusRow, focusOffset }`. That
    survives the re-render because it names a POSITION (row + character
    count into that row's rendered text), not a specific Text node object.
    `resolveRangeSelection` threads this `snapshot` through and, right after
    its own `state` write, calls `restoreExactSelection(cardEl, snapshot)`:
    deferred one `requestAnimationFrame` (`cardEl.isConnected` guards against
    the reviewer having navigated away in that one frame) — the same
    "wait one frame for the just-swapped state to actually render" pattern
    `showPassiveMenu`'s own `positionMenu` call already relies on — then
    `locateOffsetInRow` (a `TreeWalker` over the row's OWN, freshly rendered
    text nodes, summing lengths until the target offset falls inside one) maps
    each snapshot endpoint back onto a real (Text node, local offset) pair in
    the NEW DOM, and `Selection.setBaseAndExtent(anchorNode, anchorOffset,
    focusNode, focusOffset)` re-applies it — `setBaseAndExtent`, not a plain
    `Range`, because it preserves the true anchor→focus DIRECTION the
    reviewer actually dragged in, not just a start/end pair in document order.

    **Deliberately restored EXACT, never rounded to the `lo`/`hi` line range**
    `state.rangeAnchor`/`change` use just above it in the same function:
    confirmed explicitly — rounding the visible/copyable selection itself
    (not just the app's own navigation unit) would silently turn "select half
    a word to copy it" into "select and copy three whole lines instead",
    which is exactly backwards from the reviewer's own stated goal ("ik wil
    alles kunnen selecteren als normaal [...] en kopiëren"). The app's own
    unit selection and the reviewer's own visible/copyable text selection are
    two independent things from here on — the first is always whole-line
    (rule 1), the second is always exactly what was dragged.

    Not attempted for a Shift+click (`resolveShiftClickSelection` never reads
    or restores a native selection at all — see that bullet above) or for a
    plain click (`resolveClickSelection` — nothing real was selected to
    begin with, a click's own native caret is collapsed). Test:
    `tests/diff-row-mouse-select.spec.mjs`.
- **A single click landing INSIDE a real call-segment selects that exact
  segment at `'call'` granularity instead of `'line'`** (unchanged from
  before, just now scoped to a genuine click, see rule 2) — top-level only,
  and only on the row's NEW/right side (confirmed "oude kant alleen 'line'" —
  the old/left pane never carries a call selection at all, `changeCalls` only
  ever segments the new text). A row whose new text has no real call structure
  (a blank line, or one the click isn't actually inside) falls back to
  `'line'`.
  - `rowCellHTML` wraps every call-chain segment of a call-eligible row
    (`sideKey==='right' && r.rightMark==='ins' && r.right != null`, only
    while `focused`) in a hoverable+clickable span via the same `markChars`
    per-character pass the active-segment underline already uses:
    `CALL_HOVER_CLS` (a plain `call-seg` marker class, see below) plus
    `data-call-seg="<segment start>"` — the segment's own stable per-row key,
    the same one `callKey`/call-approval already use. `callSegmentsForRow(r)`
    (the `rowCallSegments(rows, i)` implementation, extracted so it can be
    called with the row object directly) computes the segments;
    `highlightChanges` (paired/modified rows) and the plain `markChars` branch
    both merge this in alongside the existing `underline`/`segDots` concerns.
  - `onBlockMouseDown` (`Block.mjs`) additionally resolves
    `e.target.closest('[data-call-seg]')` and passes that segment's start (or
    `null`) as the second argument to `onRowMouseDown` — `home.mjs`'s
    top-level `resolveClickSelection` uses it to look up the matching unit in
    `navUnitsOf(b, rows, 'call')` (`u.start === row && u.segStart === segStart`)
    and select it directly, `gran` forced to `'call'`. A drilled column's own
    `beginMouseSelection` closure simply never passes this through, which is
    what keeps a drilled column's click `'line'`-only with zero extra code.
  - **The hover is not a bare Tailwind `hover:` class.** Prism's own token
    tags (`<span class="token ...">`) interrupt the character stream
    `markChars` walks, so one LOGICAL call-segment (e.g. `->billingAddress`)
    typically renders as SEVERAL adjacent DOM spans sharing the same
    `data-call-seg` value (one per Prism token) rather than a single merged
    span — a bare `hover:` class would then only light up whichever one
    sub-span the cursor happens to sit over, a couple of characters at a
    time, defeating the explicit ask ("dat lost tegelijk het 'waar ligt de
    grens'-bezwaar op" — the hover must show the segment's FULL extent).
    `CALL_HOVER_CLS` is therefore a plain `call-seg` marker with no visual
    effect of its own; `onCallSegHover(e, on)` — a delegated `@mouseover`/
    `@mouseout` pair on the same `<article>`, always wired (not opt-in like
    the click handler, since it only toggles a CSS class, no `state`
    write) — finds every sibling span sharing the hovered one's
    `data-call-seg` value within the same row and toggles `call-seg-hover` on
    all of them together, so the whole segment highlights as one block
    regardless of how many Prism tokens it's split into. The actual grey tint
    (`.call-seg.call-seg-hover`) lives in `index.html`'s `<style>`, same
    colour family as the plain-row hover bar (`#e2e8f0`/`#3f3f46` — slate-200/
    zinc-700), with the usual light + two dark mirrors (`@media` and
    `:root[data-theme='dark']`) — see "What can't use a Tailwind `dark:`
    variant" in `.claude/rules/conventions.md`.
- **A click on a non-focused card focuses it first, exactly like the
  keyboard would** (reviewer follow-up: "een klik op een andere kaart dan de
  focus kaart moet dat kaart focussen alsof je gewoon met je key er
  navigeert" — mouse-navigation.md, Rule 1: reuse the function, never a
  parallel implementation). `ensureTopLevelDiffFocus(i)` (`home.mjs`, called
  from both `resolveClickSelection` and `resolveRangeSelection`) reuses
  `expandColumn(0)`/`leaveRelated()` (mirrors repeated ← out of a drilled
  column or the comments/Onderliggende-code panel), `stepBlock` (mirrors ↓
  flowing across a same-file boundary — only tried once already in diff mode,
  since that "flow" concept doesn't exist from list mode), and the ←(list)
  →(`enterDiff`) fallback for a different-file neighbour or a still-list-mode
  click. The caller's own unit lookup then overrides whatever landing unit
  `stepBlock`/`enterDiff` picked, so the reviewer always ends up exactly on
  the clicked/selected row. The two visible non-focused full cards this
  applies to: the top-level look-ahead preview (`i === sel + 1` in the
  `pair.forEach` block-column loop) and a drilled column's own sibling preview
  (`drillPreviewColumns`, focused via `focusDrillPreviewSibling` →
  `drillToSibling`, since that preview always renders nested inside the
  ALREADY-focused column — no level change needed there, only the sideways
  sibling swap; this one call site resolves eagerly at mousedown instead of
  deferring to mouseup, since a still-unfocused preview never supports a
  drag/selection range, only the single row clicked). A drilled column that
  isn't the focused one is always a collapsed rail instead (no rows to click
  at all) — its own click already calls `expandColumn`, unrelated to this
  feature.

Test: `tests/diff-row-mouse-select.spec.mjs` (a genuine click always forces
`'line'` even from `'group'`/`'call'`, a native double-/triple-click still
only selects the one line it lands on, a mousedown+drag native selection
produces the same 3-of-4-lines range `range-select.spec.mjs`'s
Shift+ArrowDown x2 does, a click directly on a real (Prism-multi-token)
call-segment selects it at `'call'` with the whole segment's hover toggling
together, a click on an unchanged/non-landable line is a no-op, a drilled
column's double-click still only selects the one line, and a click on the
look-ahead preview focuses + selects it).

## Only the new/right pane drives selection — the old/left pane is display-only

Bug report: in a 'split' diff the old and new pane each render through their
OWN independent `.innerHTML` binding (`codePane`, one call for `'left'`, one
for `'right'`), and both used to read the SAME `activeGroup()` — two
independent reactive consumers of one shared value, the exact "co-subscribers
can drop an update" shape from `.claude/rules/arrowjs-pitfalls.md`. arrow.js
could drop the re-run for ONE of the two after an approve-driven auto-advance
moved `state.change`, leaving the old pane's own binding frozen on the
PREVIOUS cursor — visibly, two indigo active-row bars on two DIFFERENT rows at
once, one per pane. Reviewer follow-up, explicitly confirmed per case below:
"ik wil dat we alleen nieuwe kunnen selecteren en navigeren".

Fix: the old/left pane of a **split** diff no longer has any selection state
of its own at all — `codeDiff`'s split branch passes the left `codePane` call
a permanently-null `activeGroup` stub (`NO_ACTIVE_GROUP`) and `emitMeta:
false` (threaded through `codePane`/`paneHTML` into `rowCellHTML`'s existing
`opts.emitMeta`, the exact same suppression `unifiedRowHTML` already applies
to its own decorative OLD half of a paired unified row). This removes not just
the symptom but the race itself: with the left pane's binding no longer
reading `activeGroup()`/`state.change` at all, there is nothing left to
compute independently, so it can never disagree with the right pane again.

Concretely, only the new/right pane's rows now carry: the active cursor bar
(and its dimmed/grey non-focused variant), `data-row` (so a click there is a
no-op — see below), `data-changed`, the `data-change-active`(-end) anchor, the
✓ approve checkmark, and the "onderliggende code" line-summary badge.
**Including a PURE DELETION** (a removed line with no replacement — the
right/new side is an empty filler row): reviewer answer "als het side by side
is, moet rechts een lege regel zichtbaar zijn" — `approveHere`'s existing
`sideKey === 'right' || r.right == null` fallback for the old/left pane is now
gated behind the same `emitMeta` flag, so on the split stand's canonical
right pane it is simply always true (there is no more "or" clause needed
there), and the checkmark/active bar land on the empty filler row instead of
the old text. Nothing else needed to change for this: `changeLines`/
`changeGroups`/`unitAtRow` already operate on the aligned ROW index regardless
of side, so ↑/↓/f/d/s already reach a pure-deletion row exactly as before —
only WHICH pane paints the result moved.

**Scope is 'split' only.** The **unified** stand ('a's 2nd stand, one "old (-)
above new (+)" column, see below) is untouched: it was never two independent
bindings in the first place (`unifiedHTML` is ONE `.innerHTML` binding), and a
lone old-only row there (a pure deletion, or any one-sided row) already gets
full canonical treatment on its own line — reviewer confirmed this stays as
the exception: "als het boven elkaar is, mag het het wel keuren". A wholly
`removed` block/file (`effectiveOnly === 'left'` in `codeDiff` — there is no
"new" pane to defer to at all, only ONE pane renders) is likewise untouched —
reviewer: "blijft normaal werken".

**Hover is the one thing that still couples both sides**, even though only
the new/right pane is a click target — reviewer answer "het moet hover state
krijgen als nieuw connected ook hoverd, en andersom". Every row (regardless of
`emitMeta`) carries a plain, unconditional `data-row-pair="<i>"` (distinct
from `data-row`, which stays canonical-only); a delegated `mouseover`/
`mouseout` pair (`onRowPairHover`, wired next to the existing
`onCallSegHover` on the card's own `<article>`) toggles a plain marker class,
**`row-pair-hover`** (`index.html`'s own `<style>`, same grey inset-bar tokens
as the ordinary per-row hover affordance, light + the two dark mirrors — same
"custom class, not a Tailwind `hover:` variant" reasoning as `.call-seg-hover`
right above it: the old and new pane are two entirely separate `<code>`
elements, so a bare CSS `:hover` can never reach across to the other one), on
EVERY element sharing that index — including the hovered element itself, since
the old/left pane also lost its own native `cursor-pointer`/`hover:` classes
(now gated on `emitMeta` too, next to the existing `focused` gate) precisely
because it is no longer a click target: showing a pointer cursor there would
be misleading.

Test: `tests/diff-old-pane-display-only.spec.mjs` (the old pane never carries
`data-row`/an active tint, a click there is a no-op, an approve-driven
auto-advance never leaves a stale bar on it, hovering either side lights up
both, and the pure-deletion empty-filler-row case above). Every pre-existing
count-based assertion of "one row × two panes" (`tests/navigate.spec.mjs`,
`tests/drill-focus.spec.mjs`) was updated to "one row × the new/right pane
only" — that was the bug's own symptom baked into the previous expectation,
not a coincidental unrelated count. `updateHints` (`Block.mjs`) needed one
matching fix: it used to resolve "the" scrolling pane via the first
`[data-scrollsync]` match in document order, which is the old/left pane in
'split' — now display-only, so its rows no longer carry `data-changed` at
all. It now prefers `[data-pane="new"] [data-scrollsync]`, falling back to the
old plain query only for the one render path with no "new" pane at all (a
wholly removed block).

## The active-row cursor bar dims when the diff doesn't own the keyboard

The active row/unit gets an inset left bar (`shadow-[inset_...px_0_0_...]`, a
box-shadow so it adds no width and the bars of adjacent active rows merge into
one continuous accent) plus a brighter background tint — `rowCellHTML`
(`Block.mjs`) for an ordinary code diff, `translationRowCls`
(`translationDiff.mjs`) for a TRANSLATION block's per-key overview. Both are
driven by `activeGroup()`/`activeIndex()`, which only checks
`state.selected`/`state.focusLevel` (see "`→` into the Underlying-code card" in
`.claude/docs/keyboard-navigation.md`) — **not** `state.mode` or
`relatedActive()`. So the bar used to stay bright indigo even when the keyboard
had actually left the diff: back in the block index (`state.mode==='list'`),
inside an inline comment thread, the embedded Claude chat, or the
Underlying-code panel — same block still selected, same cursor position, wrong
visual cue.

The fix reuses `diffActive()` (`Block.mjs`, `opts.diffActive` — the same flag
that already dims the card's own **border**, see "Focus highlight per stop" in
`.claude/docs/keyboard-navigation.md`) as a second input, threaded all the way
down through `codeDiff`/`codePane`/`unifiedCodeDiff`/`paneHTML`/`unifiedHTML`
into `rowCellHTML`'s new `focused` parameter (and `translationSlot` →
`translationBlockView`'s `opts.focused` → `translationRowCls`'s `focused`
parameter):

- **`focused` (diff owns the keyboard):** unchanged — indigo, 3px bar
  (`shadow-[inset_3px_0_0_#6366f1]`) + the brighter del/ins/context tint.
- **Not focused, but still the cursor's row:** the bar turns **grey and one
  pixel thinner** — `shadow-[inset_2px_0_0_#94a3b8] dark:shadow-[inset_2px_0_0_#71717a]`
  (slate-400/zinc-500) — and the background falls back to the row's ordinary
  (non-active) tint, or the plain filler tint for a mark-less row (the empty
  side of a one-sided add/remove). **Colour and thickness change together,
  never colour alone** — the reviewer is colourblind (see `CLAUDE.md`).

`Block()`'s own `diffActive` opt defaults to `() => true` (not `() => false`)
for this reason: every real call site in `home.mjs` passes it explicitly (a
preview/look-ahead card passes `() => false`, and also always pins
`activeGroup: () => null`, so it never reaches the active branch at all), so
the default only matters for a test/harness that constructs `Block()` directly
and only cares about e.g. `activeGroup` — such a test gets the ordinary
"focused" look without also having to wire `diffActive`.
`translationBlockView`'s `opts.focused` mirrors this with its own
`() => true` default. Test: `tests/diff-active-row-dim.spec.mjs`.

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
