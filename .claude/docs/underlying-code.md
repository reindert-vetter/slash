# The "Underlying code" card (`RelatedPanel`)

`RelatedPanel.mjs`'s default export, `data-testid=related-code`: the child blocks
of the currently focused column — relation children, resolved method calls, and
test-coverage links — as small Prism-highlighted excerpts. Sits directly right of
the block column in `<main>`'s flow (see `.claude/docs/detail-layout.md`);
`Enter`/click on a child drills it open as its own column
(`.claude/docs/drilling.md`).

## The children and their badges

Each child is one card (`data-testid=related-item`). It follows
`focusedBlock()`, so it moves along with a drilled column.

- A **relation child** carries a kind badge (`listener`, and the other
  `KIND_LABEL` words for the Laravel request chain), fed from the relations read
  model via `GET /api/relations?pr=N`. `home.mjs`
  (`childrenOf`/`relatedChildren`) pulls the children from `state.allBlocks` and
  lazily loads their code. See "Relations between blocks" in
  `.claude/docs/workflows-analysis.md`.
- A **method call** (`kind=method_call`, from `GET /api/callresolve` — code +
  descriptor sit in the row, so no extra fetch) has no word badge but a **diff
  stat** (`data-testid=related-diffstat`): `+A −R` (green/red, added/removed lines
  of the called definition, via `diffStat` in `Block.mjs`, git-`--stat` style), or
  a gray **`Unchanged`** badge when the call points into a file the PR doesn't
  change (`r.diff` is `null`). Only calls on **lines the PR changed** get a row;
  **enum cases** (`AddressType::BILLING`) resolve to their enum declaration. See
  "Resolving (also unchanged) called methods" in
  `.claude/docs/workflows-analysis.md`.
