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
  time), `blockNewSourceText`, and the draft persistence helpers. A pure leaf
  module (no import of `Block.mjs`/`home.mjs`/`RelatedPanel.mjs`), so both
  `Block.mjs` and `home.mjs` import it directly with no cycle.
- `src/Block.mjs` — `isInlineEditable`, `inlineEditToggleButton`,
  `inlineEditorSlot`, the `allowInlineEdit`/`onSaveInlineEdit` opts.
- `src/home.mjs` — `saveInlineEdit`, and wiring `allowInlineEdit: true` /
  `onSaveInlineEdit: saveInlineEdit` only at the top-level `Block()` call
  site in `DetailPanel`.
- `src/RelatedPanel.mjs` — `claudeContextBlock`'s additive `proposedCode`/
  `proposedStale` branch.

Test: `tests/inline-edit.spec.mjs` (direct-mount `Block()` unit tests,
mirroring `tests/diffview.spec.mjs`'s own pattern — eligibility, the overlay
editor's content, the draft surviving a remount and being cleared once
saved). The actual `startClaudeChat`/`claude_chat` hand-off itself is already
covered by `tests/claude-chat-panel.spec.mjs` and is unrelated to this
feature's own logic, so it is asserted here only via a spy on
`onSaveInlineEdit`.
