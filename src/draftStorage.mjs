// draftStorage.mjs — a small localStorage-backed cache for a comment/reply/
// Claude-chat composer's typed-but-not-yet-sent text.
//
// Reviewer request: "als ik iets type in de comment/chat input, en ik
// refresh, dan wil ik bij die ene comment/chat input dezelfde tekst zien. als
// ik een url open en/of een andere blok selecteer, dan wil ik die tekst niet
// zien." RelatedPanel.mjs already has an in-memory, per-session draft cache
// (composeDrafts/replyDrafts/prReplyDrafts, keyed by the exact anchor the
// field is composing on) — that already satisfies "never travels to a
// different block/URL", since a different anchor is simply a different key.
// What was missing is surviving a real page refresh, which wipes any
// module-level `Map`. This module is the thin persistence layer underneath
// those Maps: every key already carries the anchor's own identity (plus the
// PR id, added by RelatedPanel.mjs's own key builder, since draftKeyFor
// itself carries no PR id), so restoring from here can never leak a draft
// into a different block/PR — the key simply won't match.
//
// Deliberately `localStorage`, not the URL and not a workflow write: this is
// a pure frontend cache, exactly like the theme preference (theme.mjs) and
// the debug-mode toggle (debugLog.mjs) — it touches no server state at all,
// so `.claude/rules/workflows-write-boundary.md` doesn't apply. Wrapped in
// try/catch, same as those two, for a browser with localStorage unavailable
// (private mode, quota) — the in-memory Map still covers the same-session
// case either way, this is purely the "survive a refresh" layer on top.
const PREFIX = 'slash:draft:'

export function loadDraft(key) {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch (_) {
    return null
  }
}

// saveDraft stores `text` under `key`, or removes the entry entirely once
// `text` is empty — an empty draft is the same as no draft, and there is no
// reason to keep growing localStorage with blank entries every keystroke a
// reviewer backspaces down to nothing.
export function saveDraft(key, text) {
  try {
    if (text) localStorage.setItem(PREFIX + key, text)
    else localStorage.removeItem(PREFIX + key)
  } catch (_) {
    // storage unavailable — nothing to fall back to here, the caller's own
    // in-memory Map already covers the same-session case.
  }
}

export function clearDraft(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch (_) {
    // ignore — same as saveDraft above.
  }
}