- **Test coverage**, both directions, from `GET /api/testcovers`: `kind=covers`
  (a test block shows the tested method, same diff stat/`Unchanged` badge as
  `method_call`) and `kind=covered_by` (a tested production method shows "covered
  by TestX::testY", reusing the existing test PR block). Both are **block-level**
  and thus drop out at `gran==='line'`/`'call'`. A test without a usable coverage
  annotation shows a **warning** in the card header instead of a child
  (`data-testid=related-covers-warning`, custom inline SVG + explanation — never
  an AI guess). See "Linking test coverage" in
  `.claude/docs/workflows-analysis.md`.
- An **approval badge** (`data-testid=related-approval`, `done/total`, green + ✓
  when fully approved) on any child that is itself a PR block, rendered in that
  child's own header (`approvalBadge`). Per-child only — there is **no**
  panel-header rollup element (no `related-approval-total` testid; an earlier
  version of this doc claimed one). A call into an unchanged file has no approval
  concept and no badge. Counts ride along on the descriptor (`approve`, filled by
  `relatedChildren`/`resolvedCallChildren` via `blockApproveCount`); the same
  `{done,total}` also feeds the sidebar pill — see
  `.claude/docs/approval.md`.
- A child found by an LLM carries a **`source: haiku/sonnet`** badge;
  Go-resolved children show none.
- Selecting an `Unchanged` child gets the same indigo border as any other selected
  item. An earlier version gave it a gray ring even while selected ("nothing to
  review"); that exception was dropped — the app has one single
  blue-selected/gray-unselected border rule (see "Focus highlight per stop" in
  `.claude/docs/keyboard-navigation.md`), and the `Unchanged` **text** badge
  still carries that signal.

In the card header the **title (`class::method`) is always visible** (gets the
first line, truncates only at extreme length); the **file path** sits below it on
its own line and truncates.

A **relation child** also stays in the left list as a fully navigable row (own
diff, selection, `?sel=` restore) but sorts to the very bottom under an
**"Onderliggende code" heading** (`data-testid=underlying-heading`,
`BlockList.mjs`), marked via `state.underlyingIds` (a plain `{blockId: true}` map,
reassigned wholesale alongside `state.blocks`). The PR-wide approval header skips
those rows when summing `state.approvalTotal` (already counted in their parent's
subtree).

`recomputeLeftList` (`home.mjs`) determines the left list: `state.blocks` =
`allBlocks` minus any **PR block that is the definition of a resolved/found method
call** (`resolvedCallTargetIds`, including a relation child that is also such a
target) — so a function shown as "Underlying code" under a parent doesn't *also*
appear separately in the left list. It runs on `loadBlocks` and after every
`loadCallResolve`, preserving selection by **block id** so a reload doesn't shift
the cursor.

**Exception, symmetric with `testCoverTargetIds`:** a resolved-call target whose
**caller is a TEST block** (`testCallTargetIds`, `home.mjs`) — a test literally
calling the production method it exercises, as opposed to only covering it via a
`@covers` annotation — is exempt from `resolvedCallTargetIds`'s hidden set. Such a
target is always primary, reviewable PR code (e.g. the very action a new test
method is added for), never incidental reference code, so a test resolved-calling
it must not make it vanish from the index — the same reasoning that already kept
`testCoverTargetIds` out of the hidden set. Instead of merely staying visible at
its ordinary category rank, it joins `state.underlyingIds` alongside relation
children (`recomputeLeftList`'s `childIds`), so it sorts to the bottom under the
same "Onderliggende code" heading. Before this exemption, a PR consisting only of
a changed production method plus new tests for it showed a single index entry —
the test class — with the actual changed code hidden entirely, reachable only by
drilling from the test's own Onderliggende-code panel.

## "loading code…" vs. "no code found"

Every child descriptor carries a `loading` flag, set in `home.mjs` (the
`setRelated` watch chain) — **never** by `RelatedPanel` reading `b.code`. For a
**lazy** PR-block child (relation child/`covered_by`) it's `!kid.code`
(`ensureCode` always sets `kid.code` to an object once the fetch completes, even on
error: `{error}`); for an **embedded**-code child (`method_call`/`covers`, code
sits in the callresolve/testcovers row) it's hard `false`.

`relatedCard` renders three-way: code → excerpt; empty + `loading` → "loading
code…"; empty + not loading (a completed load that turned out empty/error, or an
empty embedded `childCode`) → the end state **"no code found"**
(`data-testid=related-empty`, same gray style). The item key encodes that state
(`related:<id>:code|load|empty`), otherwise the loading→code/empty transition can
freeze on a reused keyed node (`.claude/rules/arrowjs-pitfalls.md`). Test:
`tests/related-empty-code.spec.mjs` (PR 96 embedded empty; PR 90 lazy load that
completes empty).

## List navigation

`↓` falling through whatever sits before this card — the last inline comment
conversation (see `.claude/docs/comments-panel.md`) or the embedded Claude chat
(`.claude/docs/claude-chat-panel.md`), which is where a bare `→` from the diff
now lands — selects the **first** item (`cs.codeSel=0`); `↓`/`↑` move through them (clamping at the last — `↑` on the
first steps back onto the last inline comment conversation if the unit has one,
else out to the diff, via `hasVisibleComments`/`enterCommentsTail`); `←` steps back
the same way from any position. The selected item gets an indigo ring
(`data-active=true`). All items stack **vertically** at full width. Full chain:
`.claude/docs/keyboard-navigation.md`.

The card has **no fixed height cap**: it grows with its content up to the block
column's full height and then scrolls internally (`min-h-0`, body
`flex-1 overflow-auto`). Code excerpts **wrap** (`whitespace-pre-wrap
break-words`, no horizontal scroll).

**Refresh restore of the panel cursor:** `cs.focus`/`codeSel`/`sel`/`threadPos`
live in the URL under their own `rel` namespace
(`bindUrlState(cs, …, { ns:'rel' })`), so a refresh returns to the same child /
the same comment thread. Because the data pushes (`setRelated`/`loadComments`)
clamp `cs` while loading — and the mirror watch would immediately reflect that into
the URL — `RelatedPanel` snapshots the restored values in `restorePending` and
reapplies them, clamped, exactly once via **`applyRelRestore`** once the
children/comments are in (only focusing if the target exists, then clearing so
later navigation stays free). See skill `url-state` and the URL-state section in
`CLAUDE.md`.

## Column width (`relatedColumnWidthCls`)

The width of the **entire** column (not per card) is a reactive `${() => …}` class
binding on `<section data-testid=related-code>` instead of a static string. It
takes a **representative non-comment** code line across all currently shown
top-level cards (`rc.children`, excluding the `tests_group` bar — nested chips and
the drill-preview column keep their own fixed `w-72`) and turns that character
count into `clamp(min, calc(Nch + 2rem), max)`: the `ch` unit is exactly one
monospace glyph, so this is **purely arithmetic on an already-known character
count** — no live DOM measurement (`scrollWidth`/`getBoundingClientRect`) that
could race a layout pass.

- `min` = the default floor `42rem`/`49.2rem` (matching a one-sided/`a`-narrowed
  block, see `.claude/docs/detail-layout.md`).
- `max` = `56rem`/`65rem` — deliberately **below** the block column's own
  `70rem`/`82rem`, so one long line can't grow this card to half the screen.
- `clamp()` handles "no code" and "everything shorter than the floor" for free.

**Comment lines deliberately don't count** (`codeGrowthChars`, a state-machine
scan that skips a leading PHPDoc block, `//`/`#` lines and intervening `*`
continuations) — a long prose comment wraps neatly and must never widen the
column; only real code (long chains, wide return types) does.

