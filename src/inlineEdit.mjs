// inlineEdit.mjs — inline, IDE-style editing of a diff block's new/right
// side (reviewer request: "ik wil in de diff blok wat geselecteerd is de
// code kunnen editen in de blok zelf als een idea").
//
// Deliberately NOT a write path of its own: "Opslaan" never commits/writes
// anything by itself — it hands the reviewer's edited code to a brand-new
// "Chat over deze regel" conversation (RelatedPanel.mjs's startClaudeChat)
// as invisible first-turn context, so the reviewer can add a follow-up
// instruction ("pas dit ook op andere plekken aan") before Claude actually
// touches anything. See home.mjs's saveInlineEdit for the actual hand-off —
// this module only holds the pieces that don't belong to Block.mjs's own
// opts-only convention (Block.mjs stays decoupled from `state`/home.mjs)
// but also aren't home.mjs-specific: the shared "which block is being
// edited" flag (one at a time, top-level only — see Block.mjs's own
// `allowInlineEdit` gate), plain-text source extraction, and local-draft
// persistence. A pure leaf module (no import of Block.mjs/home.mjs/
// RelatedPanel.mjs), so both Block.mjs and home.mjs can import it directly
// with no cycle.

import { reactive } from './vendor/arrow.js'
import { loadDraft, saveDraft, clearDraft } from './draftStorage.mjs'

// inlineEditState.id — the id of the block currently in inline-edit mode, or
// null. A single shared flag, not per-block state: only one block can be
// edited at a time in v1 (the top-level selected card only).
//
// selRowStart/selRowEnd — the aligned-row range (blockRows() indices) of the
// diff's own active navigation unit at the moment editing was opened — set
// together with `id` by openInlineEdit below, -1/-1 when nothing was
// selected (e.g. list mode). This is now the editor's own SCOPE, not just a
// caret-placement hint: inlineEditorSlot (Block.mjs) shows and edits ONLY
// these rows, falling back to the whole block only when there was no active
// unit at all — see "Only the selected unit is editable" in
// .claude/docs/inline-edit.md (a deliberate narrowing from v1's "whole block
// at once", reviewer follow-up: "is het handiger als je alleen kan bewerken
// wat is geselecteerd?"). Also still used to place the caret in the MIDDLE
// of that range once the editor mounts (reviewer request: "moet gelijk de
// cursor zetten in het midden van wat is geselecteerd") — see
// computeInlineEditCaretOffset/scheduleInlineEditCaret.
export const inlineEditState = reactive({ id: null, selRowStart: -1, selRowEnd: -1 })

// openInlineEdit — the ONE entry point that turns inline editing on for a
// block, used by both Block.mjs's header toggle button (activeGroup()'s own
// unit) and home.mjs's "Bewerk deze code" command (topLevelActiveUnit(b)) —
// see inlineEditToggleButton/the `edit-code` COMMANDS item — so the two
// never disagree about what "the selection" means. `unit` is the diff's
// currently active navigation unit shape ({start,end}, aligned-row indices),
// or null when nothing is selected (e.g. list mode).
export function openInlineEdit(b, unit) {
  inlineEditState.id = b.id
  inlineEditState.selRowStart = unit ? unit.start : -1
  inlineEditState.selRowEnd = unit ? unit.end : -1
}

// closeInlineEdit — the ONE way editing turns back off (Annuleren, Opslaan,
// or toggling the header button while already open), so
// scheduleInlineEditCaret's own "already placed the caret for this open"
// guard resets every time, not just once per block id.
export function closeInlineEdit() {
  inlineEditState.id = null
  caretScheduledFor = null
  growScheduledFor = null
}

// computeInlineEditCaretOffset maps a stored row range onto a character
// offset into blockNewSourceText(rows) — the SAME text inlineEditorSlot's
// textarea is seeded with — using the identical per-row rule that function
// applies (one line per row unless a row carries no text on either side), so
// the row index and the line index always agree. Returns the MIDDLE of the
// selection's own start/end offset (reviewer asked for the middle, not the
// start), or null when there was no selection (rowStart<0) or it isn't found
// in `rows` at all (defensive — inlineEditorSlot then just leaves the caret
// wherever the browser puts it by default, i.e. the end).
export function computeInlineEditCaretOffset(rows, rowStart, rowEnd) {
  if (rowStart == null || rowStart < 0 || rowEnd == null || rowEnd < 0) return null
  let offset = 0
  let start = null
  let end = null
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i]
    const text = r && (r.right != null ? r.right : r.left)
    if (text == null) continue
    if (i === rowStart) start = offset
    if (i >= rowStart && i <= rowEnd) end = offset + text.length
    offset += text.length + 1
  }
  if (start == null) return null
  return Math.round((start + (end == null ? start : end)) / 2)
}

