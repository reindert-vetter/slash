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
| The line/group gutter toggle (`data-approve-toggle`) or a call segment's dot (`data-seg-dot`) | `Space` (approve + continue) | "Approving from the mouse" in `.claude/docs/approval.md` |
| The Claude chat's "Stuur" button | `Enter` in the chat composer | `.claude/docs/claude-chat-panel.md` |
| Focusing the Claude chat composer (click or Tab), on an already-anchored conversation | `→` from `'comment'` into it | "Clicking straight into the composer…" in `.claude/docs/claude-chat-panel.md` |
| A `claude-question-option` chip | typing that same answer as free text (the backend records the next message as the open question's answer either way) | `.claude/docs/claude-chat-panel.md` |
| `block-open-menu` / `pr-menu-button` / `comment-detail-menu` / `claude-chat-menu` (each opens `openMenu(...)`) | `Enter` on the same target | "Every menu also has a mouse entry point" below |

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