**Not the longest line but the 75th percentile** (nearest-rank) of the remaining
line lengths: one extreme outlier must not single-handedly push the column to the
ceiling — that line just wraps. The plain median was too aggressive the other way
(in a method with 3-4 real content lines the loose `{`/`}` lines pull it to almost
0 even for a genuinely wide method), so the 75th percentile is the middle ground.

Only reacts to `rc.children` — the same plain snapshot `kids()` reads — so it adds
no co-subscription on the selected block's `b.code`. Consequence: the width
symmetry with the neighbouring column is a **default**, not a guarantee. Test:
`tests/related-code-grow.spec.mjs`.

`InlineComments`/`ClaudeChatPanel` reuse this same clamp **scaled**, not
verbatim: `commentColumnWidthCls()` (2/3) and `claudeColumnWidthCls()` (1/3),
sitting side by side in `comments-and-related`'s first row — see
"The embedded Claude chat column" in `.claude/docs/detail-layout.md` and
`.claude/docs/comments-panel.md`.

### Narrow viewport (< 1400px)

A hard Tailwind cutoff, not a vw-scaling formula: `index.html`'s
`tailwind.config` defines a custom **max-width** screen `narrow: { max: '1399px' }`
(Tailwind emits a screen's CSS after the corresponding unprefixed utility — the
same source-order mechanism `2xl:` already relies on — so a `narrow:` class
alongside a base class wins below 1400px with no specificity conflict; at/above
1400px nothing changes). Motivation: on a ~1378px window a two-sided diff card
(`w-[70rem]` = 1120px) next to even the floor of this column (672px) overflowed by
430px, so the reviewer had to scroll away most of the diff to glimpse this column.

- **`relatedColumnWidthCls`** (and thus `commentColumnWidthCls`/
  `claudeColumnWidthCls`, scaled off it) drops floor/ceiling from
  `w-[42rem]`/`w-[56rem]` (672/896px) to **`w-[40rem]`/`w-[48rem]` (640/768px)**.
- **`widthCls`** (`Block.mjs`, the diff card — top-level and every drilled column)
  drops its two tiers from `w-[70rem]`/`w-[42rem]` (1120/672px) to
  **`w-[42rem]`/`w-[28rem]` (672/448px)** — the `split` tier reuses the number the
  narrow-60%/`singleSide` tier had above 1400px, which in turn drops further,
  keeping roughly the same ~60% ratio so the `a` toggle still visibly differs.
  Deliberately scoped to `widthCls`'s own two tiers: `fit`'s content-driven width
  (`fitWidthCls`/`boundedWrapWidthCls`, `.claude/docs/diff-card.md`) is
  untouched — it's an opt-in stand that is uncapped upward by design and was never
  going to reliably fit at 1378px.
- **The sum at the common floor:** `42rem` + `1rem` (`gap-4`) + `40rem` = `83rem`
  = 1328px, comfortably inside a ~1378px window (vs. the reported 1808px before).
  A genuinely wide child still grows this column to its (lower) ceiling and may
  still need some horizontal scroll — narrowing improves the typical case, it
  doesn't guarantee every combination fits.

