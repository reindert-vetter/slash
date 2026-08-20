# Keyboard navigation (two modes)

The keyboard flow lives in `home.mjs` (`onKeydown`) and has two modes via
`state.mode`: `'list'` (choose a block in the sidebar) and `'diff'` (walk the
changes of a block).

## Split out of this file

- **`.claude/docs/command-palette.md`** — every menu: the `Enter` block
  palette, the `/` PR-wide menu, `withClose`/`defaultSel`, the postApprove
  follow-up + `findNextUnapproved`, the review-submit menus, the comment-scoped
  and compose menus.
- **`.claude/docs/footer.md`** — the footer: inline diff preview of the active
  unit, `footerBoxPx`/height reservation, the AI description.

## The left→right navigation chain (`←`/`→` through the whole layout)

`←`/`→` form one continuous chain of **stops**, left to right across the
layout. This is **on top of**, not instead of, the per-stop `↑`/`↓` navigation
(block selection in the index, change group in the diff, child in Underlying
code).

1. **Description** (`prInfoCard`/`state.showDescription`) — PR title/summary/
   description plus the **Taken** block stacked below it (see
   `.claude/docs/detail-layout.md`). **Hidden by default** (the column then
   takes up no width at all) and the leftmost stop — **except** on a
   genuinely fresh open (no `?sel=` at all: a bare `/pr/<id>` link, "Open
   review tree" from the PR overview without a remembered position, a just-
   generated PR), where `loadBlocks` sets it `true` so the reviewer's first
   view is the summary, not a block in the index (see `hadSelParam`/
   `hadInitialSelParam` in `home.mjs`, and `.claude/docs/pages-and-routing.md`).
   A restored `?sel=` (refresh, shared link, the `/pr-overview` round trip)
   always skips this and lands straight on the restored block, as before.
2. **PR block index** (`data-testid=pr-index`, the sidebar,
   `state.mode==='list'`) — shifts right as soon as stop 1 is open, so the
   description really sits to its left (see `.claude/docs/detail-layout.md`).
   - **Stop 2b — the methodes-kolom** (`data-testid=test-methods-column`,
     `state.testColumnFocused`): a **conditional** stop, only inserted when the
     selected row is a `test_class` row (see
     `.claude/docs/test-class-grouping.md`). Deliberately NOT renumbered into
     the chain, so every "stop 3" reference below stays valid. Details in that
     file; keyboard summary: `→` from stop 2 lands here first and slides the
     pr-index away, a **second** `→` steps into stop 3 of the ACTIVE method
     (`state.classMethodSel`, via `curBlock()`); the column is hidden in diff
     mode; `←` from stop 3 comes back here first, a second `←` leaves it;
     `↑`/`↓` walk the class's own methods and at the class edges exit to the
     index and step exactly ONE visible row further (clamped when there is
     none); `Enter` opens the ordinary block palette (not the diff — only `→`
     does that), since `curBlock()` already resolves to the active method;
     `f`/`d`/`s`/`a` are a no-op, same as stop 1.
3. **Block with diff** (`state.mode==='diff'`, `state.focusLevel===0`).
4. **Drilled columns** (`state.drill`/`focusLevel>0`) — a **side branch**, not a
   strict stop: reachable only via Enter/click on an Underlying-code child (see
   `.claude/docs/drilling.md`), never via `→`. `←` does peel them back one by
   one like any other stop.
