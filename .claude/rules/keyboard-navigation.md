# Keyboard navigation (two modes)

The keyboard flow lives in `home.mjs` (`onKeydown`) and has two modes via
`state.mode`.

## The left→right navigation chain (`←`/`→` through the whole layout)

Separate from the individual mechanisms below, `←`/`→` together form one
continuous chain of **stops**, from left to right across the whole layout:

1. **Description** (`prInfoCard`/`state.showDescription`) — the PR title/
   summary/description. **Hidden by default** (takes up no width then — the
   column disappears entirely, no rail like the comments/tasks sidebar's
   collapse) and the leftmost stop. `←` here leaves the whole chain to
   `/pr-overview` (see
   below) — there is nothing to the left of stop 1.
2. **PR block index** (`data-testid=pr-index`, the sidebar, `state.mode==='list'`)
   — physically shifts right as soon as stop 1 is open, so the description
   really sits to its left instead of after it (see `.claude/rules/detail-layout.md`).
3. **Block with diff** (`state.mode==='diff'`, `state.focusLevel===0`).
4. **Drilled columns** (`state.drill`/`focusLevel>0`) — a **side branch**, not
   a strict stop: only reachable via Enter/click on an Underlying-code child
   (see "Drilling" in `.claude/rules/detail-layout.md`), not via `→`. `←` does
   peel them back one by one, just like the other stops.
5. **Underlying code** (`RelatedPanel`, `cs.focus==='code'`) — the rightmost
   stop of this chain; there is no `→`/`←` stop after it.

**Comments and Tasks are no longer stops in this chain.** Together they form
a standalone, **Cmd+→-toggled** fixed sidebar (`CommentsSidebar`, see
"Comments/tasks sidebar" in `.claude/rules/detail-layout.md`) that you can
open/close from **any** position in the app, regardless of which stop of the
chain above currently owns the keyboard. Within that sidebar, `↓`/`↑` move
between comments (top) and tasks (below, stacked); `←` closes from anywhere
in the sidebar in a single move back to the diff (the sidebar itself stays
open — only the keyboard focus leaves it). See that section for the full
mechanism (`toggleSidebar`/`cs.sidebarOpen`/the hint rail).

**Focus highlight per stop:** stops 1-3 show the *same* on/off indigo
focus border (`border-indigo-300 ring-1 ring-indigo-200`, otherwise the
neutral grey border) exactly while that stop owns the keyboard, mirroring the
`diffActive` pattern of the block-diff card (`Block.mjs`): the description card
(`prInfoCard`, `data-testid=pr-info-card`) while `state.showDescription` is
true, the pr-index (`data-testid=pr-index`) while `state.mode==='list' &&
!state.showDescription`, and the block-diff card (stop 3, and each drilled
column, stop 4) while it owns `focusLevel`. Both `prInfoCard` and the pr-index
`<aside>` build this into their existing top-level `class="${() => …}"`
function binding (not a keyed list item), so it just re-evaluates reactively on
`state.showDescription`/`state.mode` — no arrow.js keyed-node pitfall applies
here (that pitfall only bites keyed array items like the `Block()` cards, see
`.claude/rules/conventions.md`). Stop 5 (Underlying code) deliberately has
**no** outer focus border — that was removed on purpose (see the "Underlying
code" section in `.claude/rules/detail-layout.md`), so the chain isn't
uniformly bordered end-to-end, only stops 1-4.

`→` moves one stop to the right, `←` one stop to the left — this is
**on top of**, not instead of, the existing per-stop `↑`/`↓` navigation
(which still moves within a stop: block selection in the index, change group
in the diff, child in Underlying code). Concretely, with the adjustments this
required relative to the older per-mechanism behavior:

- **Stop 1 ↔ 2:** `←` in `'list'` mode (outside the search box) used to open
  the search box (`activateSearch()`); it now **opens the description**
  (`state.showDescription = true`). `→` from the description closes it again
  (`state.showDescription = false`) and gives the block index the keyboard
  back. While the description is open, `↑` does nothing; `↓` gives — if there
  are PR-wide comments — the keyboard to the **PR-wide comments block** below
  the card (see the separate section "PR-wide comments, stop 1" further on);
  without such comments `↓` is also a no-op (there's no internal cursor to
  move otherwise) — that prevents them from shifting the block selection
  below.
  **The search box is not its own stop** — it belongs to stop 2 and is no
  longer reachable via `←` (that was its only keyboard entry); it remains
  reachable via a mouse click (and native Tab), and typing filters as always
  once it has focus. If the search box was already focused via a click
  (`state.searchActive`), `←` now does the same thing there (to stop 1, with
  `exitSearch()` to cleanly release DOM focus) instead of the old no-op
  ("already the leftmost stop").
- **Before stop 1 (end of the chain):** `←` while `state.showDescription` is
  open (there is no stop 0) navigates away from the PR to the **PR inbox**
  (`location.href = '/pr-overview'`, see `.claude/rules/pages-and-routing.md`).
  Choosing a PR there lands you on `/pr/<id>` without a `sel` param in the
  URL, so `state.selected` sits at its default (`0`) — the **first block** is
  immediately selected, not whatever was selected earlier on that PR.
- **Stop 2 ↔ 3 / stop 3 ↔ 4:** unchanged — see the `'list'`/`'diff'` sections
  below resp. "Column navigation" in `.claude/rules/detail-layout.md`.
- **Stop 3/4 ↔ 5:** unchanged — `→` from the diff is `enterRelated()`, `←`
  from `cs.focus==='code'` (on the first child, or via `↑` there) is
  `exitRelated()`. `→` from `'code'` no longer does anything — it used to
  jump to the comments column (`gotoRow(1)`), but that is no longer a stop in
  this chain (see above and "Comments/tasks sidebar" in
  `.claude/rules/detail-layout.md`); comments/tasks are only reachable via
  Cmd+→, from any stop.
- `state.showDescription`/`cs.taskSel`/`cs.sidebarOpen` deliberately live
  **outside** the URL (like `menu`/`ui.task` elsewhere) — ephemeral cursor
  state, not a navigation position a refresh needs to restore.

### PR-wide comments, stop 1 (`PrWideComments`, `handlePrWideKey`)

Below the PR description card (stop 1) sits a second card
(`data-testid=pr-wide-comments`, see "PR-wide comments" in
`.claude/rules/detail-layout.md`) with the PR-wide comments (`kind !== ''` —
GitHub issue/review comments without a line anchor). That has its **own**
cursor `pw` (`RelatedPanel.mjs`, separate from `cs.focus`/`cs.sel` of the
block-scoped comments/tasks panel and separate from `state.showDescription`
itself) and its own keyboard handler, `handlePrWideKey(key)`, invoked from
`home.mjs`'s `onKeydown` **as long as `state.showDescription` is true** —
before all generic shortcuts (`Enter` opens menu, `/`, `f`/`d`/`s`), so those
don't accidentally steal a keystroke while this block owns the keyboard
(same ordering precedent as `relatedActive()` further down in `onKeydown`).
`isPrWideFocused()` (`pw.focus !== null`) determines whether this block
currently owns the keyboard:

- **`↓` from the description** (stop 1 itself, `pw.focus === null`) gives
  the keyboard to this block — lands on the **first** entry (`pw.focus = 'item'`,
  `pw.sel = 0`) — provided there are PR-wide comments; otherwise a no-op (the
  description keeps the keyboard).
- **`↓`/`↑`** move, while `pw.focus === 'item'`, through the flat entry list
  (`pw.sel`, clamped at start/end); `↑` on the **first** entry gives the
  keyboard back to the description (`pw.focus = null`) — mirroring how `↑`
  on the first row of the block-scoped index steps back to the diff.
- **`Enter`** on an entry (`pw.focus === 'item'`) opens its thread
  (`pw.focus = 'thread'`, `pw.threadPos = 0`, reply field focused) —
  functionally a click on the row. Within the thread `↑`/`↓` walk the
  message history (`pw.threadPos`, mirroring `cs.threadPos`); `↓` at the
  bottom (`pw.threadPos === 0`, the reply field) steps to the **next**
  entry (`pw.focus` back to `'item'`), if one exists.
  **`Enter` within the thread** is the discoverable resolve shortcut: an
  **empty** reply field + `Enter` **resolves** the comment (`done:true`, the
  same `POST /signals/reply` as the resolve button); a **non-empty** field +
  `Enter` is handled by the field's own `@keydown` (sends the reply,
  `done:false`) — the global `handlePrWideKey('Enter')` branch deliberately
  does nothing in that case (the `pwComposeEmpty()` guard), so there's no
  double send. Shift+Enter remains a newline (the global handler ignores
  `Enter` with `e.shiftKey`).
- **`←`** steps, from anywhere within this block (`pw.focus !== null`), back
  one level: out of a thread to row focus (`pw.focus = 'item'`), and from
  row focus back to the description (`pw.focus = null`) — the description
  simply stays open in the process (this is not a stop transition, just an
  internal step back). **Only** once this block has no focus at all
  (`pw.focus === null`, i.e. back on the description itself) does `←` fall
  through to the existing stop-1 `←` handling in `onKeydown` (away to
  `/pr-overview`, see "Before stop 1" above) — `handlePrWideKey('ArrowLeft')`
  then returns `false` and the caller (`onKeydown`) does the navigation
  itself.
- **`Escape`** closes this block's focus in one move (`pw.focus = null`), just
  like `←` from row focus, but in one step regardless of how deep you were
  (thread or row).
- **`Enter` on stop 1 itself** (the description card, `pw.focus === null`)
  remains, unchanged, opening the **PR-wide** command menu (see below) — this
  block only claims `Enter` while it itself has the focus.

