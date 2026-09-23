# Manual column resize: drag any column to a custom width

Every column in `<main>`'s column flow — the block-diff card, a drilled
Underlying-code column, and the Underlying-code/Claude-chat/inline-comments
columns next to it — computes its own width as a pure, content-driven
Tailwind class (`widthCls`/`relatedColumnWidthCls`/`commentColumnWidthCls`/
`claudeColumnWidthCls`, see `.claude/docs/diff-card.md`). On top of that, a
reviewer can drag any of those columns' right edge to a custom pixel width,
remembered per block for a month. Mechanism lives in `src/columnWidth.mjs`, a
pure, state-agnostic utility module (same tier as `urlState.mjs`/`theme.mjs`).

## Why a cookie, not the URL or `localStorage`

An explicit product decision, not a default:

- **Per block, not one global preference** — unlike `theme.mjs`'s
  `localStorage`, which holds exactly one value for the whole app. A width
  override is keyed per `(kind, block)` (see below), so `localStorage`'s
  single-key shape doesn't fit without inventing the same JSON-map structure
  a cookie already gives for free.
- **Not the URL** — `?sel=`/`?drill=`/etc. already carry the navigation
  position (see CLAUDE.md's "URL state" section); a per-block width map for
  every column kind would make a shared link unreadably long, and a width
  preference isn't "where you were", it's "how you like to look at code" —
  the same category of decision the cookie already fits.
- **30 minutes, not indefinite** — the reviewer's own explicit choice: a
  width preference is "how I like to look at code in THIS session", not a
  setting worth carrying across days. Short enough that a stale entry for a
  since-merged/deleted block, or for a block the reviewer simply isn't
  looking at anymore, ages out quickly rather than accumulating; there is no
  cleanup workflow for this cookie (deliberately — see
  `.claude/rules/workflows-write-boundary.md`: a cookie write is a pure
  browser-local operation, not a durable write that needs a workflow at
  all). Superseded a much longer-lived 30-day cookie — see "Cookie-size cap"
  below for the bug that longer retention (and the underlying unbounded map)
  exposed.

## Mechanism: an inline style always wins over the class

An inline `style="width:...px;max-width:...px"` beats a Tailwide `w-[...]`
class regardless of specificity, so **none of the existing width-class
functions needed to change** — this is a purely additive layer:

- `colWidthStyle(state, key)` returns that whole-value style string (or `''`
  for "auto — the class wins"), read by each column's own `style="${() =>
  ...}"` binding (the "attribute value must be the whole value" rule in
  `.claude/rules/arrowjs-pitfalls.md`).
- `getColumnWidth(state, key)` is the reactive read: it `void`s
  `state.colWidthVersion` before reading `state.colWidths[key]`. **Adding a
  brand-new key to a plain reactive object is not reliably re-notified in
  this codebase's arrow.js build** — the same caveat already documented on
  `state.langSiblings` in `home.mjs` — so every write bumps
  `state.colWidthVersion` and every reader depends on that counter instead of
  the individual key. Cheap and correct, at the cost of every column's style
  binding re-evaluating on any OTHER column's resize too (acceptable — these
  are already small, per-card nested slots, not the outer array-building
  closures the "outer closure vs. nested slot" pitfall warns about).

## Column identity: `${kind}:${id}`

`kind` ∈ `'diff' | 'related' | 'claude' | 'comments'`. Each kind is an
**independent** override, even for two columns that visually sit in the same
row (see the accepted trade-off below).