// caretScheduledFor — a PLAIN (non-reactive) guard, deliberately outside
// arrow.js's reactive system (same discipline as inlineEditorSlot's own
// highlightCodeEl/growEl): the toggling slot that mounts inlineEditorSlot can
// re-run for an unrelated reason while editing stays open (see
// arrowjs-pitfalls.md), and re-focusing/re-placing the caret on every such
// re-render would yank it away from wherever the reviewer has since
// typed/moved it. Tracks which block id the caret has already been placed
// for; reset to null by closeInlineEdit so reopening the SAME block later
// places it again.
let caretScheduledFor = null

// scheduleInlineEditCaret focuses the just-mounted textarea and puts the
// caret at `offset` (or the end of the text when `offset` is null — no
// selection to center on). Deferred via requestAnimationFrame because the
// textarea mounts asynchronously (an arrow.js reactive flush, not
// synchronous with the state write that revealed it) — same pattern as
// RelatedPanel.mjs's focusThread. Guarded by both caretScheduledFor (above)
// and a re-check of inlineEditState.id (the editor may have already been
// closed again by the time the animation frame runs).
export function scheduleInlineEditCaret(b, offset) {
  if (caretScheduledFor === b.id) return
  caretScheduledFor = b.id
  requestAnimationFrame(() => {
    if (inlineEditState.id !== b.id) return
    const ta = document.querySelector('[data-testid="inline-edit-textarea"]')
    if (!ta) return
    ta.focus()
    const pos = offset == null ? ta.value.length : Math.max(0, Math.min(ta.value.length, offset))
    ta.setSelectionRange(pos, pos)
  })
}

// growScheduledFor — mirrors caretScheduledFor below: a plain, non-reactive
// guard so the just-mounted <textarea>'s height is force-recomputed only
// ONCE per "open", not on every re-render of the toggling slot that mounts
// inlineEditorSlot while editing stays open.
let growScheduledFor = null

// scheduleInlineEditGrow corrects the just-mounted <textarea>'s height to its
// REAL rendered content height (ta.scrollHeight) right after mount, instead
// of relying only on inlineEditorSlot's own upfront "assume 16px per line"
// estimate (Block.mjs's initialHeightPx). See "Scrolling a long selected
// unit" in .claude/docs/inline-edit.md for the bug this fixes: an
// underestimated height leaves the <textarea> itself internally scrollable
// (a plain <textarea>'s own default overflow), which silently captures the
// reviewer's mouse-wheel scroll instead of letting it bubble to the intended
// overflow-auto ancestor — while the absolutely positioned, highlighted
// <pre> underneath (which tracks the container, not the textarea) never
// moves at all, reading as "I can't scroll in here". Deferred via
// requestAnimationFrame for the same reason scheduleInlineEditCaret is: the
// textarea mounts asynchronously, not synchronously with the state write
// that revealed it.
export function scheduleInlineEditGrow(b) {
  if (growScheduledFor === b.id) return
  growScheduledFor = b.id
  requestAnimationFrame(() => {
    if (inlineEditState.id !== b.id) return
    const ta = document.querySelector('[data-testid="inline-edit-textarea"]')
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
  })
}

// blockNewSourceText — a block's WHOLE new/right-side source as one plain
// string, built from the same aligned rows blockRows()/commentTarget()
// already use (Block.mjs/home.mjs) — reused here instead of a second source
// of truth, and the exact text a real edit would eventually replace
// (Line..EndLine, model.go). Still used for the FULL block (e.g. as the
// base a sub-range edit gets merged back into — see
// mergeInlineEditRangeIntoSource below) even though the editor itself no
// longer edits the whole thing at once (see blockNewSourceRangeText).
export function blockNewSourceText(rows) {
  const lines = []
  for (const r of rows || []) {
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) lines.push(text)
  }
  return lines.join('\n')
}

// blockNewSourceRangeText — the plain-text content of just rows[rowStart..
// rowEnd] (inclusive), the same per-row rule blockNewSourceText applies to
// the whole block. This is the editor's actual scope now (see
// inlineEditState's own doc comment above): rowStart<0 (no active unit —
// list mode, or a block with no navigable changes) falls back to the WHOLE
// block, exactly like the old v1 behaviour.
export function blockNewSourceRangeText(rows, rowStart, rowEnd) {
  const all = rows || []
  if (rowStart == null || rowStart < 0 || rowEnd == null || rowEnd < 0) return blockNewSourceText(all)
  const lines = []
  for (let i = rowStart; i <= rowEnd; i++) {
    const r = all[i]
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) lines.push(text)
  }
  return lines.join('\n')
}

