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
`Footer`/`ProgressBar`/`MenuHost`) is a small always-in-place button,
`data-testid=main-scroll-right-hint`, **fixed to the top-right corner of the
viewport** (`fixed top-6 right-6`) — deliberately not scrolling along with the
content, unlike `Block.mjs`'s `diffLeaveRail` it borrows its visual language
from (bordered rail, own icon): a rail that scrolled with the content could
only ever be reached by first scrolling to see it, which defeats the purpose.
Only visible while `state.mainOverflowRight` is true.

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
  `MainScrollRightHint`: in diff mode `<main>` starts at `left-0` and the
  pr-index is slid fully off-screen (see "`<main>`'s own offsets" below), so
  `top-6 left-6` lines up exactly with the right-hand hint's own corner. In
  list mode, though, that corner is where the pr-index (`<aside>`, `fixed
  left-6 top-6 bottom-6 w-[26rem]`, `BlockList.mjs`) itself sits whenever this
  button would show (`canStepMainLeft()` is only true there before the
  description opens, i.e. exactly while the pr-index is fully visible at
  `translate-x-0`) — so `canStepMainLeftPositionCls()` switches to
  `top-6 left-[28rem]`, just past the pr-index's own right edge, instead of
  overlapping its header/search row.
- Own glyph: a chevron docked against a vertical bar (same shape as
  `block-close-column`'s icon, mirrored), never colour alone, per the
  colorblind rule.

Test: `tests/main-scroll-left-hint.spec.mjs`.

## PR-info column (stop 1, hidden by default)

`data-testid=pr-info-column`, `w-[39rem]` (1.5× the original `26rem`, widened so
title/summary/description/Jira box truncate less quickly), rendered by
`prInfoCard(state)` inside its own `PrInfoPanel(state)` component (`home.mjs`).
It is the leftmost stop of the left→right nav chain (see
`.claude/docs/keyboard-navigation.md`) **and** visually the leftmost thing on
screen — as its own `position:fixed` panel, a sibling of `<aside>` (the
pr-index, `BlockList.mjs`) and `<main>`, mounted before both. Reason: `<aside>`
is itself `position:fixed` and sits outside `<main>`'s flex flow, so a
flex-child of `<main>` would render *after* it (that was the earlier, wrong
shape); the panel therefore takes over the pr-index's fixed `left-6` spot and
pushes the pr-index right.

`state.showDescription` (default `false`, ephemeral — outside the URL) decides
whether the column exists at all; closed it takes up **no space** (the whole
`${() => state.showDescription ? … : ''}` block drops away). Open (only in
`state.mode==='list'`) moves three things in lockstep off that one flag:

- `PrInfoPanel` appears at `left-6`.
- `<aside>` shifts `translate-x-[40.5rem]` (instead of `translate-x-0`, in
  `BlockList.mjs`'s class ternary — checked **before** the existing
  `mode==='diff'` branch, which wins: in diff mode the pr-index still slides
  fully away). 40.5rem = the column's 39rem plus the 1.5rem gap, so the two sit
  snugly together.
- `<main>` shifts the same 40.5rem (`left-[69.5rem]` instead of
  `left-[29rem]`, in the same ternary as its `mode==='diff' → left-6` branch),
  so the block column doesn't land under the shifted pr-index. Decoupled from
  `<aside>`'s transition but the same distance, so both animate in sync (200ms).

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
  `.claude/docs/workflows-trackers.md`.
- **Two stacked halves**: Haiku's short explanation (`sinceSummary`,
  `pr-info-since-summary`) above the deterministic commit/file list
  (`sinceFacts`, `pr-info-since-facts`), both through `renderMarkdown`. The AI
  half is best-effort and simply absent when the call failed; the facts always
  stand on their own.
- **Absent entirely** when `newSinceKind`/`sinceFacts` are empty — nothing new,
  or a PR this reviewer never reviewed. Explicit answer: no "je bent bij"
  placeholder, the same silence the overview keeps.

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

## `<main>`'s own offsets

In `'list'` mode `<main>` starts at `left-[29rem]` (next to the sidebar), in
`'diff'` mode at `left-0` (no sidebar to clear); in both cases the columns pack
from the left. `<main>`'s right edge is `right-0` in every mode, **deliberately
asymmetric** with every other panel (sidebar/footer/`PrInfoPanel` keep their
1.5rem edge): the far edge is exactly where a wide last column's content used to
get clipped before it was scrolled fully into view, so that margin was traded
for usable scroll width. The bottom offset tracks the footer's real height —
see `.claude/docs/footer.md`.

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
(`TasksPanel(state, openTask)`, `<section data-testid=workflows-panel>`, title
**"Taken"**) stacked directly **below** `prInfoCard` inside `PrInfoPanel`'s own
fixed column — only visible while `state.showDescription` is true. A plain
sibling in that column's `flex-col gap-3` container, so `prInfoCard`'s `flex-1`
shares the height with this `shrink-0 max-h-[16rem]` block.

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

**Click-only — no keyboard cursor.** Stop 1 suppresses `↑`/`↓`, so a Taken row
(`workflowRow`) has no focus ring of its own; only a click on a
`comment`-bearing row calls `openTask(run)` (`home.mjs`), which looks up the
block by `comment.file`+`comment.label`, steps the diff to the stored
granularity/row range (`unitsFor`+`unitAtRow`, the same walk as `setGran`), and
selects the comment via `selectComment(runId)` (exported from
`RelatedPanel.mjs`) once the comment-scope watch has caught up (a couple of
`await Promise.resolve()` ticks — see the watch-timing note in
`.claude/rules/arrowjs-pitfalls.md`). A run without a `comment` ref is purely
informational. `openTask` also searches every `test_class` row's `.methods` —
see `.claude/docs/test-class-grouping.md`.

Each row shows, below the label + status badge, a short **description**
(`data-testid=workflow-note`, gray, `line-clamp-2`, `workflowNote` in
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