5. **Inline comment block(s)** (`cs.focus` one of `'new'`/`'comment'`/
   `'thread'`) — **conditional**: only reachable when the selected unit actually
   has a comment (`hasVisibleComments()`, see
   `.claude/docs/comments-panel.md`); otherwise `→` skips straight past it.
   `'thread'` is **not** a horizontal `→` stop of its own: it's a **vertical**
   cursor within stop 5, reached only via `↑` from `'comment'` (walking that
   conversation's own bubbles, newest first) — exactly the `cs.claudePos`
   pattern stop 5b already uses. `→` on either `'comment'` or `'thread'` goes
   straight to stop 5b in one step (see below); `↑` past the oldest bubble
   moves to the previous conversation (or exits, on the first one), instead of
   clamping. **`→` also reaches stop 5b from the still-open `'new'` composer**
   (only once the caret has nowhere further right to go, same
   `editableCaretCanMoveRight()` guard as `'comment'`/`'thread'` — see above),
   even before anything is placed: `enterClaudeChatFromNew`
   (`.claude/docs/claude-chat-panel.md`), not `enterClaudeChat` — no anchor
   comment is required.
   - **Stop 5b — the embedded Claude chat** (`data-testid=claude-chat-column`,
     `cs.focus==='claude'`): reached with `→` from stop 5's `'comment'`,
     `'thread'` or `'new'` level — **also conditional**, on `claudeChatVisible()`,
     a **strict iff** with stop 5 itself: a comment must actually be visible
     (or the brand-new composer be open), never on its own (explicit request —
     a conversation whose comment fell out of the visible index is no longer
     independently reachable, see "Superseded" in
     `.claude/docs/claude-chat-panel.md`). Nothing auto-creates a comment to
     hang a conversation on, so a unit with neither has no chat column and `→`
     from the diff skips to stop 6 (`enterClaudeChat` is a no-op there). NOT
     renumbered into the chain, so every "stop 6" reference below stays valid.
     A dashed connector (`data-testid=comment-claude-connector`, same look as
     the Onderliggende-code chip connector) sits between stop 5 and 5b
     whenever 5b is visible. Details in `.claude/docs/claude-chat-panel.md`;
     keyboard summary: `↑`/`↓` walk the transcript on its own `cs.claudePos`
     cursor (exactly as `'thread'` walks reactions on `cs.threadPos` — 0 = the
     composer, 1..n = the n-th turn from the bottom, clamped at the oldest);
     `↓` at `claudePos === 0` first walks the chat's own **code blocks** —
     the code-preview cards stacked below the merged row, on their own
     `cs.previewPos` cursor (1..n counted from the TOP, `↑` walks back up into
     the composer; see "`↓` walks the chat's own code blocks" in
     `.claude/docs/claude-chat-panel.md`) — and only `↓` past the last card
     (or `↓` at rest when there are none) releases the panel focus entirely
     and jumps straight to the **next visible block's diff**, still skipping
     stop 6 (explicit request — landing in Underlying code read as an unwanted
     extra "menu" in the way of continuing the review; see
     `advanceToNextBlockFromClaudeChat`, `home.mjs`) — unchanged even when
     reached via the still-unplaced `'new'` composer, since its draft text lives in `composeDrafts`, untouched by
     leaving; `←`/`Escape` step back directly to `'comment'` (not to
     `'thread'`) — or, reached via the composer (no anchor comment exists yet,
     `cc.commentId == null`), back to the still-open `'new'` composer instead,
     draft intact; `→` does nothing (there is no stop past it). When the
     NEWEST turn is a still-open question with clickable options, this same
     `↑`/`↓` chain grows one extra rung between the composer and that turn —
     the question's own options, bottom to top — and `Enter` sends whichever
     one is highlighted; see "↑/↓ walks a still-open question's options
     before the transcript" in `.claude/docs/claude-chat-panel.md`.
6. **Underlying code** (`RelatedPanel`, `cs.focus==='code'`) — the last stop of
   the chain reachable via `→`: `→` there leaves the card nowhere to go. Note
   that "last" is about the `→` chain, not the screen — the stop-5b Claude
   column renders to the *right* of it (see `.claude/docs/detail-layout.md`).
   `↓` out of the chat (stop 5b) no longer reaches this stop at all — it jumps
   straight to the next block instead (see stop 5b above).

### Walking into the since-review blocks and the Taken block

The "Aanpassingen sinds jouw review" blocks inside the PR-description card and
the "Taken" block under it (see `.claude/docs/detail-layout.md`) **are**
reachable by keyboard — it used to be
click-only, and stop 1 swallowed `↑`/`↓` entirely. Reviewer: *"ik wil met mijn
down key naar beneden en daar kunnen navigeren, ik moet ook naar rechts kunnen,
naar de diff, en naar boven terug naar pr description."* It is a cursor WITHIN
stop 1, not a stop of its own in the `→` chain:

- **One flat cursor list** (`buildStopOneRows`), in on-screen order: the
  since-review blocks (keys `since:story`/`since:facts:N`,
  `sinceReviewSections`), then the **`Omschrijving`** block
  (`DESC_FOCUS_KEY = 'desc:body'`, only when the PR has a description), then the
  merged "Taken" rows. Reaching those in-card blocks by keyboard is the whole
  point — the card scrolls, and both the last since block and the description
  used to sit below its bottom edge with no way to get there (*"ik kan niet naar
  omschrijving"*). `Enter` on a focused, capped block opens it to its full text
  instead of opening a menu (`toggleSinceExpanded` /
  `toggleDescriptionExpanded`; a short, uncapped block falls through to the
  `'pr'` menu). Both kinds carry `data-stop-one-key`, so one selector scrolls
  whichever one took the cursor into view.
- **`state.taskFocus`** holds the focused row's **key**, or `''` when the
  description card itself has the cursor (which is also what makes
  `prInfoCard`'s own focus ring drop — exactly one of the two looks focused).
  A key, never an index: the merged list reorders under its own polls (see
  "Snapshot a selection by stable ID" in `.claude/rules/conventions.md`), so
  `stepTaskFocus(dir)` re-resolves the cursor against the CURRENT list on every
  step and a row that disappeared simply leaves index -1 (`↓` then starts at the
  top again).
- **`↓`** enters the list at the top (the first since block, or the first Taken
  row when there is nothing new since the review), then walks down and stops on
  the last row. **`↑`** walks up and, from the FIRST row, releases the cursor back to the
  description card instead of getting stuck. The focused row scrolls itself into
  the block's 3,5-row window via `scrollIntoViewVertical` — never bare
  `scrollIntoView`, see the axis rule in `.claude/rules/arrowjs-pitfalls.md`.
- **`→`** is unchanged and works from a focused row too: it leaves stop 1 for the
  block index (and one more `→` reaches the diff), clearing `taskFocus` on the
  way out. **`←`** also keeps its meaning — it exits the chain to `/pr-overview`,
  even from a focused row; `↑` is the way back to the description.
- **`Enter`** on a focused row opens **that row's** menu (`'task'`, anchored under
  the row) instead of the PR-wide `'pr'` menu — the keyboard twin of clicking it.
  Same shape as the push-todo row's own `Enter`.
- The cursor is cleared whenever stop 1 stops owning the keyboard: the
  `ArrowRight` branch does it directly, and a `watch` on `state.showDescription`
  covers every other route (a mouse click into a diff, `enterDiff`, an
  auto-selection) — otherwise returning to stop 1 later would land on a stale row.

`f`/`d`/`s`/`a`/Space are untouched here: stop 1 has no diff context, so they
stay the no-ops they already were. Test: `tests/taken-keyboard-nav.spec.mjs`.

Transitions, and how they differ from the older per-mechanism behaviour:

- **Stop 1 ↔ 2:** `←` in `'list'` mode (outside the search box) opens the
  description (`state.showDescription = true`); it used to open the search box
  (`activateSearch()`). `→` closes it again and hands the keyboard back to the
  index. While it is open `↑`/`↓` walk into the "Taken" block below the
  description card and back out again (see "Walking into the Taken block" above;
  they used to be plain no-ops, and still are when that list is empty — PR-wide
  comments live in the index itself, see below). **The search box is not its own stop** — it
  belongs to stop 2 and is no longer reachable via `←`; a mouse click (or
  native Tab) still gets you there and typing filters as always. If it already
  has focus (`state.searchActive`), `←` goes to stop 1 via `exitSearch()`
  instead of the old no-op.
- **Before stop 1 (the end of the chain):** `←` while `state.showDescription`
  navigates away to the PR inbox (`location.href = '/pr-overview'`). What
  travels along and comes back (`?pr=`/`?sel=`/drill) is described in
  `.claude/docs/pages-and-routing.md`.
- **Stop 2 ↔ 3 / 3 ↔ 4:** see the `'list'`/`'diff'` sections below resp.
  "Column navigation" in `.claude/docs/drilling.md`.
- **Stop 3/4 ↔ 5 ↔ 5b ↔ 6:** `→` from the diff lands on stop 5 (the first
  conversation) when the unit has one and it isn't already resolved
  (`enterCommentsOrRelated()`, RelatedPanel.mjs — an already-resolved first
  conversation instead skips straight to the next open one, or to stop 6,
  see "→ skips an already-resolved default comment" in
  `.claude/docs/comments-panel.md`), else straight on to **stop 5b**, the
  embedded Claude chat (`enterClaudeChat()`) — it no longer
  goes to stop 6 from here. `↓` on the last conversation (or at the bottom of an
  open thread) falls through to stop 6 instead of clamping; `↓` at the bottom
  of stop 5b is different — it does **not** fall through to stop 6 any more
  (explicit request), it releases the panel entirely and jumps to the next
  visible block's diff (see stop 5b's own entry above). `↑` on stop 6's first
  child steps back onto stop 5's last conversation if one exists, else straight
  to the diff — stop 5b is **not** on that way back, it is only ever entered by
  `→`/the diff-with-no-comment path. `↑` on a conversation first walks that
  conversation's OWN
  thread (newest bubble first, `'thread'`), and only once you're past the
  oldest message does it move to the previous conversation — or, on the first
  conversation, exit straight to the diff — the "+ Nieuwe comment" trigger row
  and its `cs.focus==='trigger'` stop were removed; starting a comment goes
  exclusively through the palette's "Comment op deze regel" (`startComment`).
  `←` on stop 6 always lands directly on the diff (stop 3/4), skipping stop 5
  even when a comment thread exists — deliberately asymmetric with `↑` just
  above, which still detours there from the first child. Full mechanism:
  `.claude/docs/comments-panel.md`.
- `state.showDescription` deliberately lives **outside** the URL — ephemeral
  cursor state, not a navigation position worth restoring.

### `Cmd+[` / `Cmd+]` (Mac) — `Ctrl+[` / `Ctrl+]` elsewhere — remap onto `←`/`→`

Reviewer request for a chord that works regardless of which stop/field
currently owns the keyboard. `onKeydown` (`home.mjs`) checks
`isModifiedKey(e) && !e.shiftKey && (e.key === '[' || e.key === ']')` **first,
before every other branch**, and recurses into itself with a minimal object
whose `key` is swapped to `'ArrowLeft'`/`'ArrowRight'` — so it is not a second,
parallel nav mechanism, it runs the exact same `←`/`→` logic described in this
whole section, stop for stop.

**`Shift+Cmd+[` / `Shift+Cmd+]` are deliberately excluded** (reviewer
follow-up request) and fall straight through this whole function untouched —
no `preventDefault`, no recursion — so the browser's own native
Shift+Cmd+[/] (tab-switching in Chrome/Safari on Mac) keeps working. Only the
**kale** `Cmd+[`/`Cmd+]` (no Shift) drives the custom nav now.

**One deliberate difference from a plain `←`/`→`:** inside a comment/reply/
Claude-chat text field, an ordinary `ArrowLeft`/`ArrowRight` defers to the
caret (`editableCaretCanMoveLeft`/`Right` in `relatedActive()`'s branch) —
`Cmd+[`/`Cmd+]` never does. Native browsers bind `Cmd+[`/`Cmd+]` to
history back/forward, never to caret movement, so there is no existing
in-field meaning to preserve; `isModifiedKey(e)` (still true on the recursed
object, since it carries the original `metaKey`/`ctrlKey`) short-circuits that
one exception, so the chord always drives the nav chain, even mid-text. The
recursed object additionally carries **`navRemap: true`**, which exempts it
from the in-field Cmd guard described right below — without that marker the
guard would return on the recursed call and `Cmd+[` would stop exiting a
composer mid-text. Test: `tests/cmd-bracket-nav.spec.mjs`.

### A Cmd/Ctrl chord inside a text field stays native

Reviewer report: "als ik in een textarea zit, dan kan ik niet cmd + left
drukken, dan moet het werken zoals normaal". A Cmd/Ctrl-modified key pressed
while DOM focus really sits in an `INPUT`/`TEXTAREA` is a **native caret /
selection / editing command** — `Cmd+←`/`→` (start/end of the line on Mac),
`Cmd+↑`/`↓`, their `Shift+` selecting variants, macOS's emacs-style
`Ctrl+←`/`→` — and the review tree must never bind over it. `onKeydown`
(`home.mjs`) therefore returns on `isNativeTextEditKey(e)`
(`isModifiedKey(e) && !e.navRemap && isEditableFocused()`) **immediately after
the `Cmd+[`/`Cmd+]` remap block and before every other branch**, so no
individual branch has to repeat the check.

**Why one early guard and not a per-branch exception:** the
`isEditableFocused()` fallback further down already lets any unclaimed key flow
into the field; only two branches sit in front of it and could swallow a
modified arrow as navigation — `relatedActive()`'s arrow branch (which
short-circuited its own `editableCaretCanMoveLeft`/`Right` caret exception on
`isModifiedKey(e)`, a condition written for the `Cmd+[`/`]` remap but which a
genuinely pressed `Cmd+←` also satisfied, so it exited the composer instead of
moving the caret) and `state.searchActive`'s unconditional `ArrowLeft`
(`exitSearch()`). The guard fixes both, plus the palette query input, in one
place. `relatedActive()`'s `!isModifiedKey(e)` is deliberately left as-is: with
this guard in front, the remap really is the only modified arrow that can still
reach it.

**Deliberately Cmd/Ctrl only, not a Shift-only chord.** `Shift+←`/`→` already
behaves natively via the caret exceptions, and `Shift+↑` on a textarea's first
visual line keeps its existing range-selection meaning (see "Shift+↑/↓
ranges"). Test: `tests/text-field-modifier-keys.spec.mjs`.

### Focus highlight per stop

**One single, app-wide border rule, no per-block exceptions:** every
block/card/row uses the same two states — `border-indigo-300
dark:border-indigo-500 ring-1 ring-indigo-200 dark:ring-indigo-500/30` while
selected/focused, `border-slate-300 dark:border-zinc-700` (plus `ring-1
ring-black/5` on an otherwise-idle card) otherwise. Never a bespoke gray or a
colour-only exception per component. This mirrors the `diffActive` pattern of
the block-diff card (`Block.mjs`) and applies to: `prInfoCard`
(`data-testid=pr-info-card`) while `state.showDescription`; the pr-index
(`data-testid=pr-index`) while `state.mode==='list' && !state.showDescription`;
the methodes-kolom (`TestMethodsColumn.mjs`) while `state.testColumnFocused`;
and the block-diff card (stop 3, and each drilled column at stop 4) while it
owns `focusLevel`. Both `prInfoCard` and the pr-index `<aside>` build it into
their existing top-level `class="${() => …}"` binding — not a keyed list item,
so no arrow.js keyed-node pitfall applies here.

Stop 5/6 (Underlying code) deliberately has **no outer** focus border of its
own, but every child card/chip/tests-bar inside it follows the same two-state
border (see `.claude/docs/underlying-code.md`).

The same `diffActive()` flag also dims the **active-row cursor bar** *inside*
the diff (the inset indigo bar on the row `state.change` points at) to grey —
one pixel thinner too — the moment the diff stops owning the keyboard, even
though the block stays selected and the cursor position doesn't move (e.g.
back in the block index, or inside a comment thread/Underlying code/the
Claude chat). See "The active-row cursor bar dims when the diff doesn't own
the keyboard" in `.claude/docs/diff-render.md`.

**The same rule applies to list rows** — the sidebar row (`BlockList.mjs`'s
`row`), the search box, `toggleRow`/`ignoreToggleRow`, and
`TestMethodsColumn.mjs`'s `methodRow`. A selected row keeps its existing
`bg-indigo-50 dark:bg-indigo-500/15` + `ring-1 ring-inset ring-indigo-200
dark:ring-indigo-500/30` tint as the **primary** signal (deliberately kept: a
large part of the Playwright suite asserts `bg-indigo-50` for "selected", and
rows sit flush with no gap, so a tint reads more reliably there than a border);
the border is added on top. Every row's border is always 1px in both states
(only the *colour* toggles), so selecting never shifts row height. Deliberate
side effect: the old light `border-slate-100` hairline between rows is now the
same `border-slate-300 dark:border-zinc-700` card-rest tint, so the list reads
more like a bordered table — a conscious trade-off, revertible locally (back to
`border-b border-slate-100 dark:border-zinc-800/60`) without touching the rest
of this rule.

**On a genuinely fresh open, NO ordinary block row reads as selected at all** —
the reviewer is looking at stop 1 (the PR summary), and `state.selected` only
holds its just-loaded default (or `applyDefaultUnapprovedSelection`'s
automatic pick, see point 1 above); neither is the reviewer's own choice, so
highlighting a row underneath the summary would read as "I already picked this
block" when nobody did. `state.blockIndexEntered` (`home.mjs`, ephemeral, not
in the URL) gates this: `false` until the reviewer actually crosses between
stop 1 and the block index for real (the `ArrowRight`/`ArrowLeft` branches
around `showDescription` in `onKeydown`, or a direct click on a row in
`BlockList.mjs`), then stays `true` for the rest of the session.
`rowFocused`'s own highlight condition short-circuits to "not focused" while
`state.showDescription && !state.blockIndexEntered`. The same load-time open
also skips the search box's usual auto-focus (see "The search box does NOT
grab keyboard focus on a genuinely fresh open" below) — together, stop 1 truly
owns the keyboard with nothing in the ordinary block list looking or acting
selected.

