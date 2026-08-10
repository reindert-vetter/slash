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
| The Claude chat's "Stuur" button | `Enter` in the chat composer | `.claude/docs/claude-chat-panel.md` |
| Focusing the Claude chat composer (click or Tab), on an already-anchored conversation | `→` from `'comment'` into it | "Clicking straight into the composer…" in `.claude/docs/claude-chat-panel.md` |
| A `claude-question-option` chip | typing that same answer as free text (the backend records the next message as the open question's answer either way) | `.claude/docs/claude-chat-panel.md` |

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
