# Mouse navigation

The counterpart of `.claude/docs/keyboard-navigation.md`, and deliberately much
smaller: this app is keyboard-first, so almost every mouse action is defined as
"the same thing a key already does". This file holds only what is **generic**
about mouse interaction — the app-wide conventions and the two pitfalls that
recur. Anything specific to one feature stays documented with that feature; this
file points at it.

## Rule 1: a click is the Enter-equivalent, never its own behaviour

Where a click and a key both act on the same thing, the click runs the **same
function** the key runs — never a parallel implementation. Concretely:

| Click target | Equivalent key | Documented in |
|---|---|---|
| An Underlying-code child (`data-testid=related-item`) → drill | `Enter` on the focused child | "Drilling" in `.claude/docs/drilling.md` |
| A drill-hint chip (`related-nested-chip`) | `Enter` on the focused chip | "Drill hint chips" in `.claude/docs/underlying-code.md` |
| The tests bar (`related-tests-bar`) → toggle | `Enter` on the bar | "Grouping covering tests" in `.claude/docs/underlying-code.md` |
| A sidebar block row | `↑`/`↓` selection | `.claude/docs/keyboard-navigation.md` |
| `toggle-approved` / `toggle-ignored` | `Enter`/`→` on that row | `.claude/docs/keyboard-navigation.md`, `.claude/docs/approval.md` |
| The approve checkbox on a block card | the palette's "Approve …" item | `.claude/docs/approval.md` |
| `pr-info-body-toggle` ("more…") | the PR menu's "Show full description" | `.claude/docs/detail-layout.md` |
| A `/pr-overview` row → popover | `Enter` on the selected row | `.claude/docs/pr-overview.md` |
| A diff row → 1×/2×/3× click selects the line/group/whole block, mousedown+drag = a per-line range | `f`/`d`/`s` (zoom) + `↑`/`↓` (jump to it in steps), Shift+`↑`/`↓` (range) | "Line selection: hover, click, drag-range" in `.claude/docs/diff-render.md` |
| A call segment's dot/hover ring (`data-seg-dot`) | `Space` (approve + continue) | "Approving from the mouse" in `.claude/docs/approval.md` |
| A mouse selection (diff row/group/call) | landing on that unit, then `Enter` | "A mouse selection shows the palette passively" in `.claude/docs/command-palette.md` |
| The Claude chat's "Stuur" button | `Enter` in the chat composer | `.claude/docs/claude-chat-panel.md` |
| Focusing the Claude chat composer (click or Tab), on an already-anchored conversation | `→` from `'comment'` into it | "Clicking straight into the composer…" in `.claude/docs/claude-chat-panel.md` |
| A `claude-question-option` chip | typing that same answer as free text (the backend records the next message as the open question's answer either way) | `.claude/docs/claude-chat-panel.md` |
| `block-open-menu` / `pr-menu-button` / `comment-detail-menu` / `claude-chat-menu` (each opens `openMenu(...)`) | `Enter` on the same target | "Every menu also has a mouse entry point" below |
| `block-leave-diff` (top-level card) / `block-close-column` (a drilled column) | `←` on the diff (`leaveDiffToList`/`closeDrilledColumn`) | "Every diff card/column also has a mouse way back" below |
| `block-open-description` (top-level card) | `←` twice on the diff (`leaveDiffToDescription`) | "Every diff card/column also has a mouse way back" below |

Two consequences worth keeping in mind when adding a click handler:

- **Reuse the function, don't reimplement the effect.** `drillIntoChild` is
  called by both the `Enter` branch in `onKeydown` and the panel's `@click`
  callback for exactly this reason — a second code path would drift.
- **A click may be more permissive than the key.** A click is an unambiguous
  request, whereas a key is often overloaded. The send-status button next to
  "Stuur" opens the comment menu on click regardless of whether the reply field
  is empty, while `Enter` only opens it when the field *is* empty (otherwise
  `Enter` sends the reply). See "Status mark / send-status indicator" in
  `.claude/docs/comments-panel.md`.

## Rule 2: a mouse-only shortcut is allowed, but only as a shortcut

A few targets do something the keyboard cannot do in one step. That is fine as
long as the keyboard can still reach the same **state** in several steps — a
mouse-only *destination* is not.

- **A collapsed column rail** (`block-collapsed`/`drill-collapsed`) jumps
  straight to that level; the keyboard gets there with repeated `←`
  (`expandColumn`, see `.claude/docs/drilling.md`).
- **A chip at depth d** drills `d+1` levels in one click (with
  `stopPropagation` so the card underneath doesn't also drill), where the
  keyboard drills one level at a time — see `.claude/docs/underlying-code.md`.
- **The `viewModeIndicator` icons** jump straight to a `split`/`unified`/`fit`
  stand, where `a` cycles — see "`a` — cycling the diff view" in
  `.claude/docs/keyboard-navigation.md`.
- **`block-open-description`** jumps straight from the diff (stop 3) to the PR
  description (stop 1) in one click; the keyboard reaches the same state with
  `←` twice — see "Every diff card/column also has a mouse way back" below.

## Rule 3: genuinely click-only surfaces must not hold state

Two surfaces have no keyboard cursor at all, and both are deliberate:

- **The "Taken" rows** under the PR-description column (`openTask`) — stop 1 of
  the nav chain suppresses `↑`/`↓`, so a row has no focus ring; a run without a
  `comment` ref is purely informational. See "Tasks" in
  `.claude/docs/detail-layout.md`.
- **The collapsed-run spacer** in a huge block's diff ("⋯ N unchanged lines").
  It lives inside an `.innerHTML` string, so it cannot carry an arrow.js
  binding at all and is handled by click delegation on the pane's `<code>`
  (`onPaneClick`). See "Huge blocks" in `.claude/docs/diff-render.md`.

Adding a keyboard cursor to either would mean adding a nav stop, which is a
change to the chain in `.claude/docs/keyboard-navigation.md` — not a local one.

## Rule 4: hover carries no state in the review tree

On `/pr/<id>` nothing is reached by hovering: a comment thread, a detail card
and a drilled column all appear from **selection** only. Hover is limited to CSS
affordances (a row tint, a cursor change). Keep it that way — a hover-revealed
control is unreachable by keyboard and invisible on touch.

The one place with real hover machinery is the `/pr-overview` row list, where a
`mouseenter` may move the selection ring. That needs a gate against a **parked**
pointer: a scroll or a layout change can slide a row under a stationary cursor
and fire a genuine `mouseenter` that hijacks the keyboard selection. Both halves
of that gate (`hoverEnabled` — a coordinate-delta check on `mousemove`, plus
disarming on a data-driven repaint) are documented with the feature, in
"The hover-vs-keyboard flag" in `.claude/docs/pr-overview.md`.

## Every menu also has a mouse entry point

Until this was added, only rows *inside* an open menu were clickable —
opening one at all was almost entirely keyboard-only (Enter/`/`). Four small
icon buttons close that gap, each just calling the same `openMenu(...)` the
matching key already calls (rule 1 above — reuse, never a second
implementation):

| Button (`data-testid`) | Opens | Where | Icon |
|---|---|---|---|
| `block-open-menu` | `COMMANDS` (block palette) | `Block.mjs`'s header row, next to `viewModeIndicator` | vertical kebab (⋮) |
| `pr-menu-button` | `PR_COMMANDS` (PR-wide menu) | `prInfoCard`'s existing `pr-info-theme-row`, next to the theme/auto-warn toggles | shield-check |
| `comment-detail-menu` | `prCommentCommandsFor()` | `commentDetailCard`'s author line (`RelatedPanel.mjs`) | speech-bubble-with-dots |
| `claude-chat-menu` | `claudeChatCommandsFor()` | `claude-chat-header` (`ClaudeChat.mjs`), both the block-scoped and the PR-comment-index Claude column | sparkle |

Each gets its **own** icon (reviewer request: "per plek een eigen icoon …
zodat ze visueel te onderscheiden zijn") rather than one repeated kebab, so
the four are told apart at a glance while staying in the same visual
language (small inline SVG, `currentColor`, same size class as the existing
icon buttons).

**`block-open-menu` is hover-revealed, the other three are always visible**
(reviewer decision, per button — a block card is dense and stacks many
instances on screen, the other three surfaces are singular/already-selected
UI). The reveal is **CSS-only** (`opacity-0 group-hover:opacity-100
focus-visible:opacity-100` on a static `group` class on the card root) —
never a reactive `state`/`cs` flag — per rule 4 ("hover carries no state").
`focus-visible` also reveals it on Tab, and the click handler works
regardless of visibility (a `dispatchEvent('click')` in a test, or a real
click right as CSS opacity animates in), so nothing keyboard/touch-only is
actually gated behind hover; Enter on the same card still opens the identical
menu either way.

`onOpenMenu`/`openMenu` is threaded as a plain **render-time callback opt**
at each call site (`Block(b, { onOpenMenu: () => openMenu(...) })`,
`commentDetailCard(c, { openMenu: () => openMenu('prComment') })`,
`callbacks.onOpenMenu` inside `claudeChatCallbacks`/the PR-comment Claude
view's own callbacks object) — the same shape `InlineComments`' own
`openCommentMenu` already uses, not a new module-level opener registration
(that shape stays reserved for a call that originates from logic buried
inside `RelatedPanel.mjs`, like `claudeMenuOpener`, not from a straightforward
render-prop). The Claude column reuses the **existing**
`openClaudeMenuFromComposer` (`RelatedPanel.mjs`) for both its call sites, so
there's still exactly one function that calls `claudeMenuOpener`. Test:
`tests/mouse-menu-buttons.spec.mjs`.

## Every diff card/column also has a mouse way back

Until this was added, `←` was the only way out of a diff session or out of a
drilled Underlying-code column — clicking a collapsed rail (`expandColumn`,
above) jumps several levels at once, but there was no click that did just
what a single `←` press does. Small icon buttons close that gap, each calling
the exact function `←` already runs at that depth (`onKeydown`'s `ArrowLeft`
branch in `state.mode==='diff'`, `home.mjs`):

| Button (`data-testid`) | Calls | Rendered on | Icon |
|---|---|---|---|
| `block-leave-diff` | `leaveDiffToList()` | the top-level block card (`focusLevel===0`) | a bulleted list |
| `block-open-description` | `leaveDiffToDescription()` | the top-level block card (`focusLevel===0`) | a double chevron ("rewind") |
| `block-close-column` | `closeDrilledColumn()` | the currently focused drilled column | a chevron docked against a bar |

`leaveDiffToList`/`closeDrilledColumn` (`home.mjs`, next to `expandColumn`)
are themselves just the two bodies extracted verbatim out of that
`ArrowLeft` branch — `onKeydown` now calls them too, so there is exactly one
implementation of each, per rule 1 above. `leaveDiffToDescription` is
`leaveDiffToList()` immediately followed by the same stop-2 → stop-1
transition that `onKeydown`'s `ArrowLeft` branch runs in `state.mode==='list'`
(`state.showDescription = true` plus its sibling flag resets) — i.e. the exact
same two steps `←` twice would take, composed into one function, per
"reviewer request: a mouse-only destination is fine, per Rule 2 below, as
long as the keyboard already reaches the same state in more than one step".

Only `block-leave-diff`/`block-open-description` (top-level) or
`block-close-column` (a drilled column) are ever passed to a given
`Block(b, {...})` call site in `home.mjs`, and `Block.mjs` only renders the
matching button(s) while `diffActive()` (the same gate `viewModeIndicator`
already uses) — so at most one of these buttons is ever on screen at a time
per card, on whichever card/column currently owns the diff keyboard.

**`block-leave-diff` and `block-open-description` live OUTSIDE the card**,
in `diffLeaveRail` — a small bordered block rendered to the LEFT of the
top-level `<article>` (reviewer request: a dedicated block instead of more
icons crowded into the header row that already holds `viewModeIndicator`/
`block-open-menu`). `Block()`'s own template root became a
`flex items-start gap-2` wrapper around `diffLeaveRail(...)` (a nested
reactive slot, empty unless `!preview && diffActive() && onLeaveDiff`, same
shape as every other conditional slot in this file) and the `<article>`
itself — every existing attribute the resize/measurement code relies on
(`data-col-resize-root`, `data-diff-col-key`) stays on the `<article>`
unchanged. `block-close-column` stays where it was, in the drilled column's
own header row — a drilled column has no stop-1 destination of its own, so it
never gets a left rail.

**Always visible, not hover-revealed** (reviewer decision, unlike
`block-open-menu`): there is only ever one rail/one close button showing at
once, so the "dense card, many instances" reasoning that keeps
`block-open-menu` hover-only doesn't apply here.

**Each gets its own icon**, not a shared chevron, for the same
"per plek een eigen icoon" reason as the four menu buttons above — leaving
the diff entirely, jumping to the description, and closing one drilled column
are different actions with different reach, and telling them apart at a
glance matters more than reusing one glyph.

**Does not collide with the passive command-palette preview**
(`showPassiveMenu`, see "A mouse selection shows the palette passively" in
`.claude/docs/command-palette.md`): that preview floats **below the bottom
row of the current selection**, inside the diff body, while the rail sits to
the card's **left**, entirely outside it, and `block-close-column` sits in
the drilled column's header row, above the diff entirely — none of these ever
overlap the preview on screen. None of them are `[data-row]`
and none sit inside `[data-testid="command-anchor"]`, so a click on any of
them still dismisses a stray passive preview first (the existing
document-level `mousedown` listener, capture phase) exactly like a click
anywhere else outside the diff would — the dismiss only *sets a flag*, it
never calls `stopPropagation()`, so the button's own `@click` (which does
call `e.stopPropagation()` before its state change, per the pitfall below)
still fires normally afterward.

## Pitfall: a nested `@click` must call `stopPropagation()` FIRST

A nested handler that synchronously mutates reactive state can unmount its own
ancestor — including that ancestor's click-swallowing listener — before native
bubbling reaches it, so the click keeps going and the ancestor's handler runs
after all (typically reopening the thing the button just closed). Always call
`e.stopPropagation()` in the nested handler itself, **before** the state
mutation. Full mechanism and the case it was found in: "A nested `@click`
handler …" in `.claude/rules/arrowjs-pitfalls.md`.

## Pitfall: a test that drives the UI with the mouse parks a pointer

`.click()` moves the real pointer and leaves it there for the rest of the spec,
so a later layout change can fire a real `mouseenter` from it. When a spec's
subject is not hover, prefer `dispatchEvent('click')`. See
`.claude/docs/testing-playwright.md`.