**`toggleRow` (the toggle-approved row) deliberately does NOT get the same
treatment**, even though `applyDefaultUnapprovedSelection` can land
`state.toggleFocused` there on a fresh, fully-approved-PR open: gating the
highlight the same way as `rowFocused` would hide a real, reachable selection
until the reviewer crosses into the index for real — worse than the rare
visual overlap that gating would have prevented. See
`tests/fresh-open-default-selection.spec.mjs`'s "everything approved" case and
`toggleRow`'s own comment in `BlockList.mjs`.

That test used to also double as the regression case for a real bug, now
fixed: `onKeydown`'s `state.showDescription` `ArrowRight`/`ArrowLeft` branch
(closing/exiting stop 1) sat AFTER two earlier guards that could each swallow
the key first — `if (state.blocks.length === 0) return` (a genuinely
block-less PR, see `emptyState` in `BlockList.mjs`) and the toggle-row guard
right below it (`(state.toggleFocused || state.ignoreToggleFocused ||
state.pushTodoFocused) && [...].includes(e.key)`, which also excludes
`ArrowRight`). A fresh, fully-approved-PR open lands `state.toggleFocused` AND
`state.showDescription` true at the same time
(`applyDefaultUnapprovedSelection`), so it was the **toggle-row guard** — not
the `state.blocks.length === 0` guard, which never actually fires there
(`state.blocks` keeps every block regardless of approval, only the display
loop in `BlockList.mjs`'s `renderList` hides fully-approved rows) — that
silently ate `ArrowRight` and left stop 1 permanently stuck open, with no way
to close it or exit to `/pr-overview`. (An earlier version of this note
mis-attributed the bug entirely to the `blocks.length === 0` guard; corrected
here.) The fix moved the whole `state.showDescription` branch to run
immediately after the `Enter`-opens-menu branch, before both guards — stop 1
now uniformly claims every key while open, regardless of block count or which
sidebar row/toggle happens to also carry `state.toggleFocused`-like state.

**A second, related bug survived that fix**, found later via manual testing on
a real, already fully-approved single-block PR: `applyDefaultUnapprovedSelection`
leaves `state.selected` pointing at the (now sidebar-hidden) fully-approved
block when it lands on the toggle row — so that block's diff still renders in
the list-mode preview panel on the right (`detail-card`). A mouse click
straight into one of its rows reaches `enterDiff()` via
`ensureTopLevelDiffFocus` (see "Mouse line selection" above), which — unlike
every KEYBOARD path — is never stopped by the trailing-row guard (that guard
only intercepts `ArrowRight`/`f`/`d`/`s`/`Space`/`Enter` typed while
`state.toggleFocused` is true; a click bypasses it entirely). `enterDiff()`
used to leave `state.toggleFocused` (and its `ignoreToggleFocused`/
`batchRowFocused`/`pushTodoFocused` siblings) untouched, so the stale flag rode
along into diff mode and silently hijacked the next `Enter`/`f`/`d`/`s`/`Space`
there (the SAME trailing-row guard, and the toggle-row `Enter` branches further
down in `onKeydown`, both still saw it as true) — symptom: `Enter` on a
selected diff row toggled "Show N approved blocks" instead of opening
`COMMANDS`. Fixed by clearing all four flags inside `enterDiff()` itself — the
one function every "enter diff" path (keyboard **and** mouse) funnels through
— rather than in the `state.showDescription` `ArrowRight` branch above:
clearing them there would incorrectly break the very "everything approved →
land on the toggle row" case this section opens with, since that transition
must leave `state.toggleFocused` set. Regression test: "a mouse click into the
still-visible preview diff clears the stale toggle-row focus" in
`tests/fresh-open-default-selection.spec.mjs`.

A genuinely block-less PR (`state.blocks.length` truly 0 — nothing ingested
yet, `emptyState` in `BlockList.mjs`) hit the OTHER guard the same way, and is
covered separately in `tests/ingest-btn-disabled.spec.mjs` (PR 900001, never
seeded by any fixture): `→` from stop 1 lands on the empty state's own "Ingest
#\<pr\>" button — the one actionable thing there — and `←` still exits to
`/pr-overview`, same as everywhere else. The `_fixtures.mjs` `goto()` wrapper's
own auto-skip-stop-1 `ArrowRight` (added so the rest of the suite doesn't have
to know about stop 1 at all) hit this exact bug too, silently, via its own
`.catch(() => {})` on the "detached" wait — which is also why the wider suite
never caught it before now.

### Comment-index items (PR-wide comments as ordinary "Start" rows)

PR-wide comments have no keyboard cursor of their own — a comment
(`kind !== ''`) is a synthetic, ordinary row in the block index (stop 2,
`kind:'comment'`). `↑`/`↓`/click select it exactly like a PR block
(`stepVisibleSelected`/`stepListSelection` are generic over it), and selection
alone reveals its thread in the block column — no hover, no separate cursor.
The row synthesis, approval mapping (`0/1`→`1/1`) and detail card live in
`.claude/docs/comments-panel.md`.

**`Enter` opens a small action menu; `→` instead steps into the item's own
thread** — deliberately NOT the same action (changed on request so `→` mirrors
`→` on an ordinary block: it steps you *into* something). The menu itself is
`prCommentCommandsFor` — see `.claude/docs/command-palette.md`.

This section covers the **unanchored** case (a genuine PR-wide/orphan
comment, nothing to drill into) — one `→` steps straight into its own thread,
as below. A comment-index item that DOES resolve to a real block instead
takes **two** `→` presses (first reveals the anchored diff's active-row
highlight, second steps into its comments) — see "Only one thing reads as
selected at a time" in `.claude/docs/comments-panel.md`.

`→` (`enterPrCommentThread`, `RelatedPanel.mjs`) reuses the same
`threadMessages`/`reactionBubble` rendering as the block-scoped thread, on its
own ephemeral, non-URL-bound cursor (`pct`, see
`.claude/docs/comments-panel.md`):

- `↑` walks up the messages and **clamps** at the oldest one.
- `↓` walks down and, once already at the newest, **falls through**: it leaves
  the thread and advances the sidebar cursor to the next comment/block
  (`stepListSelection(1)`) — mirroring the block-scoped panel's
  `advanceFromComment` "↓ loopt door" convention, except a comment-index item
  has no Underlying-code panel to fall into, so it falls through to the next
  index row.
- `←` steps back out to the index (the same row).
- `Enter` always opens the menu, whether or not the thread is focused.

## `'list'` mode

`↑`/`↓` choose a block in the sidebar, `→` steps into the diff of the selected
block — **even if that block has 0 change groups of its own** (a real PR block
whose body changes nothing and only exists as a parent of Underlying-code
children): `→` still enters `state.mode==='diff'` and shows the unhighlighted
block code, so a further `→` can continue into Underlying code, exactly like
`→` at stop 1 unconditionally steps to the block list. `enterDiff()`'s old
`groupsFor(b).length === 0` guard (a silent no-op) was removed, as was
`ensureCode`'s "diff without own groups → back to list" fallback — that
combination is a deliberately reachable state now, at any `focusLevel`. Tests:
`tests/enter-diff-zero-groups.spec.mjs`, `tests/drill-mode-flip.spec.mjs`.

### `→` lands on the first unit that still needs approval

Stepping in no longer always lands on the block's **first** change: `enterDiff`
resolves `state.change` through `firstUnapprovedChange(b)` —
`firstUnapprovedOwnUnit(b, 'group', -1)`, the exact same walk
`findNextUnapproved`'s step 1 uses — and only falls back to unit `0` when the
block is fully approved (or has no units at all). Reviewer request: "als ik naar
links ga (naar blokken index) en ik ga direct naar rechts, dan wil ik op de
regel belanden die nog niet approved is, anders wel gewoon de eerste". So
`←` then `→` resumes where the review actually stands, instead of re-offering
work that is already ticked off.

Two deliberate scope limits:

- **Only this `list → diff` step.** Drilling into an Onderliggende-code column
  (`drillIntoChild`) keeps starting at its own first unit, and every other
  landing (`applyNextUnapproved`, `openTask`, the `?chg=` URL restore) sets
  `state.change` explicitly and never comes through `enterDiff`.
- **`curBlock()`, not `state.blocks[state.selected]`** — for a `test_class` row
  the diff being entered is the ACTIVE method's, not the row's own.

A block whose code hasn't loaded yet can't answer "which unit is unapproved",
so `enterDiff` sets **`pendingFirstUnapproved`** and `ensureCode` applies the
landing once the rows are known — the exact mirror of the pre-existing
`pendingLast` (which defers "land on the LAST unit" for a step *up* into a
neighbouring block). Both flags are cleared by `stepBlock`/`stepTestMethodChange`,
whose own landing supersedes a still-pending one. Test:
`tests/enter-diff-first-unapproved.spec.mjs`.

Fully approved top-level blocks are **hidden** by default (a button at the
bottom expands them) and the "Start" heading shows a PR-wide approval counter —
see "Hiding approved blocks" and "Server-side `total`" in
`.claude/docs/approval.md`.

### Hidden (approved) blocks: skip, reveal, clamp

`state.selected` is a raw index in `state.blocks`, but `BlockList.mjs`'s
`renderList` renders no row for a hidden (approved) block, so the cursor can
land on an invisible index with no highlight anywhere. Three paths handle it,
all using the same `isFullyApproved` criterion as `renderList`:

- **`↑`/`↓` skip it** (`stepVisibleSelected`, used by both the normal and the
  search-box-active branch). No visible block left in that direction → the
  selection stays where it is rather than landing on the hidden tail.
- **Load/refresh-restore → pin, don't unfold everything.** A restored
  `?sel=file:line` may point at a hidden block — that is the reviewer's own
  position, so `revealSelectedIfHidden` sets `state.pinnedApprovedId` to that
  block's id + `scrollSelectedIntoView`, and `renderList` keeps exactly that ONE
  row visible (`i === state.selected && b.id === state.pinnedApprovedId`).
  `state.showApproved` is never touched. An earlier version flipped
  `state.showApproved = true`, unfolding the whole approved section; reverted on
  request — a restored link must not reveal unrelated approved blocks.
  Deliberately narrower than "the selected row is always shown": the **live**
  approve flow never sets `pinnedApprovedId`, so a block you fully approve while
  standing on it still hides immediately (there is no reveal/clamp attached to
  the `approvalSummaries` watch). Test:
  `tests/selected-reveal-hidden.spec.mjs`.
The search box matches a row's **label + category + file path**
(`searchHaystack`, `home.mjs`) — the path is what a reviewer remembers when the
method name escapes them ("ik wil ook op bestandsnaam kunnen zoeken"). A
`test_class` row has no file of its own worth matching, so it additionally
matches on any of its grouped **methods'** label/category/file; a comment item
has no `file` at all and keeps matching on its body snippet. Test:
`tests/block-search-file.spec.mjs`.

- **Search → clamp.** `setSearch` resets to index 0 — a synthetic landing, not
  the reviewer's own position, and typing must never reveal approved blocks
  PR-wide. `clampSelectedToVisible` moves the selection to the first visible
  match (none → it stays put). The filter itself needs no check: a filtered-out
  block is simply not in `state.blocks`.

Order is load-bearing on the load path: the reveal runs **after**
`applyBlockRefRestore` and after `loadBlocks` has awaited
`loadApprovals`/`loadBlockStats` plus a couple of microtask ticks so the
`approvalSummaries` watch has flushed — before that "hidden" isn't knowable yet
and the reveal would be a no-op.

### The sidebar's `↑`/`↓` cursor forms one circular loop

`stepListSelection`/`searchStepSelection` (`home.mjs`) wrap the bare
`stepVisibleSelected` call in both arrow branches:

```
first visible block → … → last visible block
  → toggle-approved (if any hidden approved blocks exist)
  → toggle-ignored  (if any hidden ignored comments exist)
  → batch-action    (if any comment-index row is eligible for comment_batch)
  → push-todo       (if this PR has landed-but-unpushed chat edits)
  → the search box
  → back to the first visible block
```

`↑` walks the same loop backwards. Each trailing row is only a stop when
actually rendered (`toggleRowVisible()`/`ignoreToggleRowVisible()`/
`batchRowVisible()`/`pushTodoRowVisible()`); the search box is
always the loop's other end. `stepListSelection(1)` first tries
`stepVisibleSelected` and only when that finds nothing further
(`next === state.selected`) steps onto the next existing stop —
`state.selected` stays unchanged while a toggle row owns the keyboard, so a
toggle row is an extra stop on top of the blocks, not a replacement.

`toggleRow`/`ignoreToggleRow` show the same indigo bg/ring as a selected row via
`state.toggleFocused`/`state.ignoreToggleFocused`; `rowFocused` dims the
underlying block's own ring while either flag is set, so there are never two
indigo highlights at once (except while the search box also holds real DOM
focus — a pre-existing, separate ring). On a toggle row, **`Enter`/`→`** flips
its own `state.showApproved`/`state.showIgnored` (mirroring a click) instead of
opening the menu resp. entering the diff, and **`f`/`d`/`s`/`a`** are no-ops
(no block/diff context). A click on a regular row, or typing in the search box,
always resets both toggle flags.

**The batch action row** (`state.batchRowFocused`, between `toggle-ignored` and
`push-todo` because that is also its render position, see
`.claude/docs/comments-panel.md`'s "The comment_batch checkboxes and the
bottom action row") acts DIRECTLY on `Enter`/`→`/click, like a toggle row and
UNLIKE the push-todo row right below it — it starts the `comment_batch` run
over whatever is currently checked (`startBatchFromRow`), no confirm step,
because the checkboxes on the rows above already are the deliberate curation
step. `f`/`d`/`s`/`a`/`Space` are no-ops there, same reasoning as a toggle
row.

**The push-todo row** (`state.pushTodoFocused`, the bottom-most stop — see
`.claude/docs/pending-push.md`) mirrors the toggle rows with one deliberate
difference: its `Enter`/`→`/click does not act directly, because pushing writes
to a branch other people work on. It opens a one-more-step confirm menu
(`openMenu('pushTodo')`), the same two-step shape "Keur de HELE PR goed" uses
(and "Wis Claude-gesprek" only while its shadow worktree has pending work).
`f`/`d`/`s`/`a`/`Space` are no-ops there for the same reason as on a toggle
row.

**The search box** is reached via `activateSearch()` (real DOM focus, so its
focus ring lights up) and marks the arrival as deliberate via
`state.searchLoopFocused` — a **separate** flag from `state.searchActive`,
because the box also ends up focused for two reasons that are *not* a loop
arrival: the load-time convenience focus (`focusSearchBox`, so a filter can be
typed right away — the "auto-focused search box" specs press `Escape` past) and
a plain click. Only while `searchLoopFocused` does `searchStepSelection` leave
the box on the next `↑`/`↓` (`↓` → first visible block; `↑` → `toggle-ignored`,
else `toggle-approved`, else the last visible block); otherwise `↑`/`↓` keep the
existing "browse the filtered matches while focus stays in the box" behaviour
with its own wrap, and reach only `toggle-approved`, never `toggle-ignored`.
Typing (`setSearch`), `→`/`Enter` (into the diff) and `Escape` (back to the
list) all clear the flag via `exitSearch`, however the box got focus.

**The search box does NOT grab keyboard focus on a genuinely fresh open.** The
load-time `if (state.mode === 'list') requestAnimationFrame(focusSearchBox)`
call at the bottom of `home.mjs` is additionally gated on `hadInitialSelParam`
(`… && hadInitialSelParam`): on a bare `/pr/<id>` link etc. (no `?sel=` at
all — the same condition point 1 above uses to force `state.showDescription`),
the reviewer is looking at stop 1, so nothing in the block index — neither a
row highlight (`state.blockIndexEntered`, above) nor real DOM/`searchActive`
focus — should look or act selected underneath it. A restored `?sel=` keeps
the existing convenience unchanged (search box focused immediately, as
before).

## `'diff'` mode

`↑`/`↓` walk the **changes** of the block, `←` steps back to the list. Walking
past the **last** (`↓`) or **first** (`↑`) change steps on to the next resp.
previous block **provided it comes from the same file** (the blocks joined by
the dotted connector); at a file boundary navigation stops. Stepping across
lands on the first resp. last change (`stepBlock`, file check via
`sameFileNeighbour(delta)`), so you can walk a whole file's diffs without
returning to the list. If the neighbour's code is still loading, `pendingLast`
remembers that you want the last change and `ensureCode` resolves it once the
rows are known.

### The block description is an extra ↑ stop above the first change

The card's description strip (`Block.mjs`'s `block-description`, a PHPDoc/AI
description above the diff) is **capped at 2 visual lines** (`line-clamp-2`, so
also after wrapping — a long docblock used to push the diff itself off screen)
and is its own cursor **within stop 3**, not a stop in the `←`/`→` chain.
Reviewer request: *"omschrijving boven blok moet maximaal uit 2 regels zijn (ook
na wrapped). het moet niet gelijk geselecteerd zijn als ik een blok open, maar
ik moet naar boven kunnen en dat moet dan een extra stap zijn ... dan wil ik het
kunnen uitklappen, dan wil ik ook weer naar beneden kunnen."*

