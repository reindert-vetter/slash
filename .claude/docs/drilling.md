# Drilling: Underlying code as its own column (`state.drill`)

Opening an Underlying-code child as a full-fledged diff column of its own, and
the column-navigation model (`state.focusLevel`) that follows from it.

## Opening a column (`drillIntoChild`)

`Enter`/`Space` on a **resolved** child in the Underlying-code card (a relation
child or a resolved method call — `isCodeFocused`/`focusedRelatedChild` in
`RelatedPanel.mjs`) **or a click on it** (`@click` on
`data-testid=related-item`, via the `drill` callback `home.mjs` passes to
`RelatedPanel`) opens that child as a full diff column to the right of the
existing columns (between the diff and `RelatedPanel`) instead of just the flat
excerpt. All three go through the same `drillIntoChild(child)`.

`home.mjs` keeps a **stack**, `state.drill`: every `drillIntoChild` pushes one
entry plus a matching cursor entry onto `state.drillCursor` (`{change:0}`) and
sets `state.focusLevel` to that fresh (deepest) level. Nothing closes
automatically anymore — every drilled column stays open for the whole diff
session (see "Leaving a column" below).

Requires an active diff session (`state.mode==='diff'`); drilling has no meaning
outside diff mode. **One deliberate exception:** `openCommentAnchorDrill`
(`home.mjs`) opens a drilled column while STAYING in list mode, for a
PR-comment index item anchored to a real block — see "An anchored 'Start' item
instead opens its block 'as if fully expanded'" in `.claude/docs/comments-panel.md`.
Every mechanism below (opening/closing, `.key()`, scrolling) is otherwise
unaware of the distinction — only `BlockList`'s "hide the index in diff mode"
check, the two `home.mjs` watches noted there, and **the rail** needed to
special-case it: for this one drill the column it was opened FROM is hidden
outright instead of collapsing to a rail (and its `drill-left-hint` chevron
with it), so the anchored column sits exactly where an ordinary block card
would — `commentAnchorColumnHidden`, see "The anchored column IS the leading
column" in `.claude/docs/comments-panel.md`.

A drill entry is **one of two forms**:

- **A real PR block** — if the child is already in `state.allBlocks` (a relation
  child, or the definition of a resolved method call that itself changes in this
  PR), that existing block object is reused (no copy): it already carries
  `code`/`approvedRows`/etc., and
  `relatedChildren`/`resolvedCallChildren`/`callRows` work generically on any
  block id, so the child gets its own full navigable Underlying-code panel for
  free (recursion works out of the box).
- **A synthetic frame** — a resolved method call into a file the PR doesn't
  change: a minimal object
  `{ id, label, file, class, name, status:'unchanged', code:null, synthetic:true }`
  (`unchanged` because old === new, so the diff is entirely equal; a `modified`
  badge would mislead — class/name split from `child.label` on `::`), for which
  `ensureCode` fetches the old/new source like any block. This level shows **only**
  its diff, no Underlying-code card of its own (no caller scan runs for a
  synthetic frame). With zero changed rows its card also shows **no approve
  checkbox** at all (`Block.mjs` hides it for `b.status === 'unchanged'`).

## Refresh restore (`?drill=`/`?dgran=`/`?dchg=`/`?dcur=`)

`state.drill`/`drillCursor` don't live in the URL themselves (too large/not
serializable, same reason as `state.blocks`), but `home.mjs` mirrors them into
plain URL-facing fields, exactly like `blockRef` mirrors `state.selected`
(URL-state section in `CLAUDE.md`):

- `state.drillRef` → `?drill=` — each entry's stable `.id` (a real block id, or a
  synthetic call frame's caller-scoped `b.id + '::' + callKey`) joined with `>`,
  which occurs in no id.