The Playwright default viewport (1280×720, see
`.claude/docs/testing-playwright.md`) is itself below 1400px, so effectively the
whole suite exercises the narrow widths — `related-code-grow.spec.mjs`'s ceiling
assertion reflects 768px.

## Drill hint chips (a recursive mini-tree growing rightward)

Any child whose block **itself** still has changed underlying code shows a short
**dotted dash** to the right of its card toward a chip column
(`data-testid=related-nested`, `w-72` — doubled from `w-36` so longer labels fit):
one chip per changed (grand)child (`data-testid=related-nested-chip`) with

- the **full `class::method` label**, which **wraps and is never truncated**
  (`whitespace-normal break-words`; bare name without a class — the shared
  `blockLabel` helper in `Block.mjs`);
- its own **diff stat `+A −B`** (`data-testid=related-nested-diffstat`, `diffStat`
  over the lazily-`ensureCode`d kid; a gray **`…`** placeholder while loading —
  never "Unchanged", every chip target is by definition a changed PR block);
- the **approval `done/total`** (`data-testid=related-nested-approval`,
  `blockApproveCount` of the block itself — deliberately not the subtree; ✓ prefix
  when fully approved, hidden at `total 0`).

No file line in the chip (the full `label · file` sits in `title`).

**Recursive and rightward, not indented below:** each chip is a flex row
(`nestedChip`) — the chip button, followed (if that child has further changed
children) by its **own** chip column via `nestedChipColumn`, the same function that
renders the top-level column next to the card and now the **only** recursive
building block at any depth (the earlier indented-below `nestedSubChips` is gone).
Depth cap **2 chip levels** below the card (`NESTED_DEPTH`, `home.mjs` — every
level multiplies `ensureCode` fetches, and looking deeper is what drilling is for);
per level capped at **3 chips + "+N more"** (`data-testid=related-nested-more`,
never keyboard-reachable), cycle-safe via a shared `seen` set (the
`nestedPrBlocks` pattern). Since a row can now be wider than its own `w-72`
column, the card's existing `overflow-auto` body also scrolls horizontally — a
consequence of the layout, no separate CSS.

Data comes from `nestedChangedKids(prBlock, parentId, seen, depth)` (`home.mjs`):
plain descriptors on `r.nested` plus a recursive key signature `r.nestedSig`
(`nestedSigOf`), built in the same descriptor builders/`setRelated` watch as
everything else — never in a render binding, so no `b.code` race.
`directChildBlocks` by definition only yields **PR blocks**, so an
`Unchanged`/synthetic call target never gets a chip (such a call child explicitly
gets `nested: []`). Chips ride on the descriptor, so they appear at every
granularity where the child itself is visible.

A **click on a chip at depth d drills d+1 levels at once** (the card child, then
every ancestor chip, then the chip itself — sequential `drillIntoChild` steps via
the same `drill` callback, with `stopPropagation` so the card click doesn't also
drill one level beyond); `Enter` on the card remains the normal single-level drill.

### Keyboard through the chip tree (`cs.chipPath`)

A second, nested cursor next to `cs.codeSel`: empty (`[]`) = the keyboard is on
the card itself, `[i]` the i-th top-level chip, `[i,j]` its j-th subchip (one index
per depth, mirroring the recursive `nested` shape). Only meaningful within
`cs.focus==='code'` (`handleRelatedKey`), spatially consistent with the rightward
growth:

- **`→`** descends into whatever is focused (card or chip) toward its own first
  nested chip (no-op without nested children).
- **`←`** climbs one level back; only with an empty `chipPath` does it fall through
  to "leave the panel". This is a **deliberate behaviour change** — `←` used to
  always close the panel regardless of chip focus.
- **`↓`/`↑`** walk the **siblings at the current depth** (`chipListAt`, clamped at
  both ends, no flow into another level) as long as `chipPath` isn't empty,
  otherwise the existing `cs.codeSel` behaviour over the cards.
- **`Enter`** drills the whole chain via `focusedChipChain()` (ancestors + focused
  chip, mirroring the click handler).

