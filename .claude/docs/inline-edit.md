# Inline, IDE-style editing of a diff block (Block.mjs)

Reviewer request: "ik wil in de diff blok wat geselecteerd is de code kunnen
editen in de blok zelf als een idea" — followed by an explicit pivot before
this was built: **"Opslaan" never commits/writes anything directly.** It
hands the reviewer's edited code to a brand-new "Chat over deze regel"
conversation (`startClaudeChat`, `.claude/docs/claude-chat-panel.md`) as
invisible first-turn context, so the reviewer can add a follow-up
instruction ("pas dit ook op andere plekken aan") before Claude actually
touches anything. **No new write path at all** — this rides entirely on the
existing `claude_chat`/`chat_checkout`/`chat_merge` pipeline
(`.claude/rules/workflows-write-boundary.md`).

## Three entry points, one shared gate

Opening the editor now has **three** ways in, all funnelling through the
exact same `openInlineEdit(b, unit)` and the same eligibility gate
(`inlineEditEligibleNow()`, `home.mjs`: `state.mode === 'diff' &&
state.focusLevel === 0 && isInlineEditable(curBlock(), blockRows(curBlock()))`):
the header toggle button, the `"Bewerk deze code"` command-palette item, and
the **`e` key** (`eKey()`, `home.mjs`, wired in `onKeydown` right after the
`f`/`d`/`s` zoom keys) — reviewer request: "als ik e druk op een code blokje
die ik kan editen, dan wil ik het gelijk editen". `e` needs no separate
`isEditableFocused()` guard: `onKeydown`'s existing fallback
(`isEditableFocused()`, checked well before this branch) already returns
whenever real DOM focus sits in a text field — including the inline-edit
`<textarea>` itself once editing is open — so pressing `e` while already
editing (or while typing anywhere else) is just an ordinary character, never
a toggle.

## Escape (close, keep draft) / Cmd+Enter (save) — handled by the textarea itself

