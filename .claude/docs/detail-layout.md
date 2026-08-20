# Detail layout: `<main>`'s column flow, the PR-info column, Tasks

The layout to the right of the sidebar: how `<main>` packs and scrolls its
columns, the leftmost PR-info column (stop 1 of the nav chain), the block
column's own width, and the "Taken" block.

## Split out of this file

- `.claude/docs/comments-panel.md` — PR-wide comments as navigable "Start"
  rows (comment-index items) + the inline comment blocks (threads, composer,
  drafts, focus tokens).
- `.claude/docs/test-class-grouping.md` — grouping TEST blocks per class
  (`test_class` rows + the methodes-kolom, stop 2b).
- `.claude/docs/drilling.md` — `state.drill`/`state.focusLevel`: a drilled
  Underlying-code column as a full diff, rails/`expandColumn`, the
  enter/return animations, the sibling look-ahead preview, card `.key()` rules.
- `.claude/docs/underlying-code.md` — the `RelatedPanel` "Underlying code"
  card: children, scoping/ordering, nested chips, call-arrow overlay, tests
  bar, column width.
- `.claude/docs/claude-chat-panel.md` — the embedded Claude conversation
  column (stop 5b): its state machine, the SSE-driven live progress, and the
  getter-based render contract of `src/ClaudeChat.mjs`.
- `.claude/docs/pending-push.md` — the push-todo row at the very bottom of the
  index (below both toggle rows) and the per-block "ongepusht" marking
- `.claude/docs/diff-card.md` — the `a`-toggle widths
  (`split`/`unified`/`fit`), `fitWidthCls`, "preview never wider than active",
  the preview-collapse mechanism.

## Columns instead of independently fixed panels

`PrInfoPanel`, `<aside>` (the pr-index, `BlockList.mjs`) and `<main>`
(`DetailPanel`) are real flex siblings of **one** row, `AppColumns(state)`
(`home.mjs`, `data-testid=app-columns`, `position:fixed inset` box — see
below for its exact edges) — in that DOM order, left to right. This replaced
an earlier shape where each of the three was its **own independent**
`position:fixed` panel, kept apart only by hand: `<aside>`/`<main>` each
carried a `left-[Nrem]`/`translate-x-[Nrem]` computed to happen to match its
neighbours' widths (`29rem`, `40.5rem`, `69.5rem`, `42rem`, …), and hiding
`<aside>` was a `translate-x` + `opacity` trick — which, being
`position:fixed`, **never actually gave its layout space back**; only
`<main>`'s own separately-computed offset kept content from landing on top of
it. A real, reported bug (a resolved comment's card rendering partly BEHIND
the still-open pr-index) was traced to exactly that: two independently
hand-synced numbers with no structural guarantee they'd ever agree, or a
frame where they briefly didn't. `AppColumns` removes the whole magic-number
system: every column is now a genuine flex item, so the browser computes
"next to, never under" automatically, and a hidden/collapsed column always
gives its own layout space back rather than merely being covered.

- `AppColumns` itself is `fixed left-6 right-0 top-6 z-10 flex items-stretch
  gap-6` plus a reactive `bottom` (see "`<main>`'s own offsets" below) — the
  bounding box every child stretches to fill vertically.
- `PrInfoPanel` (open) and `<aside>` are `shrink-0` with an explicit width
  (`w-[39rem]`/`w-[26rem]`); `<main>` is `flex-1 min-w-0` and takes whatever
  space its neighbours don't claim.