`chipPath` resets to `[]` as soon as `codeSel` changes and on every `setRelated`
push (the tree can rebuild, so an old depth index isn't trustworthy). The focus
ring (`data-active` on the chip) is scoped on `cs.codeSel` **as well as**
`chipPath`, because two different cards can have the same chip-tree shape and thus
the same path — without that check the "focused" chip lit up on every card with
that shape at once (regression: the last test in
`tests/related-nested-chip.spec.mjs` drills three levels deep and verifies only
the card at `codeSel` shows an active ring).

### arrow.js details for the cards/chips

The card root of `relatedCard` is a flex row (card `min-w-0 flex-1`). The approval
count is a **precomputed string** (`approveText`) in an always-present element, and
every conditional sub-template (chip column, diff stat) runs through a
`${() => …}` **function binding** — never a static template↔string ternary, which
leaked arrow's template function as text on chunk reuse (see
`.claude/rules/arrowjs-pitfalls.md`). The card `.key` in `fullCard` carries
`r.nestedSig` so every tree change (set/approval/diff loaded) builds a fresh node;
chip keys are the **id path** (the same id can hang under two parents).
`data-child-id` stays on the innermost card, so the call-arrow overlay (which
targets the card's **left** edge) isn't affected by the chips on the right. The
`tests_group` bar gets no chips.

## Grouping covering tests into a horizontal bar

`groupTestChildren` (`home.mjs`) + `testsBar` (`RelatedPanel.mjs`): as soon as a
block shows, besides its `covered_by` children, **other** (non-test) children too,
those tests collapse into one horizontal row
(`data-testid=related-tests-bar`: chevron + "N tests" pill + one compact chip per
test method, `data-testid=related-tests-chip`) at the spot where the first test sat
in the ordering — so they don't push the actual underlying code down.

Click or `Enter` on the bar **toggles** `state.testsExpanded` (ephemeral, not in
the URL, reset to closed on a block switch via `lastRelatedBlockId` in the
`setRelated` watch callback; it's an inline dep in that watch getter): expanded,
the tests render as ordinary child cards directly below the bar (the bar stays as
a collapse toggle). With **no** other children (or no tests) this is a no-op — the
tests render as ordinary cards.

The group item rides along **within** the child list as a synthetic
`kind:'tests_group'` descriptor, so the panel cursor (`cs.codeSel` indexes
`rc.children` 1-to-1) needs no special case: `Enter`/click lands in
`drillIntoChild`, which branches on the child (toggle instead of drill);
`orderedChildBlocks` filters it out, just like `covered_by`. The bar's `.key`
encodes open/closed + the test ids (fresh node per toggle). Test:
`tests/related-tests-group.spec.mjs` (fixture PR 99, `testsgroup-*.json` +
`materializeTestsGroupWorktrees`).

## Call-arrow overlay (`src/callArrows.mjs`)

A smooth indigo bezier arrow from the changed call site in the **active navigation
unit** (right edge of the new pane, at the call-site row's height) to the
corresponding **changed** child card — exclusively for a `method_call` child whose
definition is itself a PR block (an `Unchanged` target never gets one), one arrow
per matching child, only in diff mode and only for **the column that holds the
keyboard**: the top-level block (`focusLevel === 0`, `state.gran`/`state.change`)
**or** the focused drilled column (`focusLevel > 0`, its own
`state.drillCursor[focusLevel-1]`). Exactly the `approveContext()` idiom —
`callArrowPairs(b)` guards on `b === focusedBlock()`. Every drilled column is a
full navigable diff, so there's no reason for the arrow to vanish on drilling.

The DOM side (`main.querySelector('[data-pane="new"]')` /
`panel.querySelector('[data-child-id]')`) needed **no** change: a non-focused
column always collapses to a rail without `[data-pane]`, so the query
automatically finds the one remaining pane — that of the keyboard-owning column,
at any depth.

**Scope mirrors the panel's visibility exactly** (`resolvedCallChildren`'s
`hideOutOfScope`) at **every** granularity, `group` included — so there's no
fallback to "the child's first known call site anywhere in the block": a card the
panel doesn't show must never receive an arrow.

**Deliberately an imperative drawing layer**, not a reactive template (the
`updateHints`/`positionMenu` model): `callArrowPairs` (`home.mjs`) computes the
pairs in the **callback** of the existing `setRelated` watch (untracked — no new
reactive `b.code` reader, so no stuck-on-loading race) and pushes them via
`setCallArrows` to `callArrows.mjs`, which purely reads the DOM
(`getBoundingClientRect` on the `data-row` row in `paneHTML` resp. the
`data-child-id` card on `relatedCard` — two static attributes) and redraws one
**statically mounted** `position:fixed` `<svg data-testid=call-arrows>` (top-level
next to `MenuHost`, `z-[15]`: above `<main>`'s z-10, below the sidebar's z-20 and
the command menu; `pointer-events:none`). Path `data-testid=call-arrow`, stroke
`#6366f1` at 0.45 opacity + arrowhead marker. The svg is laid exactly over
`<main>`'s rect on each draw and clips itself, so arrows never draw over the
pr-index/PR-info/sidebar/footer.

Redraw triggers: rAF-coalesced on the watch itself, `resize`, capture `scroll`
(including inner scrollers), and a 250ms settle after every push (for the 200ms
width transitions).

**The `a` toggle needs an explicit resettle.** It touches none of the `setRelated`
watch's dependencies, so the watch doesn't fire and `setCallArrows` isn't called
again — while every card's width changes anyway, leaving the arrow drawn at the
pre-toggle coordinates. `toggleDiffView` (`home.mjs`) therefore calls
`resettleCallArrows()`: the same immediate + 250ms settle schedule, without
changing the pairs (only the geometry changed).

A call-site row scrolled out of the diff viewport loses its arrow (the same
visibility rule as `updateHints`); a child card scrolled out internally keeps an
arrow **clamped** to the panel edge. Test: `tests/call-arrows.spec.mjs` (fixture
PR 100, `arrow-*.json` + `materializeArrowWorktrees`).

## Scoping to the navigation cursor

`home.mjs` (`callScopeMethods`/`findCallSites`) links every resolved call to the
diff segment it sits on.

- **`gran==='call'`** — exactly the method of that one call (land on
  `->billingAddress` and you see `Order::billingAddress`); a segment without a
  resolved call gives an empty card.
- **`gran==='line'`** — only calls whose site falls within
  `[unit.start, unit.end]`.
- **`line`/`call` are a hard filter (hiding)** — you never see a call, listener,
  `covers`/`covered_by` child of a line you did *not* select
  (`relatedChildren`'s `scoped` flag).
- **List mode** (no diff) shows **all** resolved calls of the block.

### `gran==='group'` hides out-of-scope children too

Same hard filter as `line`/`call`, not merely a reorder below the in-scope ones.
This reverses an earlier deliberate choice ("a group spans multiple lines, so a
child shouldn't disappear") — reversed on explicit request, because it produced
exactly the confusing result of several cards next to a selected group, only some
of which belonged to it, with no visual distinction. Don't reintroduce.

Every relation/annotation carries an **absolute source line** recorded server-side
by the detector that found it (`relations.Relation.Line` resp.
`testcovers.Entry.Line`, see `.claude/docs/workflows-analysis.md`).
`groupLineRange(b, rows)` converts the selected group unit to that same absolute
range (reusing `unitLineRange`), and **`groupTierForLine(range, line)`** is the one
function every group-scoping decision goes through: it scores a child's recorded
line into a `groupTier` of `0` (kept) or `1` (out of scope, filtered out by
`relatedChildren`).

**The load-bearing rule behind it: hide only what can be PROVEN to sit outside the
selected group — missing scope information is never itself a reason to hide.**
`groupTierForLine` returns tier `0` whenever there is no active range at all (list
mode, or another granularity) **or** the child's own `line` is falsy (a relation
recorded before the field existed — `Line`'s own "0 = legacy row" convention — or
a fixture that never set one): "nothing to compare", not "line 0, presumably out
of range". Three exemptions follow:

1. **A block-level synthetic callKey**
   (`resource:`/`migration_model:`/`data_provider:`/`trait_usage:`, see
   `isBlockLevelCallKey`) has no site to compare — always kept, as at
   `line`/`call`. `trait_usage:` was added *because* of this change: `group` is the
   **default** granularity, so once it hard-filtered, `findCallSites` silently
   finding no site would have made a trait-usage child disappear almost always.
2. **A `covered_by` child** (`coveredByChildren`) never carries a site of its own —
   the annotation lives in the *test's* file, not the viewed block's. Explicitly
   kept **always** visible: a hard filter would hide "covered by TestX::testY"
   almost every time the reviewer is in diff mode. `coveredByChildren` no longer
   takes a `range` parameter; its `groupTier` is unconditionally `0`.
3. **A relation/`covers` child with no recorded `line`** — kept, never treated as
   "line 0 is out of range". This is also what keeps several existing Playwright
   fixtures correct.

**`translation:` children are NOT exempt** — that callKey couples to a real
string-literal site (the quoted key inside `trans()`/`__()`/`@lang()`), so it stays
hard-scoped to the line it's used on, like an ordinary method call.

Outside `gran==='group'`, `groupTierForLine`'s `!range` guard keeps every tier at
`0` — a no-op, so the ordering below is unchanged.

**Inline comment blocks are unaffected by all of this** —
`InlineComments`/`commentUnder` already hard-filter by aligned-row range at *every*
granularity, `group` included.

## Ordering within a tier

1. A call whose definition itself changes in this PR (a real child block) — `prio 0`.
2. A call on a recently changed line — `prio 1`.
3. The rest — `prio 2`.

**Within the same prio the largest child wins** (most non-empty lines, `codeSize`
over the child source — `childCode` for a call, loaded `code` for a listener), so
substantial changed code sits on top and trivial one-liners sink. Load-bearing
because relation accessors (e.g. a 3-line Eloquent `MorphOne`) are **also**
`added` PR blocks and thus `prio 0` — they'd otherwise land before a genuinely
changed method purely on source order. A child whose code hasn't arrived counts as
`size 0` and sinks until it loads; equal prio+size keeps source order (stable
sort). Block-level listener children drop out at `line`/`call`.

## Reactivity: the list is pushed, not computed in a binding

The child list is computed in a `watch` in `home.mjs` and pushed into the panel via
`setRelated` — the same decoupling as `setCommentScope`. **Load-bearing**: if the
render binding read the selected block's `b.code` (via `blockRows`), it would race
`home.mjs`'s diff render over that same `b.code` and the diff would stay stuck on
"loading".

**Equally load-bearing: the watch getter must enumerate the navigation state
_inline_** (`state.selected`, `mode`, `change`, `gran`, the block lists,
`callResolve`, `relations`, `curBlock().code`), computing the children only in the
_callback_ (`() => setRelated(relatedChildren(), unresolvedCalls())`). Compute them
in the getter and all reactive reads hide inside
`relatedChildren`/`unresolvedCalls`, whose early returns (empty block at load,
`resolved.length === 0`, scope shortcuts) let the crystallized run drop
`state.selected` from its dependency set — the watch stops re-subscribing and the
panel **freezes** on the block selected at load time. See the watch-deps rule in
`.claude/rules/arrowjs-pitfalls.md`.

## Automatic LLM search for unresolved calls

No button: `home.mjs` calls `startCallSearch(focusedBlock())` in the `setRelated`
watch as soon as the panel shows a block with `unresolved` calls
(`POST /api/workflows/resolve_call`, deduped per caller+callKey in
`searchRequested` so it fires once). It resolves the block's **entire** unresolved
set, not just the selected unit, so the reviewer never has to navigate anywhere.

While searching, the card shows a "searching…" pill
(`data-testid=related-searching`, also while `unresolved` is still queued) —
`position:absolute right-2 top-2 z-10` on the `<section>` itself, so it floats
above the scrollable list instead of taking flow space. **The scrollable wrapper
reserves top padding (`pt-9`) for exactly as long as that pill shows**
(`searching() || pending() > 0`, a reactive whole-value class binding): without it
the pill sat on top of the first card's right-aligned header badges
(`diffStatBadge`/`approvalBadge`). Deliberate trade-off: no permanent empty strip
once nothing is searching, at the cost of the list shifting a few pixels when a
search starts/finishes.

See "Resolving (also unchanged) called methods" in
`.claude/docs/workflows-analysis.md`.