// mergeInlineEditRangeIntoSource rebuilds the block's WHOLE new-side source
// with just rows[rowStart..rowEnd] replaced by `text` — everything outside
// that range is left exactly as it already was. This is how "Opslaan" keeps
// its promise that only the selected unit changes (reviewer: "opslaan
// vervangt alleen dat stuk; de rest van het blok blijft ongewijzigd"): the
// reviewer only ever typed the sub-range, but the proposed code handed to
// Claude (home.mjs's saveInlineEdit) is the full, accurate result. rowStart<0
// (no active unit — the whole-block fallback) returns `text` unchanged, since
// there is no "rest of the block" to preserve in that case.
export function mergeInlineEditRangeIntoSource(rows, rowStart, rowEnd, text) {
  if (rowStart == null || rowStart < 0 || rowEnd == null || rowEnd < 0) return text
  const all = rows || []
  const before = []
  const after = []
  for (let i = 0; i < all.length; i++) {
    const r = all[i]
    const t = r && (r.right != null ? r.right : r.left)
    if (t == null) continue
    if (i < rowStart) before.push(t)
    else if (i > rowEnd) after.push(t)
  }
  const parts = []
  if (before.length) parts.push(before.join('\n'))
  parts.push(text)
  if (after.length) parts.push(after.join('\n'))
  return parts.join('\n')
}

// ── Local draft persistence ─────────────────────────────────────────────
// Mirrors RelatedPanel.mjs's composeDrafts/draftStorage.mjs exactly: an
// in-memory Map for the running session, backed by draftStorage.mjs's
// localStorage wrapper for surviving a real refresh. Reviewer request: "je
// komt terug bij het blok en je tekst staat er nog" — never silently
// dropped; only cleared once the edit is actually handed to a chat (see
// clearInlineEditDraft's call site, home.mjs's saveInlineEdit). Leaving the
// editor via "Annuleren" or navigating away deliberately does NOT clear it.
//
// Each draft stores both the typed text AND a snapshot of the (sub-range's
// own) new-side source at the moment editing started (or resumed) —
// `originalSource` — so a later save can tell, precisely (not by asking the
// reviewer), whether the underlying code has since changed under it (a
// landing of this reviewer's own or a colleague's, in between). See
// saveInlineEdit (home.mjs) for how that becomes a plain-language note in
// the chat's invisible context.
//
// The key is scoped to rowStart/rowEnd, not just the block id: since v1's
// "edit the whole block" scope narrowed to "edit only the selected unit"
// (see inlineEditState's own doc comment above), two different units of the
// SAME block are two unrelated drafts — sharing one key would otherwise seed
// a freshly opened, different unit's editor with whatever text was typed for
// an earlier, differently-sized unit. rowStart<0 (the whole-block fallback)
// keys as 'all', same bucket every direct-mount test that never sets
// activeGroup already exercises.
const inlineEditDrafts = new Map()

function inlineEditDraftKey(b, rowStart, rowEnd) {
  const range = rowStart != null && rowStart >= 0 ? rowStart + '-' + rowEnd : 'all'
  return 'inline-edit:' + b.pr + ':' + b.id + ':' + range
}

export function loadInlineEditDraft(b, rowStart, rowEnd) {
  const key = inlineEditDraftKey(b, rowStart, rowEnd)
  if (inlineEditDrafts.has(key)) return inlineEditDrafts.get(key)
  const raw = loadDraft(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.text === 'string') {
      inlineEditDrafts.set(key, parsed)
      return parsed
    }
  } catch (_) {
    // malformed/legacy value — treat as no draft rather than throwing.
  }
  return null
}

export function saveInlineEditDraft(b, text, originalSource, rowStart, rowEnd) {
  const key = inlineEditDraftKey(b, rowStart, rowEnd)
  const entry = { text, originalSource }
  inlineEditDrafts.set(key, entry)
  saveDraft(key, JSON.stringify(entry))
}

export function clearInlineEditDraft(b, rowStart, rowEnd) {
  const key = inlineEditDraftKey(b, rowStart, rowEnd)
  inlineEditDrafts.delete(key)
  clearDraft(key)
}