- **Collapse, don't cover:** `PrInfoPanel` fully unmounts when
  `state.showDescription || state.descriptionPinned` is false (see below);
  `<aside>` collapses
  to `w-0 opacity-0 pointer-events-none` (instead of the old
  `-translate-x-[28rem] opacity-0`) whenever it should get out of the way
  (diff mode **unless `state.keepIndexInDiff` says it still fits**, the
  methodes-kolom owning the keyboard **while still in list mode**, or an
  "algemene" PR-wide compose — see `BlockList.mjs`'s own class comment).
  `state.testColumnFocused` (stop 2b owning the keyboard, see
  `test-class-grouping.md`) only forces the collapse in list mode; once
  `state.mode === 'diff'` — including a test class's active method's diff —
  the collapse is decided purely by `keepIndexInDiff`, same as an ordinary
  block, so a mouse click into a test method's diff can keep the index open
  too. Both still
  animate over the existing 200ms (`transition-all duration-200 ease-out`,
  now animating `width` instead of `transform`), so opening/collapsing
  `<aside>` still slides visually — the difference is that the space is
  really reclaimed, not just painted over.
- Since `<main>` no longer needs to know anything about its neighbours'
  widths to position itself, its own class list is fully **static** (no
  `${() => …}` binding at all) — one less per-navigation-step attribute
  re-evaluation, in the same spirit as the "don't couple a whole closure to
  one small reactive read" rule in `.claude/rules/arrowjs-pitfalls.md`.

Test: `tests/main-columns-no-overlap.spec.mjs` (asserts `<aside>`'s right edge
never passes `<main>`'s left edge, in both the ordinary list-mode case and
with `PrInfoPanel` open).

## `<main>` as a horizontally scrolling column flow

`DetailPanel` (`home.mjs`) is a `<main>` **flex-row** that packs its columns
**from the left** (`justify-start`, no stretching) and scrolls horizontally
(`overflow-x-auto no-scrollbar`) once they're together wider than the screen —
the `no-scrollbar` utility (`index.html`) hides the scrollbar chrome, the
scrolling itself keeps working.

**The resting position is always flush-left:** `resetMainScroll()` (`home.mjs`,
next to `scrollFocusIntoView`) forces `<main>.scrollLeft = 0` on every
transition *to* the resting position — `enterDiff`/`openTask` (list → diff with
`focusLevel===0 && drill.length===0`), `applyNextUnapproved` for an empty
`path`, and the two `←` paths in `onKeydown` that pop fully out of a drilled
column back to `focusLevel===0` resp. leave the diff session
(`state.mode='list'`). This clears a stray manual trackpad/scrollbar scroll.
**It deliberately does not fight back while drilled:** as long as
`focusLevel > 0`, `scrollFocusIntoView`'s intentional scroll-to-the-right wins
(see "Unfocused columns collapse into a narrow rail" in
`.claude/docs/drilling.md`). Test: `tests/main-scroll-rest-left.spec.mjs`.

**`<main>`'s own `overflow-y` already resolves to `auto`** even though the class
list only sets `overflow-x-auto` — per the CSS rule that one non-`visible` axis
forces the other to compute as `auto` too (same rule as the TRANSLATION card's
scroll container, `.claude/docs/diff-render.md`). So a too-tall block column
scrolls/clips cleanly inside `<main>`'s box; nothing ever renders behind the
footer (`z-20`, above `<main>`'s `z-10`). "My diff doesn't fit" is therefore a
space-**allocation** question, not a clipping bug — see the preview-collapse
mechanism in `.claude/docs/diff-card.md`.

### A mouse way to reach content overflowing to the right

Reviewer request: with the scrollbar hidden (`no-scrollbar` above) and only
trackpad/scrollwheel to fall back on, there was no visible affordance at all
for "there's more to the right, click here to reach it" — in **either** mode
(list or diff), since `<main>`'s column flow is the same mechanism in both.
`MainScrollRightHint` (`home.mjs`, mounted once, top-level, next to
`Footer`/`ProgressBar`/`MenuHost`) is a small button,
`data-testid=main-scroll-right-hint`, **fixed to the top-right corner of the
viewport, flush against the true edge** (`fixed top-6 right-0`, not
`right-6`) — deliberately not scrolling along with the content, unlike
`Block.mjs`'s `diffLeaveRail` it borrows its visual language from (bordered
rail, own icon): a rail that scrolled with the content could only ever be
reached by first scrolling to see it, which defeats the purpose. Only
rendered while `state.mainOverflowRight` is true, and even then **hidden by
default** — `opacity-0 ... transition-opacity`, revealed by **either** of two
OR'd conditions on the rail's own class: the static `hover:opacity-100
focus-within:opacity-100` (the same CSS-only reveal `block-open-menu` uses,
see "Every menu also has a mouse entry point" in
`.claude/docs/mouse-navigation.md`), **or** the reactive
`state.mouseActiveHints` flag — true while the mouse has moved anywhere on the
page in the last 5s (a single `window` `mousemove` listener, `home.mjs`),
auto-hiding again after 5s of no movement. Reviewer request: the button used to
sit permanently on top of the diff card's/comment card's own header row
(`right-6` landed inside the card's own top-right corner), which read as the
icon "floating over the content"; the CSS-only `hover:` fix that followed then
made it undiscoverable the other way (the mouse had to land exactly on the
rail's tiny fixed-corner box) — `state.mouseActiveHints` widens that to "any
mouse movement", while the original `hover:` stays alongside it so resting the
cursor on the button to click it doesn't have it fade out mid-click after 5s.
Deliberately still not a reactive-state-gated *destination* (Rule 4, "hover
carries no state" in `.claude/docs/mouse-navigation.md`): no keyboard-only
functionality is gated behind either condition, and the click handler still
fires regardless of visibility (`dispatchEvent('click')` in tests, same
contract as `block-open-menu`).

**Detection is a 1px sentinel, not per-call-site bookkeeping.** `<main>`'s
template appends one near-zero-width `data-testid=main-overflow-sentinel` div
as its very last child (after `related-code`); `setupMainOverflowObserver()`
(`home.mjs`, called once right after `DetailPanel(state)(app)`) watches it with
an `IntersectionObserver` rooted at `<main>` itself — `state.mainOverflowRight
= !entry.isIntersecting`. This reacts to *any* change in `<main>`'s total
content width (a column appearing/disappearing, the description column
toggling, a drilled column opening/closing, a manual column-width resize, a
window resize) automatically, the same reasoning `tests/drill-left-hint-
visible.spec.mjs` already relies on for `drill-left-hint` — no watch/call-site
needs to remember to recompute it. The sentinel's own `-ml-4` cancels out the
`gap-4` `<main>` puts before it, so its right edge lines up with the real last
column's right edge instead of always reporting one gap's worth of phantom
overflow even once everything already fits.

**A click hides exactly the current left-most (at least partly visible)
column, one column per click** — `scrollMainRightOneColumn()` walks `<main>`'s
own direct children (whatever they are for the current mode — block-column,
a drilled column, `comments-and-related`, …), finds the first one whose right
edge still reaches past `<main>`'s own left edge, and adds exactly that
column's own width to `scrollLeft`. Reviewer's explicit "stap voor stap"
request — deliberately **no** "scroll all the way right" shortcut. This is a
**pure scroll-position change**: it never touches `state.drill`/
`state.focusLevel`/anything reactive, unlike `expandColumn` (which actively
discards drilled columns) — the two must not be confused. There is
deliberately no matching "scroll back left" button in this rail: native
scrolling and `MainScrollLeftHint`/`block-close-column` (below) already cover
going back. Test: `tests/main-scroll-right-hint.spec.mjs`.

### A mouse way to reach content hidden to the left

`MainScrollLeftHint` (`home.mjs`, mounted once, top-level, right next to
`MainScrollRightHint`) is the mirror of the button above, `data-testid=
main-scroll-left-hint`/`main-scroll-left-button` — but it is **not** a pure
scroll nudge like its right-hand twin: it steps the actual nav chain back one
stop at a time (diff → block list → PR description, i.e. stop 3 → stop 2 →
stop 1), the exact thing a single `←` already does at that stop
(`stepMainLeftOneColumn()`, calling `leaveDiffToList()` or
`enterDescriptionFromList()`). It replaces the old two-icon `diffLeaveRail`
(`block-leave-diff` + `block-open-description`, a mouse-only shortcut
jumping straight from the diff to stop 1 in one click) that used to render
glued to the top-level `Block()` card — reviewer request: "one button, one
column revealed per click", the same "stap voor stap" contract as the
right-hand hint, dropping the two-step shortcut in favour of a persistent,
always-reachable button.

- **Visibility:** `canStepMainLeft()` (`home.mjs`) — true while
  `state.mode==='diff' && state.focusLevel===0` (there's a diff to leave back
  to the list) or `state.mode==='list' && !state.showDescription` (there's a
  list to leave back to the description). **False** for a drilled column
  (`focusLevel>0` — that keeps its own `block-close-column` button in its own
  header, unaffected by this change, see `.claude/docs/mouse-navigation.md`)
  and once the description is already open (nothing further left to reveal).
- **Position is NOT a fixed corner in every mode**, unlike
  `MainScrollRightHint`: in diff mode the pr-index (`<aside>`) collapses to
  width 0 (a real flex sibling now, see "Columns instead of independently
  fixed panels" below — not the old translate-based hide), so `top-6 left-0`
  (flush against the true viewport edge, not `left-6`) lines up exactly with
  the right-hand hint's own corner. In list mode, though, that corner is where
  the pr-index (`w-[26rem]`, `BlockList.mjs`) itself sits whenever this button
  would show (`canStepMainLeft()` is only true there before the description
  opens, i.e. exactly while the pr-index is fully visible) — so
  `canStepMainLeftPositionCls()` switches to `top-6 left-[28rem]`, just past
  the pr-index's own right edge, instead of overlapping its header/search row.
- **Hidden by default, same as `MainScrollRightHint` above** — `opacity-0
  group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity`
  **OR** `state.mouseActiveHints` (any mouse movement anywhere on the page in
  the last 5s, auto-hiding after 5s idle — see `MainScrollRightHint`'s own
  entry above for the full mechanism and why `group-hover:` stays alongside
  it) on the visible icon box. Reviewer request: at `left-6` the button
  used to sit on top of the diff card's own header (overlapping the file
  name/badges); moving it flush to the edge and hiding it until hovered
  removes that permanent overlap.
- **The invisible hover-catching zone is wider than the visible icon in diff
  mode** (`canStepMainLeftZoneCls()`, `w-12` vs. the icon's own `w-9`/`h-9`
  box, a `group`/`group-hover` pair rather than a plain `hover:` on the icon
  itself). Found as a regression after the AppColumns merge
  (`.claude/docs/detail-layout.md`'s own "Columns instead of independently
  fixed panels" below): a flex `gap-6` still reserves its space between
  `<aside>` and `<main>` even while `<aside>` is collapsed to width 0, so in
  diff mode there is a real ~48px strip of blank page background between the
  true left edge (where the icon sits) and the diff card's own visible left
  edge. Before that merge the card sat flush against the same spot, so
  hovering the card's own corner doubled as reaching the (already invisible)
  hint; once the card moved right, that gap became a dead zone with no visual
  cue, and the hint was reported as "not showing even when I move the mouse
  around" (`git blame` reference for this fix: the commit right after
  `9ffd73b`, which introduced the plain `hover:`-on-icon version). List mode
  has no such gap (the pr-index already sits within ~8px of this hint), so it
  keeps a tight zone matching the icon's own size.
- **In diff mode that zone also spans the FULL height** of the row
  (`top-6 bottom-6` in `canStepMainLeftPositionCls()`, and the wrapper's own
  `h-9` dropped so the height comes from the position/zone class). Widening it
  sideways still wasn't enough to make the button discoverable — a 36px-tall
  catcher in one corner is not something a mouse crosses by accident, and it
  was reported again as "die knop bestaat al, maar is niet zichtbaar" once the
  PR-description column started disappearing on width grounds (see the fit rule
  below). The whole left gutter is blank page background in diff mode, so a
  full-height catcher swallows no click: the diff card's own left edge starts
  to the right of it. **List mode deliberately keeps its `h-9` box** — there
  the hint sits at `left-[28rem]`, already ~20px over `<main>`'s own first
  column, and a full-height strip there *would* swallow clicks and
  drag-selections along that card's left edge.
- Own glyph: a chevron docked against a vertical bar (same shape as
  `block-close-column`'s icon, mirrored), never colour alone, per the
  colorblind rule.

Test: `tests/main-scroll-left-hint.spec.mjs`.

### A mouse click into a diff only hides a left column that no longer fits

The keyboard's left→right chain hides as it goes: stepping right out of the
list collapses the pr-index (`<aside>` → width 0, `BlockList.mjs`) and stop 1's
PR-description column is closed long before that. A **mouse click** on a diff
row is not such a step — reviewer request: "als ik met mijn muis op een diff
klik, en in de breedte past alles, dan moeten we niets verbergen; past het niet,
verberg dan eerst het PR-omschrijvingsblok en daarna de PR-index." So a click
keeps whichever left columns still fit, and drops the **left-most one first**.

- **Two flags, both written only by `applyDiffColumnFit` (`home.mjs`):**
  `state.keepIndexInDiff` (the pr-index stays open despite diff mode — the one
  exception to `BlockList.mjs`'s collapse condition) and
  `state.descriptionPinned` (the PR-description column stays *visible*).
- **Applies identically to a test class's active method.** A click into a
  `test_class` row's active method's diff funnels through the exact same
  `ensureTopLevelDiffFocus`/`enterDiff`/`scheduleDiffColumnFit` path as an
  ordinary block (`i` is the `test_class` row's own top-level index — see
  `DetailPanel`'s `wasTestClass` branch in `home.mjs`), so `keepIndexInDiff`
  ends up computed the same way. `BlockList.mjs`'s collapse condition must
  therefore let `keepIndexInDiff` win over `state.testColumnFocused` once
  `state.mode === 'diff'` — `testColumnFocused` only forces the collapse
  while still in **list mode** (stop 2b owning the keyboard, unrelated to
  this feature). Missing that `state.mode !== 'diff'` guard was a real bug:
  since `testColumnFocused` survives the whole diff-mode transition (see
  `test-class-grouping.md`), it kept collapsing the index on every click into
  a test method's diff regardless of `keepIndexInDiff`/available width.
- **`descriptionPinned` is deliberately separate from `showDescription`.** That
  flag doubles as "stop 1 owns the keyboard" in a dozen `onKeydown` branches
  (Enter/Space/`/`/←/→), and `mode:'diff' + showDescription:true` is exactly the
  invalid combination that once left the keyboard stuck at stop 1 (see the
  `hadInitialSelParam` comment at the bottom of `home.mjs`). So
  `showDescription` keeps meaning *ownership*, unchanged, and `PrInfoPanel`
  renders on `showDescription || descriptionPinned` — *visibility*. `enterDiff`
  performs the swap (`showDescription = false`, `descriptionPinned = true`),
  which only ever happens from the mouse: the keyboard's own → at stop 1 just
  closes the description and never reaches `enterDiff`. That same → also clears
  `descriptionPinned`, so the keyboard can still close a column a click pinned.
- **The order is index-first, description-last.** `applyDiffColumnFit` decides
  the pr-index first (it survives longer) and gives the description whatever is
  left over — which is what makes the left-most column the first to go.
- **`mainContentWidthPx()` measures, but can't race the render it feeds.** It
  sums `<main>`'s own direct children (skipping the overflow sentinel and any
  zero-width child) plus their `gap-4`s — deliberately **not**
  `main.scrollWidth`, which for a `flex-1` `<main>` equals its stretched client
  width exactly when everything already fits, i.e. reports "needs the whole
  screen" in the one case this function exists to detect. Every child of
  `<main>` is `shrink-0` with its own computed width, so showing/hiding a column
  *outside* `<main>` never changes this number — unlike the character-count
  widths in `.claude/docs/diff-card.md`, this measurement is safe.
- **It only ever shrinks, except on the click itself.** `descriptionPinned` is
  raised by `enterDiff` and `keepIndexInDiff` only while actually in diff mode,
  so a resize or a drilled column can *take* a column away but never make one
  appear on its own. Re-checked from two places, both gated on something
  actually being kept: the `resize` listener, and `setupMainOverflowObserver`'s
  own callback (a column opening further right is exactly when a kept column
  stops fitting, and that observer already fires on any `<main>` content-width
  change). Can't oscillate — giving space back only ever reduces the overflow.
- **`scheduleDiffColumnFit()` runs it twice**: synchronously (so a click that
  keeps the index never shows one frame with it collapsed) and again after the
  next frame, when the mode switch has really rendered. It's called from
  `ensureTopLevelDiffFocus`, the single function every mouse path into a
  top-level diff funnels through — which is what keeps every keyboard
  `enterDiff` caller on the old behaviour.
- `canStepMainLeft()` treats a pinned description in list mode as "already
  open": nothing left to reveal, so `main-scroll-left-hint` stays hidden.

Test: `tests/diff-click-column-fit.spec.mjs` (a wide viewport keeps the index, a
narrow one still collapses it, the keyboard path is unchanged, shrinking the
window drops the description before the index, and a click into a test class's
active method's diff keeps the index open on a wide viewport too).

## PR-info column (stop 1, hidden by default)

`data-testid=pr-info-column`, `w-[39rem]` (1.5× the original `26rem`, widened so
title/summary/description/Jira box truncate less quickly), rendered by
`prInfoCard(state)` inside its own `PrInfoPanel(state)` component (`home.mjs`).
It is the leftmost stop of the left→right nav chain (see
`.claude/docs/keyboard-navigation.md`) **and** visually the leftmost thing on
screen — a flex sibling of `<aside>` (the pr-index, `BlockList.mjs`) and
`<main>` inside `AppColumns` (see "Columns instead of independently fixed
panels" above), mounted first in that row so it visually sits to the left of
both.

`state.showDescription` (default `false`, ephemeral — outside the URL) decides
whether the column exists at all; closed it takes up **no space** (the whole
`${() => state.showDescription || state.descriptionPinned ? … : ''}` block drops
away, wrapped in a stable `class="contents"` root per the
bare-toggling-expression rule in `.claude/rules/arrowjs-pitfalls.md`).
`descriptionPinned` is the one way the column is visible **without** owning the
keyboard — a mouse click into a diff that still had room for it, see "A mouse
click into a diff only hides a left column that no longer fits" above. Open
(with the keyboard, only in `state.mode==='list'`),
`<aside>` and `<main>` need no code of their own to react to it any more —
being real flex siblings AFTER this column in `AppColumns`, the row simply
pushes them right by this column's own width plus the row's `gap-6` (1.5rem)
as soon as it mounts, and back left the instant it unmounts.

Reached from the pr-index (stop 2) with `←`; `→` closes it. While open,
`onKeydown` ignores `↑`/`↓` (no internal cursor). Both this card and the
pr-index `<aside>` carry the same on/off indigo focus border as the block-diff
card — see "Focus highlight per stop" in
`.claude/docs/keyboard-navigation.md`.

Contents: a white card with title + Jira badge, a meta line (author,
`+add −del`, file count, branch, "on GitHub ›"), a **Summary** section (Claude
text), a **Description** section (PR body + optional Jira box), and review/CI
pills at the bottom (same shapes as `overview.mjs`'s dark-zinc pills but in the
light card theme: `bg-emerald-50`/`bg-rose-50`/`bg-amber-50`).

The card reads **exclusively** `state.prMeta`/`state.pr`/`state.prUrl`/
`state.jiraKey` — never `b.code` — so it never becomes a co-subscriber with the
diff render (the "stuck on loading" pitfall,
`.claude/rules/arrowjs-pitfalls.md`).

### "Sinds jouw laatste review" (the sky block under Doel)

`sinceReviewBlock(state)` (`home.mjs`, `data-testid=pr-info-since-review`)
renders directly BELOW the green "Doel" box: what landed on this PR after the
reviewer's OWN last review/comment. Reviewer request, with three parts that are
each load-bearing:

- **Its first line is the PR overview's line, verbatim** —
  `Bijgewerkt <relatief> · nieuw sinds jouw review` (or `… jouw comment`),
  `data-testid=pr-info-since-line`. Same wording as `newSinceMark`
  (`overview.mjs`), same `relativeTime`, and the same underlying moment:
  `myLastActivity` (`inbox.go`) → `prmeta` → `GET /api/pr`'s
  `newSinceKind`/`newSinceAt`/`ghUpdatedAt`. Explicitly NOT a second
  "since" of its own next to the overview's — see stage 3/4 of `pr_status` in
  `.claude/docs/workflows-trackers.md`. That moment also folds in the
  reviewer's own in-app "approved everything per line" moment
  (`combineSinceMoment`) — needed for this exact block to behave correctly on
  your own PR (PPTD-948, see "A third variant of the same Signal" in
  `.claude/docs/approval.md`).
- **Two stacked halves**: Haiku's short explanation (`sinceSummary`,
  `pr-info-since-summary`) above the deterministic commit/file list
  (`sinceFacts`, `pr-info-since-facts`), both through `renderMarkdown`. The AI
  half is best-effort and simply absent when the call failed; the facts always
  stand on their own.
- **Absent entirely** when `newSinceKind`/`sinceFacts` are empty — nothing new,
  or a PR this reviewer never reviewed. Explicit answer: no "je bent bij"
  placeholder, the same silence the overview keeps.
- **Its data is refreshed on every page load**, not once per tracker: the two
  Activities behind it only ran at the `pr_status` Execution's start, so the
  block used to sit empty for exactly the reviewer who came back to a PR that
  moved on (reported: the overview row said "nieuw sinds jouw review", this
  block showed nothing). `refreshSinceReview` (`home.mjs`) signals the tracker
  once per load and `prmeta.changed` pushes the result in — see "Stages 3+4 also
  re-run on demand" in `.claude/docs/workflows-trackers.md`.

Colourblind rule: the sky tint is decoration, the heading word plus the facts
carry the meaning. `relativeTime` moved out of `overview.mjs` into the shared
`src/relativeTime.mjs` for this (a pure util like `theme.mjs`), so both pages
render that line from one implementation.

### Description truncation (`state.descriptionExpanded`)

Ephemeral, outside the URL. A body longer than `DESC_TRUNCATE_AT` (280
characters) is truncated with a clickable fade affordance
(`data-testid=pr-info-body-toggle`, "more…") that expands it fully; once open it
becomes a plain "Collapse" link. `DESC_TRUNCATE_AT` only gates whether the
affordance **exists** — a short body always renders in full.

The collapsed **height** is deliberately **not** a fixed pixel cap (it was
`max-h-40`; that left a large unused gap on a typical short-title PR):
`pr-info-body` is a `flex flex-col` box that becomes `flex-1` exactly while
collapsing something, so it fills whatever room is left above the status pills.
`pr-info-body-wrap` mirrors that `flex-1`/natural-size split with a
`min-h-[4rem]` floor so an oversized Jira description below it (`shrink-0`,
unbounded) can't squeeze it away; its inner `.markdown-body` swaps
`h-full overflow-hidden` for no height constraint once expanded (the card itself
scrolls then). **No DOM measurement:** the character count remains the sole
deterministic decision for "does the affordance exist", the browser's flex
layout decides the height. Accepted edge case: a body just over 280 characters
that happens to fit the (roomier) collapsed height still shows "meer…" with
nothing to reveal — pre-existing, not worth real overflow detection.

The same flag is toggled by the PR menu item **"Show full description" /
"Collapse description"** (`PR_COMMANDS`, see
`.claude/docs/command-palette.md`), so click and menu stay in lockstep. The
class strings of the body/toggle (and of `pr-info-body`/`pr-info-body-wrap`) are
**whole-value** function bindings. Test: `tests/pr-description-expand.spec.mjs`
(also asserts the collapsed wrap's bounding-box height, guarding against a
revert to a fixed pixel cap).

### Progressive loading of `state.prMeta`

`state.prMeta` (empty object at start) is **wholesale reassigned** by
`pollPRMeta` (`home.mjs`) on every poll of `GET /api/pr?pr=N` (every 1.5s until
the statuses land, max 20 polls) — the `pr_status` workflow fills the `prmeta`
read model in **3 stages** (basics → Claude `summary` → review/checks
statuses), so each section appears as its stage completes (a "generating
summary…" pulsing skeleton pill until then). `loadPRMeta` fires
`POST /api/workflows/pr_status` **fire-and-forget** and immediately starts
polling; the endpoint itself returns as soon as stage 1 is recorded
(`ensurePRStatus` uses `StartWorkflowDeferLow`, see "Recovery priority" in
`.claude/docs/tembed-workflows.md`). All of this loads regardless of whether
the column is currently visible.

### No separate PR-wide-comments card

GitHub-imported issue/review(-summary) comments and unanchored `code_warning`
findings (`kind !== ''`) used to live in their own `PrWideComments` card under
`prInfoCard`, with its own cursor (`pw`/`handlePrWideKey`/`isPrWideFocused`).
All of that is **removed**; each such comment is now a synthetic
`state.blocks` item in the sidebar — see "Comment-index items" in
`.claude/docs/comments-panel.md`. `prInfoCard` is therefore the only card in
the column and simply takes its full height (`flex-1`, no ratio logic).

## The block column and its neighbour

**Block column** (`data-testid=block-column`, **`shrink-0`** — not `flex-1`, so
at its natural diff width instead of filling the remaining space): the card of
the selected block plus the look-ahead preview of the next block (dashed
connector when they come from the same file). Width is
`w-[70rem] 2xl:w-[82rem]` for a two-sided `modified` block; a **one-sided
added/removed** block shows only one pane (`singleSide` in `Block.mjs`) and gets
the same narrow 60% width `w-[42rem] 2xl:w-[49.2rem]` as the `a` toggle —
one-sided is always narrow regardless of `a`, since there's nothing to show next
to it. Full width mechanics (the `a` cycle, `fit`, narrow viewport) live in
`.claude/docs/diff-card.md`.

**Directly next to it** (not at the right screen edge) sits the **Underlying
code** card (`RelatedPanel.mjs`'s default export, `data-testid=related-code`,
`shrink-0`), stop 5/6 of the nav chain, inline in the same column flow. Its
width is reactive (`relatedColumnWidthCls`), floored at
`w-[42rem] 2xl:w-[49.2rem]` — the same as a one-sided/`a`-narrowed block, so it
matches the column next to it for short excerpts (it was
`w-[34rem] 2xl:w-[41rem]`, which read as two unequal columns) — and capped
**below** the block column at `w-[56rem] 2xl:w-[65rem]`, so one long line can't
grow it to half the screen. That symmetry is thus a default, not a guarantee.
See "Column width" in `.claude/docs/underlying-code.md`.

Both of those live in **one shared wrapper column**
(`data-testid=comments-and-related`, a `flex min-h-0 shrink-0 flex-col gap-3`),
but not as two plain stacked rows any more: the **first** row is itself a
`flex items-start` (`data-testid=comment-claude-row`) holding
`inline-comments`, the dashed comment↔Claude connector (below), and
`claude-chat-column` side by side; a full-width **code-preview row**
(`data-testid=code-preview-column`, `CodePreviewPanel`, only present when the
comment/Claude conversation contains at least one fenced code block — see "A
full-size code-preview column" in `.claude/docs/claude-chat-panel.md`) sits
directly below that; the Underlying-code card
(`related-code`) is the **last** row, stacked below both. See "The
embedded Claude chat column" below for the two narrower clamps
(`commentColumnWidthCls`/`claudeColumnWidthCls`) that make `inline-comments` +
the connector + `claude-chat-column` sum to exactly the same width as
`related-code`'s own `relatedColumnWidthCls()`, so the two rows still line up
— the code-preview row is not part of that symmetry, it simply takes the full
width of `comment-claude-row` above it.

Tasks is **no longer** in this column flow either: it sits under the PR-info
column (below).

### The embedded Claude chat column

**`data-testid=claude-chat-column`** (`ClaudeChatPanel`, exported from
`RelatedPanel.mjs`, rendering `src/ClaudeChat.mjs`'s `claudeChatColumn`) sits in
`comment-claude-row`, immediately to the right of `inline-comments` — **not** a
sibling column of `comments-and-related` any more (that was the case before the
comment/Claude blocks were resized to sit close together; a chat transcript is
still a different kind of content from a code excerpt, but the two are now
narrow enough, and close enough, to share a row instead of each claiming a full
`relatedColumnWidthCls()`-wide column of their own).

- **Width:** `shrink-0` plus the exported `claudeColumnWidthCls()` — **exactly
  half** of `relatedColumnWidthCls()`'s own clamp, `inline-comments` taking the
  other **half** minus the connector's own width via `commentColumnWidthCls()`
  (both in `RelatedPanel.mjs`, next to `relatedColumnWidthCls` itself). `clamp()`
  scales homogeneously, so this holds for every code-growth width, not just the
  floor/ceiling — see `relatedWidthCls`'s doc comment. It is deliberately *not*
  a fourth content-driven width computation of its own; the transcript wraps
  (`ClaudeChat.mjs`'s composer/send row also wraps rather than stretching the
  column at this narrower width).
- **One merged card, not two:** the comment block and this Claude block have
  no border/bg of their own any more — a single shared
  `rounded-xl border ... bg-white ...` sits on `comment-claude-row` itself
  (`home.mjs`), now a `flex flex-col` with up to three stacked pieces: (1) an
  optional full-width `composeTargetHint` header (`activeComposeTargetHint`,
  see "The shared `composeTargetHint` header" in `.claude/docs/comments-panel.md`),
  (2) the `flex items-stretch` row of the two columns (unchanged width logic,
  still `data-testid=comment-claude-columns`), so both columns always end up
  exactly the same height (a short comment thread stretches to match a longer
  Claude conversation and vice versa — this is also the "collapse together"
  effect: when there's little content on either side the whole merged card
  just stays small), and (3) an optional shared `CommentClaudeFooter` status
  line below both (see "The menu button (`reaction-status`) and the shared
  comment/Claude footer" in `.claude/docs/comments-panel.md`) — both (1) and
  (3) render nothing at all when there's nothing to show. The two halves are
  still functionally separate — the left (comment/thread) and right (Claude)
  each keep their own keyboard focus/cursor, and the Claude column keeps its
  own `p-3` (its cards' own borders provide the same inset on the comment
  side) — only their outer boxing is now one card, split by a vertical dashed
  divider (`comment-claude-connector`, `border-l border-dashed`,
  `self-stretch`) instead of the horizontal connector `nestedChipColumn` uses
  between Onderliggende-code children.
- **Visibility:** `claudeChatVisible()` = `hasVisibleComments() ||
  chatConversationExists() || cs.focus === 'claude' || cs.focus === 'new'` — a
  unit with neither a comment nor an earlier conversation has **no** chat
  column, except while a brand-new "Comment op deze regel" composer is open
  (`cs.focus === 'new'`): the column then shows optimistically, same as the
  composer's own not-yet-placed draft, and only becomes a real backing
  comment once the reviewer sends Claude a message or places the comment —
  see "Optimistically visible while composing a brand-new comment" in
  `.claude/docs/claude-chat-panel.md`. The dashed connector
  (`data-testid=comment-claude-connector`, the same style as
  `nestedChipColumn`'s own connector) shares that same visibility check, so it
  never floats with nothing to its right.
- Keyboard-wise it is stop **5b**, entered from the comment thread's `→` (or
  straight from the diff on a unit whose conversation's comment is no longer in
  the visible index) — on screen it now sits *above* Underlying code (same row
  as the comment block) rather than to its right. See
  `.claude/docs/keyboard-navigation.md` and, for everything the panel itself
  does, `.claude/docs/claude-chat-panel.md`.
- **The whole `comment-claude-row` card hides (CSS `hidden`, not unmounted)
  when there is nothing at all to show:** neither `claudeChatVisible()` (the
  comment/composer/Claude-chat columns all share that one condition) nor
  `hasCommentClaudeFooter()` (the shared footer's own independent condition,
  exported from `RelatedPanel.mjs` for exactly this). Before this, a line with
  no comments and no Claude chat still rendered the bordered card with
  zero-height content — a bare thin gray bar directly above Onderliggende
  code. **Deliberately `hidden`, not a conditionally-mounted subtree:**
  `InlineComments()` starts the comment poll (`syncComments`) as a plain call
  in its own function body, not behind a `watch` — unmounting the whole row
  until something is visible would stop that poll from ever running, a
  chicken-and-egg deadlock that never flips `claudeChatVisible()` to `true` in
  the first place. Test: `tests/inline-comments.spec.mjs` ("the
  comment-claude-row card is hidden while there is nothing to show...").
- **`comment-claude-row` deliberately carries NO `overflow-hidden`.** It did
  once (added together with the `hidden`-toggle above), and that combination
  broke a fresh, empty composer: `inline-comments` picked up
  `justify-end` (see "Bottom-align the inline comment column" above) so it
  can sit at the bottom of the taller Claude column, but a `justify-end` flex
  item with an indefinite (`auto`) height inside an `overflow-hidden`
  ancestor makes Chromium compute the auto-height of **every** intermediate
  `flex-col` ancestor up to and including that `overflow-hidden` box as `0`
  — not just its immediate parent. The composer/Claude content still
  rendered with the right text (verifiable via `innerHTML`), just clipped
  away above a collapsed 0px row, leaving only the (sibling,
  un-clipped) `composeTargetHint` bar visible — "commenting on a line only
  shows a bare bar at the top". Removing `overflow-hidden` here costs
  nothing visually: every nested card already carries its own
  border/rounding/padding that never touches this row's own edge. Regression
  test: `tests/inline-comments.spec.mjs` ("a fresh composer with no earlier
  comments/Claude chat still gets a visible, non-zero-height row").

### Entering the comment/Claude/Onderliggende-code panel scrolls it fully into view

Reviewer request ("als ik in comment/chat blok zit, dan wil ik dat volledig
zien, schuif linkerkant dan naar links op, als ik naar links ga, moet het weer
hersteld worden") — reported with a screenshot of a wide split-diff block
leaving the composer's send button, and the whole Claude-chat column beside
it, clipped off the right edge of the viewport: `relatedActive()` owning the
keyboard used to change nothing about `<main>`'s own `scrollLeft`, so a diff
wide enough to already fill the viewport left the panel to its right
partially or fully off-screen.

- **`scrollRelatedIntoView()`** (`home.mjs`, next to `scrollFocusIntoView`)
  targets `[data-testid="related-code"]` while `isCodeFocused()` (Onderliggende
  code, its own row below), otherwise `[data-testid="comment-claude-row"]` —
  the WHOLE merged card, not just the comment or Claude half on its own: the
  two columns sit side by side in one card (see "One merged card, not two"
  above), and while composing a brand-new comment (`cs.focus === 'new'`) the
  Claude column already shows optimistically right next to the composer —
  exactly the reported case. It scrolls with
  `{ inline: 'nearest', block: 'nearest' }` — `'nearest'`, not `'start'`/`'end'`,
  so it moves `<main>` only the minimum needed to make the whole target
  visible (nothing at all if it already fits on a wide monitor); `block:
  'nearest'` per the `scrollIntoView`-axis rule in
  `.claude/rules/arrowjs-pitfalls.md`, so it never also fights `<main>`'s own
  vertical scroll.
- **One watch covers every entry point.** `watch(() => relatedActive(), (active)
  => active ? scrollRelatedIntoView() : scrollFocusIntoView())` fires on the
  transition itself — keyboard `→` into the panel, clicking a comment icon,
  "Nieuwe comment" from the palette, a comment-index row's auto-drill, … — so
  no individual call site needed patching. The `false`-transition reuses the
  existing `scrollFocusIntoView()` (already called manually on the keyboard
  exit path in `onKeydown`'s `relatedActive()` branch — that manual call stays,
  now a harmless duplicate of the same rAF-scheduled scroll) to restore
  `<main>` to the focused diff column's own flush-left rest position — the
  "hersteld" half of the request.
- Reads `relatedActive()` — a single, unconditional read of RelatedPanel's own
  `cs.focus` — inside the watch getter, the same established pattern the
  `state.indexHandedOff` watch above already relies on (deps enumerated
  inline per the watch rule in `.claude/rules/arrowjs-pitfalls.md`).
- **Walking deeper inside an already-open panel does not re-scroll.** The
  watch only fires on the true/false transition of `relatedActive()` itself,
  not on every keystroke inside it — stepping through Onderliggende-code's own
  chip tree (`cs.focus` staying `'code'` throughout) keeps using
  `scrollIntoViewVertical`/`scrollChipIntoView`'s existing vertical-only
  scroll, unaffected. Test: `tests/scroll-focus-vertical-only.spec.mjs`'s own
  baseline is captured right after entering the panel for exactly this
  reason — that single entry scroll is expected, only a *further* scroll
  while descending chips would be a regression.
- **A late-arriving overflow gets re-measured via `state.codeVersion`.** The
  `relatedActive()` transition can fire before the selected block's own
  (lazily-loaded) diff has actually finished rendering — concretely, a fresh
  page load restoring `?rel.foc=new/comment/thread/claude/code` from the URL
  owns the keyboard before the block's code has loaded, so `<main>` may not
  overflow yet — or may only reach its FINAL width over several code-load
  steps — at the moment the watch first fires, and (being a one-time
  transition) never gets a second look on its own. The watch above therefore
  also lists `state.codeVersion` as a dependency (it bumps on every code
  load, see the doc comment on `state.codeVersion` itself) and re-runs
  `scrollRelatedIntoView()` on every bump while still active, so it keeps
  re-measuring against `<main>`'s real, settling width instead of trusting a
  possibly-too-early layout — the exact scenario the reported screenshot's
  URL (`?rel.foc=new` on first load) reproduces.
  `scrollRelatedIntoView` itself also retries a few frames if its target isn't
  mounted in the DOM at all yet (same pattern as `scrollChangeIntoView`'s own
  retry), and bails early if the reviewer already left the panel again before
  a retry/re-run happens.
- **`setupMainOverflowObserver`'s own `IntersectionObserver` (see "A mouse way
  to reach content overflowing to the right" above) also calls
  `scrollRelatedIntoView()`** whenever it re-fires with `relatedActive()`
  still true — a belt-and-braces second trigger for a content-width change
  NOT caused by a code load (a resize, a drilled column opening/closing, a
  manual column-width resize), which `codeVersion` alone wouldn't catch. Note
  its crossing-only semantics (it only fires when `<main>` crosses the
  fits/overflows threshold, not on every further width change while already
  overflowing) — `codeVersion` is the mechanism actually relied on for the
  "diff keeps growing after the panel is already focused" case above.

Test: `tests/related-scroll-into-view.spec.mjs`.

## `<main>`'s own offsets

`<main>` itself carries no positional classes at all any more (see "Columns
instead of independently fixed panels" above) — it's `flex-1 min-w-0` inside
`AppColumns`, so its left edge is wherever `PrInfoPanel`/`<aside>` (open or
collapsed) leave off, and it packs its own columns from the left the same way
regardless of mode. Its **right** edge is `AppColumns`' own `right-0`, which
still deliberately carries **no** 1.5rem margin — asymmetric with every other
panel (`PrInfoPanel`/`<aside>` sit inside the row's own `left-6`, the footer
keeps its 1.5rem edge too): the far edge is exactly where a wide last column's
content used to get clipped before it was scrolled fully into view, so that
margin was traded for usable scroll width.

The **bottom** offset — the one value that still has to react to state — lives
on `AppColumns` itself, not on `<main>` alone: `bottom-6` normally, or
`bottom-[${footerBoxPx(state) + PROGRESS_BAR_PX}px]` while the footer is
visible, tracking its real content-driven height (`.claude/docs/footer.md`).
Applying it to the whole row rather than just `<main>` is equivalent to the
old `<main>`-only reservation, because the footer only ever shows content in
diff mode — exactly when `PrInfoPanel`/`<aside>` are unmounted/collapsed
anyway, so they never actually need the extra room.

### Writing an "algemene" (PR-wide) comment clears the screen for it

While `isPrWideComposing()` (`cs.prWideCompose`, see "Placing a PR-wide comment
yourself" in `.claude/docs/comments-panel.md`) the composer is the only thing
worth looking at — it is about the PR, not about any code on screen — so:

- the **pr-index** slides away through the exact same branch
  `state.testColumnFocused` already uses (`BlockList.mjs`; the predicate is
  **passed in** as `BlockList(state, isPrWideComposing)` rather than imported,
  because `RelatedPanel` already imports `BlockList` and the two must not
  become circular for one boolean);
- the **block column** gets `hidden` (`display:none`, not an empty column — an
  empty flex child would still cost one of `<main>`'s `gap-4` gaps) and its
  binding returns `[]`; the **methodes-kolom** (stop 2b) likewise;
- the **Claude column** does not render — see `claudeColumnVisible()` below;
- `<main>` moves to `left-0`, or `left-[42rem]` when the PR-description column
  was open. That column deliberately **stays** (explicit decision: hide the
  index and the code blocks, not the description); `42rem` = the existing
  `69.5rem` minus the pr-index's own `27.5rem`.

`←` closes the composer (`exitRelated`, which clears the flag) and everything
comes straight back. The flag's only dependency-free consumer is that one class
binding, so it adds no per-navigation-step attribute mutation (see
`navigate.spec.mjs`'s flicker assertion).

**`claudeChatVisible()` vs `claudeColumnVisible()`** — these had to be split
for this. The first still answers "does the merged comment+Claude ROW show at
all" and gates that row's own `hidden` class; the second ("does the Claude HALF
render") is the one that goes false during a PR-wide compose. Collapsing them
into one predicate `display:none`d the whole row — including the very composer
being typed in, which then **silently could not take DOM focus at all**
(`focusEl` called `.focus()` on a `display:none` element and it stayed on
`<body>`). Test: `tests/prwide-comment.spec.mjs`.

## Tasks: a block under the PR-description column

Workflow runs of the current PR sit in a **`shrink-0`** block
(`TasksPanel(state, actions)`, `<section data-testid=workflows-panel>`, title
**"Taken"**) stacked directly **below** `prInfoCard` inside `PrInfoPanel`'s own
fixed column — only visible while `state.showDescription` is true. A plain
sibling in that column's `flex-col gap-3` container, so `prInfoCard`'s `flex-1`
shares the height with this `shrink-0` block. `actions` is
`{ openRowMenu, refresh }`, both optional (the direct-mount specs pass
nothing).

**It is ONE merged list, not two cards.** The failures for this PR live in the
same list — see "One block: runs, failures and skipped log lines" below.

**Filtered to what needs attention — no Active/Recent split.**
`visibleWorkflowRuns(state)` (exported from `RelatedPanel.mjs`) shows a run only
while genuinely **`running`**, or once it hasn't been updated in over **5
minutes** (`TASK_STALE_MS`) **AND** it isn't sitting in **`waiting`** —
`waiting` is excluded unconditionally, however stale: the long-lived per-PR
trackers (`build_relations`, `approve`, `pr_status`) and any other workflow
that simply idles on a Signal sit in `waiting` indefinitely without being
busy, so showing it here is never actionable, just noise. So a just-started
or just-finished run stays out of view for a few minutes and only resurfaces
once it's actively running or has been idle long enough to be worth a look
(and never while `waiting`). Running-first, then most-recently-updated. Test:
`tests/workflows-panel-notes.spec.mjs`.

**A cursor of its own, reachable by keyboard.** `↓` from the PR-description card
walks into this list and `↑` walks back out — the block is a cursor WITHIN stop 1
(`state.taskFocus`, the focused row's key; the focused row gets an indigo ring
and `data-task-focused=true`, and `prInfoCard`'s own ring drops while it is set).
The full rules, including `Enter`/`→`/`←` from a focused row, live in "Walking
into the Taken block" in `.claude/docs/keyboard-navigation.md`. Because the row's
`.key()` deliberately does NOT encode focus, the focus class is a **function**
binding comparing `row.key` against that reactive cursor — not part of the
statically interpolated class string, which a reused keyed node would never
re-run (see `.claude/rules/arrowjs-pitfalls.md`). A click on **any** row opens that
row's own menu (`openTaskRowMenu` → `openMenu('task')`, see below); the
`comment`-bearing rows keep their old behaviour as that menu's default item
"Open de comment" → `openTask(run)` (`home.mjs`), which looks up the
block by `comment.file`+`comment.label`, steps the diff to the stored
granularity/row range (`unitsFor`+`unitAtRow`, the same walk as `setGran`), and
selects the comment via `selectComment(runId)` (exported from
`RelatedPanel.mjs`) once the comment-scope watch has caught up (a couple of
`await Promise.resolve()` ticks — see the watch-timing note in
`.claude/rules/arrowjs-pitfalls.md`). A run without a `comment` ref is purely
informational. `openTask` also searches every `test_class` row's `.methods` —
see `.claude/docs/test-class-grouping.md`.

Each row shows, below the status word + label, a short **description**
(`data-testid=workflow-note`, gray, `truncate` — one line, see the fixed row
height below, `workflowNote` in
`RelatedPanel.mjs`): for a `task_code_comment` run the rich
`class::method · line N · "snippet"` from the run's `comment` ref
(`WorkflowRunView.comment`); for every other type a sentence explaining *why*
the run is in that status (`WORKFLOW_STATUS_NOTE`, a `${workflow}:${status}`
map) with the bare status as fallback. **The text must never suggest active work
while the badge says "waiting"** — `build_relations` runs its build Activity
once at start and then waits indefinitely for a `rebuild` Signal, so `waiting`
there means "already built, idle", never "busy"; `workflowNote` replaces the
generic text for that combination with `buildRelationsSummary` (read from
`state.relations`/`state.callResolve`/`state.testCovers`). Below that sits
`data-testid=workflow-updated` (`relTime(run.updatedAt)`).

The row key encodes **runId + status** so a status change forces a fresh node;
the empty state wraps in an array of one (`.key('no-workflows')`) — both per
`.claude/rules/arrowjs-pitfalls.md`.

The old dummy Tasks placeholder (`ui.task`,
`data-testid=task-list`/`chat`/`chat-bubble`/`new-task`) no longer exists — no
chat, no `ui.task`.

### One block: runs, failures and skipped log lines

A failed `task_code_comment` run scoped to this PR eventually surfaces via the
Taken block above once it's stale (5+ minutes, see `TASK_STALE_MS`), but a
**mirrored glue-log line** (a poller/startup error with no workflow run of its
own — e.g. "import comments: … exit status 1", see `run_errors.go`) never had
anywhere to show on `/pr/<id>` at all: only the `/pr-overview` "Mislukte taken"
drawer read `GET /api/problems` (see `.claude/docs/pr-overview.md`). That gap
was first closed by a SECOND card below Taken (`ProblemsPanel`, `home.mjs`,
`data-testid=page-problems`, reusing `problemRunRow`/`problemLogRow` from
`src/problems.mjs`). **That card is gone** — reviewer: *"dit bij elkaar doen"*:
two stacked cards said the same kind of thing about the same PR, so a reviewer
had to read two lists to know what background work was in trouble.

Everything now goes through **`buildTaskRows(state)`** (`RelatedPanel.mjs`,
exported), which returns one ordered list of plain, **non-reactive** row
descriptors:

- **Order is purely by recency** — every row's own `at` (a normalized ms
  timestamp: a failed run's/log line's own `updatedAt`/`at`, a live run's
  `updatedAt`), newest first, across **both** groups at once: problems
  (failed runs + skipped log lines) and the live/idle runs
  `visibleWorkflowRuns` already selected are sorted together as one list, not
  problems-first. An earlier version sorted problems-first regardless of age
  ("order is by actionability, not by time") — reported as confusing: three
  day-old failed rows sat above a run that had finished 5 minutes ago.
  `visibleWorkflowRuns`'s own running-first-then-recency sort still decides
  which live runs are even selected, but the final merge re-sorts everything
  by `at`, so that running-first exemption no longer survives past the merge.
- **A failed run comes ONLY from `state.pageProblems`**, never from
  `state.workflows` (`status !== 'failed'` filters those out, plus a runId
  guard). `/api/problems` drops a failure that a later attempt already
  superseded (`supersededRuns`, `run_errors.go`); reading both sources would
  resurrect exactly the failures that are no longer anything to act on.
- **A descriptor, not a raw run**, for two reasons: every slot in `taskRow`'s
  template is then an always-present **string** (no conditional template slot
  at all — see the statically-interpolated-template pitfall in
  `.claude/rules/arrowjs-pitfalls.md`), and the row menu in `home.mjs` gets
  exactly the fields it needs (`problem`/`kind`/`retryable`/`error`/`comment`/
  `runId`/`key`) to decide what it can offer.
- **`pollProblems()`** still polls the repo-wide `GET /api/problems` on its own
  slower cadence (`PROBLEMS_POLL_MS`, 15s — failures are rare, this is a "did
  anything go wrong" check, not a live status) and filters both
  `failedRuns`/`logErrors` client-side to `pr === state.pr`, since the endpoint
  itself has no `pr=` filter — into `state.pageProblems`.
- No PR chip anywhere: the page is already scoped to this PR, so
  `problemPrChip`'s "#<pr> · title" would only repeat what's on screen.
  `/pr-overview` keeps its own drawer and `src/problems.mjs` rows unchanged
  (`showPr: true`, see `tests/overview-problems.spec.mjs`); only `baseName` is
  still imported from that module here, so both pages name a file identically.

**The word carries the state, the rose tint is decoration** (colorblind rule):
a problem row leads with `⚠ mislukt` / `⚠ overgeslagen`
(`data-testid=workflow-status`, the same slot a live run's `draait`/`klaar`
badge uses), on a `bg-rose-50/60 dark:bg-rose-950/25` row.

### 3,5 rows visible, and a count of the rest

Reviewer: *"maximaal 3,5 laten zien (half omdat je dan het idee krijgt dat er
meer is)"*. The half row is the affordance, so it must genuinely read as half a
row:

- **Every row is exactly `h-[3.25rem]`** — a fixed height with ONE truncated
  note line, instead of the old free-flowing two/three-line row. `taskRow`'s
  literal class and `TASK_ROW_H_REM` are kept in sync **by hand**: a computed
  `h-[${…}rem]` would be a class name Tailwind's Play CDN only sees after the
  row is already in the DOM.
- **The list's `max-height` is `(TASK_FULL_ROWS + 0.5) * TASK_ROW_H_REM`**
  (`11.375rem`), set as an inline `style` since the value is computed;
  `overflow-auto` (`no-scrollbar`) so the mouse still reaches everything.
- **`data-testid=tasks-more`** — "nog N meer — scroll voor de rest" under the
  list whenever there are more rows than the 3 fully visible ones. It sits in
  the usual stable `contents` wrapper (the bare-toggling-expression rule).

### Refreshing and the per-row menu

- **`data-testid=tasks-refresh`** (the header's `⟳`, glyph-only with the wording
  in `title`/`aria-label`) runs `refreshTasks()` (`home.mjs`): `pollWorkflows()`
  **and** `pollProblems()` at once, with `setTasksRefreshBusy` driving the
  button's disabled/`…` look. Without it a retry's result could sit invisible
  for up to 15 seconds.
- **A click on any row** runs `openTaskRowMenu(row, e)` → `openMenu('task')` and
  also lands the keyboard cursor on that row (the "a click runs what a key runs"
  rule, `.claude/docs/mouse-navigation.md`) — but only while stop 1 really owns
  the keyboard, never while the column is merely pinned open beside a diff
  (`state.descriptionPinned`), where a ring would point at an absent cursor.
  The menu itself is the native/context-menu variant positioned at the mouse —
  or, for an `Enter` open, just under the focused row's own rect
  (`taskRowAnchor`): the row is the anchor either way. It calls `e.stopPropagation()` **before** opening —
  see the nested-`@click` rule in `.claude/rules/arrowjs-pitfalls.md`. The
  clicked descriptor is snapshotted into the plain module variable
  `focusedTaskRow`, so nothing reading global state reaches CommandMenu's
  never-disposed reactive tree (`resolveLabel`/`snapshotCommands`).
- **`taskCommandsFor()`** (`home.mjs`, registered as `rootCommandsFor`'s
  `'task'` mode) offers only what follows from the row: "Open de comment" for a
  `comment`-bearing run, **"Opnieuw proberen"** for a retryable failure,
  "Kopieer foutmelding" when there's a message, "Verberg deze melding" for a
  log line, and always the short **"Verversen"**. The two action words are
  deliberately asymmetric in length: "Opnieuw proberen" next to a second long
  item ("Taken verversen", as it first shipped) read as the same action twice.
- **Hiding a log line is client-side only** (`hideTaskLogLine`, `taskUi.hiddenLogs`
  in `RelatedPanel.mjs`, keyed on `at|message` so the next poll doesn't bring it
  back): `/api/problems`' buffer is an in-memory log mirror the server rebuilds
  on its own terms, so "verberg" means "stop showing it in this tab", which also
  keeps it outside the workflow write-boundary.

**A retry says so in the same tick** (reviewer: "graag even dat ik gelijk zie
dat het weer aan het draaien is"). The retry is a NEW Execution, so the failure
row only disappears once `/api/problems` has seen it superseded — up to a poll
away, during which the row would otherwise look untouched. `markTaskRetrying`
(`RelatedPanel.mjs`, `taskUi.retrying`) is therefore called BEFORE the request
goes out and flips that row to **"↻ opnieuw gestart"** / "opnieuw gestart —
bezig…" in amber (`data-status=retrying`, and the key flips too so the node is
rebuilt rather than patched). No cleanup is needed — the row dies with the
failure it belongs to; only a failed POST calls `clearTaskRetrying` so the row
honestly returns to "mislukt". While the mark is set the menu drops its retry
item, so one click can't queue two Executions.

**"Opnieuw proberen" = start the same Workflow Type over with the stored input.**
`POST /api/workflows/retry {runId}` → `handleRetryRun` (`tasks_api.go`) →
`TaskManager.RetryRun` (`run_errors.go`): read the failed run's own input, then
`engine.StartWorkflow(sameType, sameInput)`. A **start**, so it stays inside
`.claude/rules/workflows-write-boundary.md`; the failed run itself is
deliberately left alone — `supersededRuns` hides it as soon as a newer attempt
at the same identity exists, and `cleanup` collects it later.

Not every failure can be retried, and the menu says so instead of pretending:
`retryableWorkflow` (`run_errors.go`) excludes a **per-item deterministic Run
ID** (`perItemRunID` — a comment thread, a chat, an explain/resolve key: a
second start is idempotent and returns the very same failed run) and a
**retired Workflow Type** (`retiredWorkflowTypes`, whose registering code is
gone). `FailedRun.retryable` carries that to the UI, which then shows "Kan niet
opnieuw proberen — deze taak start alleen bij de bron".

Test: `tests/pr-page-problems.spec.mjs` (a failure scoped to the open PR shows
in the Taken list, one for a different PR is filtered out, no PR chip; the
row menu's retry/hide items; the "nog N meer" footer).
