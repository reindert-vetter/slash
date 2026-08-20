# Command palette (`src/CommandMenu.mjs`)

Every menu in the review tree is the same searchable popover component, opened
in a different **mode**. `Enter` opens a block-scoped palette, `/` a PR-wide
one, and several follow-up menus open by themselves after an approve. The
command lists live in `home.mjs`; `CommandMenu.mjs` is pure presentation — it
receives `menu`, a `resolve(query)` function and `onRun`, and contains no
filter or navigation logic.

Arrow-key navigation of the tree itself lives in
`.claude/docs/keyboard-navigation.md`.

## Modes

| `ms.mode` | Opened by | List |
|---|---|---|
| `block` | `Enter` in list/diff mode | `COMMANDS` |
| `pr` | `Enter` at stop 1 (the description column), and `/` on any stop with no menu of its own (see below) | `PR_COMMANDS` |
| `comment` | `Enter` on a focused comment row with an empty reply field | `commentCommandsFor()` |
| `claude` | `Enter` on the Claude column while its composer is NOT the focused element (`cs.claudePos > 0`, stepped up into the transcript), OR — via a separate callback path, see "Comment hiervan maken' on an empty Claude input" in `.claude/docs/claude-chat-panel.md` — while it IS focused but EMPTY (rest position) | `claudeChatCommandsFor()` — "Wis Claude-gesprek" (confirm submenu, and deliberately first so it stays the `defaultSel` action) + "Comment hiervan maken" (only while `claudeAnchorIsPlaceholder()`) + "Probeer de mislukte turn opnieuw" (direct, the keyboard twin of the failed bubble's own button) |
| `prComment` | `Enter` on a comment-index row | `prCommentCommandsFor()` |
| `compose` | `Enter`/"Place…" with text in the composer | `COMPOSE_COMMANDS` |
| `replyPublish` | automatically when a reply is sent on a thread that isn't on GitHub | `replyPublishCommandsFor()` |
| `postApprove` | automatically after a palette approve | `POSTAPPROVE_COMMANDS` |
| `reviewApprove` / `reviewChoice` / `reviewReject` | automatically when nothing is left ahead | `REVIEW_APPROVE_COMMANDS` / `REVIEW_CHOICE_COMMANDS` / built from the typed text |
| `task` | a click (left OR right) on any row of the "Taken" block — `openTaskRowMenu`, always `native`-styled at the cursor | `taskCommandsFor()` — "Open de comment" / "Opnieuw proberen" (dropped while that retry is still in flight; or the honest "kan niet opnieuw proberen" line) / "Kopieer foutmelding" / "Verberg deze melding" / "Verversen", each present only when the clicked row's own descriptor supports it. See "Refreshing and the per-row menu" in `.claude/docs/detail-layout.md` |

There is deliberately no `bulkComments` mode anymore — "Laat Claude alle
openstaande comments verwerken" moved out of the palette entirely, into the
sidebar itself. See "The comment_batch checkboxes and the bottom action row"
in `.claude/docs/comments-panel.md`.

`openMenu(mode, opts)` sets the mode (and, via `opts`, the right-click
`native`/`x`/`y` styling — see "The right-click context menu" below),
`closeMenu` resets it to `'block'`, and `resolveCommands`/`rootCommandsFor`
switch on the mode.

**Every menu also has a mouse entry point now** — `block-open-menu` (on the
block card), `pr-menu-button` (in `prInfoCard`), `comment-detail-menu` (on a
comment-index item's detail card) and `claude-chat-menu` (in the Claude
column header) each just call `openMenu(...)`, same as the matching key. See
"Every menu also has a mouse entry point" in `.claude/docs/mouse-navigation.md`
for the full list, icons and the hover-visibility decision per button. Every
one of these — plus every other surface with a menu of its own — is also
reachable by right-clicking anywhere on its card, native-styled and
positioned at the cursor: see "The right-click context menu" below.

## The right-click context menu

Reviewer request: a native right-click (Cmd/Ctrl-less, the ordinary secondary
mouse button) should show the app's own menu, styled like the native
macOS/Chrome context menu, instead of the browser's own Copy/Look up/Inspect
menu — "overal in de app", not just the diff. The guiding principle, which
also folds neatly into Rule 1 of `.claude/docs/mouse-navigation.md` ("a click
runs the same function a key runs"): **a right-click opens the exact same menu
`Enter` would open at that spot.** If there's no such menu there (a direct
action like the toggle-approved row, or an unchanged/filler diff line), or the
target is a real editable field, nothing is suppressed and the native browser
menu stays — never invent a menu action doesn't offer. This **replaced** the
earlier "a mouse selection shows the palette passively" preview outright (a
plain click/drag no longer shows any menu at all, only a right-click does);
that older mechanism (`schedulePassiveMenu`/`showPassiveMenu`/
`passiveMenuOverlay`/`menu.passive`) has been deleted, not kept alongside.

### It's a styling/positioning variant of the SAME `CommandMenu`, not a second implementation

`openMenu(mode, opts)` takes an optional 2nd argument; every right-click entry
point calls it with `{ native: true, x: e.clientX, y: e.clientY }` (a plain
click/`Enter`/`/` pass nothing, unchanged). `ms.native`/`ms.x`/`ms.y` carry
that through to `CommandMenu(ms, resolve, onRun, { native: ms.native })`
(`CommandMenu.mjs`). What `native` actually changes, deliberately kept small:

- **Width & position** — narrow, intrinsic width (`min-w-[220px] max-w-xs`,
  never stretched to a pane's region) at the exact point the reviewer
  right-clicked, clamped into the viewport (`positionNativeMenu`, `home.mjs`)
  — instead of `positionMenu`'s anchor/region-based placement under a diff
  selection.
- **Row style** — shorter rows (`py-1` vs. `py-2`) and a solid macOS-blue
  highlight (`bg-blue-500 text-white`) instead of the palette's indigo tint; a
  row with `children` gets a trailing `›` chevron (the standard macOS submenu
  affordance).
- **No pinned "Sluit menu" row** — reviewer: "niet nodig als ik met
  rechtermuisknop open doe"; Esc and an outside click already close it, same
  as any real native OS context menu. Filtered in the ONE place both
  `CommandMenu`'s render and `onKeydown`'s ↑/↓/Enter share
  (`resolveCommands`, `home.mjs` — it wraps the mode-specific
  `resolveCommandsInner` and drops `c.id === 'close-menu'` whenever
  `ms.native`), precisely so those two consumers never index into two subtly
  different lists. `defaultSel(list, native)` mirrors this: `0` for `native`
  (the filtered list's first row is already the first real action), the
  usual "skip the pinned row" `1` otherwise.
- **The search field stays, and gets focus on open** — reviewer: "direct
  input selecteren"; typing must work immediately, no extra click. This is
  NOT input-less like a native OS menu — it's still the same searchable
  palette underneath, just narrower.
- **"Kopieer selectie"** — see its own section below.

Everything else — filtering, submenus (`enterSubmenu`), the no-match
fallback, `runCommand`, keyboard ownership (`menu.open`) — is identical to
the keyboard-triggered palette; there is exactly one `CommandMenu` component
and one `openMenu` function.

### Where a right-click lands: reusing each surface's own click-landing step first

A right-click never assumes the keyboard/selection is already where the
cursor points — it lands there FIRST (reusing the exact function that
surface's own left-click already calls, per Rule 1), then resolves which menu
`Enter` would now open, then opens it. Concretely, one `@contextmenu` binding
per surface, colocated with (or added right next to) that surface's existing
`@click`/mouse-entry-point button, `preventDefault`ing only when it actually
opens something:

| Surface | Landing step | Menu opened |
|---|---|---|
| A diff row (top-level or a drilled column, `Block.mjs`'s delegated `onBlockContextMenu`) | `resolveClickSelection` (synchronous — a right-click has no drag/native-selection gesture to protect, unlike a `mousedown`) — **skipped when the click lands INSIDE the current selection**, see below | `block`, only if it actually landed on a real unit (`handleRowContextMenu`, `home.mjs`) — else the native menu stays (an unchanged/filler line keeps its Copy/Look up) |
| Elsewhere on a block card (header/gutter, no `[data-row]` under the cursor) | none needed | the block's own `onOpenMenu` (same as `block-open-menu`) |
| A sidebar row (`BlockList.mjs`'s `row()`) | the same `state.selected = i` + flag resets its own `@click` does | `rightClickMenuMode()` (see below) — `block` for an ordinary block, `prComment` for a comment-index item, or nothing (native menu stays) for a row with no menu of its own |
| The push-todo row (`BlockList.mjs`'s `pushTodoRow`) | `state.onPushTodo`'s own landing | `pushTodo` — literally the same handler the `@click` calls, just forwarding `{native,x,y}` |
| `pr-info-card` | none needed (only rendered while it already owns the keyboard) | `pr` (same as `pr-menu-button`) |
| `comment-detail-card` (a PR-wide comment item) | none needed (only rendered for the selected item) | `prComment` (same as `comment-detail-menu`) |
| The focused block-scoped thread (`expandedConversation`, `RelatedPanel.mjs`) | none needed | `comment` (same as `reaction-status`'s `openCommentMenu`) — except inside the reply `<textarea>` itself, which keeps its native Cut/Copy/Paste/spellcheck menu |
| An unfocused thread row in the same block (`compactConversation`) | `cs.sel = i; toComment(); beat()` — its own `@click` | `comment` |
| `claude-chat-card` (`ClaudeChat.mjs`, both the block-scoped and PR-comment-index Claude column) | none needed | `claude` (same as `claude-chat-menu`), except inside the composer `<textarea>` |

#### A right-click inside the current selection never collapses it

Reviewer report: "als ik iets selecteer en dan rechtermuisknop druk, gaat de
selectie weg. dat wil ik niet." The landing step above is unconditional for a
LEFT click, and rightly so — but for a right click it destroyed the very thing
the menu is about: `resolveClickSelection` collapses a Shift+arrow/drag range
back onto the single clicked line and re-forces `gran` to `'line'`, so
"Keur deze 3 regels goed" had already become "Keur deze regel goed" by the
time the menu appeared.

`rowInsideActiveSelection(level, b, row)` (`home.mjs`) therefore gates it: the
landing step runs only when the clicked row falls OUTSIDE the unit the focused
cursor currently covers — the single group/line/call unit, or the merged span
of an active range (`rangeUnit`). Inside it, the menu just opens. A row
outside still lands there first, unchanged, matching every other platform.
It returns `false` whenever that level doesn't own the keyboard, or the card
is a look-ahead preview (`isActiveCard`), so those keep landing normally too.

Skipping the `state` write also keeps the reviewer's **native** text selection
alive for free — it is that write's row-DOM teardown which otherwise wipes it
(the same mechanism `restoreExactSelection` exists to repair for a drag). Test:
`tests/selection-menu.spec.mjs`.

`rightClickMenuMode()` (`home.mjs`) is the general-purpose resolver for
"which menu would `Enter` open right here, right now" — it deliberately does
**not** reuse `/`'s own `contextMenuMode()` verbatim, because `/` and `Enter`
genuinely disagree at three spots: the toggle-approved/toggle-ignored/batch
rows run a **direct action** on `Enter` (no menu at all), while `/` falls back
to the general `pr` menu there since `/` always wants to show something
searchable. `rightClickMenuMode()` mirrors `Enter`, not `/`: `null` (native
menu stays) for those three rows, and — unlike `contextMenuMode()`, which
`/` never reaches from inside a panel at all — it DOES cover `compose`/
`comment`/`claude` when the target is inside one of those panels (since a
right-click, unlike `/`, can land directly there), falling back to
`contextMenuMode()` for everything else (`pushTodo`/`prComment`/`pr`/`block`).
One universal guard sits in front of all of it: `isEditableFocused()` (or,
locally, a `.closest('textarea, input')` check right in the handler) — a real
text field always keeps its native Cut/Copy/Paste/spellcheck menu, mirroring
"a right-click may be more permissive than Enter, but a text field is never
overridden" (see mouse-navigation.md's "a click may be more permissive than
the key" for the general shape of that asymmetry, applied here in the OTHER
direction: comment/thread focus is more permissive on right-click than
`Enter`'s own `commentReplyEmpty()` gate, since a right-click is as
unambiguous a request as the existing `reaction-status` button).

Every `onOpenMenu`-style callback threaded down as a render prop (`Block.mjs`,
`RelatedPanel.mjs`, `ClaudeChat.mjs`) now forwards an optional `opts` object
straight to `openMenu` — `(opts) => openMenu(mode, opts)` — so a plain click
(`onOpenMenu()`, no args) and a right-click (`onOpenMenu({native,x,y})`) reach
`openMenu` through the exact same function, never two.

### "Kopieer selectie"

Suppressing the native context menu also removes native "Copy" — reviewer:
"menu item toevoegen om selected te kunnen kopieren". `openMenu` appends a
**"Kopieer selectie"** command to the end of the list (never disturbing
`defaultSel`'s own default action) whenever `opts.native` is true AND
`window.getSelection().toString()` is non-empty AT THE MOMENT OF OPENING — a
right-click never collapses an existing browser text selection the way a
left-click would, so whatever the reviewer dragged before right-clicking is
still intact by the time `openMenu` reads it. Deliberately **absent** when
there is no real text selection: a plain right-click that only lands a
navigation cursor (`resolveClickSelection` — a line/call unit, not a text
range) has no well-defined "what would this copy" answer, so nothing is
invented for that case; the item simply doesn't appear. Runs
`copySelectionCommand(text)` → the same `navigator.clipboard.writeText` +
minimal-error-handling shape as `copyReviewSummary` (no toast convention in
this app, see `.claude/rules/conventions.md`), with `text` snapshotted once at
open time so a later change to the page's selection can't retroactively
change what a delayed click on this row would copy.

Test: `tests/selection-menu.spec.mjs`.

## Opening, ownership and positioning

`home.mjs` (`menuOverlay`) renders the menu once at `<main>` level as a
`position:fixed` element (`data-testid=command-anchor`, the menu itself
`data-testid=command-menu`) with a full-screen catch layer
(`data-testid=command-overlay`) that closes on an outside click.

While the menu is open it **owns the keyboard**: `onKeydown` handles `↑`/`↓`
(selection), `Enter` (execute via `runCommand`, which closes first and then
runs the action), `Esc` (close — from a submenu it first steps back to the
root), and block navigation is suspended. Typed characters flow into the
focused input (`data-testid=command-input`, two-way bound to `ms.query`).

**`Space` with an empty search field runs the selected item too** — the exact
same `runCommand(list[ms.sel])` call as `Enter`, no second implementation.
Gated on `ms.query === ''`: as soon as anything is typed (you can write a
comment straight into that field, e.g. the no-match "Create a comment with
this" fallback), Space is a normal character again and falls through
untouched to the input, same as any other letter.

`positionMenu` anchors it just **below** the selection and gives it the width
of the right (NEW) pane — half width, over the code you're reviewing:

- **Vertical:** `menuAnchor()` → the **last** row of the active change unit
  (`[data-change-active-end]`, present in both list preview and diff mode),
  otherwise the block card, otherwise the sidebar row. Deliberately the *last*
  row: for a multi-row `group` or an extended Shift+↑/↓ range the menu must
  float below the *bottom* of the selection instead of covering it.
  `[data-change-active]` (`Block.mjs`) keeps marking only the **first** row and
  stays reserved for `scrollChangeIntoView`.
- **Width + left edge:** `menuRegion()` → the `[data-pane="new"]` pane of the
  selected block, falling back to `[data-pane="old"]` for a removed block, then
  the whole block column (`data-pane` sits on `codePane`, `Block.mjs`).
- **From the block index** (`state.mode==='list'`, the `block`/`postApprove`
  palettes — `isIndexMenu()`): anchors on the selected sidebar row
  (`[data-idx="${state.selected}"]`) and takes the full sidebar width
  (`[data-testid="pr-index"]`) — not the list-mode diff preview in `<main>`,
  which also carries a `[data-change-active]` but is not where the reviewer
  pressed.
- **At stop 1** (the `pr` menu while `state.showDescription` — `isDescriptionMenu()`,
  applies to both `Enter` and `/`): anchors on `[data-testid="pr-info-card"]`
  with the width of `[data-testid="pr-info-column"]`. The card is tall, so the
  menu usually flips above/over the column, but it always sits next to the
  description instead of in the diff region. Outside stop 1 the `pr` menu keeps
  the default diff positioning. Test: `tests/pr-description-menu.spec.mjs`.
- **`comment` mode** anchors on the focused comment row resp. the thread pane;
  **`prComment` mode** on `[data-testid=comment-detail-card]`, falling back to
  `[data-testid=block-column]`.
- **`replyPublish` mode** reuses whichever of the two anchors above matches the
  reply field it was opened from, via `pendingPublishInfo().kind`
  (`RelatedPanel.mjs`): `'prwide'` (the comment-index detail card's reply
  field) gets the `prComment` anchor/region, `'thread'` (the block-scoped
  conversation) gets the `comment` anchor/region. **This mode was added
  without its own branch at first** — it fell through to the generic diff-row
  default and floated the publish-choice menu over the code being reviewed
  instead of the comment column. Every new `ms.mode` needs an explicit branch
  in both `menuAnchor`/`menuRegion` (or a deliberate decision to fall through);
  don't assume the generic default is harmless. Test:
  `tests/reply-publish-menu-position.spec.mjs`.
- **`claude` mode** anchors on `[data-testid=claude-chat-card]`, falling back to
  `[data-testid=comment-claude-row]` — deliberately its OWN branch in both
  `menuAnchor`/`menuRegion`, never falling through to the diff-row default
  every other mode eventually reaches: the Claude column is reachable with no
  diff row on screen at all (it hangs off a comment thread, not a diff), so
  without this branch `positionMenu` finds neither anchor nor region and the
  palette silently never becomes visible (stays `visibility:hidden` forever).

If it doesn't fit below the screen it flips above, and is clamped within the
viewport regardless. It starts `visibility:hidden` until `positionMenu` has
placed it (no flash top-left), and repositions on resize, scroll (capture, also
inner scrollers), after every keystroke (the filter list changes height) and
220ms after opening (the panel width animates 200ms when stepping into the
diff).

### The highlighted row scrolls itself into view on `↑`/`↓`

`command-list` (`CommandMenu.mjs`) is a fixed `max-h-72` box with its
scrollbar hidden (`no-scrollbar`) — a list long enough to overflow it (e.g.
`prCommentCommandsFor`'s menu once it grew past "Chat met Claude") used to
leave the keyboard-highlighted row (`menu.sel`) genuinely invisible below the
fold, with no visual affordance that more rows even existed: `↑`/`↓`
(`home.mjs`'s `onKeydown`) only ever moved `menu.sel`, nothing scrolled the
list itself. `CommandMenu()` now sets up a `watch(() => menu.sel, ...)`
(inside the component function body, not a template binding) that finds the
row via `data-cmd-idx="${i}"` (a static attribute per row, added purely for
this) and calls `el.scrollIntoView({ block: 'nearest' })` — safe here without
the axis rule's `inline` guard (see `.claude/rules/arrowjs-pitfalls.md`)
because `command-list` is its own vertical-only scrolling box, never nested in
`<main>`'s horizontal scroller. The watch is set up fresh on every open
(`CommandMenu()` runs anew each time, per the disposable-`ms` shape above) and
deliberately never disposed — it only ever reads that one open's own
`menu.sel`, which nothing touches again after close, so it stays dormant
rather than becoming an actively-growing leak (contrast the label-function
leak the `ms` swap above exists to prevent, which depends on continuously
changing GLOBAL state). Test: `tests/command-menu-scroll.spec.mjs`.

### Ephemeral state: a stable `menu` plus a disposable `ms`

The menu state is deliberately **not** in the URL. It is split in two: a
stable `reactive({ open })` (which `MenuHost`'s top-level binding hangs off)
and a disposable `let ms = reactive({query, sel, sub, mode, commands, native,
x, y})` that `openMenu` **replaces with a fresh object on every open** —
`native`/`x`/`y` are only meaningful while `native` is true (a right-click
menu, see "The right-click context menu" above). Orphan bindings from a
previous open then point at the old `ms`, which is never touched again, so
they never fire. `closeMenu` only sets `menu.open = false`.

This is load-bearing: arrow.js does not fully clean up a dropped subtree, so
reopening in a different mode used to crash (`W[t] is not a function`). For the
same reason `resolveLabel`/`snapshotCommands` resolve every **label function**
once, in `openMenu`, and store a plain string on `ms.commands`/`ms.sub` — a
label function reaching the nested `CommandMenu` tree becomes an ever-growing
ghost that recomputes on every later navigation step. See "arrow.js doesn't
fully clean up a dropped subtree" in `.claude/rules/arrowjs-pitfalls.md`.

### `withClose` + `defaultSel`

`withClose(list, onClose)` (`home.mjs`) prepends a pinned **"Close menu"** item
to every root list (`COMMANDS`, `PR_COMMANDS`, `COMPOSE_COMMANDS`,
`commentCommandsFor()`, `prCommentCommandsFor()`, `POSTAPPROVE_COMMANDS`,
`REVIEW_APPROVE_COMMANDS`, `REVIEW_CHOICE_COMMANDS`) **and** every submenu
(`children`, incl. "Open GitHub", the Jira submenus and the approve-confirm
submenu). Choosing it always closes the entire palette, even from a submenu
(`Esc` still just steps one level back). `postApprove`'s own `onClose` also
clears `postApproveTarget`.

So the pinned row never becomes the default Enter action, every fresh
menu/submenu opens on the **2nd item**: `defaultSel(list)` =
`Math.min(1, Math.max(0, list.length-1))`, used by `openMenu`/`enterSubmenu`/
the Esc-back-to-root branch. Deliberately **not** applied to the `reviewReject`
step or the "no match" `make-comment` fallback — both are dynamic 0/1-item
lists where "type, Enter" would break. The per-keystroke `sel` reset
(`CommandMenu.mjs`'s `@input`) stays at `0` (the top row of the filtered
result).

### Filtering, submenus, and the no-match fallback

Filtering is a **subsequence fuzzy match** (`filterCommands`, exported from
`CommandMenu.mjs` so the keyboard handler walks exactly the same filtered list
as the render — `ms.sel` and the visible rows stay in sync).

A command may carry **`children`**: choosing it opens a submenu instead of
running an action (`runCommand` → `enterSubmenu`, which resets query/selection
and repositions). `ms.sub` holds the open child list; `resolveCommands` filters
that instead of the root list (without the comment fallback).

If filtering yields **nothing** for a non-empty query, the menu falls back to
**two** items: **"Chat over deze regel"** (default, first — opens the Claude
composer via `startClaudeChat` and then immediately **sends** the typed text as
the conversation's first turn, via `sendClaudeChatText`, the exported wrapper
around `sendClaudeMessageFromNew` — the same send path the composer's own
Enter/"Stuur" uses) and **"Comment op deze regel"** (opens the comment composer
via `startComment` and only **prefills** it, `comment-compose`, same target as
the ordinary `comment` row in `COMMANDS`). Reviewer request: typed text that
matches nothing is far more often a question meant for Claude than a comment
draft, so it should reach Claude right away instead of sitting prefilled for a
second Enter — placing a comment stays a deliberate second step since it's a
real, GitHub-visible action (`createComment` from `RelatedPanel.mjs` →
`POST /api/workflows/task_code_comment`, within the write boundary), while a
chat message is not. This is a **plain array, not `withClose`** — so index 0
(not index 1 via `defaultSel`) is the default Enter action, which is why the
CHAT item must stay first.

**The chat/comment order was reversed on explicit request** (it used to be
"Maak hiermee een comment" first): typing something the palette doesn't know is
far more often the start of a question for Claude than the start of a comment,
so chatting became the default and the comment item moved right below it —
"chat over deze regel … dan moet zelfs dan de default worden, daaronder Comment
op deze regel". Equally deliberate, from the same exchange: the fallback stays
gated on **no match at all**. It was *not* widened to "always, as soon as
something is typed" — with real matches present the palette's own commands keep
the field. Filter + fallback both live in `resolveCommands(query)`.

## `Enter` — the block palette (`COMMANDS`)

Block actions only: toggle approve, comment on this line (`startComment` from
`RelatedPanel.mjs`), **"Chat over deze regel"** (`startClaudeChat` — opens the
Claude composer directly, with no comment written/placed first; see
"`Enter` → 'Chat over deze regel'" in `.claude/docs/claude-chat-panel.md`), and
**Open GitHub**. Deliberately **no** navigation items (step in diff / next /
previous) — that's what the arrows and `f`/`d`/`s` are for.

At **stop 1** (the description column) there is no block context, so `Enter`
there opens the `pr` menu instead
(`openMenu(state.showDescription ? 'pr' : 'block')`). Block 0 in the list is a
different stop (`showDescription` is `false`) and keeps the block palette.

**Approve is scoped to the current navigation unit** (`toggleApprove`/
`approveTargetRows`): the whole block in list mode, the selected
group/line/call in diff mode — it approves exactly the rows of that unit, or
retracts them if already approved. At `gran==='group'`/`'line'` (not `'call'`)
it additionally sweeps a directly-following filler row along, one-way — see
"the filler-row sweep" in `.claude/docs/approval.md`.

**`focusLevel`/`drillCursor`-aware:** a drilled column has its own block plus
its own `change`/`gran` cursor, so `approveContext()` (`home.mjs`) resolves
`{ block, mode, gran, change }` once (mirroring
`findNextUnapproved`/`fKey`/`dKey`/`setDrillGran`'s own `focusLevel` branch) and
`approveNoun`/`approveTargetRows`/`toggleApprove`/`toggleCallApprove` + the
`COMMANDS` label take that context instead of reading `curBlock()`/`state.gran`/
`state.change`. Without it, `Enter` → "Approve …" invisibly approves the
top-level block while a drilled column owns the keyboard. See "Column
navigation" in `.claude/docs/drilling.md` and `tests/drill-approve.spec.mjs`.

The label is a function so it names the live unit (`approveNoun`): "Approve
this block" (list), "Approve these lines" (group), "Approve this line" (line),
"Approve this call" (call), and "Retract approval of …" when already approved.
See `.claude/docs/approval.md`.

**Open GitHub** has two children: *Line in Files changed* (`openGithubLine` —
the anchor `#diff-<sha256(path)><R|L><line>`, line = the `start` of the code
side plus the active unit's offset; new side `R`, removed block `L`) and *PR
page*.

## A multi-row selection replaces the block palette (`rangeCommandsFor`)

While a Shift+arrow multi-row selection is active in the index or the
methodes-kolom (`hasMultiSelection()`, see "Shift+↑/↓ in the INDEX" in
`.claude/docs/keyboard-navigation.md`), `blockCommands()` returns
`rangeCommandsFor()` instead of `COMMANDS`: the pinned "Sluit menu" plus up to
four real actions. `COMMANDS`' own items all speak about ONE line/block
("Comment op deze regel", "Open GitHub"), which a selection of several rows has
no single answer for — hence this separate, smaller list instead of reusing
`COMMANDS` with a wider target.

- **"Keur deze N blokken/methodes goed"** (`toggleRangeApproval`, reading "Trek
  goedkeuring van … in" once every row in the selection is approved) — always
  present, default (2nd) item, unchanged since this feature's first cut.
- **"Plaats comment over deze N blokken/methodes"** (`startRangeComment`) and
  **"Chat met Claude over deze N blokken/methodes"** (`startRangeChat`) — both
  only shown when the CURSOR's own block/method isn't itself a PR-comment
  index row (`rangeChatEligible()`; a comment item has no diff/code to anchor
  a NEW comment or chat to, the same reason `COMMANDS` never opens there
  either). **The anchor is deliberately the CURSOR's own item, not the literal
  first (lowest-index) item of the Shift-selection** — explicit reviewer
  decision: the composer/Claude column can only ever render under the block
  column that's actually on screen (the cursor's), so anchoring anywhere else
  would show a composer under one block while claiming to be about a
  different one. The wider scope still reaches both surfaces:
  - **Comment:** `placeComment` (`RelatedPanel.mjs`) prepends a short
    "_Comment over N blokken: label1, label2, … en M meer_" line
    (`rangeCommentPrefix`, capped at 5 names) to the reviewer's typed text
    before posting — there is no separate invisible context field on a real
    GitHub comment, so the scope has to be visible in the body itself.
  - **Claude:** `claudeContextBlock`'s `cs.rangeCompose` branch
    (`claudeRangeContextBlock`) sends a plain **manifest** — label, file, and
    the block's own start line (plus its old/new start line when its code
    happens to already be loaded) — instead of the single-unit code snippet a
    normal chat sends. **Deliberately no source code for any block**, however
    many the range covers: unlike a Shift+↑/↓ **line**-range within one block
    (capped only for the *automatic* explain via `MAX_EXPLAIN_LINES`, never
    for an explicit chat, see keyboard-navigation.md), an index-level range
    has no ceiling on the number of *whole blocks* it can cover, and embedding
    every one's own diff would make the prompt grow with the selection size
    instead of staying a small, predictable manifest. Claude already has
    Read/Bash access in its own shadow worktree for this conversation (see
    `.claude/rules/workflows-write-boundary.md`'s carve-out), so it opens a
    listed file itself the moment it actually needs the code. Explicit
    product decision (Reindert), see `.claude/docs/claude-chat-panel.md`'s
    "Chat over een heel bereik" section.
  Both are captured once, at the moment the palette item runs
  (`rangeComposeItems`, `RelatedPanel.mjs`) — a later Shift+↑/↓ that grows or
  shrinks the same selection while the composer is still open never
  retroactively changes what it claims to cover.
- **"Ignore N comments in dit bereik"** (`toggleRangeIgnore`, reading "Ignore
  ongedaan maken voor N comments" once every one of them is already ignored)
  — only shown when the selection contains at least one PR-comment index row
  (`rangeIgnorableComments()`). An ordinary block/test method has **no**
  ignore concept of its own (only a PR-comment index item does, via the
  existing single-item `toggleIgnoreComment`/`prCommentCommandsFor`'s
  "Ignore"), so this reuses that exact per-comment action across every
  ignorable row in the selection and silently skips every other row — the
  same kind-based split `toggleRangeApproval` already makes, just in the
  opposite direction (there a comment item is the one skipped, since
  "approved" means "resolved", a real GitHub-side action).

Every range action still writes **one Signal per affected block/comment**,
never a batch write — `toggleRangeIgnore` calls the ordinary
`toggleIgnoreComment` per row exactly like `toggleRangeApproval` calls
`persistApproval` per row.

## The postApprove follow-up menu

**`Space` (outside the palette) approves + "Ga door"s in one keypress and
never opens this menu at all** — see "Space" in
`.claude/docs/keyboard-navigation.md`.

After approving **via the palette** (not via the block card's own checkbox,
which stays a plain toggling click), if there is still a next unapproved unit a
follow-up menu opens immediately (`ms.mode = 'postApprove'`,
`POSTAPPROVE_COMMANDS`): pinned **"Close menu"** or a 2nd item (default — it
only navigates, never auto-approves) labelled **"Ga door"** or **"Ga terug"**
depending on the plan (see "Returning to an unapproved ancestor" below). This
only triggers when the action **added** approval
(`toggleApprove`/`toggleCallApprove` detect that via `allIn`/`keys.has(key)`
**before** the mutation — a retract never opens it) and `findNextUnapproved()`
actually found something.

Two exceptions skip the menu and navigate straight away, both because there is
nothing to choose besides continuing:

- **The next unit stays within the same block** (step 1 below).
  `toggleApprove`/`toggleCallApprove` pass the just-approved block id into
  `afterApproveAction(approving, blockId)`, captured **synchronously** (before
  the async `findNextUnapproved` gap); `afterApproveAction` compares it against
  the plan's **landing block** (the last entry of `target.path`, or the
  top-level block at `target.root` for an empty path), plus `!keepList` and
  `root === state.selected`. On a match it calls `applyNextUnapproved(target)`
  directly. **Deliberately NOT a bare `target.path.length === 0` check** —
  inside a drilled column step 1's plan always carries a non-empty `path`
  (`state.drill.slice(0, level)`), so a path-length check would never fire
  there. Test: `tests/drill-approve-line-skip.spec.mjs`.
- **Approving from the block index** (`state.mode !== 'diff'`, captured
  synchronously as `keepList`): there is no diff/drill to jump into, only the
  sidebar selection to move. `applyNextUnapproved` branches on
  `target.keepList` and then moves **only** `state.selected` (to `target.root`)
  + `scrollSelectedIntoView()` — `target.path` is ignored, so an index approve
  never drills. Because `postApprove` can therefore never open with `keepList`
  true, `postapprove-next`'s label function never needs to consider it either.

A diff-mode approve landing on a *different* block still opens the menu —
**including** a return to an unapproved ancestor (step 3 below): that always
lands on a different block than the one just approved, by construction, so
neither exception applies and the menu always shows for a confirm, just with
the "Ga terug" wording instead of "Ga door".

## `findNextUnapproved()` — walking the review tree

"Next" follows the review **tree**, not the flat sidebar list, depth-first
(`home.mjs`):

1. **Further within the column that owns the keyboard** — the top-level block
   (`state.gran`/`state.change`), or the drilled column at `state.focusLevel`
   with its own `state.drillCursor` cursor (`firstUnapprovedOwnUnit`,
   forward-searching at the current granularity).
2. **Down into its Underlying-code children** (`orderedChildBlocks` — the same
   order the panel shows, excluding `covered_by` to avoid the method↔test
   cycle), depth-first per child (`firstUnapprovedInSubtree`, cycle-safe via a
   `seen` set): the child itself from its first `'group'` unit, otherwise its
   own children, and so on. See `.claude/docs/underlying-code.md`.
3. **Return to an unapproved ancestor** (reviewer request — "als ik een
   onderliggende code goedkeur, dan wil ik terug naar de bovenliggende code
   als dat nog niet is goedgekeurd"): only once the focused column's whole
   subtree (steps 1+2, both exhausted) is fully approved, walk the drill stack
   from the **deepest** ancestor up (`state.drill[lvl-2]`, or the top-level
   block for `lvl===1`) and return to the **first** one that still has an
   unapproved unit of its **own** (`firstUnapprovedOwnUnit(parent, 'group',
   -1)`, never a sibling or a deeper descendant — those are steps 2/4). Lands
   on that ancestor's own **SAVED cursor** — its `state.drillCursor` entry (or
   `state.gran`/`state.change` for the top level) — not its next unapproved
   line: drilling further IN never touches an ancestor's cursor (`drillIntoChild`
   only ever *pushes* a fresh entry for the new deepest level; an ancestor's own
   entry is only ever written by an explicit navigation action taken *at that
   same level*), so it still holds exactly the position the reviewer left before
   descending — "waar ik als laatst was", not "de eerstvolgende open regel".
   Defensively clamped (`Math.min(savedCur.change, units.length - 1)`) against a
   granularity whose unit count shrank since (a code reload). The returned plan
   carries `isReturn: true`, which only this step ever sets — `POSTAPPROVE_COMMANDS`'s
   `postapprove-next` label reads it (`postApproveTarget.isReturn`) to say **"Ga
   terug"** instead of **"Ga door"**, everything else about the item (its
   position — 2nd, right after the pinned "Sluit menu", still `defaultSel`'s
   default Enter action — and its `run`, `applyNextUnapproved(postApproveTarget)`)
   is unchanged; `applyNextUnapproved` needs no special case either, since a
   return is just a plan whose `path` is *shorter* than the current
   `state.drill`, which its existing common-prefix trim already collapses
   correctly (see below). Only meaningful at `state.focusLevel > 0` — a
   top-level block (never drilled into anything) has no ancestor to return to.
4. Failing that (every ancestor up to the top level is itself fully approved),
   **Up** through the drill stack again: back to the parent (an earlier
   drilled column, or the top-level block) and its **next, not-yet-tried**
   sibling child, repeated upward.
   4b. (top level only) the **remaining methods** of the current `test_class`
   row — see `.claude/docs/test-class-grouping.md`.
5. **Across `state.blocks`** in sidebar order, also subtree-aware
   (`firstUnapprovedInSubtree` per candidate), so a top-level block that only
   has an Underlying-code child still open is not skipped.

With lazy `ensureCode` fetches for every visited block. Steps 1/2/3 are
forward-and-then-up **within the current drill stack only**; steps 4/5 are the
genuinely forward, no-wrap search — so a `null` result means "nothing left
ahead of me", not "the PR is done" (see the review-submit menus below).

It returns a plan `{ root, path, gran, change }` (`root` = top-level index,
`path` = the chain of PR blocks to drill through, empty = the top-level block)
— plus `isReturn: true` for a step-3 plan — and stashes it in
`postApproveTarget`. "Ga door"/"Ga terug" applies it via `applyNextUnapproved`,
which trims `state.drill` to the common prefix with `path` (mirroring
`expandColumn`'s trim) and drills only the remainder (`drillIntoChild`) instead
of tearing down the whole stack for a nearby sibling step (or, for a step-3
return, doesn't drill anything further at all — the trim alone already lands on
the ancestor); a different `root` resets `state.drill`/`drillCursor`/
`focusLevel`. No recomputation is needed — the palette owns the keyboard while
it's open. This is one-off: after navigating, no new follow-up menu opens.

**Steps 2/3/4/4b run regardless of `inDiff` — only step 1 is genuinely
diff-only.** They used to sit inside the same `if (focused && inDiff)` gate as
step 1, but `inDiff` (`level > 0 || state.mode === 'diff'`) is false in plain
list mode — exactly where a reviewer approves a small block or a freshly added
test method without ever pressing `→`. That silently returned `null` while a
sibling test method still showed `0/N`, or while a resolved-call child (hidden
from the flat sidebar via `resolvedCallTargetIds`, so unreachable by step 5)
still had unapproved rows. Step 1 staying a no-op in list mode is correct:
there is no cursor within the block to resume from, and approving the whole
block from the list already covered all of its own rows. (Step 3 is moot in
list mode anyway — it only ever fires at `state.focusLevel > 0`, which implies
a diff cursor already exists.) Test:
`tests/findnextunapproved-list-mode.spec.mjs` (PR 110, PR 112).

## `lastIndexRowRect` — keeping a follow-up menu at the same spot

`isIndexMenu()` counts `postApprove` too, so `menuAnchor()` tries
`[data-idx="${state.selected}"]` for both menus. But a fully approved block's
row disappears from the sidebar immediately (see "Hiding approved blocks" in
`.claude/docs/approval.md`), and that happens *before* the follow-up menu
opens — `menuAnchor()` would then fall back to the whole `[data-testid="pr-index"]`
aside, whose much taller rect throws `positionMenu()`'s flip-above calculation
to the top of the viewport.

`lastIndexRowRect` (a module-level `let` next to `isIndexMenu`) caches the
row's `getBoundingClientRect()` while it still exists; once the row is gone,
`menuAnchor()` reuses that cached rect as a duck-typed object exposing only
`getBoundingClientRect()` (all `positionMenu()` ever calls). `openMenu(mode)`
resets the cache on every open that is **not** an approve follow-up
(`isReviewFollowup(mode)`, covering `postApprove` plus the three review-submit
modes), so a stale position never leaks into an unrelated session. Test:
`tests/postapprove-menu.spec.mjs`.

## Review-submit menus: `reviewApprove` / `reviewChoice` / `reviewReject`

When `findNextUnapproved()` returns `null`, `afterApproveAction` opens one of
two follow-ups based on `state.approvalTotal` (the PR-wide combined counter —
see "Combined approval per tree" in `.claude/docs/approval.md`), read after a
few `await Promise.resolve()` ticks (the `approvalSummaries`/`approvalTotal`
watch is decoupled and only fills as a microtask):

- **Everything approved** (`done === total`, `total > 0`) → `reviewApprove`
  (`REVIEW_APPROVE_COMMANDS`): pinned "Close menu" / **"Approve the whole PR"**
  (default). Nothing left to reject.
- **Something still open** somewhere outside the forward search → `reviewChoice`
  (`REVIEW_CHOICE_COMMANDS`): pinned "Close menu" / **"Approve the whole PR"**
  (default) / **"Reject the PR"**.

**Approving the whole PR is deliberately a TWO-STEP choice** (a real GitHub
review was "too easy to hit by accident"). Neither "Approve the whole PR" item
carries a `run`; both carry `children: REVIEW_APPROVE_CONFIRM_COMMANDS`, so
choosing it opens a confirmation submenu through the ordinary `children`
mechanism (no new mode). That submenu also goes through `withClose` and holds
**two** real items, which post the *identical* review and differ only in where
the reviewer ends up: **"Goedkeuren en ga naar overzicht"** (the default 2nd
item — finishing a PR is almost always followed by picking up the next one; it
awaits `submitReview('APPROVE')` and only then goes to
`overviewExitUrlAfterApprove()` — deliberately NOT `overviewExitUrl()`/its
`?pr`/`?sel`/drill round-trip, since there's nothing left to return to; instead
`/pr-overview?approved=<pr>` makes that PR already gone from the list with the
new top row selected, see "`?approved=<id>`" in
`.claude/docs/pages-and-routing.md`) and
**"Goedkeuren en sluiten"** (submit and stay). Both "Approve" items carry a
check-in-circle icon, and "Reject the PR" carries an X-in-circle icon (`c.icon`,
`commandIcon` in `CommandMenu.mjs`, `'approve-pr'`/`'reject-pr'`) — the icon
**shape** plus the label text carry the meaning (which of the two opposite
actions this is, and for approve also "this affects the whole PR"), the
emerald/rose colour is decoration only (see the colourblind rule in
`.claude/rules/conventions.md`). "Reject the PR" got no confirm step — its
mandatory free-text reason already is one.

`submitReview` posts `POST /api/workflows/submit_review {pr, event, body}` (the
sanctioned write path, see `.claude/rules/workflows-write-boundary.md` and
`submit_review` in `.claude/docs/workflows-trackers.md`). Error handling is
deliberately minimal (`console.error`) — this app has no toast convention. A
successful submit is a fresh workflow run, so `submitReview` calls
`pollWorkflows()` so it shows in "Taken" before the next `WORKFLOWS_POLL_MS`
tick.

**"Reject the PR" doesn't post right away** — GitHub (and
`validateSubmitReview`, 400) reject an empty `REQUEST_CHANGES` body. It opens
`reviewReject`, a **free-text** step that reuses the palette textarea
(`ms.query`) as the reason field. `rootCommandsFor` returns no static list;
`resolveCommands` builds **one** command from the typed text, and only once
it's non-empty — an empty query yields `[]`, which via `onKeydown`'s existing
`if (list[ms.sel]) runCommand(...)` guard makes `Enter` a no-op rather than a
silent close. `CommandMenu.mjs`'s placeholder changes for this mode ("Type the
reason for rejection (required)…") as the only instruction. With text, the one
row calls `submitReview('REQUEST_CHANGES', reason)`.

All three modes share the `lastIndexRowRect` exception with `postApprove` via
`isReviewFollowup(mode)`. Tests: `tests/review-submit-menu.spec.mjs`, plus the
last test in `tests/postapprove-menu.spec.mjs`.

**There used to be a fourth item here, `REVIEW_BATCH_COMMENTS_ITEM`**, opening
a `'bulkComments'` palette mode that listed every open comment before handing
them to `comment_batch`. Removed on request — the whole feature moved into the
sidebar itself (a checkbox per eligible comment-index row plus a bottom
"Verwerk N comments met Claude" action row), with no menu shortcut left in its
place: that action row is now always visible whenever there's something to
batch, which already covers this entry point. See "The comment_batch
checkboxes and the bottom action row" in `.claude/docs/comments-panel.md`.

### After a successful submit: copy a one-line summary to the clipboard

`submitReview` also copies a short summary of the just-submitted review to the
clipboard — for pasting into Slack/a PR checklist elsewhere — but **only**
after the `fetch` actually succeeded (never on a `!res.ok` or a network error,
both of which `return`/throw before reaching this). `buildReviewClipboardText`
builds the text from `state.prUrl || GITHUB_PR` (the same fallback the
"Open GitHub" links use) plus the event:

- **`APPROVE`** — `${link} ✅`, or, when the reviewer has own comments still
  open, `${link} ✅ met N comment`/`comments` (singular at exactly 1). "Own"
  reuses `isOwnComment` (see below); "still open" is `c.status !== 'resolved'`.
  The count (`ownOpenCommentCount`) is **PR-wide**, not scoped to one block —
  it reads the whole `commentListSnapshot()` (`RelatedPanel.mjs`), matching
  what "approving the whole PR" itself covers. Deliberately **not** scoped to
  "placed during this session" — a reviewer who reopens the same PR later
  still gets an accurate count of what they left open. A thread that ends in
  **meaningless praise** is skipped (`isPraiseComment`, see below).
- **`REQUEST_CHANGES`** — deliberately **no emoji**: `${link} met nog een paar
  aanpassingen: ${reason}`, `reason` being the typed rejection text verbatim
  (only internal whitespace/newlines are collapsed to one line — never
  summarized or truncated).

`copyReviewSummary` wraps `navigator.clipboard.writeText` with the same
minimal error handling as `submitReview` itself (`console.error`, no toast
convention). Tests: the three cases (no comments, with own unresolved
comments, reject) in `tests/review-submit-menu.spec.mjs`, using the same
`navigator.clipboard` stub as `tests/overview.spec.mjs`'s "Kopieer GitHub URL"
test.

#### A thread ending in "just praise" is not an open point

A comment that only says "Nice"/"Goed"/"Lekker" leaves the PR author nothing to
do, so `ownOpenCommentCount` filters it out via `isPraiseComment` (`home.mjs`).
Two choices in it are **deliberate and explicitly agreed — do not "fix" either**:

1. **Raw substring, no word boundaries.** Any occurrence anywhere in the text
   matches, so `"Nice, maar deze query geeft N+1"` is skipped too — and
   `"goedgekeurd"`/`"goedkeuring"` therefore match on `goed`. Adding `\b` would
   make the rule narrower than what was asked for.
2. **Only the LAST message of the thread decides** (`threadLastBody` — the final
   `c.reactions` entry, which is already chronological, else `c.body`),
   regardless of who wrote it. The last message is the thread's current state: an
   inhoudelijke comment closed off with "Goed, opgelost" is settled, while a
   thread that opens with "Nice" but ends in a real question still counts.
   Checking *every* message would let one polite word mid-discussion hide a
   thread forever.

The word list is **configurable**, so a reviewer can add words without touching
code: read-only **`GET /api/praisewords`** (`praisewords.go`) serves
`<dataDir>/praise-words.json` — a JSON array of strings, normalized to trimmed
lowercase. Missing, unparsable, or normalizing to nothing → the built-in
defaults `["nice","goed","lekker"]`, never an error; editing it takes a restart
(cached per data dir, same as `names.json` — see "Real names instead of logins"
in `.claude/docs/pages-and-routing.md`). The file is deliberately **not**
committed: unlike the team-wide `data/names.json` it is one reviewer's personal
vocabulary. Write boundary: a pure read + in-memory cache, so it needs no
workflow (same carve-out as `/api/me`).

The frontend fetches it **once at startup** (`ensurePraiseWords`, next to
`loadBlocks()`), because `buildReviewClipboardText` is synchronous; a failed or
slow fetch just leaves `DEFAULT_PRAISE_WORDS` in place, which is also what every
offline test run sees. Tests: `TestPraiseWords*` (`praisewords_test.go`) for the
list + endpoint, and the "own unresolved comments" case in
`tests/review-submit-menu.spec.mjs`, which seeds a third, praise-carrying
comment and still expects `✅ met 2 comments`.

## The comment-scoped menu (`comment`, `commentCommandsFor`)

If the keyboard is on a placed comment row in `RelatedPanel`
(`isCommentOrThreadFocused()` — `cs.focus === 'comment'` at rest, OR
`cs.focus === 'thread'` while stepped ↑ into one of its own replies) **and the
reply field is empty**, `Enter` opens this menu instead of the block palette —
two to seven rows:

1. **"Close menu"** (pinned).
2. **"Resolve comment"** (default, 2nd item) — or **"Unresolve comment"** in
   that same slot once the thread is resolved (`isResolvedComment`); never
   both. **Absent entirely for an AI finding** (`isAiComment` — `source ===
   'ai'` or `kind === 'ai_warning'`, `home.mjs`): reviewer request, "ai
   comments wil ik niet resolven, maar wil ik verwijderen". Both halves go,
   including "Unresolve comment" — resolving is a conversation concept that
   doesn't apply to a `code_warning` finding.
3. **"Verwijder comment"** — the default-selected item on an AI finding, since
   item 2 doesn't exist there, so one `Enter` deletes it outright with no
   confirm step (deliberate).
4. **"Bewerk bericht"** — only for the reviewer's OWN message
   (`isOwnMessage`), which the keyboard is currently on
   (`focusedThreadMessage()` — the root at rest, or the specific reply
   stepped into). See "Editing an own message" in
   `.claude/docs/comments-panel.md`.
5. **"Comment hiervan maken"** — only when `source === 'ai'` (a `code_warning`
   finding; see "Converting an AI-controle finding into a real comment" in
   `.claude/docs/comments-panel.md`).
6. **"Zet op GitHub"** — only while the thread has NO GitHub root
   (`needsPublishChoice`), i.e. exactly when item 7 is absent. This is how an
   already-written local conversation moves over without typing a new reply
   first: it publishes the root (and, via its with/without-the-earlier-messages
   submenu, the earlier local replies) through `publishThreadOnly`. See
   `publishThreadCommand` and "Publishing a local thread to GitHub" in
   `.claude/docs/comments-panel.md`.
7. **"Open op GitHub"** — only when the comment actually has a GitHub anchor.

`commentCommandsFor()` is built fresh on every open (unlike the static lists it
is data-conditional per focused comment), still via `withClose`.
`focusedCommentGithubId()` (`RelatedPanel.mjs`) decides whether the last item exists
at all — `null` for a local note or a comment whose GitHub post never landed
(`comments.Comment.GithubID` is 0 then) — so there is never a dead row. It
opens `(state.prUrl || GITHUB_PR) + '#discussion_r' + githubId`; this panel only
ever shows block-scoped review comments (`kind === ''`), so that anchor form is
always right (never `#issuecomment-<id>`).

A **non-empty** reply field leaves `Enter` alone — the field's own `keydown`
wins (`sendReaction`), so "type a quick reply, press Enter" keeps working
(`isCommentOrThreadFocused`/`commentReplyEmpty` guard the distinction).

**Mouse path:** the send-status button next to "Stuur" (`reaction-status`)
opens this same menu on click, so resolve/delete stay reachable without the
keyboard. See the send-status paragraph in
`.claude/docs/comments-panel.md`.

- **"Verwijder comment"** → `deleteCommentAndSelectRow`/`deleteFocusedComment`
  sends a **`delete` Signal** (`POST /api/workflows/{runID}/signals/delete`) to
  the comment's Execution — the only write path. The workflow marks the comment
  `deleting`, removes it from GitHub (best-effort) and then from its read
  model. The request rides along on the same `reply` Signal as a reaction
  (`ReactionSignal.Action`) because a workflow can only `WaitSignal` on one name
  at a time. Where the keyboard lands afterwards: see
  `.claude/docs/comments-panel.md`.
- **"Resolve comment"** → `resolveFocusedComment` sends a **`reply` Signal**
  with `done:true` and the sentinel body `"/resolve"` (never posted as text).
  The workflow sets the status to `resolved` and, for a review-diff thread,
  resolves the conversation on GitHub too; a PR-wide thread has no GitHub
  resolve concept, so it stays local. See
  `.claude/docs/workflows-comments.md`.
- **"Unresolve comment"** → `unresolveFocusedComment` sends that same Signal
  with `action:'unresolve'` and no body: the status goes back to `open`, the
  workflow stores the `"/reopen"` trace itself and reopens the GitHub
  conversation for a review-diff thread. Only for a thread resolved after
  resolve became reversible — see "Resolve is reversible" in
  `.claude/docs/workflows-comments.md`.
- **"Bewerk bericht"** → `startEditMessage` opens an inline editor on the
  focused message in place; sending posts the `edit` Action of the same
  `reply` Signal (`sendMessageEdit`, `RelatedPanel.mjs`). See "Editing an own
  message" in `.claude/docs/comments-panel.md`.

## The comment-index item menu (`prComment`, `prCommentCommandsFor`)

`Enter` on a comment-index row (a PR-wide comment as an ordinary "Start" row)
opens this; `→` deliberately does something else (steps into the thread) — see
"Comment-index items" in `.claude/docs/keyboard-navigation.md` for the arrow
side and `.claude/docs/comments-panel.md` for the row/detail card itself.
`selectedComment()` gates a branch checked **before** the generic
Enter-opens-menu handling.

Rows (for an AI finding — `isAiComment`, see the comment-scoped menu above —
the resolve/unresolve slot is missing altogether, leaving **"Beantwoorden"**
default and **"Verwijder comment"** right behind it):
**"Sluit menu"** (pinned) → **"Beantwoorden"** and **"Resolve comment"**,
whose order depends on `isOwnComment(c)` (`home.mjs`): for the reviewer's own
comment — placed in this app (`!c.source || c.source === 'ui'`) or placed on
GitHub by them and later imported (`c.source === 'github'` +
`c.author === meLogin()`) — **"Resolve comment"** comes first (thus default);
otherwise **"Beantwoorden"** stays first. Both are always present, only the
order changes → **"Verwijder comment"** (`deletePrCommentItem`, always third,
never the default: destructive) → optionally **"Bewerk bericht"** (only for the reviewer's OWN
message the keyboard is currently on — `focusedPrThreadMessage(c)` walking
`pct`, see "Editing an own message" in `.claude/docs/comments-panel.md`) →
optionally **"Comment hiervan maken"** (only `source === 'ai'`, never true at
the same time as "own") → **"Chat met Claude"** (`startPrCommentChat`, always
present — opens the embedded conversation right under this item's own detail
card, since a comment-index item has no diff/`→` chain to reach the
block-scoped chat through; see "A PR-wide comment-index item can also start a
conversation" in `.claude/docs/claude-chat-panel.md`) → optionally **"Zet op
GitHub"** (`needsPublishChoice`) → **"Ignore"** ("Ignore ongedaan maken" once
ignored — `toggleIgnoreComment`, a durable sidebar-visibility flag through the
per-PR `ignore_comment` tracker).

Because the detail card already shows on selection, "the thread shows above the
menu" is just a consequence of the anchoring, not a separate menu variant.

**"Beantwoorden"** (`startPrCommentReply`) only reveals + focuses the reply
textarea in the detail card; typing + `Enter` (or the send button) sends, via
the same `reply` Signal (`done:false`). **"Resolve comment"**
(`resolvePrCommentItem`) sends that Signal with the `"/resolve"` sentinel +
`done:true` — and reads **"Unresolve comment"** (`unresolvePrCommentItem`,
`action:'unresolve'`) in that same slot on an already resolved thread.
**"Verwijder comment"** (`deletePrCommentItem`) sends the ordinary `delete`
Signal on the item's own Execution — the same one `deleteFocusedComment` uses
for a block-scoped comment. This menu had no delete at all, so a PR-wide AI
risk finding could be resolved but never removed (reported bug); no cursor
fix-up is needed, unlike `deleteCommentAndSelectRow`, since a PR-wide item has
no diff row to land on. No new write path anywhere here.

### A no-match query falls back to Chat/Beantwoorden, not "Geen commando's"

Reported bug: selecting a comment-index row (e.g. an AI-risicowaarschuwing),
pressing `Enter`, then typing an actual question ("Klopt dit echt? geef code
voorbeelden") fuzzy-matched none of the short labels above ("Beantwoorden",
"Resolve comment", "Chat met Claude", …) and collapsed to `CommandMenu`'s bare
"Geen commando's." — a dead end, since a comment-index item has no diff row to
fall back onto either (stepping `→` into the thread and typing straight into
the reply field still worked, since that field isn't filtered by the palette
at all — which is what made this easy to miss). `resolveCommands` (`home.mjs`)
now gives `ms.mode === 'prComment'` the same shape of no-match fallback as the
block palette's own (see "Filtering, submenus, and the no-match fallback"
above), only when `filterCommands(ms.commands, query)` is empty for a
non-blank query: **"Chat over deze comment"** (default, first —
`startPrCommentChat(selectedComment())`, then prefills `claude-chat-compose`
with the typed text) and **"Beantwoorden met deze tekst"**
(`startPrCommentReply(selectedComment())`, prefills `comment-detail-reply`).
It can't reuse the block-mode fallback verbatim: that one anchors on
`commentTarget`/`startComment`/`startClaudeChat`, which assume a real diff
unit to hang a NEW comment/chat off — a comment-index item has neither
(`commentTarget()` returns `null` for it, per "Selecting a 'Start' item
empties the block-scoped index" in `.claude/docs/comments-panel.md`), so this
fallback targets the item's own existing composer entry points instead. Test:
`tests/pr-comment-menu-fallback.spec.mjs`.

## The compose (comment-kind) menu (`compose`, `COMPOSE_COMMANDS`)

**Only while the open composer is CONVERTING an AI-controle finding**
(`isConvertingAiWarning()`, `RelatedPanel.mjs` — true exactly while
`warningOverride` is set, i.e. the composer was opened via "Comment hiervan
maken", see `.claude/docs/comments-panel.md`), does `Enter` (and the
composer's own **"Plaats…"** button, via `RelatedPanel`'s `openCompose` prop)
open this menu instead of placing the comment immediately. Five rows:
**"Sluit menu"** (pinned), **"Plaats comment"** (default, 2nd — so "type,
Enter, Enter" still places it directly), *Claude command* (placeholder), *Let
Claude implement this (group/line/call)* (placeholder, label names the unit
via `granNoun()` from `commentTarget()`), and *Jira* (a submenu of three
placeholders).

**An ORDINARY composer (not converting a finding) skips this menu entirely —
Enter/"Plaats…" call `runComposePost()` straight away**, posting the comment
with no extra step. Reviewer request: only a conversion of an AI finding into
a real, public comment deserves one more look before it becomes public; a
plain new comment should just post — even one on a line that happens to
already carry an unrelated (not-being-converted) AI warning. `runComposePost`
(`home.mjs`, extracted so the menu item and the direct-post shortcut share one
implementation — "a click runs the same function a key runs",
`.claude/docs/mouse-navigation.md`) is exactly what **"Plaats comment"**'s own
`run` calls too.

**"Plaats comment"** / `runComposePost()` → `placeComment(state,
commentTarget)` posts a normal public comment. It's `async` and calls
`pollWorkflows()` after a successful place, so the new `task_code_comment` run
shows in the "Taken" card immediately instead of at the next
`WORKFLOWS_POLL_MS` tick. Placing a comment leaves the approval of the unit it
hangs on **untouched** — see `.claude/docs/approval.md`.

**A right-click on the composer still always opens this menu, conversion or
not** — `rightClickMenuMode()` deliberately does NOT mirror the
`isConvertingAiWarning()` split: a right-click is itself an explicit request
to see the available commands, unlike Enter/a plain click, which are
unambiguous "post it" requests. See "The right-click context menu" above.

**There used to be a sixth row, "Alleen voor mijzelf"** (`placeComment(…,
{ local: true })`, storing a private note that never reaches GitHub — see the
`local` flag in `.claude/docs/workflows-comments.md`) — removed on request
("dat gebruik ik niet meer"): it was the one UI entry point that let the
reviewer keep a brand-new root comment private. `placeComment`'s `opts.local`
parameter itself is untouched (generic, shared plumbing —
`ensureClaudeAnchorForNew`, `RelatedPanel.mjs`, still always creates its
Claude-chat anchor comment with `local:true`). This was a DIFFERENT feature
from `replyPublishCommandsFor`'s own "Alleen voor mijzelf (blijft lokaal)"
item (keeping an existing thread's own REPLY local, not creating a brand-new
private root comment) — that one has since been removed too, on the same kind
of request, see below. Test: `tests/compose-place-comment.spec.mjs` now also
asserts the row is gone.

The Enter branch sits in `onKeydown` **before** the `relatedActive()` branch
(`isComposeOpen()` + `composeHasText()`), so it works whether the composer was
opened by keyboard or button; **Shift+Enter** falls outside it and stays a
newline. This was the first flow to open a menu **over** an open composer,
which is what surfaced the arrow.js orphan-binding crash the fresh-`ms` split
fixes (above).

## The publish menu (`replyPublish`, `replyPublishCommandsFor()`)

The compose menu's sibling for an **existing** thread that has never touched
GitHub (a private note, or an AI finding). Sending a reply there doesn't post:
the send is held (`pendingPublish` in `RelatedPanel.mjs`) and this menu decides
what may become public. Three rows: **"Sluit menu"** (pinned), **"Alleen mijn
antwoord op GitHub"** (default, 2nd) and **"Ook de AI-melding op GitHub"** /
**"Ook mijn comment op GitHub"** (label by `source`). Every item calls
`sendPendingReply(publish, withHistory)`, which re-runs the very same send with
a `publish` flag on the `reply` Signal.

**There used to be a fourth, DEFAULT row, "Alleen voor mijzelf (blijft
lokaal)"** (`sendPendingReply('', false)`, keeping the reply local — the
"type, Enter, Enter" flow behaved exactly as before this menu existed).
Removed on request ("dat gebruik ik niet meer" — the exact same request, and
the same accepted default-shifts-one-item-down consequence, as the compose
menu's own "Alleen voor mijzelf" above): a bare "type, Enter, Enter" on a
still-local thread now publishes just the typed reply to GitHub instead of
keeping it local. `sendPendingReply`'s `publish: ''` branch and the backend's
local-reply plumbing (`ReactionSignal.Publish`, `workflows.go`) stay — generic,
unused from here, exactly like `placeComment`'s `opts.local` above. Test:
`tests/reply-publish-local-thread.spec.mjs`.

The two GitHub items become a **submenu** (*"Zonder de eerdere N berichten"* /
*"Met de eerdere N berichten"*) only when the thread actually holds earlier
local replies — otherwise they stay plain, directly running items rather than
costing a keypress for a choice with one possible answer. Built fresh at open
time with plain-string labels, per `snapshotCommands`' rule.

It is **not** an `isReviewFollowup` mode: the reply field it belongs to is
on-screen, so `positionMenu` anchors it normally.

## `/` opens the menu of the CURRENT STOP (`contextMenuMode`)

`/` used to be hardwired to `openMenu('pr')`. It now opens whatever menu
belongs to the stop that owns the keyboard — `contextMenuMode()` (`home.mjs`),
mirroring the Enter branches further down in `onKeydown`:

| stop | mode |
|---|---|
| the push-todo row | `pushTodo` |
| a comment-index row | `prComment` |
| stop 1 (description), a toggle row, no block loaded | `pr` |
| anything else (a selected block / a diff / stop 2b) | `block` |

Reviewer request: "als ik `/` typ, wil ik chatten met claude. Als dat betekent
dat ik een code line heb geselecteerd, wil ik het menu zien dat al bestaat …
als er geen menu is, laat dan in pr tree het algemene menu zien." The chat part
follows for free: with the block palette open, typing a question nobody's
command matches lands on **"Chat over deze regel"**, the default no-match
fallback (above). So `/`, type, Enter is one flow.

`compose`/`comment`/`claude` are deliberately **absent** from that table: those
stops all sit behind the `isComposeOpen()`/`relatedActive()`/`isEditableFocused()`
branches, which return before `/` is ever looked at — a `/` typed into a
composer must reach the field as a character. They are still reachable exactly
as before, via `Enter`.

**Accepted consequence, stated so it isn't mistaken for a regression:** the
PR-wide menu (and thus "PR keuren", "Diepgravend onderzoek", "Algemene comment
plaatsen") is no longer one keypress away from a selected block — it now takes
`←` into stop 1 first, or `Enter` there. That is the direct implication of the
request above; the specs (`tests/pr-menu.spec.mjs`,
`tests/prwide-comment.spec.mjs`) walk that extra step.

## The PR-wide menu itself (`pr`, `PR_COMMANDS`)

The same overlay, with actions on the **whole PR**. Five root items:

1. **"Sluit menu"** (pinned).
2. **"GitHub"** (submenu, thus the default item — a submenu rather than a
   direct action, deliberately left as-is): *Open on GitHub*, **"PR keuren"**
   and **"Algemene comment plaatsen"** (`startPrWideComment` — a PR-WIDE issue
   comment, not a line comment; it used to run `startComment` and therefore
   placed an ordinary line comment, or nothing at all, see "Placing a PR-wide
   comment yourself" in `.claude/docs/comments-panel.md`). **"PR keuren"** is a manual
   entry point into the exact same approve/reject flow as the automatic
   review-submit follow-up below (`children: REVIEW_CHOICE_COMMANDS`, the
   identical array, no second implementation) — so a reviewer can approve or
   reject the whole PR at any moment, not only right after approving the last
   reachable unit. Nesting a submenu's item that itself opens a further
   submenu (here down to `REVIEW_APPROVE_CONFIRM_COMMANDS`, or into the
   `reviewReject` mode) works with no changes to `enterSubmenu`/`onKeydown`:
   `Esc` from any submenu depth always resets straight to that mode's root
   (`ms.sub = null`), never "back one level", so extra nesting is free.
3. **"Jira"** (submenu): *Open in new tab* (deep link), plus *Place comment* and
   *Create subtask* as **placeholders** (no Jira write integration yet).
4. **"Show full description" / "Collapse description"** — a label function
   toggling `state.descriptionExpanded`, the same ephemeral flag as the in-card
   "more…" affordance (see `.claude/docs/detail-layout.md`). The label is
   snapshotted at open time by `snapshotCommands`, so no reactive binding leaks
   into the `CommandMenu` tree.
5. **"Alle goedkeuringen intrekken"** (submenu, one confirm row — same
   lightweight "one extra Enter" confirm as "PR keuren" above) — clears every
   approval in the WHOLE PR in one action (`retractAllApprovalsForPr`).
   Walks `state.blocks` exactly like `syncViewedFiles`/the approval rollup
   (an ordinary block's own `approvedRows`/`approvedCalls`; every method of a
   `test_class` row, which carries no approval of its own — see
   `.claude/docs/test-class-grouping.md`), clearing each and persisting it
   through the existing single-block `approve` Signal (`persistApproval`) —
   the same write path `toggleRangeApproval`/`applyBulkApproval` already use,
   one Signal per block, never a batch write. Reviewer request: a bulk
   opposite of approving everything, for when a re-review is needed from
   scratch. Test: the last test in `tests/pr-menu.spec.mjs`.

There used to be a 4th item here, **"Diepgravend onderzoek"**, which manually
started `code_warning` on Opus. Removed on request ("die wordt toch
automatisch gedaan toch?") — confirmed still true:
`.claude/docs/workflows-analysis.md`'s "AI risk check of the whole PR" section
already fires `code_warning` automatically on a PR's first ingest and on
every ingest-refresh that finds a newer head SHA, gated only by the "Live AI
assistent" toggle (which never gated the now-removed manual trigger either).
The now-unused `checkPRWarnings` function (and its call site) were removed
along with the menu item — there is no other way left in the UI to force a
one-off re-run outside of a new commit landing.

A typed `/` in a focused input never reaches this handler — the
`relatedActive()` branch catches it earlier, so the character flows into the
field. Which stop `/` opens this list from: see `contextMenuMode` above.

The Jira/GitHub links need **PR metadata** (title + URL, and the `KEY-123`
ticket key derived from the title) from the `prmeta` read model via
`GET /api/pr?pr=N`, filled by `pr_status` (see
`.claude/docs/workflows-trackers.md`). `home.mjs` (`loadPRMeta`) ensures the
tracker on load; missing metadata falls back to the bare PR URL resp. the Jira
base.