- **Not selected on arrival:** `enterDiff` clears it, so stepping into a block
  lands on a change unit exactly as before.
- **`↑` off the first unit** (`state.change === 0`) lands on the strip when the
  block has a description — **one extra step** in the same walk. A second `↑`
  then continues into the previous same-file block (or clamps at a file
  boundary) exactly as it always did, so the strip is never a dead end.
- **`↓`** goes back down onto the block's first change.
- **`Enter`** toggles the 2-line cap open/closed (`toggleBlockDescExpanded`)
  instead of opening the block palette — same shape as `Enter` on stop 1's
  since-review/Omschrijving blocks, and there is no unit context to build a
  palette for while the strip owns the cursor. A description short enough to fit
  in full has nothing to open (`blockDescCollapsible`, a character count exactly
  like `descCollapsible`'s, so the "meer… (Enter)" hint and `Enter` can never
  disagree) and `Enter` is a no-op there.
- **`←`/`→`** release the strip and then do what they do from the diff itself
  (back to the list resp. on to the comments/Underlying code).
- **`f`/`d`/`s`/`a`/Space are no-ops** while the strip owns the cursor, same
  reasoning as stop 1 and the methodes-kolom: no unit to zoom or approve.
- **A click on the strip** does both halves of that `Enter`: it focuses the
  strip AND toggles the cap (`toggleBlockDescExpanded({focus:true})`), the same
  key/mouse pairing `toggleSinceExpanded` has at stop 1.
- **State:** `state.descFocusId` (the block **id** whose strip has the cursor)
  and `state.descExpanded` (ids opened out) — both ephemeral, deliberately NOT
  in the URL (a cursor/disclosure position, like `descriptionExpanded`), and
  both keyed by id rather than index per "Snapshot a selection by stable ID" in
  `.claude/rules/conventions.md`. `Block.mjs`'s two strip bindings read **only**
  these two, never `state.selected`/`change`: a binding that depended on the
  diff cursor would re-set the strip's `class` on every ordinary step, which
  `tests/navigate.spec.mjs` asserts never happens. The focus is released
  explicitly by every path that moves the cursor by itself
  (`clearBlockDescFocus` in `stepBlock`/`nextChange`/`prevChange`/`enterDiff`/
  `leaveDiffToList`/`selectRow`/`ensureTopLevelDiffFocus`) rather than by a
  `watch` — a `watch` on `state.selected` also fires on a same-value reassign
  from the 5s comment poll and would close what the reviewer just opened (see
  that pitfall in `.claude/rules/arrowjs-pitfalls.md`).
- **Deliberate scope limit:** top level only (`focusLevel === 0`). A drilled
  Onderliggende-code column keeps its own `{change, gran}` cursor and has no
  description stop.

Test: `tests/block-description-stop.spec.mjs`.