- **`'diff'`** — keyed by the block's own stable `b.id` (Block.mjs already
  relies on this id for drilled/synthetic call frames, see
  `.claude/docs/drilling.md`). Both the top-level selected card and every
  drilled column reuse the same `Block()` render and therefore the same
  wiring (`home.mjs`'s two `Block(b, {...})` call sites), so an override
  survives a drill/step exactly like the rest of a block's state.
- **`'related' | 'claude' | 'comments'`** — these three (`RelatedPanel.mjs`)
  only ever receive `commentTarget()`, never a raw block, so the key reuses
  the `${file}:${line}` identity `state.blockRef` already relies on
  elsewhere (CLAUDE.md's "URL state" section):
  `colWidthKeyFor(kind, commentTarget)` in `RelatedPanel.mjs`. `null` when
  `commentTarget()` returns nothing (e.g. a synthetic comment-index item) —
  no key, no override, no handle.

## Accepted trade-off: the comment/Claude ↔ Underlying-code row alignment can break

`.claude/docs/detail-layout.md` documents a width invariant:
`commentColumnWidthCls()` (half) + the connector + `claudeColumnWidthCls()`
(the other half) sum to exactly `relatedColumnWidthCls()`, so the comment/Claude row
lines up with the Underlying-code row beneath it. Resizing any ONE of the
three columns independently (the reviewer's explicit choice — "elke kolom
volledig onafhankelijk resizable") breaks that alignment the moment an
override is active on just one of them. **Deliberately accepted**, not a bug:
an explicit manual resize is allowed to override an automatic layout
guarantee, the same stance already taken for `fit`'s clip-avoidance guarantee
below.

## The `fit` stand: the override wins there too

`fit`'s whole point is normally to avoid clipping a long PHP line (see
`.claude/docs/diff-card.md`'s "uncapped upward" note). A manual override
still applies on top of `fit` and can re-introduce clipping if dragged
narrower than the content needs — again explicitly accepted per product
decision: a reviewer's own drag is a deliberate action, and the override
mechanism draws no distinction between stands.

## Resize handle and the two reset paths

`resizeHandle(onDown, onReset)` (`columnWidth.mjs`) renders a thin
`data-testid=col-resize-handle` strip on the right edge
(`cursor-col-resize` — Rule 4 in `.claude/docs/mouse-navigation.md`: hover
carries no state, only a CSS cursor change) with a subtle hover tint. Its
column root needs **`relative` + `data-col-resize-root`** — the latter is the
drag's `closest(...)` anchor, so the handle can find its own column
regardless of nesting.

**`right-0`, never a negative offset:** several resizable roots
(`related-code`, the block-diff `<article>`) carry `overflow-hidden` for
unrelated reasons; a handle positioned outside the box's own edge
(`-right-1`) is clipped there and therefore never hit-testable —
`page.mouse.down()` silently missed it entirely in the regression test until
this was caught. `right-0` keeps the handle inside the clipped box.

- **Any non-preview/look-ahead card shows the handle**, for the `'diff'`
  kind too — `Block.mjs` gates it on plain `!preview`, **not**
  `diffActive()`. `diffActive()` additionally requires `state.mode ===
  'diff'` and `!relatedActive()`, which is right for `viewModeIndicator`
  (a genuinely diff-session-only concept, see the "preview never wider than
  active" rule in `.claude/docs/diff-card.md`) but wrong for resize: it made
  the handle disappear in **list mode** (the block-index/sidebar still
  open, before stepping `→` into a diff session) even though the selected
  card is visibly right there, and while the keyboard had moved into the
  card's own Underlying-code panel (`relatedActive()`). `preview` already
  reports `false` in exactly the cases resize should stay available (both
  `Block()` call sites in `home.mjs`: `preview: i !== sel || !focusedHere`
  at the top level, `preview: !focusedHere` for a drilled column — `focusedHere
  = state.focusLevel === 0/level`), so `!preview` alone is the right, and
  only, gate — consistent with how the Underlying-code/Claude-chat/
  inline-comments handles already show unconditionally (no mode/
  `relatedActive()` gating at all). The override itself always applied to a
  preview/unfocused instance of the same block regardless (its width
  persists regardless of role) — only the drag handle's visibility changed.
- **Drag** (`startColumnResize`): `mousedown` on the handle starts it,
  `document`-level `mousemove`/`mouseup` track the rest of the gesture — the
  same module-level-listener shape as `home.mjs`'s own
  `window.addEventListener('resize', ...)` (re-checking `applyDiffColumnFit`)
  — needed because the pointer routinely leaves the handle's thin (`w-2`, 8px) hit
  area mid-drag. Floored at `MIN_COL_PX` (200px) so a column can never
  collapse to an unusable sliver; no upper bound (`<main>` already scrolls
  horizontally without limit).
- **Reset path 1 — snap-back:** on `mouseup`, if the dragged width ends up
  within `SNAP_BACK_PX` (10px) of the CURRENT auto width, the override is
  cleared instead of committed. `parseAutoWidthPx(clsString)` computes that
  auto width from the same width-class string the column would render
  without an override — two shapes: the `relatedColumnWidthCls`/
  `commentColumnWidthCls`/`claudeColumnWidthCls`/`boundedWrapWidthCls` shape,
  **viewport-aware** (`w-[Nrem] narrow:w-[Nrem] 2xl:w-[Nrem]`, and picking the
  wrong token — e.g. always the bare one — compared a wide-viewport drag
  against the narrower base width and wrongly committed an override on a 3px
  nudge, caught by the regression test below); and `Block.mjs`'s
  `contentWidthCls` shape (`w-[Npx]`, a PHP diff card in every stand), which
  needs no conversion at all. **Superseded (2026-08-20):** that second shape
  used to be `w-[calc(Nch_+_Mrem)]`, and resolving its `ch` against the card
  `<article>`'s own font needed a throwaway off-screen probe element
  (`chPxFor`) plus the `el` parameter threaded through `autoWidthPxFn` — a
  canvas `measureText` approximation had landed ~25px off, outside
  `SNAP_BACK_PX`. `Block.mjs` now converts its own chars-count to px against
  the CODE font's real advance width (`CODE_CHAR_PX`, see
  `.claude/docs/diff-card.md`), so both the probe and `el` are gone and this
  function no longer touches the DOM at all. `autoWidthPxFn` still RECEIVES
  the drag's `root` — `startColumnResize` passes it unchanged — every caller
  now just ignores it.
- **Reset path 2 — double-click:** `@dblclick` on the handle calls
  `resetColumnWidth`/`clearColumnWidth` directly, independent of any drag
  distance.

## The call/comment-arrow overlay is suspended for the duration of a resize

The Underlying-code call-arrow overlay (`.claude/docs/underlying-code.md`)
points at fixed DOM anchors — the diff pane's own right edge, an
Onderliggende-code card's edge — that a column resize moves continuously.
Nothing else in a resize gesture touches `setRelated`/`setCallArrows`/
`scroll`/`resize`, so left alone the line stayed drawn at its pre-drag
coordinates throughout the drag and only snapped to the right place on some
later, unrelated redraw. `startColumnResize`/`startKeyResize`
(`columnWidth.mjs`) now call `suspendCallArrows()` (`callArrows.mjs`) as
soon as the gesture starts — hides the overlay immediately — and
`resumeCallArrows()` once it ends (drag `mouseup`, or either `cancel()`/
`commit()` of a held `c`/`v` keyboard resize) — clears the flag and redraws
through the existing tracked-settle schedule, so the line reappears already
tracking the new (possibly still CSS-transitioning) width instead of
snapping from a stale position.

## Keyboard resize: hold `c`/`v` on the FOCUSED column, double-tap to reset

The drag handle has a keyboard counterpart, next to `f`/`d`/`s`/`a` in
`onKeydown` (`home.mjs`): holding **`c`** continuously shrinks and holding
**`v`** continuously grows the column at a fixed px/sec rate
(`startKeyResize`/`KEY_RESIZE_PX_PER_SEC`, `columnWidth.mjs`), floored at
`MIN_COL_PX` like the drag, no upper bound; releasing the key persists
whatever width it landed on (the cookie write, same as a drag's mouseup).
**Two quick taps of the same key in a row reset to auto** — the keyboard
mirror of the handle's dblclick reset — see "Double-tap detection" below.

**Which column: the FOCUSED one, kind `'diff'` only.** `startResizeKey`
(`home.mjs`) targets `focusedBlock()` — whichever block owns
`state.focusLevel` right now (the top-level selected card, or the currently
open drilled column) — via its `'diff:' + b.id` key, exactly the key
`Block.mjs`'s own resize handle already writes to. This is the same column
whether the keyboard is sitting on that block's own diff, or has already
stepped further into ITS Underlying-code panel / an inline comment thread /
the embedded Claude chat (`relatedActive()`): the guard sits **before** the
`relatedActive()` branch in `onKeydown`, not after like `f`/`d`/`s`/`a` (which
stay diff-only, see `.claude/docs/keyboard-navigation.md`) — `relatedActive()`
otherwise ends unconditionally in a `return` for any key it doesn't itself
claim, so a check placed after it would never fire while a sub-panel owns the
keyboard. The only "don't hijack" guard here is `isEditableFocused()` (a real
composer/reply/Claude-chat field has DOM focus) plus `isModifiedKey(e)`
(Cmd/Ctrl+C/V stays native copy/paste) — deliberately narrower than
`f`/`d`/`s`/`a`'s guard, since "reading a thread with no field focused" is
exactly the case this was widened for. `toggleFocused`/`ignoreToggleFocused`/
`isTestColumnActive()` still make it a no-op, like every other diff-only
shortcut — none of those stops owns a column.

**`Block.mjs` needed one small addition to make the column findable from
`home.mjs`:** the card's own `<article>` carries a static
`data-diff-col-key="${'diff:' + b.id}"` next to `data-col-resize-root` (same
static-interpolation shape as the existing `data-testid="${'svg-pane-' +
labelText}"`), so `startResizeKey` can `document.querySelector(...)` the
actually-rendered column and start from its real current width — the same
`getBoundingClientRect().width` source `startColumnResize`'s drag already
uses, via `startKeyResize`'s own read.

**No snap-back-to-auto on release** (unlike the drag's mouseup path): that
check needs the auto-width class function (`parseAutoWidthPx(widthCls(...))`),
which only `Block.mjs` has — plumbing it out to `home.mjs` for this one path
wasn't worth it, and the double-tap reset already covers "I want to go back to
auto" explicitly.

### Double-tap detection — `c` only, not `v`

`startResizeKey`/`stopResizeKey` (`home.mjs`) track, per key (`c` and `v`
independently — `c` then `v` in a row is NOT a double-tap), whether the last
release was a short **tap** (held ≤ `KEY_RESIZE_TAP_MAX_MS`, 250ms) and how
long ago. A release counts as the second half of a double-tap only when BOTH
presses were short taps AND the gap between them is ≤
`KEY_RESIZE_DOUBLE_TAP_MS` (350ms) — deliberately requiring both, not just a
short gap: two genuine long holds back to back (shrink, pause, shrink some
more) must NOT reset, only two quick taps like a double-click. On a detected
double-tap, `startKeyResize`'s handle is `cancel()`ed (not `commit()`ed) and
`clearColumnWidth` runs directly — the tiny width change the brief tap itself
already made is simply discarded, exactly like the handle's own dblclick
reset ignores any drag distance.

**This reset is gated on `key === 'c'` — `v` never resets on a double-tap.**
Reviewer report: tapping `v` twice in quick succession to grow a column a
little further ("dubbeld drukken op v, moet de breedte niet resetten") kept
getting misread as the double-tap-reset gesture instead, discarding both
taps' width change. `c` (shrink) keeps the original double-tap-to-reset
behaviour; a short `v` release always just `commit()`s, exactly like a
genuine hold would — `lastTap.v` is still tracked (for symmetry/possible
future use) but can never make `isDoubleTap` true. The handle's own
mouse-drag dblclick reset (`resetColumnWidth`) is unaffected either way — it
has no `c`/`v` concept at all.

A `keyup` on `c`/`v` ends the hold (`stopResizeKey`); a `window` `blur`
listener is a safety net for the case a `keyup` never arrives (e.g. Alt-Tab
away while still holding the key) — without it the animation frame loop would
keep running, silently growing/shrinking the column forever in the
background.

## Cookie-size cap: a write past the browser's own cookie-size limit used to silently fail FOR EVERYTHING

Reviewer report: "als ik met v een custom breedte maak (of sleep), overleeft
dat de refresh niet" — but a fresh cookie reproduced fine (`v`-hold and drag,
every `kind`, against a live PR): the mechanism itself works. The actual bug
only shows up after enough usage. `writeCookie` re-serializes the **entire**
`state.colWidths` map on every single write, with no size cap. Reproduced
directly: a ~12.7KB encoded map is **rejected outright** by
`document.cookie`'s write — not truncated, the assignment is silently a
no-op and `document.cookie` reads back with the cookie simply absent
afterwards. Browsers cap a single cookie's name+value around 4093 bytes.

Since a reviewer's map grows one key per distinct `${kind}:${id}` ever
resized (every block/PR combination is its own key, see "Column identity"
above), a reviewer who has used this feature for a while eventually crosses
that limit — and from that point on, **every future resize silently stops
persisting**, not just the one that tipped the map over the edge, because
each write re-serializes the whole (now-too-large) map. In the current
session nothing looks wrong (`state.colWidths` still holds the new value in
memory), which is exactly why this only surfaces as "it doesn't survive a
refresh".

**Fix, `columnWidth.mjs`:** `writeCookie` now runs the map through
`boundedMap(map)` first — drop the OLDEST entry (by the object's own
insertion order) one at a time until the encoded JSON fits under
`MAX_COOKIE_BYTES` (3800, a safety margin under the real ~4093 limit).
`setColumnWidth` additionally `delete`s a key before re-setting it, even
when it already exists, so a re-resized column moves to the END of
insertion order — turning "oldest key" into genuinely "least-recently-set",
a cheap LRU-ish approximation with no extra bookkeeping (no timestamps
stored). `boundedMap` never mutates its input; only the persisted COOKIE is
bounded, the in-memory `state.colWidths` for the current session is
untouched. Shortening the retention window to 30 minutes (above) also
reduces how large the map can realistically grow, but does not by itself
prevent this — a single busy review session touching enough distinct
columns could still cross the limit, hence the cap is the real fix and the
shorter retention is a separate, independent product decision.

## The `split` stand's own middle divider: drag it, the RIGHT pane never shrinks

Reviewer request: "ik wil het middelste scheiding ook kunnen slepen met mijn
muis, dan moet recht meeschuiven naar rechts" — confirmed as: dragging the
divider between the split stand's old/left and new/right panes (`Block.mjs`'s
`codeDiff`) may grow the left pane, but the right/new pane must never end up
NARROWER than its own current width — the CARD grows to make room instead,
the divider just slides straight along with the pointer.

**Mechanism (`startSplitResize`, `columnWidth.mjs`):** on `mousedown` it reads
the left pane's (`[data-pane="old"]`, inside the code-diff container's own
`[data-split-root]`) and the whole card's (`[data-col-resize-root]`) CURRENT
rendered widths. Every `mousemove` moves both by the **identical** delta —
`state.colWidths['splitLeft:'+b.id]` (the left pane's own override, read via
`codePane`'s new `styleFn` opt, applied ONLY to the split stand's old/left
pane) and `state.colWidths['diff:'+b.id]` (the SAME whole-card override key
the right-edge `resizeHandle`/`c`/`v` keyboard resize already write, see
above). Since both move by the same amount, the right/new pane's own share
(`cardWidth - leftWidth - dividerWidth`) is never touched by this drag at
all — it stays numerically constant regardless of drag direction, which is
exactly the "never shrinks below its own current width" guarantee. Dragging
the divider therefore reuses (and, if one was already active, continues
from) the exact same card-width override a drag on the right edge writes —
the two mechanisms are not independent, they share one override.

No container-width clamp is needed for this reason: the card is free to grow
without bound (`<main>` already scrolls horizontally without limit, same as
every other width mechanism here). Only `MIN_SPLIT_PANE_PX` (120, smaller
than `MIN_COL_PX` since this only bounds one half of a two-pane split) floors
the left pane so it can't collapse to an unusable sliver.

**The divider itself (`splitDividerHandle`, `columnWidth.mjs`)** replaces the
plain static `w-px` line with a wider (`w-2`) in-flow hit strip — same visual
language as `resizeHandle` (`cursor-col-resize`, a subtle hover tint) but NOT
absolutely positioned: it IS the divider between the two panes, not an
overlay glued to one column's edge. A `@dblclick` resets BOTH overrides at
once (`resetSplitDivider`), so double-clicking genuinely goes back to fully
auto rather than "auto split at whatever size the card happens to be".

**Deliberately mouse-only, no keyboard equivalent** (unlike the whole-card
resize's `c`/`v`) — out of scope for this reviewer request, which only asked
for the mouse drag; the whole-card `c`/`v` resize still reaches a similar end
state in several keyboard steps (grow the card, the auto split formula
still applies), so this isn't a case of new state that's mouse-only reachable.

**No snap-back-to-auto on release**, unlike the right-edge handle's own drag
(reset path 1 above): that check needs the split-left auto-width formula
(`splitLeftPaneWidthCls`, `Block.mjs`) parsed back out of a `max-w-[...]px]`
class shape `parseAutoWidthPx` doesn't recognise (it only understands a bare
`w-[...]`/`w-[...]rem` token) — not worth teaching it a second shape for this
one caller when the dblclick reset already covers "I want auto back"
explicitly, mirroring the keyboard `c`/`v` resize's own same trade-off above.

## Test

`tests/column-resize.spec.mjs` — drags the block-card handle wider, asserts
the inline style, reloads the page and asserts the cookie-backed override
survived, then double-click-resets it; a second test drags a few px (within
the snap-back window) and asserts no override commits at all; a third holds
`c` via `keyboard.down`/`keyboard.up` and asserts the inline style shrank and
survived a reload, then double-taps `c` and asserts the override is gone
again. Uses the shared, read-only anchor fixture PR 12903 (no write happens,
so neither `APPROVAL_RESET_PRS` nor `seededPr` applies — see
`.claude/docs/testing-playwright.md`). Runs at a widened viewport
(`test.use({ viewport: { width: 2200, height: 900 } })`) so a rightward drag
has room before hitting the window edge, and waits ~300ms after entering
diff mode for `scrollFocusIntoView`'s auto-scroll to settle before measuring
the handle's position — otherwise the drag targets stale coordinates from
before the card finished sliding into view.
