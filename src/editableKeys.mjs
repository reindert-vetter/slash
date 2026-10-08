// editableKeys.mjs — "does this key belong to the focused text field?" helpers
// for a page's document-level onKeydown: whether a text input has focus, a
// Cmd/Ctrl modifier, and whether an arrow key would still move the caret inside
// that field (so it must not move the page's own cursor instead). Pure DOM
// reads, shared by the review tree (home.mjs) and the QA page (qa.mjs), which
// both route the same RelatedPanel.mjs comment/Claude block.

// isEditableFocused reports whether DOM focus currently sits on a text input —
// used to keep the `a` shortcut (a real letter a reviewer might type) from
// firing while typing into a field that isn't otherwise guarded by cs.focus
// (see the `a` handler in onKeydown for why that guard alone isn't enough).
export function isEditableFocused() {
  const el = document.activeElement
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
}

// isModifiedKey reports whether Cmd (Mac) or Ctrl (Windows/Linux) is held —
// used by the single-letter shortcuts (a/f/d/s) to step aside for the
// browser/OS's own Cmd+A (select all) / Cmd+F (find) / Cmd+D (bookmark) /
// Cmd+S (save): `event.key` stays the bare letter regardless of the modifier,
// so without this check those shortcuts silently ate the native browser
// behavior even outside any editable field (isEditableFocused() only covers
// TEXTAREA/INPUT, not a plain, selectable diff/code pane). Deliberately
// doesn't check altKey/shiftKey — those don't collide with a native
// select-all/find/bookmark/save shortcut on any platform this app targets.
export function isModifiedKey(e) {
  return e.metaKey || e.ctrlKey
}

// isNativeTextEditKey reports whether this keydown is a Cmd/Ctrl-modified key
// pressed while DOM focus really sits in a text field — i.e. a NATIVE caret /
// selection / editing command the app must never hijack: Cmd+←/→ (start/end of
// the line on Mac), Cmd+↑/↓ (start/end of the field), their Shift+ selecting
// variants, and macOS's emacs-style Ctrl+←/→. Reviewer report: "als ik in een
// textarea zit, dan kan ik niet cmd + left drukken, dan moet het werken zoals
// normaal". `onKeydown` returns on it before any other branch, so this is one
// guard for EVERY text field (comment composer/reply, Claude chat, the search
// box, the palette query) instead of a per-branch exception — the
// isEditableFocused() fallback further down already lets an unmodified,
// unclaimed key flow into the field; only relatedActive()'s and
// state.searchActive's own arrow branches sat in front of it and swallowed a
// modified arrow as navigation. The Cmd+[ / Cmd+] block-history chord
// (top of onKeydown) is checked BEFORE this guard and returns on its own, so
// it never reaches here regardless of focus — see "Cmd+[ / Cmd+]" in
// .claude/docs/keyboard-navigation.md.
export function isNativeTextEditKey(e) {
  return isModifiedKey(e) && isEditableFocused()
}

// editableCaretCanMoveLeft reports whether a focused text field's caret sits
// strictly past the very start (there's a character — or a selection — to its
// left), meaning a plain/Option ArrowLeft has somewhere to go *within* the
// field. Used to decide whether ArrowLeft should move/word-jump the caret
// (leave it to the browser) or fall through to the existing "exit the
// field/panel" shortcuts below (relatedActive's ArrowLeft branch) — a caret
// already at position 0 (e.g. a freshly opened, still
// empty composer/reply field) has nothing to move left into, so ArrowLeft
// there keeps its long-standing "step back out" meaning instead. See also
// editableCaretCanMoveRight below, its mirror image for ArrowRight.
export function editableCaretCanMoveLeft() {
  const el = document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false
  try {
    return el.selectionStart > 0 || el.selectionEnd > 0
  } catch {
    return false
  }
}