**Two different chevrons, deliberately distinct:**

- **Grey, _outside_ the block card** (`stepChevron`/`canStep(delta)`,
  `home.mjs`, rendered in the block column): shown on the last (resp. first)
  change when a same-file neighbour exists — "the arrow will take you to the
  next block". Hidden at a file boundary. The **up** chevron additionally waits
  for the description stop above (see the section right above): while the strip
  is still the next thing `↑` reaches it would promise the wrong destination, so
  it only appears once the strip itself has the cursor. Its toggling slot
  (`stepChevronSlot`) must keep its **stable element root** (a static
  `display:contents` wrapper) — a bare keyed `${…}` wrapper made the chunk
  `ref` go stale and corrupted the block column's keyed reconcile; see the
  "bare toggling expression" pitfall in `.claude/rules/arrowjs-pitfalls.md`.
- **Green, _inside_ the card** (`scrollHint`/`updateHints`, `Block.mjs`):
  "there are changes off-screen — keep scrolling within THIS block". Also used
  verbatim by a TRANSLATION block's per-key overview (see
  `.claude/docs/diff-render.md` for the `data-scrollsync`/`data-changed`/
  `data-change-active` wiring). Up vs. down is carried by the chevron's own
  shape, not colour, so it already works for a colourblind reviewer.

When stepping in (`→`), selection jumps to the **first changed line** (added,
removed or modified); `state.change` is the index. Navigation units come from
`changeGroups(rows)` (`Block.mjs`): consecutive changed rows count as **one**
group, but a run longer than 5 rows is cut into chunks of 5 (`MAX_GROUP`). The
cut only happens on a row containing a **letter** — a bracket/punctuation-only
changed row is pulled into the current group (`hasLetter`), so a group never
ends right before or on a bare-bracket line — and never on a **pure deletion**
(`isPureDeletionRow`: the other pane stays empty), so a removed run of any
length is ONE group the reviewer can approve in a single action instead of a
chain of 5-row chunks (reviewer request; there is nothing to read in chunks
there, the code is gone). An unchanged row still breaks the run, so a deletion
group never swallows the code around it. `blockRows(b)` produces exactly the
same aligned rows as the render, so navigation and highlight never diverge.

The selected block gets the active group as a reactive `activeGroup` function
(reads `state.mode`/`selected`/`change`), so the pane re-highlights without
re-rendering the whole `DetailPanel`. Active rows get a stronger tint + an inset
left bar (`shadow-[inset_3px_0_0_…]`, no layout shift) and the first row a
`data-change-active` anchor, which `home.mjs` scrolls with
`scrollIntoView({block:'center'})`.

## `→` into the Underlying-code card

In `'diff'` mode the Underlying-code card (`enterRelated` in
`RelatedPanel.mjs`, `cs.focus === 'code'`) is reached by `↓` falling through the
end of the last inline comment conversation, or by a bare `→` from the diff
when the unit has no comments/conversation at all (see the chain above) —
**not** by `↓` from the embedded Claude chat (stop 5b) any more, which instead
jumps straight to the next visible block's diff (explicit request, see
`.claude/docs/claude-chat-panel.md`). Landing here selects the **first** child
(`cs.codeSel = 0`). The card is a pure list:
`↓`/`↑` move through the children (clamping at the last), and from the first
child `↑`/`←` step back onto the last conversation of the unit if one exists
(`enterCommentsTail()`), else to the diff (`exitRelated`). There is no `→` that
leaves the card. The selected child gets an indigo ring (`data-active=true`).
The card itself: `.claude/docs/underlying-code.md`.

The panel cursor (`cs.focus`/`codeSel`/`sel`/`threadPos`/`claudePos`) lives in
the **URL** under its own `rel` namespace
(`rel.foc`/`rel.code`/`rel.csel`/`rel.thr`/`rel.cpos`), so a refresh returns to
the same child/thread/chat turn; `applyRelRestore` reapplies it once, clamped,
after the children/comments load. A restored `rel.foc=claude` deliberately waits
for the comments (or, for a conversation whose comment isn't in the visible
index, for `cc.conversations`) exactly like `'comment'`/`'thread'` wait for
theirs, and only ever restores onto an EXISTING comment — restoring a position
must not itself write. See skill `url-state`.

**`Enter`/`Space`** on the card (or a **mouse click** on `data-testid=related-item`)
**drills** the focused child (`focusedRelatedChild()` → `drillIntoChild`): it
opens as its own diff column, and the Underlying-code panel + inline comment
blocks jump along to that level (`focusedBlock()`). With no child focused
`Enter` does nothing — unresolved calls are picked up by the LLM search
automatically, no key or button (`startCallSearch` + the `setRelated` watch).

Right after drilling the keyboard sits on the **diff** of the new column, not
its panel (`drillIntoChild` calls `leaveRelated()`); `↑`/`↓` then walk that
column's change groups and `←` closes it, handing focus back to the parent
column's diff (the closed child reappears in that parent's Underlying-code
list). Repeated `←` peels back level by level to the top-level block, where a
further `←` exits the diff session and clears the drill state. An unfocused
column collapses to a narrow rail; clicking a rail is a shortcut for repeated
`←` (`expandColumn`) and discards anything drilled deeper. Full `state.focusLevel`
mechanism: `.claude/docs/drilling.md`.

`←`/`Escape` from the panel's first position (`cs.codeSel === 0`) steps back
onto the last conversation of the unit if one exists, else gives focus back to
the diff of **that same** column (`handleRelatedKey`) — this is no longer a
separate "pop" step; the column-by-column navigation only follows once
`relatedActive()` is `false` again.

## Selection granularity (`f` zoom in / `s` zoom out / `d` back)

Within a block you zoom with **`f`** (in) and **`s`** (out) through three levels
(`GRANS`, `home.mjs`); **`d`** is "back" and acts as previous-call at the finest
level. All three step aside for a held Cmd/Ctrl (`isModifiedKey(e)`, see the `a`
section) so `Cmd+F`/`Cmd+D`/`Cmd+S` still reach the browser.

- **`'group'`** (the starting point when stepping in): a whole run of changed
  lines (`changeGroups`).
- **`'line'`**: one changed line at a time (`changeLines`).
- **`'call'`**: one **call segment within** that line (`changeCalls`). Unlike
  the coarser levels this splits on **structure**, not on what changed, so a
  segment can later carry a call-graph edge. `segmentCalls` splits on `->`,
  `.`, `;` and the binary separators `??`, `&&`, `||` and the comparison
  operators (`==`/`===`/`!=`/`!==`/`<=`/`>=`); the `;` stays attached to its
  call, the separators lead the next segment. So `$order->customer()->name();`
  becomes `$order` / `->customer()` / `->name();`, and `$a->x ?? $b->y` becomes
  `$a` / `->x ` / `?? $b` / `->y`. **Deliberately not separators** (they would
  break real chains): `=>` (array `key => value` stays one segment), `::`
  (static call, part of the chain), the ternary `?`/`:` (clashes with `?->` and
  `::`), and a bare `<`/`>` (clashes with `->`/`=>`). The `.` boundary is mostly
  for Vue/JS property access, alongside PHP concatenation. The chosen segment's
  characters get a narrow underline in the same indigo (`#6366f1`,
  `UNDERLINE_CLS`) as the active row's inset bar.

**Every changed content row is selectable at the finer levels.** `'line'` lands
on an added/modified row via its **new side** and on a **pure deletion** (a
removed line with no replacement — a real change that counts toward the approve
total, so it must be individually approvable; its ✓ then renders on the old/left
pane, `approveHere` in `Block.mjs`). `'call'` splits the **whole** new line into
segments and **every** segment is landable, changed or not; a pure deletion is
landable there too, as one empty new segment with the whole old line underlined
on the old side. `'group'` stays a whole run including removed lines.

### Reference units: an UNCHANGED line that carries a resolved call

Landable, but deliberately **not approvable**. Reviewer request: "er zijn
uitzonderlijke situaties waarbij je onderliggende code hebt gelinkt aan regels
die niet zijn aangepast, zoals bij tests blokken. In dat geval wil ik ook de
regel kunnen selecteren (niet approven enzo) zodat ik ook naar die
onderliggende code kan gaan (door wederom naar rechts te drukken)." A test
method typically calls the very production method it exercises from a line the
PR never touched: no unit sat on that row, so `callScopeMethods` could never
scope to it and `→` could never reach that child at all.

- **Which rows** — `referenceRows(b, rows)` (`home.mjs`): the sites
  `findCallSites` reports for b's own **resolved/found `callRows`**, minus every
  row that is `rowChanged`. Only real resolved method calls, so a reference unit
  always has something concrete behind it; a block-level synthetic callKey
  yields no sites and therefore never creates one. Memoized per block on the
  identity of `b.code` + `state.callResolve` (both reassigned wholesale), since
  this is reached from navigation bindings on every keystroke.
  **Accepted consequence:** because `referenceRows` reads `state.callResolve`,
  every reactive binding that computes units now also depends on it. That list
  only changes on `loadCallResolve` (page load, and after a `resolve_call` run
  lands), which already triggers a `recomputeLeftList` + a `setRelated` rebuild
  anyway — so this adds no per-keystroke work, unlike the outer-closure
  coupling warned about in `.claude/rules/arrowjs-pitfalls.md`.