- `state.drillGran`/`drillChange` → `?dgran=`/`?dchg=` — only of the **deepest,
  focused** column (`drillCursor`'s last entry). Kept for backward
  compatibility with an older shared link and as the round-trip's convenience
  pair, but no longer the primary restore path — see `?dcur=` below.
- `state.drillCursorRef` → `?dcur=` — **every** level's own `{gran, change}`
  cursor, index-aligned with `drillRef`'s id path, each entry encoded as
  `${gran}:${change}` and joined with `>` (same separator/convention as
  `drillRef`). This is what makes an **ancestor** (non-focused, rail-collapsed)
  column's exact position survive a refresh too — not just the focused one.
  It matters even though an ancestor's cursor is never itself visible on
  screen (it collapses to a rail, see "Unfocused columns collapse into a
  narrow rail" below): **"Finishing a drilled column's subtree returns to an
  unapproved ancestor"** (below) reads exactly that saved cursor once the
  reviewer pops back out of a finished subtree — without `?dcur=` every
  ancestor's cursor silently reset to `{group, 0}` on refresh, so "Ga terug"
  landed at the top of the column instead of where the reviewer had actually
  left it.

Restore follows the same snapshot-before-the-clobbering-watch pattern as
`blockRefPending`: `drillRefPending` (the path, split on `>`), `drillCursorPending`
(`{gran, change}`, the legacy deepest-only pair) and `drillCursorRefPending`
(an array of `{gran, change}`, one per path entry, parsed from `?dcur=`) are
captured right after `bindUrlState` and applied by **`applyDrillRefRestore`**
once `loadBlocks` has loaded the blocks/relations **and**
callresolve/testcovers (normally fire-and-forget — only with a `drillRef` to
restore do we await them, so a method-call/covers child is findable via
`relatedChildren`). The walk starts at `curBlock()` and looks, per level, for
the child in `relatedChildren(parent)` whose `(c.blockId || c.id)` matches,
reusing **`drillIntoChild`** itself so every side effect (`ensureCode`,
`focusLevel`, scroll, the entrance animation) is identical to a real drill. Not
found (deleted relation, resolver rerun, expired link) → stops silently, like
`applyBlockRefRestore`; whatever was drilled so far stays (and so does any
still-unconsumed tail of `drillCursorRefPending` — it's simply never applied).

The path is walked back in FIRST, entirely, at every level's default
`{group, 0}` cursor (`drillIntoChild`'s own fresh push) — only THEN does a
second pass apply each level's own `drillCursorRefPending[i]` entry
(**`applyDrillCursorRestoreAt`**), once its rows are known (guarded on
`b.synthetic || b.code`) — synchronous for a synthetic frame, otherwise
deferred until `ensureCode`'s fetch for that specific level completes
(`ensureCode`'s "drilled column's code arrived" branch now checks
`state.drill.indexOf(b)` generically, not only
`state.drill[state.focusLevel - 1] === b`, so an ancestor whose code was still
in flight while the path was walked back in also gets its cursor once it
loads). This two-pass order is load-bearing, not incidental: applying an
ancestor's restored cursor DURING the walk — before the next path segment is
resolved — can make that very next lookup fail, because `relatedChildren`
hides a relation child while ITS PARENT's own cursor sits at `line`/`call`
granularity (see `relatedChildren`'s `scoped` guard) — exactly the
granularity an ancestor deep enough to have a restored non-`group` cursor is
likely to carry. The legacy `applyDrillCursorRestore` (deepest-only, from
`?dgran=`/`?dchg=`) only still runs when `drillCursorRefPending` itself is
absent (an older link with no `?dcur=` at all) — once `?dcur=` is present it
already covers the deepest level too. All of `drill`/`dgran`/`dchg`/`dcur`
travel along in the `/pr-overview` round trip
(`overviewExitUrl()`/`treeUrl()`, see "`?sel=` travels along…" in
`.claude/docs/pages-and-routing.md`).

**Bug found and fixed: a two-level-deep restore could silently drop to one
level, nondeterministically.** Reviewer report: "als ik in een onderliggende
blok van een onderliggende blok refresh dan ga ik naar de bovenliggende
blok" — a refresh at drill depth 2 sometimes landed one level shallower, with
`?drill=`/`?dcur=` in the resulting URL silently truncated to the first
segment. Root cause was narrower than the "`line`/`call` cursor applied too
early" case the two-pass order above already guards against: a restored
**`group`** cursor at a non-zero index (e.g. `group:1`) on an ANCESTOR level
was, by design, deferred until after the whole path is walked — but that
ancestor's own children are looked up (`relatedChildren(parent)` in the very
next loop iteration) while its cursor still sits at the walk's default
`group:0`. `relatedChildren`'s outer `scoped` guard only fires for `line`/
`call`, so a relation-edge or test-coverage child is still found fine — but
`resolvedCallChildren`'s OWN internal scoping (`callScopeMethods`, unconditional
on granularity: it scopes to whichever change group is CURRENTLY active
regardless of `line`/`call`/`group`) can filter a call-resolved child down to
just group 0's rows. A target child whose call site only sits inside the
group the restore actually wants (`group:1`) then isn't in
`relatedChildren(parent)`'s candidate list yet, the next path segment isn't
found, and the walk stops one level short — reproduced as genuinely
nondeterministic against a real PR (roughly coin-flip, depending on whether
the ancestor's own `/api/code` fetch happened to have already landed, which
flips `resolvedCallChildren`'s scope from "not yet computable → unfiltered"
to "computable → filtered to group 0"). Fixed in `applyDrillRefRestore`: right
after `drillIntoChild` for a level, if that level's own
`drillCursorRefPending` entry is a `group` cursor, apply it immediately (via
`applyDrillCursorRestoreAt`) — BEFORE the next iteration resolves that level's
children — rather than waiting for the second pass. A restored `line`/`call`
cursor is still deliberately left for the second pass, for exactly the reason
the two-pass order above documents.

## Column navigation: `state.focusLevel`

**Every** column — the top-level block card and every drilled column — is a
full-fledged navigable diff with its **own** change-group cursor (unlike the
earlier "always the deepest level" model). `state.focusLevel` says which one owns
the arrow keys: `0` = the top-level selected block (using
`state.change`/`state.gran`), `1..state.drill.length` indexes
`state.drill[level-1]` with its cursor in `state.drillCursor[level-1]`
(`{change, gran}`, mirroring `state.change`/`state.gran`).

So a drilled column **does** zoom with `f`/`d`/`s` (group → line → call, the same
`setGran` logic, as `setDrillGran(level, delta)` on its own cursor entry).
`fKey`/`dKey`/`sKey` (`home.mjs`) branch on `state.focusLevel`: `> 0` operates on
that level's drillCursor entry, `0` on `state.gran`/`state.change` as always.

`focusedBlock()` (which the Underlying-code panel and inline comments follow) is
`state.focusLevel === 0 ? curBlock() : state.drill[state.focusLevel - 1]`, so
stepping a column back with `←` moves the panel along. There is still exactly one
`RelatedPanel` instance (`cs`/`rc` remain singletons).

### Sideways to a sibling instead of clamping

A drilled column has no "next block" to walk to (that's `sameFileNeighbour`/
`stepBlock`, level 0 only) but it does have a **sibling**: if `↓`/`f` goes past the
**last** unit of the column (or `↑`/`d` past the **first**), navigation steps
sideways to the next/previous child in the Underlying-code list of the **parent**
column. This lets the reviewer walk a block's whole underlying-code tree
top-to-bottom without pressing `←` for every sibling.

`drillToSibling` **replaces the column at the same level** (pop the current
`state.drill`/`drillCursor` entry, then `drillIntoChild(sibling)`, which puts a
fresh entry back at the same depth) — it never stacks deeper.
`drillSiblingContext` determines the parent (`curBlock()` at level 1, otherwise
`state.drill[level-2]`, so it works at any depth) and its sibling list: exactly
`relatedChildren(parent)` minus the non-drillable `tests_group` toggle bar; the
current column is found via `blockId`-or-`id`.

**No wrap-around** — on the last/first sibling it still clamps. Sideways-forward
(`↓`) lands on the new column's **first** `group` unit; sideways-back (`↑`) on its
**last** — mirroring `stepBlock`'s "stepping up lands on the last change" — and
best-effort synchronous: if the sibling's code hasn't loaded it falls back to the
first unit rather than waiting (no `pendingLast`-style deferral, deliberately
simple). `dKey`'s `call`-level guard (`cur.change > 0`) is extended with
`hasPrevDrillSibling()` so `d` on the very first call segment already steps back
to the previous sibling, mirroring the top-level `dKey`'s `sameFileNeighbour(-1)`
check. See `tests/drill-sibling-walk.spec.mjs`.

### Resolved: a self-referencing relation edge listed the block as its own child

Reported live (screenshot: `.claude/scratch/child-card-wider-than-selected.png`):
a second card with the exact same title, `file:line` and approve count as the
selected/focused one, sitting right where the Onderliggende-code panel shows
its children. Confirmed and fixed (previously recorded here as an
unreproduced "open investigation" with three static candidates — reproducing
narrowed it to the first).

**Root cause:** `childrenOf(b)` (`home.mjs`) mapped every `state.relations`
row with `r.parentId === b.id` straight to a child descriptor with **no
self-loop guard** — unlike `nestedChangedKids`, which already skips
`kid.id === parentId`. A relation edge with `childId === parentId` (the
backend detector matching a block's own trigger back to itself — e.g. a
recursive dispatch/call) made `relatedChildren(b)` list `b` as its own child:
literally the same title/file/line, its own code, since it IS the same block
object. Reproduced deterministically by mocking a self-loop `/api/relations`
row on the existing PR 12903 fixture (`page.route`, mirroring
`tests/drill-preview.spec.mjs`'s fixture-override style) — confirmed the
duplicate `related-item` before any fix, using the real Onderliggende-code
panel, not a guess.

**Fix:** `childrenOf`'s filter is now `r.parentId === b.id && r.childId !== b.id`.

`resolvedCallChildren`'s matching gap (a resolved call resolving back to its
own caller) and a duplicate landing directly in `state.blocks` were the other
two candidates weighed while investigating; neither was needed to explain the
reproduced case, so neither was touched — no speculative guard was added
without a failing test proving it necessary. Test:
`tests/drill-self-loop-relation.spec.mjs`.

### Approve follows `focusLevel` too

`approveContext()` (`home.mjs`): without it, "Approve …" would invisibly approve
the TOP-LEVEL block/cursor while a drilled column held the keyboard (the reported
"I can't approve anything in underlying code"). See "Enter — command palette" in
`.claude/docs/command-palette.md` and `tests/drill-approve.spec.mjs`.

### Finishing a drilled column's subtree returns to an unapproved ancestor

Reviewer request: approving everything reachable from a drilled column (its own
rows, plus its whole Onderliggende-code subtree) doesn't mean the column you
drilled **in from** is itself done — you may have drilled in before finishing
it. `findNextUnapproved()`'s step 3 (`.claude/docs/command-palette.md`) then
walks the drill stack upward and lands back on the first ancestor that still has
an unapproved unit of its own, on that ancestor's **saved cursor**
(`state.drillCursor[lvl-2]`, or `state.gran`/`state.change` for the top level) —
exactly the position the reviewer left before drilling deeper, since drilling IN
only ever *pushes* a fresh cursor entry for the new deepest level and never
touches an ancestor's own entry. That saved cursor also survives a **refresh**
in the middle of a multi-level drill session: `?dcur=` mirrors every level's
own `{gran, change}`, not just the deepest one (see "Refresh restore" above),
specifically so this ancestor lookup still finds the real pre-refresh position
rather than the `{group, 0}` default `drillIntoChild` pushes for a fresh
column. `applyNextUnapproved` needs no change for this:
a step-3 plan's `path` is simply a **prefix** of the current `state.drill`, which
the existing common-prefix trim already collapses to (closing the drilled
column(s) below it), including the `markDrillReturn`/`.drill-return` entrance
animation (see "Return animation" below) since `common === target.path.length`
in this case.

This still opens the `postApprove` confirm menu (it always lands on a different
block than the one just approved, so neither of the "skip the menu" exceptions
in `.claude/docs/command-palette.md` applies) — but with its 2nd item labelled
**"Ga terug"** instead of **"Ga door"** (`findNextUnapproved`'s `isReturn` flag on
the plan, read by `POSTAPPROVE_COMMANDS`'s label function). Test:
`tests/drill-approve-return-to-ancestor.spec.mjs`.

### Entering, leaving, and what may not happen

- **Right after drilling, focus is on the diff of the new column**, not its
  Underlying-code panel: `drillIntoChild` calls `leaveRelated()` (the exported
  `exitRelated`) instead of `enterRelated()`. The reviewer lands on the first
  change group and walks with `↑`/`↓` (`drillNextChange`/`drillPrevChange`).
- **The drilled column reuses the same `Block(b, {...})` render** as the top-level
  card, so red/green, char diff and filler alignment are identical. What was
  missing was **scrolling to the active change** (on a large function the reviewer
  landed at the top of the body with the hunk off-screen, which looks like "no
  diff formatting"): `drillIntoChild` therefore also calls
  `scrollChangeIntoView(false)` for the cached case, and `ensureCode` does the
  same as soon as a not-previously-loaded drilled/focused child's code arrives
  (`state.drill[state.focusLevel - 1] === b`). `scrollChangeIntoView` itself:
  `.claude/docs/keyboard-navigation.md`.
- **`←` closes the focused drilled column** and returns focus to the diff of the
  **parent** column (the previous drilled column, or from level 1 the top-level
  block). The closed child reappears in that parent's Underlying-code list on its
  own, since the list is driven by `focusedBlock()` via the `setRelated` watch.
  Repeated `←` peels back level by level. **Also reachable by mouse:** the
  `block-close-column` button in that column's own header
  (`Block.mjs`'s `blockCloseColumnButton`) calls the exact same
  `closeDrilledColumn()` (`home.mjs`) `←` runs at `focusLevel > 0` — see
  "Every diff card/column also has a mouse way back" in
  `.claude/docs/mouse-navigation.md`.
- **Only at level `0` does `←` close the whole diff session**
  (`state.mode='list'`), and only then are `state.drill`/`state.drillCursor`
  cleared: drilled columns only mean anything within *this* session. The
  mouse equivalent is `MainScrollLeftHint` (`home.mjs`), which calls the
  matching `leaveDiffToList()` — see "A mouse way to reach content hidden to
  the left" in `.claude/docs/detail-layout.md`.
- **Nothing else may flip `state.mode` to `'list'` while there's drilling.**
  `ensureCode`'s "block with no navigable changes → back to list" fallback (for a
  restored `?mode=diff` URL) is gated to the resting position
  (`state.focusLevel === 0 && state.drill.length === 0`): after a postApprove
  "Continue" that selects a new root and drills into its child, that root's still
  in-flight code fetch lands *after* the drilling — if the root has 0 groups of
  its own, the ungated fallback flipped to list mode with the drill stack
  standing, so `←` missed the peel branch. Test:
  `tests/drill-mode-flip.spec.mjs`.
- **`→` still opens the Underlying-code panel** of the focused column
  (`enterRelated()`) — still the only way to drill **deeper**.
- From within the panel (`relatedActive()`), `←`/`Escape` unconditionally
  return focus to the diff of **that same** column (`handleRelatedKey`'s
  `exitRelated`), at any child position and regardless of whether the unit
  has visible comments (only `↑` from the first child still detours through
  the last comment conversation, see `.claude/docs/comments-panel.md`) —
  that no longer closes a column; the column-by-column navigation above only
  follows once `relatedActive()` is `false` again.

## Reactivity: no flicker on a gran/change step

The outer `${() => state.drill.map(...)}` binding that builds the columns
deliberately does **not** subscribe to `state.drillCursor` (only to
`state.codeVersion` and `state.focusLevel`, which flip a column's `.key(...)`). If
that closure also read `drillCursor`, every `f`/`d`/`s`/`↑`/`↓` step would rebuild
**all** open columns (every `Block()` call and thus all Prism highlighting again)
— the "outer closure vs. nested reactive slot" pitfall in
`.claude/rules/arrowjs-pitfalls.md`.

The `state.drillCursor[i]` reads that matter live in the
`activeGroup`/`hintsEnabled`/`diffActive` functions passed to `Block(b, {...})`:
those are themselves reactive bindings (invoked only from within `Block`'s own
`${…}` slots), so they re-evaluate on their own dependency without rebuilding the
column — exactly as `state.change`/`state.gran` already did for the top-level
card.

## Card `.key()` rules

**The column `.key`** encodes position in the stack, code status
(`load`/`code`/`err`) **and** whether the column currently has focus
(`foc`/`unfoc`) — like the `sel`/`prev` component on the top-level card — so a
focus switch forces a fresh card with fresh `${…}` bindings instead of arrow.js
reusing the node.

**The block-card `.key(...)`** encodes **role** (`sel`/`prev`) **and** code status
(`load`/`code`/`err`), so arrow.js builds a fresh card as soon as a block moves
preview→selected or its code arrives. Without those, arrow.js reuses the keyed
node (move+patch) *without* re-running the `${…}` bindings: the `activeGroup`
highlight + scroll stayed frozen on the previous selection, and the
`null→loaded` diff render dropped out intermittently ("stuck on loading"). The
"code arrived" signal runs through `state.codeVersion` (bumped in `ensureCode`),
which the `DetailPanel` binding subscribes to so it re-runs and flips the key. The
`setCommentScope`/`setRelated` watches still read `curBlock().code` (they must, to
follow the cursor) — it's precisely their co-subscription that makes the diff
binding miss the update, so we rebuild via the key rather than adding another
`b.code` reader. See `.claude/rules/arrowjs-pitfalls.md`.

**An ordinary `state.change` step must not flip that card key** (it would force a
fresh `Block()` call and thus a visible flicker on every ↑/↓). The gray step
chevron (`stepChevronSlot`/`canStep`) reads `state.change`, so it lives in its
**own** nested `${() => …}` slot instead of directly in `DetailPanel`'s outer
array-building closure. That slot also sits in a **stable element root** (a
`<div>` with a static `contents` class), not a bare keyed `${…}` wrapper — a bare
wrapper let the chunk `ref` go stale as soon as the chevron toggled and corrupted
the keyed reconcile of the block column (the preview card disappeared and the tab
froze on repeated ↓/↑ through same-file blocks). Both pitfalls:
`.claude/rules/arrowjs-pitfalls.md`; test:
`tests/step-preview-stability.spec.mjs`.

## Scrolling and the ‹ chevron hint

A new column scrolls itself into view (`scrollFocusIntoView`, `<main>` scrolls
horizontally) — always aligned **left** (`inline:'start'`, for a drilled column
too), so the columns you came from disappear off-screen to the left instead of
cramming the new one onto the right. The same function re-aligns the now-focused
column when stepping back, and when leaving the `RelatedPanel` back to the diff
(`onKeydown`'s `relatedActive()` branch calls it as soon as `handleRelatedKey` has
released panel focus): panel navigation scrolls `<main>` sideways, and without
that re-alignment the diff card stayed cut off to the left after `→…→` then
`←…←`.

Every **focused** drilled column (`state.focusLevel > 0`) additionally shows a
small gray **‹ chevron on its left edge** (`data-testid=drill-left-hint`, outside
the card, vertically centered) as a hint that there are columns off-screen to the
left — purely a cue, no click action (`←` does the stepping). It's baked into the
column `.key` via the existing `foc`/`unfoc` component.

**The chevron sits outside the `drill-column` box (`absolute -left-3`)**, so
`scrollIntoView({inline:'start'})` would clip it behind `<main>`'s left edge (that
call aligns the column div's own box flush against the inner edge, so anything
12px beyond falls outside the `overflow-x-auto`-clipped scrollport).
`drillColumnCls` therefore carries a static `scroll-ml-4` (1rem left scroll
margin) — a CSS property `Element.scrollIntoView()` respects, so
`scrollFocusIntoView` itself needed no change. Unconditional on this class: the
div with testid `drill-column` only renders when the column is focused (the
non-focused branch returns a `drill-collapsed` rail early), and `drillColumnCls`
was already a plain non-reactive string per `.map()` iteration.

Test: `tests/drill-left-hint-visible.spec.mjs` — note it uses an
`IntersectionObserver` ratio, not `getBoundingClientRect().left >= 0`: that
coordinate is viewport-relative and stays positive even for a chevron fully
hidden behind `<main>`'s clip edge, so a coordinate check can't distinguish
"visible" from "clipped by an ancestor's `overflow`".

## Opening animation (`drill-enter`)

A fresh `drillIntoChild` call (a real drill, or `drillToSibling`'s replacement)
sets a module-level, **non-reactive** marker `drillOpenMarker = { level, id }`
(`home.mjs`). The `state.drill.map(...)` render reads it once per column and
**consumes** it immediately (`if (justOpened) drillOpenMarker = null`) before
building that column's class string (a plain non-reactive interpolation, **not** a
`${() => …}` binding — nothing to track). Only on a match does the wrapper get
`drill-enter` (a short fade+slide `@keyframes` in `index.html`, with a
`prefers-reduced-motion` guard).

**This must never become a reactive/permanent class binding:** the column
`.key(...)` also flips on a mere focus switch (`←`/rail click) or when code
arrives, and neither is an "open". The consume-once pattern handles both cases:

- If the key stays the same across a navigation step (which only touches
  `drillCursor`), arrow.js reuses/patches the node; the class string is only set
  on node **creation**, so no new animation trigger (a CSS animation doesn't
  repeat without `iteration-count:infinite`).
- If the key does flip, the marker is already consumed (`null`), so the fresh node
  gets no class and no replay.

Test: `tests/drill-open-animation.spec.mjs` (the class is present right after
drilling; a subsequent `ArrowDown` proves via an ad-hoc marker attribute that the
node is **not** remounted).

## Return animation (`drill-return`)

The exact mirror for the column that **regains** keyboard focus once a drilled
column closes (`drillReturnMarker`/`markDrillReturn` in `home.mjs` +
`.drill-return` in `index.html`). Three call sites set the marker, each right
after lowering `state.focusLevel`:

- `onKeydown`'s `←` branch (peeling back one level),
- `expandColumn` (a rail click, can jump back several levels at once),
- `applyNextUnapproved`, but **only** when the common-prefix trimming already
  covers the full target (`common === target.path.length`, so no further
  `drillIntoChild` follows) **and** the root doesn't change (`sameRoot`) —
  landing on a brand-new top-level block is a fresh selection, not a return.

`markDrillReturn(level)` resolves which column that is (`{level, id}`; level 0 =
the top-level block via `curBlock()`, else `state.drill[level - 1]`). Two render
passes consume it once each, the same pattern as `justOpened`:

- The drilled-columns list: a `justReturned` check next to `justOpened`;
  `drillColumnCls` gets `drill-enter` *or* `drill-return`, never both (the two
  markers are set by disjoint actions).
- The top-level block-column closure had no stable wrapper root to attach a
  one-time class to (`Block(b, {...})` was pushed directly), so
  `inner = Block(b, {...})` is wrapped in
  `<div class="contents ..." data-testid="detail-card">` — a static non-reactive
  class string per `.map()` iteration (`display:contents` keeps it out of layout,
  so no `flex` gap artifact) — and the `.key(...)` moved from `Block(...)` onto
  that wrapper (the key belongs on the outermost pushed item). `justReturned` is
  only checked for `i === sel`; only the selected card can be the level-0 return
  target.

`.drill-return` is `.drill-enter` mirrored: the same fade + 180ms ease-out but
`translateX(-6px)→0` (in from the left), within the same
`prefers-reduced-motion` guard. Test: `tests/drill-return-animation.spec.mjs`.

## Look-ahead preview of the next sibling

`drillPreviewColumns`, `data-testid=drill-preview-column`: **below** the focused
(always rightmost) drilled column's card — not next to it — a dimmed preview of
the sibling `↓` would step to at the end (`drillNextChange`→`drillToSibling`).
Mirrors the top-level look-ahead preview: only the **next** sibling (never the
previous), always visible as soon as one exists (not only on the last change
unit), connected with the same vertical dotted `connector()`.

`resolveChildBlock` (extracted from `drillIntoChild`) resolves the sibling
descriptor to the same block-like object a real drill would push, so the preview
shows identical, already-loaded code once promoted.

`drillPreviewColumns()` is called from a **nested**, array-returning
`${() => drillPreviewColumns()}` slot *inside* the focused column's own per-item
template (next to the real `Block(b, …)` card, same `flex-col` wrapper) — not as a
separate top-level item in `state.drill.map(...)`'s array. Doubly load-bearing:

1. It only reads the cheap, **identity-guarded** field `state.drillPreviewChild`,
   never `drillSiblingContext`/`relatedChildren` directly (those read much broader
   state — `b.approvedRows`/`state.callResolve`/`testCovers`/`relations` — and
   would rebuild every open `Block()` card on an unrelated approval/poll). That
   calculation lives in the existing `setRelated` watch (which runs
   `relatedChildren()` anyway) and only writes the field on a genuinely different
   next-sibling id.
2. Being nested, a preview switch never rebuilds the outer
   `state.drill.map(...)` closure (and thus never the real card above it). An
   earlier version pushed the preview as a top-level array item with a
   **constant** key and did not reliably re-render on a changing sibling target —
   the same keyed-node-reuse pitfall.

Test: `tests/drill-preview.spec.mjs`. The preview's own width/collapse rules live
in `.claude/docs/diff-card.md`.

## Unfocused columns collapse into a narrow rail

As soon as `state.focusLevel` is on a drilled column (i.e.
`state.drill.length > 0`), every column without that focus (the top-level card
when `focusLevel > 0`, and every drilled column before the focused one — never
after, since `focusLevel` is always `state.drill.length`, so the focused column is
always rightmost) no longer makes sense at full diff width: there's nothing to
review in a column that doesn't own the arrow keys.

`collapsedColumnHTML(b, level, testid, drillIdx)` (`home.mjs`) renders it as a
narrow button (`w-14`, full height via `<main>`'s flex-stretch) with an arrow icon
+ a vertically truncated label — the full `class::method` via the shared
`blockLabel` helper (`Block.mjs`); style borrowed from `RelatedPanel.mjs`'s
`sidebarHintRail`. Testids: `data-testid=block-collapsed` (top-level) resp.
`data-testid=drill-collapsed` + `data-drill-idx` (drilled).

Clicking calls **`expandColumn(level)`**: functionally identical to pressing `←`
repeatedly until you're at that level — `state.drill`/`state.drillCursor` are
truncated to `level` and `state.focusLevel = level`, so anything deeper is
discarded. Deliberately the same semantics as the `←` pop, not a "keep the child
open but hidden" variant, which would break the single-focus-owner model.

Both render spots branch with **ordinary JS ifs inside their existing,
already-`focusLevel`-subscribed bindings** (the top-level `${() => {...}}` slot in
`block-column`, and the per-item `.map()` callback), so no new nested reactive slot
and no new keyed-node pitfall: the top-level slot still returns an array
(`[collapsedColumnHTML(...).key(...)]`, never a bare element), and the
drilled-columns list rebuilds on every `focusLevel` switch anyway via the
`foc`/`unfoc` key. See `tests/drill-collapse.spec.mjs` (one and two levels deep).