Reviewer request: "esc moet edit sluiten zonder op te slaan (mag het wel
onthouden als dat nu het geval is), cmd + enter moet het opslaan." Both are
bound directly on the editor's own `<textarea>` via `@keydown`
(`onTextareaKeyDown`, `Block.mjs`'s `inlineEditorSlot`) rather than through
`home.mjs`'s global `onKeydown`: a Cmd/Ctrl-modified key pressed while a real
editable field holds DOM focus is claimed FIRST by `onKeydown`'s own
`isNativeTextEditKey` guard (`isModifiedKey(e) && isEditableFocused()`,
see `.claude/rules/arrowjs-pitfalls.md`'s nested-handler-ordering rule), so a
global `Cmd+Enter` branch would never be reached while the textarea is
focused — the editor has to own both keys itself. `Escape` mirrors
`onCancelClick`/"Annuleren" exactly (`closeInlineEdit()`, draft untouched —
only a real save clears it); `Cmd+Enter`/`Ctrl+Enter` mirrors `onSaveClick`/
"Opslaan" exactly (reads the textarea's own current value, `closeInlineEdit()`,
then `onSave(b, text, originalSource)`).

## A keyboard hint for both states (gated on the reviewer's keyboard-hints setting)

`home.mjs`'s `blockShortcutHints()` — the function behind every card's
`ShortcutHintBar` (`src/shortcutHints.mjs`, itself gated on
`keyboardHints.enabled`, the settings-page "Keyboard hints" toggle, see
`.claude/docs/settings-page.md`) — short-circuits to two edit-specific hints
whenever the card it's asked about is the one currently mid-edit
(`inlineEditState.id === curBlock().id`): `Esc` → "annuleren",
`Cmd+Enter` → "opslaan". This is safe to key purely on `curBlock()` (the
top-level selected block) with no `focusLevel` check of its own: editing is
only ever open for the top-level card (v1 scope, see below), and DOM focus is
trapped in the `<textarea>` while it's open — every arrow-key/drilling path
is intercepted by `onKeydown`'s `isEditableFocused()` fallback first — so a
drilled column's own hint request can never collide with an open top-level
edit. Not editing: the **group**-granularity hint list gains an `e` →
"bewerk code" entry, shown only while `inlineEditEligibleNow()` is true — the
**line/call** list stays untouched (deliberately `s`/`d`/`f`-only, an earlier,
separate reviewer decision, see `blockShortcutHints`' own comment) even though
the `e` key itself still works at any granularity there, it just isn't hinted.

## Scope (v1, deliberately narrow)

- Only the **new/right side**, and only the **whole block** at once (not a
  sub-range) — a reviewer edits the entire new-side source as one free-form
  text.
- Only a **`modified`/`added`** code block: not `removed` (nothing left to
  edit), not the synthetic `unchanged` drilled call-frame, not TRANSLATION/
  SVG/IMAGE (each already replaces the text diff with its own render, see
  `.claude/docs/diff-render.md`), and not a **virtualized** block
  (`VIRTUALIZE_MIN_ROWS`, 400 rows — editing a windowed view would silently
  drop whatever sits outside it). `isInlineEditable` (`Block.mjs`) is the one
  gate.
- Only the card that currently owns the diff keyboard — never a look-ahead
  preview card, and never a drilled Onderliggende-code column that isn't the
  FOCUSED one (see "Extended past v1's top-level-only scope" right below).
  `Block()`'s `allowInlineEdit`/`onSaveInlineEdit` opts default to `false`/a
  no-op, so a card that never wires them up simply never shows the
  affordance — there is no "Opslaan does nothing" trap.

## Extended past v1's top-level-only scope: the FOCUSED drilled column too

Reviewer report: selecting a "Comment op regel"/"chat op regel" index item
opens its anchor block as a drilled column (`openCommentAnchorDrill`, see
"An anchored 'Start' item instead opens its block 'as if fully expanded'" in
`.claude/docs/comments-panel.md`) that looks exactly like an ordinary diff
card — but `e`/the header toggle/"Bewerk deze code" did nothing there,
because v1 (above) wired `allowInlineEdit`/`onSaveInlineEdit` up only at the
top-level card's own `Block()` call. Follow-up clarification, explicitly
narrowing scope: an **unfocused** drilled column still needs none of this —
editing only ever belongs to whichever column currently owns the cursor/
keyboard, not to every visible Underlying-code card.

That is exactly what already existed: every drilled column's own `Block()`
call (`home.mjs`'s `state.drill.map(...)`) already computes a per-level
`diffActive` (`state.focusLevel === level && !relatedActive() &&
!commentAnchorAwaitingEntry(level)`) — the same condition, generalized, the
top-level card's own `diffActive` uses. `Block.mjs`'s own gate
(`!preview && allowInlineEdit && diffActive() && isInlineEditable(...)`)
already restricts the affordance to the focused column for free; an
unfocused drilled column never even renders this `Block()` call in the first
place (it collapses to a rail instead, see "Unfocused columns collapse into
a narrow rail" in `.claude/docs/drilling.md`). So the fix is additive, not a
new rule: the drilled column's own `Block()` call gained
`allowInlineEdit: true, onSaveInlineEdit: saveInlineEdit` — the exact same
two opts the top-level card already passes. This also covers the
comment/chat-op-regel anchor's own drilled column for free, since it is
*the same render* (`focusLevel === level` at `level === 1`, see "The anchored
column IS the leading column" in `.claude/docs/comments-panel.md`) — no
separate wiring needed for that case.

Three shared functions were generalized from `curBlock()`/
`state.focusLevel === 0` to `focusedBlock()`/a per-level `diffActive` check
(mirroring, not duplicating, what each `Block()` call site's own `diffActive`
opt already computes), so the keyboard/palette entry points agree with
whichever card now shows the affordance:

- **`inlineEditEligibleNow()`** — the one shared gate for the `e` key and the
  `COMMANDS` `edit-code` item's `when`.
- **`eKey()`** — opens the editor on `focusedBlock()` with
  `focusedActiveUnit()` (the same unit that card's own `activeGroup` opt
  highlights), instead of always `curBlock()`/`topLevelActiveUnit(b)`.
- **`blockShortcutHints()`**'s edit-mode short-circuit (`editingBlock`) —
  follows `focusedBlock()` too, so the Esc/Cmd+Enter hint shows on whichever
  card is actually mid-edit.

`saveInlineEdit(b, text, originalSource)` itself needed **no** change — it
was already generic on `b` (only reads `b.file`/`b.line`/`b.endLine`/
`blockRows(b)`), so it works unchanged for a drilled block.

Test: `tests/comment-anchor-expanded-view.spec.mjs` and
`tests/inline-edit.spec.mjs` (existing top-level coverage; both re-verified
against this change).

## Two entry points, one shared flag

`isInlineEditable(b, rows)` is **exported** from `Block.mjs` (not just used
internally) so both entry points share the exact same eligibility check —
no duplicated logic, no drift between them:

- The card header's own edit-toggle button (`inlineEditToggleButton`), shown
  only while `diffActive()` on the top-level card.
- **`COMMANDS`'s `"Bewerk deze code"` item** (`home.mjs`, right after
  `approve`) — added after a reviewer report: "ik zie niks in het menu als
  ik op geselecteerde code klik". `Enter` and a right-click both open this
  exact same list (`.claude/docs/command-palette.md`, "The right-click
  context menu" — one shared implementation, not two), so this single
  addition covers both of the reviewer's named expectations at once. Its
  `run` calls the shared `openInlineEdit(b, topLevelActiveUnit(b))`
  (`inlineEdit.mjs`) the header button also calls; its `when` mirrors that
  button's own gate exactly (`state.mode === 'diff' && state.focusLevel ===
  0 && isInlineEditable(curBlock(), blockRows(curBlock()))`) so the item is
  absent everywhere the button would be too — never present-but-non-functional.

### Opening the editor focuses it and places the caret in the middle of the active selection

Reviewer request: "'bewerk deze code' dat moet gelijk de cursor zetten in
het midden van wat is geselecteerd" — the editor used to mount with no
focus at all (a click into the textarea was needed before typing worked)
and, once focused, the caret defaulted to wherever the browser puts an
uncontrolled `<textarea>`'s caret (its own end), regardless of what the
reviewer had actually selected in the diff.

`inlineEdit.mjs` is the ONE place both entry points funnel through now:

- **`openInlineEdit(b, unit)`** — replaces a bare `inlineEditState.id = b.id`
  write at both call sites. `unit` is the diff's own active navigation unit
  (`{start, end}`, aligned-row indices) — `activeGroup()`'s current value at
  the header button (`inlineEditToggleButton(b, activeGroup)`), or
  `topLevelActiveUnit(b)` at the `COMMANDS` item (the exact function the
  top-level card's own `activeGroup` opt is built from, see `home.mjs`) — so
  the two entry points can never disagree about "what's selected". Stores
  `unit.start`/`unit.end` on `inlineEditState.selRowStart`/`selRowEnd`
  (`-1`/`-1` when nothing was selected, e.g. list mode).
- **`closeInlineEdit()`** — replaces every `inlineEditState.id = null` write
  (Annuleren, Opslaan, toggling the header button off) and also resets the
  caret-placement guard below, so reopening the SAME block later places the
  caret again instead of silently doing nothing the second time.
- **`computeInlineEditCaretOffset(rows, rowStart, rowEnd)`** — maps that row
  range onto a character offset into `blockNewSourceText(rows)` (the exact
  text the textarea is seeded with), using the identical per-row rule that
  function applies, and returns the **middle** of the selection's own
  start/end offset — not the start, per the reviewer's explicit wording.
  Returns `null` when there was no selection.
- **`scheduleInlineEditCaret(b, offset)`** — `inlineEditorSlot` (`Block.mjs`)
  calls this right after computing the offset above. Deferred via
  `requestAnimationFrame` (mirrors `RelatedPanel.mjs`'s `focusThread`
  pattern) since the textarea mounts asynchronously, not synchronously with
  the state write that revealed it. Guarded by a **plain, non-reactive**
  module-level token (deliberately outside arrow.js's reactive system, same
  discipline as `inlineEditorSlot`'s own `highlightCodeEl`/`growEl`): the
  toggling slot that mounts `inlineEditorSlot` can re-run for an unrelated
  reason while editing stays open (see `.claude/rules/arrowjs-pitfalls.md`),
  and re-focusing/re-placing the caret on every such re-render would yank it
  away from wherever the reviewer has since typed/moved it — so this only
  ever runs once per "open", reset by `closeInlineEdit`.

`offset == null` (no selection to center on) leaves the caret at the text's
own end — the pre-existing default a plain `<textarea>` already gives an
uncontrolled value, unchanged for that case.

## The editor: no textarea look, no contenteditable

"Alsof er geen tekstveld is" — the editor must look identical to the
ordinary rendered code (same font/size/colours/background), not like a form
field. Two layers, both children of the same `overflow-auto` container
(`inlineEditorSlot`, `Block.mjs`):

- A plain, **transparent-text `<textarea>`** is the real, native editing
  surface (caret, native selection, copy/paste — all free, no reactive
  binding on its value at all, an uuncontrolled input).
- A Prism-**highlighted `<pre>`** sits absolutely positioned underneath it
  (`top:0`, only left/right pinned, never `bottom`/`height`, so its natural
  content height matches the textarea's own), kept in sync by hand on every
  `@input` (`highlightForLang`, never through an arrow.js binding — this
  stays outside arrow.js's reactive system entirely, the same imperative-DOM
  discipline `updateHints`/`syncScroll` already use). Because both layers
  share one scrolling ancestor and the `<pre>` has no independent scroll of
  its own, scrolling the container moves both together with **zero** JS
  scroll-sync code.

**Why not `contenteditable` on the highlighted markup directly** (the other
obvious approach): re-tokenizing a `contenteditable` on every keystroke would
hit the exact caret-loss/keyed-node-reuse class of bug
`.claude/rules/arrowjs-pitfalls.md` already documents for the read-only mouse
selection (there: once per gesture; here: once per keystroke, far more
often), and extracting plain text back out of a contenteditable tree
interleaved with Prism `<span>`s is fragile compared to a `<textarea>.value`,
which is always exactly the right string.

## Local draft, never silently dropped

`src/inlineEdit.mjs` mirrors `RelatedPanel.mjs`'s `composeDrafts` +
`draftStorage.mjs` exactly: an in-memory `Map` for the running session,
backed by `draftStorage.mjs`'s `localStorage` wrapper for surviving a real
refresh (reviewer request: "je komt terug bij het blok en je tekst staat er
nog"). Each draft stores both the typed text **and** a snapshot of the
new-side source at the moment editing started/resumed (`originalSource`).

- **Never cleared** by "Annuleren" or by navigating away — only a
  **successful save** clears it (`clearInlineEditDraft`, called from
  `home.mjs`'s `saveInlineEdit`).
- Because `originalSource` is stored alongside the text, a later save can
  tell **precisely** (not by guessing) whether the underlying code changed
  since the draft started — see below.

## "Opslaan": builds a `commentTarget`-shaped object, then `startClaudeChat`

`home.mjs`'s `saveInlineEdit(b, text, originalSource)` mirrors
`commentTarget()`'s own return shape (so the lazily-created anchor
comment/GitHub-anchoring behaves exactly like any other "Chat over deze
regel") but scoped to the **whole block** (`rowStart:0`, `rowEnd:
rows.length-1`, `startLine:b.line`, `endLine:b.endLine`), plus two additive
fields:

- **`proposedCode`** — the reviewer's edited text.
- **`proposedStale`** — `true` only when `blockNewSourceText(blockRows(b))`
  (the CURRENT new-side source) genuinely differs from the draft's own
  `originalSource` snapshot — i.e. a landing (this reviewer's own or a
  colleague's) happened in between. A precise, computed fact, never a guess.

`RelatedPanel.mjs`'s `claudeContextBlock` (the function that builds a
conversation's invisible first-turn context, see "Invisible selection
context on a conversation's FIRST turn" in `.claude/docs/claude-chat-panel.md`)
gained a small, additive branch: when `t.proposedCode` is present it appends
a second fenced block ("Door de reviewer voorgestelde nieuwe code..."),
directly under the existing "Voorbeeldcode:" (the current code) — and, only
when `t.proposedStale` is true, one more plain-language line noting the
proposal may be based on an older version of the file. Every other caller's
target has no `proposedCode`, so this is a pure addition with no effect on
any existing chat entry point.

`saveInlineEdit` then simply calls `startClaudeChat(target)` — the exact same
entry point `COMMANDS`'s "Chat over deze regel" and the no-match palette
fallback already use (`home.mjs`) — which resets the comment/Claude focus
state and lands the keyboard in the (empty) composer. The reviewer still
types their own follow-up message by hand; nothing is sent automatically.

## Files

- `src/inlineEdit.mjs` — the shared `inlineEditState` flag (one block at a
  time, plus its `selRowStart`/`selRowEnd` caret-placement fields),
  `openInlineEdit`/`closeInlineEdit` (the one entry/exit point both call
  sites and both close actions use), `computeInlineEditCaretOffset`/
  `scheduleInlineEditCaret` (see "Opening the editor focuses it…" above),
  `blockNewSourceText`, and the draft persistence helpers. A pure leaf
  module (no import of `Block.mjs`/`home.mjs`/`RelatedPanel.mjs`), so both
  `Block.mjs` and `home.mjs` import it directly with no cycle.
- `src/Block.mjs` — `isInlineEditable`, `inlineEditToggleButton`,
  `inlineEditorSlot` (including `onTextareaKeyDown`, see "Escape (close, keep
  draft) / Cmd+Enter (save)" above), the `allowInlineEdit`/`onSaveInlineEdit`
  opts.
- `src/home.mjs` — `saveInlineEdit`, `inlineEditEligibleNow`/`eKey` (the `e`
  key, see "Three entry points, one shared gate" above), wiring
  `allowInlineEdit: true` / `onSaveInlineEdit: saveInlineEdit` only at the
  top-level `Block()` call site in `DetailPanel`, the `"Bewerk deze code"`
  entry in `COMMANDS`, and the edit-mode branch of `blockShortcutHints()`.
- `src/RelatedPanel.mjs` — `claudeContextBlock`'s additive `proposedCode`/
  `proposedStale` branch.

Test: `tests/inline-edit.spec.mjs` — direct-mount `Block()` unit tests
(mirroring `tests/diffview.spec.mjs`'s own pattern — eligibility, the overlay
editor's content, the draft surviving a remount and being cleared once
saved, `Escape`/`Cmd+Enter` inside the textarea), plus real-app tests against
a seeded PR for the `COMMANDS` entry point and the `e` key (each absent in
list mode, present and functional once the block owns the diff keyboard),
plus a pure-function test of `computeInlineEditCaretOffset`'s row→offset
arithmetic and a direct-mount test asserting the textarea is focused with the
caret strictly inside a given `activeGroup()` unit's own text. The actual
`startClaudeChat`/`claude_chat` hand-off itself is already covered by
`tests/claude-chat-panel.spec.mjs` and is unrelated to this feature's own
logic, so the direct-mount tests assert it only via a spy on
`onSaveInlineEdit`.