// editableCaretCanMoveRight is the mirror image of editableCaretCanMoveLeft:
// reports whether a focused text field's caret sits strictly before the very
// end (there's a character — or a selection — to its right), meaning a
// plain/Option ArrowRight has somewhere to go *within* the field. Used so
// ArrowRight moves/word-jumps the caret (leave it to the browser) instead of
// being hijacked by relatedActive's ArrowRight shortcut below (e.g. entering
// a comment's thread) while there's still text to move
// into — only once the caret is already at the end does ArrowRight keep its
// existing nav meaning there.
export function editableCaretCanMoveRight() {
  const el = document.activeElement
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false
  try {
    return el.selectionStart < el.value.length || el.selectionEnd < el.value.length
  } catch {
    return false
  }
}

// caretVisualLineMarks measures which VISUAL (wrapped) line a character offset
// falls on inside a <textarea> — selectionStart/selectionEnd alone only give a
// linear character index, not which rendered row that is once the text wraps
// (a comment/Claude composer is exactly such a wrapping, multi-row field). It
// builds a hidden mirror <div> that reproduces every style influencing
// wrapping (font, content width via clientWidth — so an active vertical
// scrollbar is accounted for the same way it narrows the textarea's own
// content box — padding, white-space/wrap), inserts zero-width marker spans at
// the very start, at `pos`, and at the very end of the field's value, and
// returns their offsetTop. Comparing `pos` against `start`/`end` then tells
// editableCaretCanMoveUp/Down below whether the caret already sits on the
// first/last wrapped row.
function caretVisualLineMarks(el, pos) {
  const csEl = getComputedStyle(el)
  const mirror = document.createElement('div')
  const style = mirror.style
  style.position = 'absolute'
  style.visibility = 'hidden'
  style.top = '0'
  style.left = '-9999px'
  style.height = 'auto'
  style.boxSizing = 'border-box'
  style.border = '0'
  style.width = el.clientWidth + 'px'
  style.whiteSpace = 'pre-wrap'
  style.overflowWrap = 'break-word'
  for (const p of [
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
  ]) {
    style[p] = csEl[p]
  }
  document.body.appendChild(mirror)
  const value = el.value
  const mark = () => {
    const span = document.createElement('span')
    span.textContent = '​'
    return span
  }
  const startMarker = mark()
  mirror.appendChild(startMarker)
  mirror.appendChild(document.createTextNode(value.slice(0, pos)))
  const posMarker = mark()
  mirror.appendChild(posMarker)
  mirror.appendChild(document.createTextNode(value.slice(pos)))
  const endMarker = mark()
  mirror.appendChild(endMarker)
  const result = { start: startMarker.offsetTop, pos: posMarker.offsetTop, end: endMarker.offsetTop }
  document.body.removeChild(mirror)
  return result
}

// editableCaretCanMoveUp reports whether a focused <textarea>'s caret sits
// below the very first VISUAL (wrapped) line, meaning a plain ArrowUp has a
// line to move to *within* the field. Mirrors editableCaretCanMoveLeft's role
// but for the vertical axis — used so ArrowUp moves the caret up one wrapped
// line (leave it to the browser) instead of being hijacked by relatedActive's
// ArrowUp shortcut below, only falling through to that nav shortcut once the
// caret is already on the first line. Deliberately TEXTAREA-only: a plain
// INPUT never wraps, so ArrowUp there keeps its existing nav meaning, same as
// today. Collapses a selection to its start, matching how the browser itself
// collapses an ArrowUp press on a selection.
export function editableCaretCanMoveUp() {
  const el = document.activeElement
  if (!el || el.tagName !== 'TEXTAREA') return false
  try {
    const marks = caretVisualLineMarks(el, el.selectionStart)
    return marks.pos !== marks.start
  } catch {
    return false
  }
}

// editableCaretCanMoveDown is the mirror image of editableCaretCanMoveUp: is
// there a wrapped line *below* the caret's current one. Collapses a selection
// to its end, matching how the browser collapses an ArrowDown press.
export function editableCaretCanMoveDown() {
  const el = document.activeElement
  if (!el || el.tagName !== 'TEXTAREA') return false
  try {
    const marks = caretVisualLineMarks(el, el.selectionEnd)
    return marks.pos !== marks.end
  } catch {
    return false
  }
}
