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
export const inlineEditState = reactive({ id: null })

// blockNewSourceText — a block's current new/right-side source as one plain
// string, built from the same aligned rows blockRows()/commentTarget()
// already use (Block.mjs/home.mjs) — reused here instead of a second source
// of truth, and the exact text a real edit would eventually replace
// (Line..EndLine, model.go), whole-block since editing is scoped to "heel
// blok" (see Block.mjs's isInlineEditable).
export function blockNewSourceText(rows) {
  const lines = []
  for (const r of rows || []) {
    const text = r && (r.right != null ? r.right : r.left)
    if (text != null) lines.push(text)
  }
  return lines.join('\n')
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
// Each draft stores both the typed text AND a snapshot of the new-side
// source at the moment editing started (or resumed) — `originalSource` —
// so a later save can tell, precisely (not by asking the reviewer), whether
// the underlying code has since changed under it (a landing of this
// reviewer's own or a colleague's, in between). See saveInlineEdit
// (home.mjs) for how that becomes a plain-language note in the chat's
// invisible context.
const inlineEditDrafts = new Map()

function inlineEditDraftKey(b) {
  return 'inline-edit:' + b.pr + ':' + b.id
}

export function loadInlineEditDraft(b) {
  const key = inlineEditDraftKey(b)
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

export function saveInlineEditDraft(b, text, originalSource) {
  const key = inlineEditDraftKey(b)
  const entry = { text, originalSource }
  inlineEditDrafts.set(key, entry)
  saveDraft(key, JSON.stringify(entry))
}

export function clearInlineEditDraft(b) {
  const key = inlineEditDraftKey(b)
  inlineEditDrafts.delete(key)
  clearDraft(key)
}
