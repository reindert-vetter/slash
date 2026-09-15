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
- Only the **true top-level selected card** (`home.mjs`'s `DetailPanel`, the
  `i === sel` branch) — never a look-ahead preview card, never a drilled
  Onderliggende-code column. `Block()`'s `allowInlineEdit`/`onSaveInlineEdit`
  opts default to `false`/a no-op, so a card that never wires them up simply
  never shows the affordance — there is no "Opslaan does nothing" trap.

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
  `inlineEditorSlot`, the `allowInlineEdit`/`onSaveInlineEdit` opts.
- `src/home.mjs` — `saveInlineEdit`, wiring `allowInlineEdit: true` /
  `onSaveInlineEdit: saveInlineEdit` only at the top-level `Block()` call
  site in `DetailPanel`, and the `"Bewerk deze code"` entry in `COMMANDS`
  (see "Two entry points, one shared flag" above).
- `src/RelatedPanel.mjs` — `claudeContextBlock`'s additive `proposedCode`/
  `proposedStale` branch.

Test: `tests/inline-edit.spec.mjs` — direct-mount `Block()` unit tests
(mirroring `tests/diffview.spec.mjs`'s own pattern — eligibility, the overlay
editor's content, the draft surviving a remount and being cleared once
saved), plus a real-app test against a seeded PR for the `COMMANDS` entry
point (absent in list mode, present and functional once the block owns the
diff keyboard), plus a pure-function test of
`computeInlineEditCaretOffset`'s row→offset arithmetic and a direct-mount
test asserting the textarea is focused with the caret strictly inside a
given `activeGroup()` unit's own text. The actual `startClaudeChat`/
`claude_chat` hand-off itself is already covered by
`tests/claude-chat-panel.spec.mjs` and is unrelated to this feature's own
logic, so the direct-mount tests assert it only via a spy on
`onSaveInlineEdit`.