- **How they become units** — `unitsFor(rows, gran, extraRows)`
  (`Block.mjs`, `withReferenceUnits`), fed by `navUnitsOf`, which is now the
  single entry point every consumer in `home.mjs` goes through (the remaining
  raw `unitsFor` call sites were converted, so navigation, scoping, approving,
  comment anchoring and the call arrows can't disagree about unit indices).
  At `group`/`line` a reference unit is the ordinary `{start, end}` shape; at
  `call` it is ONE whole-line unit, never a per-segment split — there is
  nothing changed to zoom into, and `rowCallSegments` reports `segStart 0` for
  a non-`ins` row, which is exactly what `callScopeMethods` matches against.
- **Why "not approvable" needed almost no code:** approval is derived
  exclusively from `changedRows`, and a reference unit contains none — so
  `approveTargetRows` yields `[]` and `unitFullyApproved`'s group/line branch
  already returns `true`. Only three things were added: an explicit
  `unit.ref` short-circuit in `unitFullyApproved` (the `'call'` branch keys off
  `approvedRows`/`approvedCalls` instead and would otherwise report "still
  open" forever), a no-op guard in `toggleApprove`/`toggleCallApprove`, and
  `blockCommands()`, which drops the "Keur … goed" row from the palette
  entirely on such a unit rather than offering a dead action.
- **It is visible:** `rowCellHTML`'s `active` flag (`Block.mjs`) now also
  covers a reference unit's row, so the inset cursor bar shows there. With no
  del/ins mark the row keeps its ordinary untinted background — the bar alone
  marks the cursor.
- **The card says "look only":** a child with neither an approve counter nor a
  comment avatar gets an **eye glyph** (`viewOnlyBadge`,
  `data-testid=related-view-only`) in that same header slot — see
  `.claude/docs/underlying-code.md`.
- **Accepted:** reference units shift `state.change` indices, so an older
  shared `?chg=` link can land one unit off in a block that has them.

Test: `tests/reference-unit-unchanged-line.spec.mjs`.

**An `added` block's own declaration row (row 0) gets the same treatment when
it is itself unchanged.** `declarationReferenceRow(b, rows)` (`home.mjs`, next
to `referenceRows`, merged into the same `extraRows` array in `navUnitsOf`)
adds row 0 whenever `b.status === 'added'` and `!rowChanged(rows[0])` — e.g. a
previously-declared/interface method that only now gets a body: the whole
block reads "added" (`OTHER` category) while its own signature line (`public
static function decode(...)`) is untouched text (identical to the
interface's), so it carried no changed mark and fell outside
`changeGroups`/`changeLines` entirely — `f`/`d` skipped straight past it to
the opening `{`. Reviewer request: "functie naam is niet selecteerbaar. ik wil
dat daar de groep of line kan beginnen." Deliberately only `group`/`line`
(`referenceUnit`'s existing shape already covers both); `call` granularity is
untouched — the signature carries nothing to segment. Same `ref:true`
semantics as the call-based reference unit above (landable, not approvable,
the "look only" eye badge), for a different reason for being unchanged.
**Deliberately gated on `status === 'added'`** — an ordinary MODIFIED
function's declaration is almost always unchanged too (only the body
changed), and turning every one of those into an extra landable stop would
derail "↑ reaches the first real unit" across virtually every reviewed
function; only a wholly new function/method gets this treatment.

**A completely blank (after `trim()`) added/removed line is not a landable unit
at `'line'`/`'call'` and doesn't count toward the approve counter.** Such a row
is `rowChanged` but has nothing to read or judge, so `changedRows`/`changeLines`/
`changeCalls` filter on `rowHasContent(r)` (the display side — `right` for an
`ins` row, otherwise `left`). `changeGroups` is deliberately **unchanged**: the
blank row just rides along inside its group run (like a brackets-only line), so
a group's highlighted range never jumps around it — only its own
countability/landability is suppressed. See `.claude/docs/approval.md` for the
counter side (incl. the Go port in `blockstats.go`).

All diff navigation goes through `unitsFor(rows, gran)` (exported from
`Block.mjs`, shared with the footer) → `unitsOf(b)`; `state.change` indexes the
units of the **current** level. On a level switch `setGran` re-anchors on the
unit covering the current row (`unitAtRow`): `f` from a group lands on its first
line, `f` from a line on its first call segment, and `s`/`d` walk back up the
same rows.

The three keys (`fKey`/`dKey`/`sKey`):

- **`f`** — zoom in. From `'list'` it first steps into the diff (`enterDiff`,
  which resets `gran` to `'group'`). In the diff it refines one level; already
  at `'call'` it steps to the **next call** (`nextChange`, so flowing on to the
  next same-file block like `↓`).
- **`d`** — back. At `'call'` it steps to the **previous call** (`prevChange`,
  flowing on to the previous same-file block like `↑`); at the very first call
  with nothing to flow to it zooms back out to `'line'`. At coarser levels it
  simply zooms out one step.
- **`s`** — always zoom out one level (`call → line → group`), clamped at
  `'group'`. Unlike `d` it never walks along previous calls, so it reliably
  escapes the call selection.

`d`/`s` do nothing in `'list'` mode; only `f` steps in from there.
`nextChange`/`prevChange` are shared with `↑`/`↓`, so arrows and `f`/`d`
traverse the diff identically.

Refining a group that spans exactly **one line** (`cur.end === cur.start`) makes
`f` skip `'line'` and jump straight to `'call'` (the line *is* the group);
`s`/`d` still step back one at a time.

**`f`/`d`/`s` also work within a drilled column** (`state.focusLevel > 0`) — the
same zoom, but on that column's own `{change, gran}` cursor in
`state.drillCursor[focusLevel-1]` (`setDrillGran`/`drillNextChange`/
`drillPrevChange`, mirroring the top-level helpers). A drilled column has no
same-file neighbour to flow into, but it does have a **sibling**: walking past
the last (resp. first) unit steps sideways to the next/previous child of the
**parent** column and replaces the column at the same depth, at any level and
any granularity. Only with no sibling left does `f`/`d` still zoom back to
`'line'`. Full mechanism (`drillSiblingContext`/`drillToSibling`, the `↑`
symmetry landing on the sibling's **last** unit, the adjusted `dKey` guard):
`.claude/docs/drilling.md`.

The call underline rides on `markChars` (a per-character class function):
`paneHTML` passes the active segment's underline set to `highlightChanges`,
which renders it into the Prism-highlighted HTML. Changed **characters** no
longer get their own background (see "Char diff" in
`.claude/docs/diff-render.md`) — the red/green line background marks a change
at line level only. An empty added line has no characters and thus no
underline.

The same range is also reachable by mouse — a real (native) text selection
over several rows resolves to the same `state.rangeAnchor` range exactly like
holding Shift, a plain click alone jumps the cursor to the row it landed on
(or does nothing at all on an unchanged line). See "Line selection: click and
browser text selection" in `.claude/docs/diff-render.md`.

## Shift+↑/↓ — selecting multiple lines/groups at once (`state.rangeAnchor`)

At **`gran==='line'` or `gran==='group'`** (`isRangeGran`),
**Shift+ArrowDown**/**Shift+ArrowUp** (`extendRange`/`drillExtendRange`) extend
the selection into a contiguous range of lines resp. a merged run of
change-groups instead of moving one unit at a time. The anchor (the unit index
where the shift selection started) lives alongside the `{change, gran}` cursor:
`state.rangeAnchor` at top level, `rangeAnchor` on the drilled column's own
`state.drillCursor[level-1]` entry.

`rangeUnit(units, change, anchor)` merges the current and the anchor unit into
one `{start, end}` row range (min/max of their row indices) — treated everywhere
else as an ordinary, larger unit, so the highlighting (`activeGroup`), the
approve scope (`approveTargetRows`/`approveContext`) and the comment anchoring
(`commentTarget`) needed nothing deeper than "use the merged unit". It works
identically for a line and a group unit; merging two groups can span an
unchanged gap, which is fine — highlighting and approve only act on the actually
changed rows within the range.

- **Only at `'line'`/`'group'`** (`isRangeGran`, the single gate both
  `extendRange`/`drillExtendRange` and every `rangeUnit` call site check). At
  `'call'` it is about segments within one line, so Shift+↑/↓ is a no-op.
- **Clamps at the block boundary** — unlike a normal `↓`/`↑`, an active range
  never flows into the next same-file block or the next Underlying-code sibling:
  approve and comment operate per block, so a cross-block range has no meaning.
- **Approve approves the whole range at once** — `approveTargetRows` filters
  `changedRows` on the merged range. The label follows suit only at
  `'line'`: `approveNoun` shows "Approve these N lines" once the range spans
  more than one line. At `'group'` it stays the generic "these lines" — a group
  already spans a variable number of rows, so there is no natural "N".
- **Comment uses the range as a multi-line anchor** — `commentTarget()` builds
  its code fragment/`startLine`/`endLine` from the merged range;
  `unitLineRange` already supported a multi-line range, so "Plaats comment" on
  a Shift range posts a real multi-line GitHub review comment.
- **The anchor clears** on anything that would overwrite the selection
  (`clearRangeAnchor()`): an ordinary non-shift arrow key
  (`nextChange`/`prevChange`/`stepBlock`/`drillNextChange`/`drillPrevChange`/
  `setDrillChange`), an `f`/`d`/`s` zoom (`setGran`/`setDrillGran` already build
  a fresh cursor without it), a block switch (`stepBlock`, `enterDiff`,
  `openTask`), and `←`/`→`. Deliberately the same "an ordinary step releases the
  selection" behaviour as a text editor. Running an approve/comment/chat action
  ON the range does NOT itself clear it — same reviewer request as the
  index-level range above (see "Shift+↑/↓ in the INDEX" below) — only a bare
  `Escape`, checked in its own `onKeydown` branch after the menu/related-panel
  branches, does that on top of the paths just listed.
- **Onderliggende-code scoping and the footer preview also widen to the merged
  range** — `callScopeMethods`/`groupLineRange`/`footerUnitInfo` (`home.mjs`)
  used to look up only the lone cursor unit (`navUnitsOf(...)[cur.change]`),
  ignoring `cur.rangeAnchor` entirely, so a Shift-selected range of several
  lines/groups still scoped the Onderliggende-code panel and the footer's
  diff-preview/AI-description to just the ONE unit under the cursor — the one
  place a range didn't yet act like a bigger group. Fixed by reusing
  `focusedActiveUnit()` (the same range-aware computation `activeGroup` already
  uses) in all three instead of a second, range-blind lookup — no parallel
  mechanism, same `rangeUnit`/`isRangeGran` gate as everywhere else. This needed
  no change to `clearRangeAnchor`'s own call sites above: all three read the
  range while the diff still owns the keyboard (mirroring approve/comment/chat,
  which are likewise all reached via `Enter` before any `→`), so widening them
  costs nothing extra and the panel/footer visibly widen live WHILE
  Shift-selecting, before `→` ever clears the anchor.
- **The automatic AI-description (`explain_code`) is capped at
  `MAX_EXPLAIN_LINES` (10) rows** — deliberately, explicit reviewer answer to
  "how big may the auto-sent context get": unlike an ordinary `'group'` (capped
  at 5 rows by `MAX_GROUP`), a Shift-selected range has no size ceiling of its
  own, and this explain request fires automatically (debounced, no keypress) —
  a large merged range must not silently trigger an unsolicited, possibly
  expensive LLM call. `footerUnitInfo` still shows the ordinary diff-preview for
  a bigger range, it just skips the `explain` descriptor (and thus
  `scheduleExplain`) once `unit.end - unit.start + 1 > MAX_EXPLAIN_LINES`.
  Starting a Claude chat about a bigger range is unaffected — that's an
  explicit reviewer action (`claudeContextBlock`, see
  `.claude/docs/claude-chat-panel.md`), never this automatic one. Also fixed
  `footerUnitInfo`'s `unitKey` for `'line'` granularity to include the unit's
  `end` row (`line-${start}-${end}`, not just `line-${start}`) — a merged
  multi-line range can share a start row with an unrelated single line, which
  the old key couldn't distinguish. Tests:
  `tests/range-select-related-scope.spec.mjs`,
  `tests/footer-explanation-range.spec.mjs`.

## `/` — the menu of the current stop

`/` is no longer "the PR menu key": it opens whichever palette belongs to the
stop that owns the keyboard (`contextMenuMode`, `home.mjs`) and only falls back
to the PR-wide menu on a stop with no menu of its own. Full table + the
consequence for reaching `PR_COMMANDS`: "`/` opens the menu of the CURRENT
STOP" in `.claude/docs/command-palette.md`.

## Shift+↑/↓ in the INDEX — selecting several rows at once

The sidebar cursor gets the same gesture the diff cursor already had, one level
up: **Shift+ArrowDown/ArrowUp** selects a contiguous range of index rows
(`state.listAnchor`, `extendListRange`) resp. of a `test_class` row's own
methods in the methodes-kolom (`state.methodAnchor`, `extendMethodRange`).
Both are ephemeral (never in the URL, exactly like `rangeAnchor`).

- **It moves like a plain arrow, it just remembers where it started** —
  `extendListRange` reuses `stepVisibleSelected`, so hidden (approved/ignored)
  rows are skipped the same way.
- **It clamps at the first/last visible block** and never continues into the
  toggle-approved / toggle-ignored / push-todo / search stops of the sidebar
  loop: those aren't blocks and can't take part in a multi-row action — the
  same reasoning that makes the diff-level range clamp at the block boundary.
  `extendMethodRange` clamps at the class edges for the same reason.
- **The anchor clears on any plain selection change** — `clearListAnchor()`,
  called from `selectRow` (thus every non-shift `↑`/`↓`), `setSearch`,
  `enterDiff`, and both row `@click` handlers (`BlockList.mjs`/
  `TestMethodsColumn.mjs`, which set `state.selected` directly rather than
  going through `selectRow`).
- **Tint vs. shape:** every row in the range gets the ordinary selected tint
  (`rowFocused` → `rowInListRange`), but the `›` marker stays on the cursor row
  alone (`rowIsCursor`), so it is always visible which row the arrows move from
  — a shape distinction, not a second colour (the reviewer is colourblind).
- **What you can do with it:** `Enter` opens a palette scoped to the whole
  selection (`rangeCommandsFor` — pinned "Sluit menu" plus **"Keur deze N
  blokken/methodes goed"**, flipping to "Trek goedkeuring … in" once everything
  in it is approved), and **`Space`** runs that same action in one press
  (`hasMultiSelection()` is the first thing `spaceKey` checks). The ordinary
  block palette is deliberately NOT shown for a range: every one of its items
  ("Comment op deze regel", "Open GitHub", …) speaks about ONE line.
- **Approving a range reuses the existing per-kind paths** — a `test_class`
  row goes through `toggleTestClassApproval`, an ordinary block through its own
  `changedRows` after `ensureCode` (most rows in a range have never had their
  code fetched), and a comment item is **skipped**: "approved" there means
  "resolved", a real GitHub-side action that a bulk key must not trigger. One
  `approve` Signal per block, never a batch write. Like the block/class
  checkbox this is a bulk toggle, so there is no `afterApproveAction`/
  postApprove follow-up.
- **Running an action does NOT clear the selection by itself.** Approving/
  commenting/chatting/ignoring the range leaves `listAnchor`/`methodAnchor`
  standing exactly as they were, including once the menu that ran the action
  has closed — reviewer request: the tint should stay up so a reviewer can
  see, and keep acting on, the same set of rows across more than one action.
  It only goes away the way any other selection does: a bare **`Escape`** (a
  new, dedicated `onKeydown` branch, checked after the menu/search-box/
  `relatedActive()`/`isEditableFocused()` branches so it never fires while one
  of those owns the key — opening the range palette and running an action
  from it therefore never touches the selection either) or one of the
  existing "this supersedes it" paths above (a plain arrow, a click, stepping
  into a diff, search).

Test: `tests/list-range-select.spec.mjs`.

## `Space` — approve + continue in one keypress

**`Space`** (`spaceKey`, `home.mjs`) is a one-key shortcut for exactly what the
block palette already does with two actions in a row: `Enter` → "Keur ...
goed" → (if the postApprove follow-up opens) "Ga door". It reuses the very
same functions — no second approve/continue implementation:

- **Approve:** `approveContext()` + `toggleApprove()`/`toggleCallApprove()` —
  the whole block in list mode, else the current group/line/call at whichever
  granularity (`f`/`d`/`s`) currently owns the keyboard, exactly like the
  palette's "approve" item (see `.claude/docs/command-palette.md`).
- **Continue:** `toggleApprove(true)`/`toggleCallApprove(..., true)` pass an
  `auto` flag down to `afterApproveAction`, which — only when it would
  otherwise stash `postApproveTarget` and open the `postApprove` confirm menu —
  applies the plan via `applyNextUnapproved` directly instead. So the menu
  never flashes on screen at all when reached through Space; the two existing
  no-menu exceptions (staying within the same block, approving from the
  blokken-index) still short-circuit exactly as before, `auto` is just a third
  way to skip the same menu.
- **Underlying code first:** before approving, Space checks whether the unit
  contains a **resolved method call whose target block still has unapproved
  work anywhere in its subtree** (`descendIntoUnapprovedCall` →
  `firstUnapprovedCallSiteInUnit`, `home.mjs`). If so it approves the unit only
  **up to and including that call's own segment** (`approveThroughCall`: every
  changed row of the unit before that row in full, plus the segments of that
  row starting at or before the call) and drills straight to the child's first
  unapproved unit — the rest of the group waits for the next Space once the
  reviewer comes back up. Reviewer request: approving a whole group in one
  press otherwise silently ticks off call sites whose code was never opened.
  A site whose own segment is **already approved** is skipped, so declining to
  approve the child and coming back up doesn't send you straight back down;
  only `callRows` count (a relation child or a synthetic block-level call key
  has no segment in this line to stop at), never in list mode, never for a
  TRANSLATION block. Test: `tests/space-descends-into-call.spec.mjs`.
- **Already approved → only continue:** if the unit under the keyboard is
  already fully approved (`isApproveDone(ctx)`, extracted out of the
  `COMMANDS` 'approve' label so both agree on the same "done" check), `spaceKey`
  toggles nothing — it runs `findNextUnapproved()`/`applyNextUnapproved()`
  itself, i.e. the bare "Ga door" half with no approve action at all.
- **Nothing left ahead either way:** mirrors `afterApproveAction`'s own
  "nothing left ahead" branch verbatim (same two `await Promise.resolve()`
  ticks to let the decoupled `state.approvalTotal` watch flush) and opens the
  same `reviewApprove`/`reviewChoice` review-submit menu (see
  "Review-submit menus" in `.claude/docs/command-palette.md`) — approving or
  rejecting the whole PR stays a manual, two-step choice regardless of how the
  last unit got approved.

**On a comment-index row, Space does something else entirely: toggle the
comment_batch checkbox, or advance.** `spaceKey`'s very first branch checks
`curBlock().kind === 'comment'` before any of the approve logic above ever
runs — see "The comment_batch checkboxes and the bottom action row" in
`.claude/docs/comments-panel.md` for the full mechanism (this used to RESOLVE
the comment outright in one keypress; reverted as "too easy to trigger by
accident" once the row also carries a checkbox — resolving now only happens
through the row's own `Enter` menu).

**Guards** (`onKeydown`): `!isModifiedKey(e)` (a held Cmd/Ctrl falls through
untouched, same as `f`/`d`/`s`/`a`) and `!state.showDescription` — stop 1 (the
PR-description column) has no block to approve, the same reason `Enter` there
opens the `pr` menu instead of `block`. Placed after `relatedActive()`/
`isEditableFocused()` (so it's suspended, like `f`/`d`/`s`/`a`, the moment the
keyboard has stepped into a comment thread, the Claude chat or a composer —
`Space` then types a literal space into that field) and after the toggle-row
guard (`state.toggleFocused`/`ignoreToggleFocused` — added to the same
`['f','d','s','a',...]` no-op list, since a toggle row is not a PR block).
Deliberately **not** excluded for `isTestColumnActive()` (unlike `f`/`d`/`s`/`a`,
which need diff context to zoom): `curBlock()` already resolves stop 2b to the
active test method, exactly like `Enter` already opens the ordinary block
palette there, so approving with Space is meaningful on that stop too.
`e.preventDefault()` always fires when handled, so Space never scrolls the
page nor (were a focusable element to hold real DOM focus) activates it
natively. Test: `tests/space-approve-continue.spec.mjs`.

## `a` — cycling the diff view (split → unified → fit → split)

**`a`** cycles globally, for **every visible diff card at once** (the
selected/preview card and every open drilled column) through `DIFF_VIEW_CYCLE`
(`home.mjs`, `['split', 'unified', 'fit']`):

- **`'split'`** — side by side, old + new (default).
- **`'unified'`** — a genuinely two-sided block collapses into ONE column, the
  old (`-`) line directly above the new (`+`) line, mirroring the footer's own
  inline-diff gutter convention (see `.claude/docs/footer.md`). The only stand
  that still shows old code.
- **`'fit'`** — only the new/right pane; old code is never shown, even for a
  two-sided block (`fitOnly(b)` in `Block.mjs`, folded into `codeDiff`'s
  `effectiveOnly` next to `singleSide(b)`). **The one exception:** a REMOVED
  block has no new side, so it keeps showing its old/left pane — hiding it would
  leave nothing to review.

`state.diffViewMode` is ephemeral, no URL binding (like
`showDescription`/`showApproved`). **All three stands share the same
content-driven width** (`contentWidthCls`/`boundedWrapWidthCls`, `Block.mjs`)
— toggling `a` changes the pane STRUCTURE above, not the card's width; see
`.claude/docs/diff-card.md`.

**Landing on a block whose every change spans exactly one row auto-jumps the
INITIAL stand to `'unified'`** — a one-time default, not a permanent override
(`a`/the indicator still cycle normally afterward); see "Landing on an
all-single-line block auto-jumps the INITIAL stand to `unified`" in
`.claude/docs/diff-card.md` for the full mechanism.

**`'unified'` hides nothing — it restructures.** For an aligned row that is a
real del+ins pair (or a whitespace-only re-alignment, `wsOnly`),
`unifiedRowHTML` stacks the OLD line (`-`, rose) above the NEW one (`+`,
emerald); a context row or an already one-sided row stays a single line.
Load-bearing: exactly **one** of a pair's two lines carries the row's metadata
(`data-row`/`data-changed`/the change-active anchor/the ✓/the comment marker) —
the same canonical side `approveHere`/`commentedHere` pick elsewhere — so a
`callArrows.mjs`/`updateHints` query for a row index never finds the decorative
OLD half. The approve ✓ moves from its absolute overlay into an inline,
fixed-width slot right after the `-`/`+` marker (`gutterSpan`), since the
overlay would sit on top of the gutter text.

**Guards.** The handler sits next to `f`/`d`/`s` in `onKeydown`, behind the same
earlier guards (command palette / search box / related panel active), and works
in both modes. Two extra checks:

- **`isEditableFocused()`** — `relatedActive()` (`cs.focus !== null`) doesn't
  cover every path where a text field has DOM focus (`startComment()` only sets
  `cs.composing`), so a literal "a" typed in a composer would be swallowed. The
  handler therefore also reads `document.activeElement` directly: TEXTAREA/INPUT
  → the shortcut does nothing and the key flows into the field. Generic and
  future-proof, independent of which navigation flag a field tracks.
- **`isModifiedKey(e)`** (`e.metaKey || e.ctrlKey`, shared with `f`/`d`/`s` and
  with the `state.toggleFocused` swallow list) — `event.key` stays the bare
  letter regardless of a modifier, and the diff panes are plain selectable text
  (not an input), so without this `Cmd+A`/`Ctrl+A` near the diff toggled the
  view instead of selecting all text. Same for `Cmd+F`/`Cmd+D`/`Cmd+S`. Test:
  `tests/select-all-shortcut.spec.mjs`.

**Compact status indicator (`viewModeIndicator`, `Block.mjs`):** three small
icon buttons (`data-testid=diffview-split`/`-unified`/`-fit`) in the card's
metadata row (next to the file:line, before the approve checkbox) show which
stand is active (indigo ring on the current one). Since `state.diffViewMode` is
global, they render **only on the card that currently owns the diff keyboard**
(`diffActive()`, the same opt that drives the card's indigo border) — never on a
preview card or a collapsed rail, so they never double up. A click jumps
straight to that stand (`setViewMode` opt → `setDiffViewMode` →
`applyDiffViewMode`, the same helper `toggleDiffView` calls); `a` keeps cycling.
The three icons are a fixed `.map()` over `VIEW_MODE_META` (always the same 3
entries in the same order, so no keyed-node pitfall applies), and each button's
class is its own whole-value `${() => ...}` binding so only the highlight
re-evaluates. Test: `tests/diffview.spec.mjs`.

`viewMode()` is read inside `Block()`'s own per-card `${() => ...}` bindings,
never in the outer per-column closure of `home.mjs`, so a toggle only re-renders
each visible card's diff structure and width — not the card-building closures
(see the "outer closure depends on navigation state" pitfall in
`.claude/rules/arrowjs-pitfalls.md`).

## `c`/`v` — resizing the focused column by keyboard

Holding **`c`** shrinks and holding **`v`** grows the manual column-width
override (the same one the resize handle's drag sets, see
`.claude/docs/column-resize.md`) of whichever column is currently
**focused** — `focusedBlock()`'s own `'diff:' + b.id` key, i.e. the top-level
selected card or the currently open drilled column, whichever owns
`state.focusLevel`. **Deliberately not diff-only** like `f`/`d`/`s`/`a`
above: its guard sits in `onKeydown` **before** the `relatedActive()` branch,
so it keeps working while the keyboard has already stepped further into that
same block's Underlying-code panel, an inline comment thread, or the embedded
Claude chat — only `isEditableFocused()` (a real composer/reply/Claude-chat
field has DOM focus) makes it yield, plus the usual `isModifiedKey(e)` so
Cmd/Ctrl+C/V stays native copy/paste. Releasing the key persists the width it
landed on; **two quick taps of the same key in a row reset it to auto**,
mirroring the handle's own dblclick reset. Full mechanism (the
`startKeyResize`/`cancel`/`commit` split, the double-tap timing, the `blur`
safety net): `.claude/docs/column-resize.md`.

## Generic input-focus guard (typing must never be swallowed by a shortcut)

`relatedActive()` (`cs.focus !== null`) is the existing safety-net branch: it
ends unconditionally in a `return`, so any key it doesn't explicitly match
(letters, `/`, unmatched Enter variants) flows through to the focused field. But
it only works while `cs.focus` stays in lockstep with real DOM focus — which is
why every path into the composer goes through `toNew()`/`startComment` (both set
`cs.focus` and `cs.composing` together), never a bare `cs.composing` toggle.

As an **extra, future-proof layer**, `onKeydown` checks `document.activeElement`
directly (`isEditableFocused()`, the same helper as the `a` guard) after the
`relatedActive()` branch and before `/`: if a TEXTAREA/INPUT has focus and no
earlier branch claimed the key, no remaining global shortcut (`/`, `f`/`d`/`s`,
`a`, arrows, the block-palette Enter) does anything.

- **`Escape`** in this fallback is the explicit "get me out of here" key —
  `leaveRelated()` (blur + `cs.focus = null` + `cs.composing = false`, mirroring
  `handleRelatedKey`'s own Escape handling).
- **`Tab`** deliberately gets no handling: the browser moves focus natively,
  after which the next keystroke doesn't hit this branch anyway.
- **A control that is an `<input>` but ISN'T meant to hold onto real DOM focus
  must blur itself right after use.** `isEditableFocused()` matches ANY
  focused `INPUT`, not just a text field — the comment_batch checkbox
  (`batchCheckbox`, `BlockList.mjs`) is an `<input type="checkbox">`, and a
  plain mouse click on it (before this fix) left it holding real DOM focus
  indefinitely, since nothing else in this app ever moves focus away from a
  clicked checkbox. Every subsequent keydown — `Enter` on that same row not
  opening its menu at all was the reported symptom — then silently fell into
  this exact fallback and did nothing, app-wide, until something else
  happened to steal focus back. Fixed locally, in the checkbox's own `@click`
  (`e.target.blur()` right after toggling) rather than by narrowing
  `isEditableFocused()` itself — that helper is relied on by every shortcut in
  this file, and the search box/composers/reply fields all genuinely DO want
  to keep DOM focus, so "any focused INPUT" stays the right definition for all
  of them. Only a control that toggles via a single click and has no typing
  concept of its own needs this same treatment if one is added later.
- The search box (`BlockList.mjs`) needs no fallback — its `@focus`/`@blur` set
  `state.searchActive` from real DOM focus directly.

### Caret guards: `←`/`→` inside a focused comment field

**`←` moves the caret, unless it is already at the very start.** The
`relatedActive()` branch (`cs.focus` `'new'`/`'comment'`/`'thread'`/`'claude'`,
each of which lands DOM focus in a text field) used to
claim `ArrowLeft` unconditionally, so a plain `←` or Option/Alt+`←` mid-text
exited the field instead of moving the caret.
`editableCaretCanMoveLeft()` (`home.mjs`) checks whether the focused
TEXTAREA/INPUT has `selectionStart`/`selectionEnd` > 0, and both branches
suppress their `ArrowLeft` handling while that holds — the key then falls
through to the field (caret step or word jump). At position 0 (a freshly opened,
empty composer/reply) `←` keeps its "step back out" meaning; `Escape` is
unchanged regardless of caret position. Test:
`tests/comment-arrowleft-caret.spec.mjs`.

**`→` gets the exact mirror-image guard.** `editableCaretCanMoveRight()` checks
`selectionStart`/`selectionEnd` < `value.length`; only once the caret is at the
end does `→` keep its nav meaning (entering the embedded Claude chat directly
from `'comment'` or `'thread'`, or — via `enterClaudeChatFromNew`, see
`.claude/docs/claude-chat-panel.md` — from the still-open, not-yet-placed
`'new'` composer too, even with no anchor comment yet; a no-op inside the chat
itself). Test: `tests/comment-arrowright-caret.spec.mjs`.

The comment-index item's own reply field (`commentDetailCard`) needs no guard at
all: it is not wired into any `cs.focus`-based branch, so `←`/`→` there fall
through to the browser by construction.

### Caret guards: `↑`/`↓` inside a focused, WRAPPED comment/Claude field

**`↑`/`↓` get the same treatment, on the vertical axis, but need a genuinely
different check.** `selectionStart`/`selectionEnd` alone is a linear character
offset — it can't tell "first/last VISUAL (wrapped) line" from "first/last
character", which only diverge once a multi-line composer (comment or the
embedded Claude chat) actually wraps its text across more than one rendered
row. Before this guard, the `relatedActive()` branch hijacked `ArrowUp`/
`ArrowDown` unconditionally, so pressing `↑` mid-paragraph in a wrapped
composer immediately exited the field instead of moving the caret up a row.

`caretVisualLineMarks(el, pos)` (`home.mjs`) builds a hidden mirror `<div>`
that reproduces every style influencing wrapping (font, content width via
`el.clientWidth` — so an active vertical scrollbar narrows the mirror the same
way it narrows the textarea's own content box — padding, `white-space:
pre-wrap`/`overflow-wrap: break-word`), inserts zero-width marker `<span>`s at
the very start, at `pos`, and at the very end of the field's `value`, and
returns their `offsetTop`. `editableCaretCanMoveUp()`/`editableCaretCanMoveDown()`
compare the caret's marker against the start/end marker (`selectionStart` for
up, `selectionEnd` for down, mirroring how the browser itself collapses a
selection on `↑`/`↓`) — TEXTAREA-only, since a plain INPUT never wraps and
keeps its existing nav meaning there. Note the caret needn't land on character
0/`value.length` exactly to count as "first"/"last line": the browser's own
column-preserving vertical caret movement can stop anywhere within that row,
so the guard compares *rows* (marker `offsetTop`), not exact offsets. Test:
`tests/comment-arrowup-caret.spec.mjs`.