Reply/resolve go via the **same** `POST /api/workflows/{runId}/signals/reply`
Signal as the block-scoped comments panel — see "Persisting reviewer
approval"/"The first slash task" in `.claude/rules/tembed-workflows.md` for
the underlying `task_code_comment` mechanism; no separate write path is
needed here (the backend already handles a PR-wide reply/resolve correctly).

**`Enter`** opens a **command palette** (`src/CommandMenu.mjs`,
`data-testid=command-menu`): a searchable command menu that appears as a
**floating popover just below the current selection**, over the rest of the
page — anywhere in the tree, in whichever block. At **stop 1** (the PR
description column, `state.showDescription`, see "The left→right navigation
chain" above) there is no block context to act on, so `Enter` there opens the
same **PR-wide** menu as `/` (`openMenu(state.showDescription ? 'pr' : 'block')`
in `onKeydown`) instead of the block-scoped palette — block 0 in the list is a
different stop (`showDescription` is `false` there) and simply keeps the
block palette. `home.mjs` (`menuOverlay`) renders it once at `<main>`
level as a `position:fixed` element (`data-testid=
command-anchor`) with a full-screen catch layer (`data-testid=command-overlay`)
that closes on a click outside the menu. `positionMenu` anchors it just
**below** the selection and gives it the **width of the right (NEW) pane** —
so **half width, over the right side** (the new code you're reviewing). The
vertical position comes from `menuAnchor()` (the active change row
`[data-change-active]`, present in both list preview and diff mode; otherwise
the block card, otherwise the sidebar row); the width + left edge come from
`menuRegion()` (the `[data-pane="new"]` pane of the selected block; falls
back to `[data-pane="old"]` for a removed block, then the whole block column
— the `data-pane` hook sits on `codePane` in `Block.mjs`). **From the block
index** (`state.mode==='list'`, for the `'block'` and
`'postApprove'` palettes — `isIndexMenu()` in `home.mjs`) the menu instead
anchors on the **selected sidebar row** (`[data-idx="${state.selected}"]`)
and takes the **full sidebar width** (`[data-testid="pr-index"]`) — not the
list-mode diff preview in `<main>`, which does also carry a
`[data-change-active]` but is not where the reviewer just pressed. So `Enter`
from the index opens the menu **at that row**, not somewhere else on the
screen. **At stop 1** (the PR-wide `'pr'` menu while `state.showDescription`
is true — `isDescriptionMenu()` in `home.mjs`, applies to both `Enter` and
`/` there) the menu anchors on the **description card**
(`[data-testid="pr-info-card"]`) and takes the **full width of the
description column** (`[data-testid="pr-info-column"]`, 26rem) — mirroring
the block-index exception; because the card is tall, the menu there usually
flips above/over the column (the existing flip+clamp), but it always sits
next to the description instead of in the diff region to the right. Outside
stop 1 the `'pr'` menu (`/`) keeps the default diff positioning. Test:
`tests/pr-description-menu.spec.mjs`. **If it doesn't fit below the screen,
it flips above** (and is clamped within the viewport regardless). It starts
`visibility:hidden` until `positionMenu` has placed it (no flash top-left),
and repositions on resize, scroll (capture, also inner scrollers), after
every keystroke (the filter list changes height) and 220ms after opening
(the panel width animates 200ms when stepping into the diff). The menu lives
in a separate `reactive({ open, query, sel })` in `home.mjs` (deliberately
**not** in the URL — ephemeral, so outside `bindUrlState`). While it is open,
the menu **owns the keyboard**: `onKeydown` handles `↑`/`↓` (selection),
`Enter` (execute via `runCommand`, which closes first and then runs the
action), `Esc` (close), and block navigation is suspended; typed characters
flow into the focused input (`data-testid=command-input`, two-way bound to
`menu.query`). Filtering uses a **subsequence fuzzy match**
(`filterCommands`, exported from `CommandMenu.mjs` so the keyboard handler
walks exactly the same filtered list as the render — `menu.sel` and the
visible rows stay in sync). The `COMMANDS` list lives in `home.mjs` and
contains **block actions**: toggling approve and commenting on this line
(via `startComment` from `RelatedPanel.mjs`) and **Open GitHub**. The approve
action is **scoped to the current navigation unit** (`toggleApprove`/
`approveTargetRows`): in list mode the whole block, in diff mode the
selected group/line/call — it approves exactly the rows of that unit (or
retracts them if they are already approved).
**`focusLevel`/`drillCursor`-aware:** a drilled Underlying-code column
(`state.focusLevel > 0`, see "Drilling"/"Column navigation" in
`.claude/rules/detail-layout.md`) has its own block plus its own
`change`/`gran` cursor (`state.drillCursor[focusLevel-1]`) — the approve
action must operate on that, not on the top-level block. `approveContext()`
(`home.mjs`) resolves that once (`{ block, mode, gran, change }`, mirroring
`findNextUnapproved`/`fKey`/`dKey`/`setDrillGran`'s own `focusLevel` branch);
`approveNoun`/`approveTargetRows`/`toggleApprove`/`toggleCallApprove` and the
`COMMANDS` label take that context instead of reading `curBlock()`/
`state.gran`/`state.change` directly. Without this, `Enter` → "Approve …"
would invisibly approve/retract the TOP-LEVEL block instead of the drilled
child while a drilled column owned the keyboard — see
`tests/drill-approve.spec.mjs`.
The label is a function so it moves live and names the unit
(`approveNoun`): "Approve this block" (list), "Approve these lines" (group),
"Approve this line" (line), "Approve this call" (call), and "Retract approval
of …" when that unit is already approved. See the granular-approval
explanation in `.claude/rules/blocks-and-ingest.md`. Deliberately **no**
navigation items (step in diff / next / previous) — you do that with the
arrows/`f`/`d`/`s`, not via the menu. A command may have **`children`**:
choosing it then doesn't open an action but a **submenu** with those
children instead of closing the menu (`runCommand` → `enterSubmenu`, which
resets the query/selection and repositions). `Esc` first steps back to the
root and only then closes the menu; `menu.sub` (in the ephemeral `menu`
reactive) holds the open child list, `resolveCommands` filters that instead
of `COMMANDS` (without the comment fallback). So **Open GitHub** has two
targets underneath it: *Line in Files changed* — deep-links to the active
line in the Files-changed diff (`openGithubLine`: the GitHub anchor
`#diff-<sha256(path)><R|L><line>`, where the line is the `start` of the code
side plus the offset of the active unit; new side = `R`, removed block =
`L`) — and *PR page* (the PR overview page, as before). If filtering
yields **nothing** for a non-empty query, the menu falls back to one item,
**"Create a comment with this"**, which starts the typed text directly as a
comment task on the selected line (`createComment` from `RelatedPanel.mjs` →
`POST /api/workflows/task_code_comment`, so within the write boundary). The
filter + fallback live in `resolveCommands(query)` in `home.mjs`, shared by
the menu render and the keyboard handler so both see the same list.
`CommandMenu` itself is pure presentation: it receives `menu`, a
`resolve(query)` function and `onRun`, and contains no filter or navigation
logic.

**Every (small) menu opens with a pinned `"Close menu"` at the top, and
starts focused on the 2nd item.** `withClose(list, onClose)` (`home.mjs`)
prepends that item to every root list (`COMMANDS`, `PR_COMMANDS`,
`COMPOSE_COMMANDS`, `COMMENT_COMMANDS`, `POSTAPPROVE_COMMANDS`,
`REVIEW_APPROVE_COMMANDS`, `REVIEW_CHOICE_COMMANDS`) as well as every submenu
(`children`, incl. "Open GitHub" and the PR-wide/compose Jira submenus) —
choosing it in **any** case closes the entire palette, even from a submenu
(`Esc` still just goes one step back to the root, unchanged). `postApprove`'s
own `onClose` also clears `postApproveTarget` while at it — mirroring the
old, separate close items it now replaces (those previously sat as the
**last** item; now there is only one shared definition, always at the top).
To prevent that fixed first row from becoming the default Enter action,
every fresh menu/submenu opens **on the 2nd item** (`defaultSel(list)` =
`Math.min(1, Math.max(0, list.length-1))`, used in `openMenu`/`enterSubmenu`/
the Esc-back-to-root branch in `onKeydown`) — falls back to index 0 as soon
as a list has 0 or 1 real items. This deliberately does **not** apply to the
`reviewReject` step (the free-text rejection reason, further on — a dynamic
0/1-item list) and the "no match" `make-comment` fallback above: both are
separate, dynamically built actions where a pinned close + start-on-2nd-item
"type, Enter" would break. The per-keystroke `sel` reset
(`CommandMenu.mjs`'s `@input` handler) stays at `0` — that simply points to
the top row of the currently filtered result, not "the 2nd item of the full
list".

**After approving via the palette** (not via the top checkbox on the block
card — that remains a directly toggling click with no follow-up), if there
is still a next unapproved unit, a **follow-up menu** opens immediately
(`menu.mode = 'postApprove'`, `POSTAPPROVE_COMMANDS` in `home.mjs`): **"Close
menu"** (pinned at the top) or **"Continue to the next unapproved
code"** (default, the 2nd item where the selection opens — only navigates,
does not auto-approve anything). This only triggers
if the action **added** approval (`toggleApprove`/`toggleCallApprove`
detect that via `allIn`/`keys.has(key)` **before** the mutation — retracting
an approval never opens this menu) and there is actually still something
open (`afterApproveAction` → `findNextUnapproved()`; nothing left open → the
menu simply stays closed, as always).

**Exception: if the next unit stays within the same block,
`afterApproveAction` skips this follow-up menu and navigates right away** —
asking "continue or not" is pure friction when there's nothing else to
choose besides continuing within the block the reviewer is already looking
at. This is exactly step 1 below (`findNextUnapproved`'s "further within the
column that currently owns the keyboard" branch): the plan then has an
**empty `path`** and `root === state.selected` (no drill, no child block, no
other top-level block). `afterApproveAction` checks those two fields (plus
`!keepList`, so that an approval from the block index — which leaves
nothing else in that same block anyway — never hits this path) and in that
case calls `applyNextUnapproved(target)` directly instead of
`openMenu('postApprove')`. Any other outcome (down into a child subtree, up
to a sibling, or on to another top-level block — steps 2-4 below) still
shows the follow-up menu. "Next" follows the review **tree**, not just the
flat sidebar list, depth-first
(`findNextUnapproved` in `home.mjs`, four steps on each call):

1. **Further within the column that currently owns the keyboard** — the
   top-level block (`state.gran`/`state.change`), or — if there is a drill
   (see "Drilling"/"Column navigation" in `.claude/rules/detail-layout.md`) —
   the drilled column at `state.focusLevel`, with **its own**
   `state.drillCursor` cursor (`firstUnapprovedOwnUnit`, unchanged,
   forward-searching at the current granularity, now also applied to a
   drilled column instead of only the top-level block).
2. **If that column is done, then down** into its **Underlying-code**
   children (`orderedChildBlocks` — the same order the panel shows,
   `relatedChildren`'s groupTier/prio/size sort, excluding `covered_by` to
   avoid the method↔test cycle — see `directChildBlocks`/
   `nestedPrBlocks` in `.claude/rules/blocks-and-ingest.md`), depth-first per
   child (`firstUnapprovedInSubtree`, cycle-safe via a `seen` set, mirroring
   `nestedPrBlocks`): first the child itself starting from its first
   `'group'` unit, otherwise its own children, and so on.
3. **If the entire subtree of the focused column is empty, then up**: back
   to the parent in the current drill stack (an earlier drilled column, or
   the top-level block) and try its **next, not-yet-tried** sibling child
   (again depth-first via `firstUnapprovedInSubtree`) — repeated upward
   through the whole drill stack.
4. **If the entire subtree of the current top-level block is also empty**
   (or the reviewer wasn't even in its diff), then **continue through
   `state.blocks`** in sidebar order — now also **subtree-aware**
   (`firstUnapprovedInSubtree` per candidate instead of just its own
   `'group'` rows): a top-level block that only has an Underlying-code
   child still open is no longer skipped.

With lazy `ensureCode` fetches for every visited block, just like the
look-ahead preview. Only **forward**, no wrap and no searching back to
previously skipped units. `findNextUnapproved` returns a plan
`{ root, path, gran, change }` (`root` = top-level index, `path` = the chain
of PR blocks to drill through, empty = the top-level block itself) and
stashes it in `postApproveTarget`; "Continue" applies it via
`applyNextUnapproved`, which trims the current `state.drill` to the common
prefix with `path` (mirroring `expandColumn`'s trim) and then drills only
the remaining part (`drillIntoChild`) — without unnecessarily tearing down
the whole stack for a nearby sibling step. On a different `root` (a
different top-level block) it resets as before (`openTask`'s block-switch
reset: `state.drill`/`drillCursor`/`focusLevel` cleared). All of this
without recomputing — the palette owns the keyboard while it's open, so the
navigation state can't have shifted in the meantime. This is a one-off step:
after navigating, **no** new follow-up menu opens automatically — the
reviewer approves the new unit themselves again with `Enter`.

**From the block index, "Continue" stays in the index.** If the reviewer
pressed `Enter` while `state.mode==='list'` was true (see above: the menu
then already anchors on the sidebar row, not the diff preview), the old
"Continue" would still step into the diff — that feels like a jump away from
the index while you were just there. `afterApproveAction` therefore captures
**synchronously**, before the async `findNextUnapproved()` gap,
`keepList = state.mode !== 'diff'` and stashes it along
in `postApproveTarget` (`{ ...target, keepList }`) — synchronously because
`state.mode` may have already changed by the time the promise resolves, but
at the moment of the approve action itself it's exactly the context the
reviewer pressed it from. `applyNextUnapproved` branches on `target.keepList`:
if true, it moves **only** `state.selected` (to `target.root`) +
`scrollSelectedIntoView()` — `target.path` is ignored (no `state.mode`/
`gran`/`change`, no diff entry, no drill), so even if the found plan would
run through an Underlying-code child, "Continue" from the index stays at the
plain list step — drilling only makes sense once you're in the diff. If
false, the existing path (drills to `target.path` if needed and jumps into
the diff of the new unit). The `postapprove-next` label (the 2nd item of
`POSTAPPROVE_COMMANDS`, after the pinned "Close menu" — see above)
is for that reason also a **function** (instead of the previous bare
string), read at snapshot time (`openMenu` → `snapshotCommands`, right after
`postApproveTarget` is set — the same safe, non-reactive timing as the
`approve` label): "Continue to the next unapproved **block**" when
`keepList`, otherwise the existing "... **code**" text.

**The postApprove follow-up menu opens at the SAME spot as the menu you
approved with, even if the approved row has meanwhile disappeared from the
index.** `isIndexMenu()` already counts `ms.mode === 'postApprove'`, so
`menuAnchor()` tries the same thing for both menus:
`[data-idx="${state.selected}"]`. But if the reviewer fully approved a
block, that row disappears from the sidebar right away (auto-hide of fully
approved blocks, see
`blocks-and-ingest.md`) — and that happens before the follow-up menu opens
(`afterApproveAction`'s `findNextUnapproved().then(...)` runs after the
approve mutation). Without a countermeasure, `menuAnchor()` would then fall
back to the **whole** `[data-testid="pr-index"]` aside: that bounding rect
is much taller than one row, and `positionMenu()`'s flip-above calculation
(`top = a.top - gap - mh`, clamped to `Math.max(gap, …)`) would throw the
follow-up menu all the way to the top of view instead of at the spot of the
first menu. `lastIndexRowRect` (`home.mjs`,
module-level `let` next to `isIndexMenu`) caches the row's
`getBoundingClientRect()` as long as it still really exists; if the row
disappears, `menuAnchor()` reuses that cached rect (as a small
duck-typed object with only `getBoundingClientRect()` — `positionMenu()`
never calls anything else on the anchor) instead of the full aside.
`openMenu(mode)` resets the cache on every open that is **not** an approve
follow-up (`isReviewFollowup(mode)` — see
below, covers both `postApprove` and the three review-submit modes), so it
never leaks an old position from an earlier, unrelated session — every
normal open rebuilds it right away once its own anchor row is visible.
Test: `tests/postapprove-menu.spec.mjs` ("blokken-index stays there").

**No more "next": the review-submit follow-up menu (`reviewApprove`/
`reviewChoice`/`reviewReject`) — submitting a real GitHub PR review.**
`findNextUnapproved()` searches **only forward** from the current
position (see its own doc comment in `home.mjs`) — a `null` result thus
means "nothing left *ahead of me*", not necessarily "everything in the PR
is done" (an earlier skipped or never-visited block may still be open).
Where `afterApproveAction` previously silently ignored this case (the menu
stayed closed), it now opens one of two follow-ups, based on
`state.approvalTotal` (the PR-wide combined approval counter across every
top-level block plus its nested/drilled PR-block children — see "Combined
approval per tree" in `blocks-and-ingest.md`), read after a few `await
Promise.resolve()` microtask ticks (the same `loadBlocks` precedent wait —
the `approvalSummaries`/`approvalTotal` watch is decoupled and only fills as
a microtask, not synchronously with the just-reassigned `b.approvedRows`):
- **Everything approved** (`approvalTotal.done === total`, `total > 0`) →
  `menu.mode = 'reviewApprove'` (`REVIEW_APPROVE_COMMANDS`): **"Close menu"**
  (pinned at the top) / **"Approve the PR"** (default, the 2nd item) — there
  is nothing left to reject, everything has already been reviewed.
- **Not everything yet** (something is still open, somewhere outside the
  scope of the forward search — e.g. an earlier block the reviewer hasn't
  reached yet) → `menu.mode = 'reviewChoice'` (`REVIEW_CHOICE_COMMANDS`):
  **"Close menu"** (pinned at the top) / **"Approve the PR"** (default, the
  2nd item) / **"Reject the PR"** — the reviewer explicitly decides here
  whether to submit the PR despite the remaining open items, or request
  changes first.
Both "Approve the PR" items call **`submitReview('APPROVE')`** — a real
GitHub PR-level review, via `POST /api/workflows/submit_review {pr,
event, body}` (the sanctioned write path, see `workflows-write-boundary.md`;
the workflow/Activity/the endpoint itself do not live in `home.mjs`, only
this call site). **"Reject the PR" doesn't post right away** — GitHub (and
the backend's `validateSubmitReview`, 400) reject an empty
`REQUEST_CHANGES` body, so it instead opens **`menu.mode = 'reviewReject'`**:
a **free-text** step that reuses the existing palette textarea (`ms.query`)
as a reason input field instead of building a new composer. `rootCommandsFor`
returns no static list for this mode; `resolveCommands` instead builds
**one** command directly from the typed text, and **only**
once it's not empty — an empty query yields `[]`, which via `onKeydown`'s
existing `if (list[ms.sel]) runCommand(...)` guard makes `Enter` a no-op
(not a silent close without sending anything). `CommandMenu.mjs`'s
placeholder changes for this mode too ("Type the reason for rejection
(required)…", the same per-mode ternary as the existing `compose` branch) as
the only instruction — there is no separate label for it. As soon as there
is text, the list shows exactly one row ("Reject the PR with this reason");
that calls `submitReview('REQUEST_CHANGES', reason)` with the typed text as
the body. Error handling is deliberately minimal (`console.error` on a
non-200 or network error) — this app has no toast/error-surface convention
anywhere (even `createComment` doesn't check `res.ok`, see
`conventions.md`); a successful submit is itself a fresh workflow run, so
`submitReview` calls `pollWorkflows()` so it shows up in "Tasks" before the
next `WORKFLOWS_POLL_MS` tick (the same existing courtesy as
`compose-post`/`compose-self`).
All three new modes share `isIndexMenu()`/`lastIndexRowRect`'s
anchor-cache exception with `postApprove` (via `isReviewFollowup(mode)`,
`home.mjs`): just like the existing `postApprove` follow-up menu, they can
open after the just-approved row has already disappeared from the sidebar.
Test: `tests/review-submit-menu.spec.mjs` (both follow-ups + the
reject-reason flow, incl. the exact `POST /api/workflows/submit_review`
payload) and the updated last test in `tests/postapprove-menu.spec.mjs`
("nothing left ahead, PR not fully approved").

The same menu mechanism also serves a **comment-scoped** variant: if the
keyboard is on a placed comment row in `RelatedPanel` (`cs.focus === 'comment'`,
before stepping into the thread) and the reply field is still **empty**,
`Enter` opens not the block palette but a menu with three rows — **"Close
menu"** (pinned at the top), **"Resolve comment"** (default, the 2nd item,
where the selection opens) and **"Delete comment"**
(`menu.mode = 'comment'`, `COMMENT_COMMANDS` in `home.mjs`; `resolveCommands`
switches on `menu.mode`, `openMenu(mode)` sets it, `closeMenu` resets it back
to `'block'`). A **non-empty** reply field leaves `Enter` alone — then the
reply field's own `keydown` wins (`sendReaction`), so "type a quick reply,
press Enter" keeps working (`isCommentFocused`/`commentReplyEmpty` in
`RelatedPanel.mjs` guard that distinction). `menuAnchor`/`menuRegion` anchor
in that mode on the focused comment row resp. the thread pane instead of the
diff. Choosing **"Delete comment"** calls `deleteFocusedComment`: that sends
a **`delete` Signal** (`POST /api/workflows/{runID}/signals/delete`) to the
comment's Workflow Execution — the only write path, within the write
boundary. The workflow (`taskCodeCommentWorkflow` in `workflows.go`) first
sets the comment to status **`deleting`** (Activity `markCommentDeleting`),
then removes it from GitHub (Activity `deleteGithubComment`, best-effort,
same as posting) and finally from its own read model (Activity
`deleteComment`, cascades the reactions), and completes the Execution. A
`delete` request rides along on the same `reply` Signal as a reaction
(`ReactionSignal.Action`, "" = reaction, "delete" = deletion) — a workflow
can only `WaitSignal` on one Signal name at a time, so this has to come in
as a distinguishable variant of the existing reactions loop, not as its own
Signal name.
Choosing **"Resolve comment"** calls `resolveFocusedComment`: that sends —
just like a thread reply — a **`reply` Signal** with `done:true` and the
sentinel body `"/resolve"`. The workflow sets the read-model status to
`resolved` (via `saveReaction`'s `Resolves` flag) and, for a
**review-diff thread**, also resolves the conversation **on GitHub**
(Activity `resolveGithubThread` → `github.Client.ResolveReviewThread`,
which via `gh api graphql` looks up the review-thread node ID based on the
root comment's `databaseId` and runs the `resolveReviewThread` mutation).
The `"/resolve"` sentinel body is **never** posted as a text reply — the
reply loop only ever posts a real, non-sentinel body. A **PR-wide** thread
(issue/review-summary) has no GitHub resolve concept, so resolve stays
local-only there (see
`.claude/rules/tembed-workflows.md`).

That same `CommandMenu` mechanism also serves a **comment-type menu**
(`menu.mode = 'compose'`, `COMPOSE_COMMANDS` in `home.mjs`): if the composer
is open and text has been typed, **`Enter`** (and the composer button
**"Place…"**, via `RelatedPanel`'s `openCompose` prop) doesn't immediately
place the comment, but opens a menu with six rows for what to do with it:
**"Close menu"**
(pinned at the top), **"Place comment"** (the **default** item, the 2nd in
the list, where the selection opens — so "type, Enter, Enter" still places
it just as directly as before), *Claude command* (placeholder), *Let Claude
implement this
(group/line/call)* — placeholder, label names the current unit via
`granNoun()` from `commentTarget()` —, *Only for myself* and *Jira* (a
submenu with *Comment on ticket* / *Create subtask* / *Create new task*,
all three placeholders). **"Place comment"** and **"Only for myself"**
both actually place it: `placeComment(state, commentTarget)` resp.
`placeComment(state, commentTarget, { local: true })` — the first posts a
**normal, public** comment (the same existing `createComment` path, just
without `opts.local`), the second a **private note** which is stored as a
comment but does not go to GitHub (see the `local` flag in
`.claude/rules/tembed-workflows.md`). Both `run` functions are `async` and
call `pollWorkflows()` right after a successful `placeComment` — without
that, the just-started `task_code_comment` run would only show up in the
Tasks column (`workflows-panel`, see
`.claude/rules/detail-layout.md`) at the next `WORKFLOWS_POLL_MS` tick
(2.5s) instead of immediately. The Claude/Git/Jira items remain placeholders
(no `pollWorkflows` call, they write nothing). The Enter branch sits in
`onKeydown` **before** the `relatedActive()` branch
(`isComposeOpen()` + `composeHasText()`, both from `RelatedPanel.mjs`), so
it works whether the composer was opened via keyboard (`cs.focus==='new'`)
or via the button; **Shift+Enter**
falls outside that and thus remains a newline in the composer. Important:
this was the first flow to open a menu **over** the open composer — which
surfaced a latent arrow.js orphan-binding bug (menu-reopen crash), fixed
with the fresh-`ms` state split, see `.claude/rules/conventions.md`.

**`/`** opens a **general, PR-wide tree menu** (`menu.mode = 'pr'`,
`PR_COMMANDS` in `home.mjs`) — the same `CommandMenu` overlay as `Enter`, but
instead of block actions these are actions on the **whole PR**. Six root
items: **"Close
menu"** (pinned at the top, where the selection has recently always opened
on the item after it), **"To PR overview"** (navigates to
`/pr-overview`, and thus the default item where the selection opens),
**"GitHub"** and **"Jira"** (as a **submenu** via the existing `children`
mechanism — each submenu itself also gets such a pinned "Close menu"),
**"Check the whole PR for risks"** (starts
`code_warning`, see `checkPRWarnings`/`.claude/rules/tembed-workflows.md`), and
**"Show full description" / "Collapse description"** (the last item,
a label function that toggles `state.descriptionExpanded` — the same
ephemeral flag as the in-card "more…" affordance in the PR info column, see
`.claude/rules/detail-layout.md`; the label is snapshotted once at open time
by `snapshotCommands`, so no reactive binding leaks into the
`CommandMenu` tree). Under
GitHub: *Open on GitHub* (opens the PR page) and *Place comment* (reuses
the line-comment composer `startComment`, same as the block palette). Under
Jira: *Open in new tab* (deep link to the ticket), *Place comment* and
*Create subtask* — the latter two are **placeholders** (no Jira write
integration yet). A typed `/` in a focused input field (comment
composer/reply) never reaches this handler — the `relatedActive()` branch
catches it earlier, so the character just flows into the field. The
Jira/GitHub links rely on **PR metadata** (title + URL, and the
`KEY-123` ticket key derived from it): that comes from the **`prmeta` read
model** via `GET /api/pr?pr=N`, filled by the `pr_status` workflow (see
`.claude/rules/tembed-workflows.md`). `home.mjs` (`loadPRMeta`) ensures on
load that the tracker is running
(`POST /api/workflows/pr_status`) and then reads the metadata; if that's
missing (yet),
the links fall back to the bare PR URL resp. the Jira base.

- **`'list'`** (start): `↑`/`↓` choose a block in the sidebar, `→` steps into
  the diff of the selected block — even if that block has **0 change groups
  of its own** (a real PR block whose own body changes nothing and which
  only exists as a parent of Underlying-code children, e.g.
  `CreatePaymentAction::findOrCreateCustomer`): `→` then still steps into
  `state.mode==='diff'` and shows the (unhighlighted) block code, so a
  subsequent `→` can continue on into Underlying code — exactly like `→` in
  the PR summary card (stop 1) always unconditionally steps to the block
  list. `enterDiff()` (`home.mjs`) previously had a `groupsFor(b).length ===
  0` guard here that silently did nothing; that has been removed (only a
  missing block itself is still a no-op). `ensureCode`'s separate "diff
  without own groups → back to list" fallback was removed for the same
  reason: that combination is now a deliberately reachable, non-dead state,
  even outside a drilled column (`focusLevel===0`) — it was already excluded
  as soon as there was a drill, see
  `tests/drill-mode-flip.spec.mjs`. See `tests/enter-diff-zero-groups.spec.mjs`.
  Fully approved top-level blocks are
  **hidden** by default from this list (a button at the bottom expands them);
  the "Start" heading shows a PR-wide approval counter. See the section
  "Hiding approved blocks" + "Server-side `total`" in
  `.claude/rules/blocks-and-ingest.md`.
  **`↑`/`↓` skip a hidden (approved) block** (`stepVisibleSelected`
  in `home.mjs`, used by both the normal and the search-box-active
  ArrowDown/ArrowUp branch): `state.selected` is a raw index in
  `state.blocks`, but `BlockList.mjs`'s `renderList` renders no row for a
  hidden (approved) block. Without this step, `state.selected` would
  sometimes land on such an invisible index — no row in the sidebar would
  show the indigo highlight, which felt like "this block is no longer
  selectable", especially after a lot of ↓/↑ deep into a review session with
  several already-approved blocks. If there's no visible block left in that
  direction, the selection just stays at the current (already visible)
  position instead of landing on the hidden tail.
  **The same gap existed on the load/search paths, and each resolves it
  differently** (`revealSelectedIfHidden`/`clampSelectedToVisible` in
  `home.mjs`):
  - **Load/refresh-restore → reveal.** A refresh restores `?sel=file:line`
    even to a hidden block (`applyBlockRefRestore`) — that's the reviewer's
    **own** position, so instead of moving the selection away,
    `revealSelectedIfHidden` opens up the approved section
    (`state.showApproved = true` + `scrollSelectedIntoView`): the block
    becomes visible and stays selected/highlighted. Already visible → no-op.
  - **Search → clamp.** `setSearch` resets to index 0 — a synthetic
    landing, not the reviewer's own position. Typing should never suddenly
    reveal all approved blocks PR-wide (and doesn't type back closed), so
    there `clampSelectedToVisible` moves the selection to the **first
    visible** match (no visible block → selection stays put, mirroring
    `stepVisibleSelected`; the search filter itself needs no separate check
    — a filtered-out block simply isn't in `state.blocks` anymore).
  Both use exactly the same `isFullyApproved` criterion as `renderList`.
  **↓ past the last visible block lands on the "Show/Hide N
  approved blocks" button itself** (`state.toggleFocused`, `stepListSelection`
  in `home.mjs` — replaces the bare `stepVisibleSelected` call in both
  ArrowDown/ArrowUp branches above): the button was previously only reachable
  with the mouse. `stepListSelection(1)` falls back to `stepVisibleSelected`
  and, only if that finds nothing further (`next === state.selected`) and
  the button actually exists (`toggleRowVisible()` — there's at least one
  approved top-level block, regardless of `showApproved`), sets
  `state.toggleFocused = true`; `state.selected` stays unchanged, so the
  button is an extra, final stop on top of the blocks, not a replacement.
  `BlockList.mjs`'s `toggleRow` then shows the same indigo bg/ring as a
  selected row (and dims the row highlight of the underlying
  `state.selected` block, so there are never two indigo highlights visible
  at once). **`↑`** from the
  button (`stepListSelection(-1)`) simply sets `toggleFocused` back to
  `false` — the last block was and remains `state.selected`, so this is
  purely a focus step, not re-navigation. **`Enter`/`→`** there toggle
  `state.showApproved` (mirroring a click on the button) instead of opening
  the command menu resp. stepping into the diff; **`f`/`d`/`s`/`a`** are
  no-ops while the button owns the keyboard (there's no block/diff context
  to act on). A click on a regular row, or typing in the search box
  (`setSearch`), always resets
  `toggleFocused` to `false` — a new navigation context never silently
  leaves the button focused.
  Order is load-bearing: on the load path the reveal only runs **after**
  `applyBlockRefRestore` (a restored `?sel=` to a visible block is a
  no-op) and after `loadBlocks` has awaited `loadApprovals`/`loadBlockStats`
  plus a couple of microtask ticks so the `approvalSummaries` watch has
  flushed (the `openTask` precedent) — before that, "hidden" isn't yet
  knowable and the reveal would be a no-op. The **live** approve flow stays
  deliberately untouched: approving a block while standing on it keeps it
  selected (there is **no** reveal/clamp attached to the `approvalSummaries`
  watch itself). Regression test: `tests/selected-reveal-hidden.spec.mjs`.
- **`'diff'`**: `↑`/`↓` walk through the **changes** of that block, `←` steps
  back to the list. Walking past the **last** change (`↓`) or the
  **first** (`↑`) — you can't go further within this block — steps you on to
  the **next** resp. **previous** block, **provided that block comes from the
  same file** (the same blocks that hang together via the dotted connector
  line); if you land on a file boundary, navigation stops there. When
  stepping across, you land on the first resp. last change (`stepBlock`,
  which does the file check via `sameFileNeighbour(delta)`), so you can
  walk through all the diffs of one file without going back to the list. If
  the neighbor block's code is still loading, `pendingLast` remembers that
  you want to land on the last change; `ensureCode` resolves that once the
  rows are known. If you're on the **last** (resp. **first**) change and
  there's a next (resp. previous) **same-file** block, a **grey step-chevron
  _outside_ the
  block card** appears — below the card (for `↓`) just above the dotted
  connector line, or above it (for `↑`) — as a hint that the arrow will take
  you to the neighboring block (`stepChevron`/`canStep(delta)` in `home.mjs`,
  rendered in the block column next to the cards). The slot that toggles
  this chevron (`stepChevronSlot`) deliberately has a **stable element
  root** (a static `display:contents` wrapper) — a bare keyed `${…}` wrapper
  made the chunk `ref` go stale here and corrupted the keyed reconcile of
  the block column (the disappearing preview card + tab hang under repeated
  ↓/↑ through same-file blocks); see the "bare toggling expression"
  pitfall in `.claude/rules/conventions.md`. This is separate from the
  **green scroll chevron _inside_ the card** (`scrollHint`/`updateHints` in
  `Block.mjs`), which now only means "there are changes off-screen —
  keep scrolling within THIS block". Grey + outside = you're leaving the
  block; green + inside = keep scrolling.
  At a file boundary (no same-file neighbor), the grey step chevron stays
  hidden.

In `'diff'` mode, **`→`** steps into the **Underlying-code card**
(`enterRelated` in `RelatedPanel.mjs`, `cs.focus === 'code'`) and lands on
the **first** child block (`cs.codeSel = 0`). All the child blocks stack
vertically at full width (no side-by-side hint anymore) and the card is a
**pure list navigation**: **`↓`** selects the **next** child block (stays on
the last), **`↑`** the **previous** child block — from the **first** child
block, **`↑`** goes back to the diff instead (`exitRelated`). **`←`** goes
from any child block back to the diff (`exitRelated`). This card no longer
has a `→` that leaves it — that used to jump to the comments column, but
comments/tasks are no longer part of this chain (see above and "Comments/tasks
sidebar" in `.claude/rules/detail-layout.md`); those are only reachable via
Cmd+→ now.
This panel cursor
(`cs.focus`/`codeSel`/`sel`/`threadPos`) lives in the **URL** under its own
`rel` namespace (`rel.foc`/`rel.code`/`rel.csel`/`rel.thr`, via
`bindUrlState(cs, …, { ns:'rel' })` in `RelatedPanel.mjs`), so a refresh
puts you back exactly on this child block / this comment thread;
`applyRelRestore` reapplies the restored cursor once, clamped, once the
children/comments have loaded
(see `.claude/rules/detail-layout.md` and skill `url-state`). **`Enter`** on
the card **drills** into the child
the cursor is on (`focusedRelatedChild()`) — and a **mouse click** on an
Underlying-code item (`data-testid=related-item`) drills into that child,
along
the same path: the child opens as its own
diff column to the right of the existing ones, between those columns and
`RelatedPanel`
(`drillIntoChild`, see the "Drilling" section in `.claude/rules/detail-layout.md`),
and the Underlying-code panel + the tasks/chat below it jump along to that
level (`focusedBlock()`). This applies **always to the focused child**; if
no child is focused (empty list) then `Enter` does nothing — unresolved
calls are **automatically** picked up by the LLM search without a key or
button (see
`startCallSearch` + the `setRelated` watch in `home.mjs`). Right after
drilling, keyboard focus sits on the **diff** of the new column, not on its
Underlying-code panel (`drillIntoChild` calls `leaveRelated()` — the
exported `exitRelated` — instead of `enterRelated()`); from there you walk
with `↑`/`↓` through the change groups of that column, and **`←`** closes the
focused drilled column, after which focus falls back to the diff of the
parent column (the closed child reappears in that parent's Underlying-code
list) — repeated `←` peels back level by level to the original top-level
block, where yet another `←` finally exits the whole diff session (and then
also clears the remaining drilled-column state). Every column that doesn't
currently have focus collapses into a narrow rail (icon + truncated
label); a **mouse click on such a rail**
is a shortcut that functionally does the same as repeated `←` — it
jumps directly to that level (`expandColumn`) and discards everything
drilled further. See the section
"Column navigation" in `.claude/rules/detail-layout.md` for the full
`state.focusLevel` mechanism + the rail. `←`/`Escape` from the first
position of the
Underlying-code panel (`cs.codeSel === 0`) gives keyboard focus back to
the diff of **that same** column (`handleRelatedKey`'s `exitRelated()`) —
that is no longer a separate "pop" step, the column-by-column navigation
above only follows once
`relatedActive()` is `false` again. This code branch (`cs.focus === 'code'`)
is entirely separate from the comments/tasks sidebar in `handleRelatedKey` —
see "Comments/tasks sidebar" in `.claude/rules/detail-layout.md` for that
navigation. Visually: all child blocks stack vertically at full
width (no arrow hint anymore); the selected child block gets an indigo ring
(`data-active=true`). See `.claude/rules/detail-layout.md`.

When stepping in (`→`), selection jumps to the **first changed line**
(added, removed, or modified) — `state.change` is the index. The
navigation units come from `changeGroups(rows)` in `Block.mjs`: consecutive
changed rows (del/ins) count as **one** group, but a run longer than 5
rows gets cut into chunks of 5 (`MAX_GROUP`). That cut only happens on
a row that contains a **letter (A-z)**: a changed row consisting purely of
brackets/punctuation (e.g. `}` or `{`) gets pulled into the current group
instead of starting a new one (`hasLetter`), so a group never ends
right before — or on — a bare-bracket line. `blockRows(b)` produces exactly
the same aligned rows as the render, so navigation and highlight never
diverge. The selected block gets the active group passed in as a reactive
`activeGroup` function (reads `state.mode/selected/change`), so the pane
re-highlights without the whole `DetailPanel` re-rendering. The active rows
get a stronger tint + an inset left bar (`shadow-[inset_3px_0_0_…]`, no
layout shift) and the first row a `data-change-active` anchor; `home.mjs`
scrolls that with `scrollIntoView({block:'center'})` to the middle of the
diff viewport.

## Selection granularity (`f` zoom in / `s` zoom out / `d` back)

Within a block you zoom with **`f`** (zoom in) and **`s`** (zoom out) through
three levels (`home.mjs`, `GRANS`). **`d`** is the "back" key which acts as
previous-call at the finest level (see below). All three step aside for a
held Cmd/Ctrl (`isModifiedKey(e)`, see the `a` section below) so
`Cmd+F`/`Cmd+D`/`Cmd+S` still reach the browser (find/bookmark/save)
instead of zooming:

- **`'group'`** (starting point when stepping in): a whole run of changed
  lines (`changeGroups`) — multiple lines at once.
- **`'line'`**: one changed line at a time (`changeLines`).
- **`'call'`**: one **call segment within** that line (`changeCalls`). Unlike
  the coarser levels, this doesn't split on *what* changed but on the
  **structure** — the calls the line makes — so you can later link each
  segment to the function it calls (an edge in the call graph). A line
  is split on `->`, `.`, `;` and the **binary separators** `??`, `&&`, `||`
  and the comparison operators (`==`/`===`/`!=`/`!==`/`<=`/`>=`)
  (`segmentCalls`; the `;` stays attached to its call, the separators lead
  — just like `->`/`.` — the next segment): `$order->customer()->name();`
  becomes `$order` /
  `->customer()` / `->name();`, and `$a->x ?? $b->y` becomes `$a` / `->x ` /
  `?? $b` /
  `->y` so the two callers around the `??` stay separated. **No** separator
  (would break real chains): `=>` (array `key => value` stays one segment),
  `::` (static call, belongs to the chain), the ternary `?`/`:` (clashes
  with `?->` and
  `::`) and a bare `<`/`>` (clashes with `->`/`=>`). The `.` boundary is
  mostly there for Vue/JS property access (`order.customer.name`), alongside
  PHP concatenation. The chosen
  segment characters get a **narrow underline** in the same indigo
  (`#6366f1`,
  `UNDERLINE_CLS`) as the inset left bar of the active row.

**Only new/adjusted lines are selectable at the finer levels, but on
`'call'` you walk through the whole line.** `'line'` navigates only along
the **new side** (the right/`ins` pane) and skips a pure deletion.
`'call'` splits the **whole** new line into segments — **every** segment is
landable, changed or not (later a relation will hang off it there), not
just the diff part. One exception: a **removed** line with no replacement
remains
landable too — as one empty new segment (nothing on the right) with the
whole old line underlined on the old side, so you can land on it as an
empty right-side row marking what's gone. (`'group'` remains a whole run
including removed
lines, so stepping in and the connector flow stay unchanged.)

**A completely empty (after `trim()`) added/removed line is not its own
landable unit at `'line'`/`'call'`, and doesn't count toward the approve
counter.**
Such a line is `rowChanged` (carries a del/ins mark — e.g. an empty line
between two statements within a fully added block) but has nothing
for the reviewer to read or judge; before the `rowHasContent` check
(`Block.mjs`, see also `.claude/rules/blocks-and-ingest.md`) you could
still select such a line (a visibly-empty `changeLines`/`changeCalls`
unit — "I can select it, but there's nothing there") and even approve
it, which let the approve counter (`changedRows`, and the backend `total`
in `blockstats.go`) run ahead of the number of actual code lines.
`changedRows`/`changeLines`/
`changeCalls` now additionally filter on `rowHasContent(r)` (the display
side —
`right` for `ins`, otherwise `left` — not empty after `trim()`).
**`changeGroups`
itself remains unchanged:** such an empty line just rides along within the
group run
it falls in (like a brackets-only line, see `hasLetter` above),
so the highlighted range of a group doesn't jump around it — only the
line's own countability/landability is suppressed.

All diff navigation goes through `unitsFor(rows, gran)` (now exported from
`Block.mjs`, shared with the footer) → `unitsOf(b)`; `state.change`
indexes the units of the **current** level. On a level switch,
`setGran` re-anchors the selection on the unit covering the current row
(`unitAtRow`): `f` from a group lands on its first line, `f` from a line on
its first
call segment, and `s`/`d` walk back up along the same rows.

The three navigation keys (`fKey`/`dKey`/`sKey` in `home.mjs`):

- **`f`** — zoom in. From `'list'` it first steps into the diff
  (`enterDiff`, which resets `gran` to `'group'`). In the diff it refines one
  level
  (`group → line → call`); if it's already at **`'call'`**, it instead steps
  to the **next call** (`nextChange` — the same flow as
  `↓`, so flowing on to the first call of the next **same-file** block).
- **`d`** — back. At **`'call'`** it steps to the **previous call**
  (`prevChange`,
  flowing on to the previous same-file block, just like `↑`); if you're at
  the
  **very first** call with no previous one to flow to, it zooms back out
  to `'line'`. At the coarser levels `d` simply zooms out one step.
- **`s`** — always zoom out one level (`call → line → group`), clamped at
  `'group'`. Unlike `d`, `s` at `'call'` never walks along previous calls but
  goes directly back to `'line'`, so you reliably escape the call
  selection.

`d`/`s` do nothing in `'list'` mode (there's nothing to zoom out of); only
`f`
steps in from there. `nextChange`/`prevChange` are shared with `↑`/`↓`, so
the arrows and `f`/`d` traverse the diff identically.

**`f`/`d`/`s` also work within a drilled column** (`state.focusLevel > 0`,
see "Drilling"/"Column navigation" in `.claude/rules/detail-layout.md`) —
exactly
the same group→line→call zoom, but on that column's own `{change, gran}`
cursor in
`state.drillCursor[focusLevel-1]` (`setDrillGran`/`drillNextChange`/
`drillPrevChange` in `home.mjs`, mirroring `setGran`/`nextChange`/
`prevChange`). A drilled column is a standalone diff, so there's no
same-file neighbor block to flow through at the first/last call at `'call'`
— but there **is** a sibling: if `f`/`↓` (or `d`/`↑`) walks past the last
(resp. first) call of the column, the column steps
sideways to the next/previous child in the Underlying-code list of the
**parent** column (at any level, any granularity — not just `'call'`), and
**replaces** itself with it at the same depth, instead of zooming back to
`'line'` as before. Only if there is no sibling left (or never was — an
only child) does `f`/`d` still zoom back to `'line'`, as before. See the
"Column navigation" section in `.claude/rules/detail-layout.md`
(`drillSiblingContext`/`drillToSibling`) for the full mechanism,
including the ↑ symmetry (lands on the previous sibling's **last** unit,
mirroring
`stepBlock`) and the adjusted `dKey` guard. If you refine a group that spans
exactly
**one line** (`cur.end === cur.start`), `f` skips the `'line'` level
and jumps straight to `'call'` (there's no meaningful line step then: the
line
*is* the group); `s`/`d` do still step back one at a time (`call → line →
group`). The
call underline
rides on `markChars` (a per-character class function): `paneHTML` passes
the
underline set of the active segment to `highlightChanges`, which renders it
via
`markChars` into the Prism-highlighted HTML. Changed characters recently
no longer get their own background
(that background marking has been removed — see the "Char diff" section
in `.claude/rules/blocks-and-ingest.md`);
the line background (red/green) now only marks a real change at the
line level. An empty added line has no characters and thus no underline
(correct: nothing to mark).

## Shift+↑/↓ — selecting multiple lines/groups at once (`state.rangeAnchor`)

At **`gran==='line'` or `gran==='group'`** (see `isRangeGran`),
**Shift+ArrowDown**/**Shift+ArrowUp** (`extendRange`/`drillExtendRange`,
`home.mjs`) extend the selection into a contiguous range of lines resp. a
merged run of change-groups, instead of moving the cursor one unit at a
time. The anchor (the unit index where the shift selection started) lives
alongside the existing `{change, gran}` cursor: top-level in
`state.rangeAnchor`, for a
drilled column as `rangeAnchor` on its own `state.drillCursor[level-1]`
entry (mirroring the rest of that cursor shape, see "Column navigation" in
`.claude/rules/detail-layout.md`). `rangeUnit(units, change, anchor)` merges
the
current unit and the anchor unit into one `{start, end}` row range (min/max
of their row indices) — treated everywhere else in the codebase as an
ordinary
(larger) unit, so the highlighting (`activeGroup`), the approve scope
(`approveTargetRows`/`approveContext`) and the comment anchoring
(`commentTarget`) didn't need deeper changes than "use the
merged unit instead of the single current one". This merge works identically
for a line unit and a group unit (both already carry a `{start, end}` row
range) — merging two separate groups can span an unchanged gap in between
(nothing else was selected there), which is fine: the highlighting/approve
scope still only act on the actually-changed rows within that range.

- **Only at `gran==='line'` or `gran==='group'`** (`isRangeGran`, the single
  gate both `extendRange`/`drillExtendRange` and every `rangeUnit` call site
  check). At `'call'` it's about segments within one line, not a vertical
  run — Shift+↑/↓ there is a no-op (`extendRange`/`drillExtendRange` return
  early).
- **Clamps at the block boundary.** Unlike a normal `↓`/`↑` (which flows on
  past the last/first unit to the next same-file block resp. the
  next/previous Underlying-code sibling — see above and
  "Column navigation") an active range never flows out of a block/column: it
  clamps at the first/last unit (of the active granularity) of the current
  block. Approve and comment operate per block, so a range spanning two
  blocks would have no meaningful sense.
- **Approve approves the whole range at once** — `approveTargetRows`
  now filters `changedRows` on the merged range instead of the single unit,
  so
  `toggleApprove`/the command-palette "approve" action (`Enter`) approves
  exactly
  the selected lines/groups (or retracts them). The label follows suit only
  at `gran==='line'`: `approveNoun` shows **"Approve these N lines"** once
  the range spans more than one line, otherwise unchanged "this line". At
  `gran==='group'` the label stays the existing, generic "these lines"
  regardless of how many groups are merged — a group already spans a
  variable number of rows, so there's no single natural "N" to name.
- **Comment uses the range as a multi-line anchor** — `commentTarget()`
  now also builds its code fragment/`startLine`/`endLine` from the merged
  range; `unitLineRange` already supported a multi-line range (for a
  `'group'` unit), so "Place comment" on an active Shift range posts a
  real multi-line GitHub review comment with no further changes needed.
- **The anchor clears** on any action that would overwrite the selection:
  `clearRangeAnchor()` — an ordinary (non-shift) arrow key
  (`nextChange`/`prevChange`/`stepBlock`/`drillNextChange`/
  `drillPrevChange`/`setDrillChange`), an `f`/`d`/`s` zoom
  (`setGran`/`setDrillGran`, which already builds a fresh cursor without
  `rangeAnchor` anyway), a block switch (`stepBlock`, `enterDiff`,
  `openTask`), and `←`/`→` (stepping out to the list, stepping into the
  Underlying-code panel). This is deliberately the same "an ordinary step
  releases the selection" behavior as in a text editor.

## `a` — cycling the diff view (split → new-only → fit → split)

**`a`** cycles globally, for **every visible diff card at once** — the
selected/preview card and every open drilled column (`state.drill`) —
through `DIFF_VIEW_CYCLE` (`home.mjs`, `['split', 'new', 'fit']`):
side-by-side (old+new, default) → **new-only** (only the right/new pane,
fixed 60% width) → **fit** (both panes again, but the card's width follows
the block's own code instead of a fixed number) → back to split. Sits next
to `f`/`d`/`s` in `onKeydown` (`home.mjs`), so with the same earlier guards
(command palette/search box/related panel active) in front — works in both
`'list'` and `'diff'` mode. **Extra guard, separate from those existing
guards:** `relatedActive()` (`cs.focus !== null`) doesn't cover every path
where a text field has DOM focus — `startComment()` (among others the
command-palette fallback "Create a comment with this") only sets
`cs.composing`, not `cs.focus`, so `relatedActive()` stays `false` there
while the composer does have focus. A literal "a" typed there would
otherwise be swallowed by this shortcut. Hence the `a` handler also checks
`document.activeElement` directly (`isEditableFocused()` in `home.mjs`:
TEXTAREA/INPUT → shortcut does nothing, key just flows into the field) — a
generic, future-proof guard that doesn't depend on which navigation state a
field happens to track or not.

**A held Cmd/Ctrl always steps aside for the browser/OS
(`isModifiedKey(e)` in `home.mjs`, shared with the `f`/`d`/`s` zoom keys,
see below):** `event.key` stays the bare letter `'a'` regardless of a
modifier, and the diff/code panes are plain, selectable text — not a
TEXTAREA/INPUT, so `isEditableFocused()` doesn't cover them. Without this
guard, `Cmd+A`/`Ctrl+A` while the reviewer's focus/selection was anywhere
near the diff toggled the diff view instead of letting the browser select
all text natively. `isModifiedKey(e)` (`e.metaKey || e.ctrlKey`) is checked
next to `isEditableFocused()` on the `a` handler, and next to the plain
letter check on `f`/`d`/`s` (and on the `state.toggleFocused` swallow list
that includes those same four keys) — so `Cmd+F`/`Cmd+D`/`Cmd+S` (browser
find/bookmark/save) also keep working. Test:
`tests/select-all-shortcut.spec.mjs`.

The state (`state.diffViewMode`, `'split'`/`'new'`/`'fit'`) is ephemeral, no
URL binding (like `showDescription`/`showApproved`). An already one-sided
block (`added`/`removed`) has no other side to hide/show — the toggle has
no effect there on the **pane choice**, `singleSide(b)` stays in charge
(`effectiveOnly` in `Block.mjs`'s `codeDiff`). A **truly two-sided**
(`modified`) block does collapse in `viewMode==='new'` to its new pane
(`forcedNewOnly(b, viewMode)` in `Block.mjs` remains the condition for
this) — **`'fit'` deliberately does NOT collapse the pane**: a two-sided
block keeps showing both panes in `'fit'`, only the card's width changes
(see below), so `forcedNewOnly` only ever reacts to `'new'`.

**The card width in `'new'` only follows `viewMode()`, not `singleSide`:**
as soon as `viewMode()==='new'`, **every** visible card shrinks to **60%
width** (`w-[42rem] 2xl:w-[49.2rem]` instead of `w-[70rem] 2xl:w-[82rem]`) —
`modified`/`added`/`removed` all alike, plus every preview/look-ahead card
and every drilled column (they all share the same `Block()` component +
the same `viewMode` option). This was previously limited to the two-sided
case (a one-sided block deliberately kept its full width, see the
width-stability rule in `.claude/rules/detail-layout.md`); the reviewer
wanted `a` to make **everything** narrow as long as `'new'` is on,
regardless of block type. The simple `narrowed(viewMode)` in `Block.mjs`
(only `viewMode()==='new'`, no `singleSide` check) is the condition behind
this branch of the width ternary; `forcedNewOnly` remains the separate
condition for the pane choice — the two can therefore diverge (a one-sided
block: `narrowed` true, `forcedNewOnly` false) and that is deliberate.

**`'fit'` (the third stand) sizes the card off its own code instead of a
fixed number, via `fitWidthCls(b)` in `Block.mjs`** — the same 75th-
percentile, non-comment-line character count (`codeGrowthChars`, moved
into `Block.mjs` and exported, shared with `RelatedPanel.mjs`'s
`relatedColumnWidthCls`) clamped between the existing 60% floor
(`42rem`/`49.2rem`) and the full split ceiling (`70rem`/`82rem`) — `'fit'`
therefore always sits between the other two stands, never wider than
`'split'`. Purely a character-count calculation on the already-loaded
source text (`b.code`), computed once per code-load (via the existing
`state.codeVersion`/key-forcing rebuild, see `.claude/rules/conventions.md`
— **not** re-derived on every navigation step, which would risk the
"outer closure depends on navigation state" flicker pitfall). Two cases:
- A genuinely **two-sided** (`modified`) block keeps **both** panes in
  `'fit'` (unlike `'new'`) — the width is based on whichever side (old or
  new) needs more room (`Math.max`), since the two panes always render at
  equal width, **doubled** for the two panes plus a fixed gutter/padding
  allowance.
- An already **one-sided** (`added`/`removed`) block only ever renders
  **one** pane regardless of `viewMode` (`singleSide(b)` wins over
  `forcedNewOnly` in `codeDiff`) — sizing it with the two-pane formula
  above would make the card needlessly wide for content shown only once,
  so it gets the **single-pane** variant instead (no doubling), based on
  just the one visible side.

Read as `viewMode()` within `Block()`'s own per-card `${() => ...}` class
binding (not in the outer per-column closure of `home.mjs`) — mirroring how
`codeDiff`'s own slot already reads `b.code`, so a toggle only re-renders
the diff structure (via `forcedNewOnly`) and the width (via
`narrowed`/`fitWidthCls`, both inside `widthCls(b, viewMode)`) of each
visible card, not the card-building closures themselves. The width ternary
sits in the same card-wide `${() => ...}` `class` binding as `diffActive()`/
`preview` (already reactive, the whole value at once — no partial string
interpolation, see the arrow.js class-binding pitfall in `conventions.md`).
Test: `tests/diffview.spec.mjs`.

## Generic input-focus guard (typing in a field must never be swallowed by a shortcut)

`relatedActive()` (`cs.focus !== null`) is the existing "safety net" branch
that
already suppresses unintended shortcuts as long as a text field
(composer/reply) is opened via the
correct path — that block unconditionally ends in a `return`, so
any key not explicitly matched there (letters, `/`, unmatched
Enter variants) simply flows through to the focused field. But that safety
net
only works if `cs.focus` is actually kept in lockstep with the real
DOM focus. One concrete spot where that wasn't the case: the "+ Comment on
this
line" button (`data-testid=new-comment`, `RelatedPanel.mjs`) used to open
the composer with a bare
`cs.composing = !cs.composing` toggle, without setting `cs.focus` —
clicking it while `cs.focus` didn't already happen to be `'new'` would
then open
a focused text field while `relatedActive()` stayed `false`. `onKeydown`
then had no signal at all that an editable field had DOM focus, and
`s`/`d`/`f`/arrows/`/` were caught as global shortcuts instead of
landing in the field (the reviewer could no longer type). Fixed by having
the button
open via `openComposer()` (`toNew()`) — exactly the same route as
every other path to this composer (`toNew`/`startComment`), which
always sets `cs.focus` and
`cs.composing` together.

As an **extra, future-proof layer** (for any other/future input field
whose
own app-state focus flag ever turns out not to be in sync with the real
DOM focus —
as above), `onKeydown` checks, after the `relatedActive()` branch, before
`/`,
once more directly `document.activeElement`
(`isEditableFocused()` — the same helper as the `a` guard above): if
DOM focus sits on a TEXTAREA/INPUT and no earlier branch has already
claimed the key, then no remaining global shortcut (`/`, `f`/`d`/`s`,
`a`, arrows, the block-palette Enter) does anything — the key just flows
into the field
. **`Escape`** within this fallback is the explicit "get me out of
here" key
(calls `leaveRelated()` — blur + `cs.focus = null` + `cs.composing =
false`, mirroring `handleRelatedKey`'s Escape handling in the
`relatedActive()` branch). **`Tab`** deliberately gets no handling of its
own: the
browser natively moves DOM focus to the next focusable element,
after which the next keystroke doesn't hit this branch anyway
(`isEditableFocused()`
is then `false`). The search box (`BlockList.mjs`) has had this pattern
for a while in
its own, even more direct way: `@focus`/`@blur` set `state.searchActive`
directly based on real DOM focus (no separate toggle path), so it doesn't
need
this fallback.

**ArrowLeft within a focused comment field moves the caret, doesn't leave
the field
— unless the caret is already right at the start.** Both the
`isPrWideFocused()` branch (PR-wide reply thread, stop 1) and the
`relatedActive()` branch (`cs.focus` `'new'`/`'comment'`/`'thread'`, the
comments sidebar) used to claim `ArrowLeft` unconditionally — even while
the reply/composer `<textarea>` actually had DOM focus and the reviewer
was mid-text, which made a plain `←` or an Option/Alt+`←` (macOS word
jump)
exit (popping thread focus back, or `exitRelated()`) instead of moving the
caret. `editableCaretCanMoveLeft()` (`home.mjs`, next to
`isEditableFocused()`)
checks whether the focused TEXTAREA/INPUT has a `selectionStart`/
`selectionEnd` > 0
— i.e. there's text/selection to the left of the caret — and both branches
suppress their `ArrowLeft` handling as long as that's the case: the key
then falls
straight through to the field, which handles it natively (caret step or
word jump). If the caret is already at position 0 (a freshly opened, still
empty
composer/reply field — the existing, tested case in `nav-chain.spec.mjs`:
"← from the composer exits straight back to the diff"), `←` keeps its
long-standing "step back out" meaning — there's nothing to move the
caret left into anyway. `Escape` remains unchanged as the explicit
"get me out of here" key, regardless of caret position. See
`tests/comment-arrowleft-caret.spec.mjs`.

**ArrowRight gets the exact mirror-image guard, for the same reason.**
`relatedActive()` (`cs.focus==='comment'`) claimed `ArrowRight`
unconditionally too — including while the reviewer was mid-text in a
comment row's already-focused reply field (`toComment()` focuses it on
landing) — which jumped into the thread (`enterThread()`) instead of moving
the caret right (the reported "first ← works, then → doesn't"). The new
`editableCaretCanMoveRight()` (`home.mjs`, next to
`editableCaretCanMoveLeft()`) checks `selectionStart`/`selectionEnd` <
`value.length` and both branches suppress their `ArrowRight` handling as
long as that's the case; only once the caret is already at the end does
`→` keep its existing nav meaning there (entering the thread for a comment
row; a no-op for `'new'`/`'thread'` and for `isPrWideFocused()`, which has
no `ArrowRight` case of its own today — added there purely for symmetry
with the `ArrowLeft` guard, not because a bug reproduced there). See
`tests/comment-arrowright-caret.spec.mjs`.

## Footer: inline preview of the selected line + AI description for an if

Below the panels sits a fixed footer (`src/Footer.mjs`, `data-testid=footer`).
Unlike the very first version, the footer is **not** visible just because a
diff is open — it's only visible once there's **actually something to
show**: `state.footerVisible` (derived in `home.mjs`'s `updateFooter()`
as `!!(state.footerUnit || state.footerExplain)`, see below for what those
two snapshots are). Since every navigable `group`/`line`/`call` unit now
always yields at least one row (see below), this is in practice **almost
every** diff-mode selection — the bar only really disappears at
`state.mode !== 'diff'` (list mode) or when there's no focused block/no
navigable unit (`hidden` instead of `flex` on the stable
`<footer>` root — the class string remains one reactive
`class="${() => …}"`
function binding, so no keyed-node pitfall, see
`.claude/rules/conventions.md`).
`footerUnitInfo` (`home.mjs`) still returns `null` outside
`state.mode==='diff'`,
so `footerVisible` is always `false` in list mode.

**Space reservation follows the same flag, 3-way instead of the old fixed
90/140px floor:** `DetailPanel`/`<main>` (`home.mjs`) and the comments/tasks
sidebar + collapsed hint rail (`RelatedPanel.mjs`) reserve `bottom-6` (no
reservation) as soon as `!state.footerVisible`, `bottom-[90px]` as soon as
just the inline diff shows, and `bottom-[140px]` as soon as the AI
description also shows — the reserved space now disappears along with the
bar itself, instead of always leaving at least 90px empty. The pr-index
(`BlockList.mjs`) and the
PR info column (`PrInfoPanel`, `home.mjs`) no longer reserve
anything at all for the footer as of this change (`bottom-6`, was a fixed,
never-reactive
`bottom-[90px]`) — both are only visible in list mode, where the footer
never shows anyway, so that reservation was already dead space.

The theme toggle is not in the footer — see "Theme" in
`.claude/rules/conventions.md` (a narrow row in `prInfoCard`, above the
PR summary; the older `ThemeToggleCorner` — an always-visible fixed
element bottom-left — no longer exists).

**Independent of the bar's own visibility**, the footer shows an inline
diff
(`- old` / `+ new`, Prism-highlighted) of **every** navigable unit,
`group`/`line`/`call` — so also when you select a whole **block of
changes**
(a `group` unit, a contiguous run of changed lines), not only for a
1-line `line`/`call` unit as before. A
`group` of multiple lines shows **per line** what changed:
one del/ins line pair per aligned row the group spans (up to
`MAX_GROUP`,
5 lines — `Block.mjs`), stacked, within the existing scrollable
`footer-diff` column (`no-scrollbar overflow-auto`) — the fixed 90/140px
height
of the bar itself stays unchanged, a long group scrolls internally
instead of the
bar growing.
This inline diff content follows the **focused column and its current
granularity/cursor** — the top-level block (`state.gran`/`state.change`) at
`focusLevel 0`, or a drilled column's own
`state.drillCursor[focusLevel-1]` cursor (see "Column navigation" in
`.claude/rules/detail-layout.md`) — via the same `unitsFor(rows, gran)` as
navigation: the rows `[unit.start,
unit.end]` of the active unit are read out one by one (`'line'`/
`'call'` are always one row, so for those levels this is unchanged, one
line pair). Long lines (>`WIDE_AT`, 110 characters, across **all** rows of
the
unit) release the `max-w` so the footer uses full width; if
specifically the **new/right** (`ins`) line of a row is longer than
`WIDE_AT`, that line additionally wraps fully (`whitespace-pre-wrap
break-words` instead of `whitespace-pre`) so the entire new code is visible
without an invisible (`no-scrollbar`) horizontal scroll — the old/left
(`del`) line doesn't wrap along, that stays unchanged. At
`'call'` level the footer underlines the **active segment** in the same
indigo as the panes via the exported `markChars` +
`UNDERLINE_CLS` (from `Block.mjs`) — underlining exactly those characters
(at
`'group'`/`'line'` the units have no set → no underline, on any row).

**The footer no longer reads `blockRows`/`b.code` itself.** `home.mjs` has
its
own, decoupled footer `watch` (the `setRelated`/`setCommentScope` pattern,
inline deps incl. `state.drillCursor` and `focusedBlock().code`) that pushes
two flat
snapshots: `state.footerUnit` (the aligned rows + underline arrays of
the active unit — one row for `line`/`call`, several for a multi-line
`group` — `null` for no unit, explicitly never an empty array, so that
both the `!!(...)` check in `updateFooter` and the single↔array-slot
pitfall
in `Footer.mjs` remain correct, see `conventions.md`) and
`state.footerExplain`
(see below), and then within that same `updateFooter()` sets the derived
`state.footerVisible`. This way the footer never becomes a co-subscriber
on the
code of the focused block (the "stuck on loading" race, see
`conventions.md`) and follows the drilled-column cursor for free.

**AI description for an if statement (`data-testid=footer-description`):**
if the text of the focused **`group`- or `line` unit** (never `call`, and
only in diff mode) contains an
`if`/`elseif`/`else if` (`reIfStatement` in
`home.mjs` — a bare regex on the line text, false positives in
strings/comments deliberately accepted), the footer shows above the inline
diff a short English AI explanation of what the condition checks and
when the branch runs. That comes from the `explanations` read model
(`GET /api/explanations?pr=N`), generated by the **`explain_code`**
workflow
(Haiku, context-only — see `.claude/rules/tembed-workflows.md`).
Generation
starts **automatically** with a debounce (`EXPLAIN_DEBOUNCE_MS`, 600ms —
navigating through with arrows doesn't trigger anything) via
`POST /api/workflows/explain_code`, client-side
deduped (`explainRequested`) and server-side idempotent (a deterministic
Run
ID per unit+code-hash, `StartWorkflowID`). While the run is in progress the
line shows
"Generating AI description…" (pulsing); a `failed` row (offline,
`SLASH_CLAUDE=off`) hides the line again. The row match is based on
`blockId|unitKey` (unitKey = `group-<start>-<end>`/`line-<row>`, the same
codeRef shape as `commentPath`) plus a **code-hash check** (`fnv1a` over
unit code + context): a stale row from before a new commit is ignored
and regenerated; a seeded row with an empty hash always matches
(test fixtures). While the description shows, the footer grows from 90px to
**140px** and `<main>` (`home.mjs`) and the comments/tasks sidebar +
hint rail (`RelatedPanel.mjs`) reactively reserve `bottom-[140px]` instead
of
`bottom-[90px]`, so nothing shifts behind the footer. See
`tests/footer-explanation.spec.mjs` (incl. the drilled-column case).
