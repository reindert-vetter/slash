// textareaAutoGrow.mjs — shared auto-grow behaviour for every plain,
// uncontrolled composer `<textarea>` in the app: the Claude chat composer
// (ClaudeChat.mjs), the new-comment composer, the inline-thread reply and the
// PR-wide comment reply (all three in RelatedPanel.mjs). A bare
// `rows="1"`/no-rows textarea never grows with its content on its own — this
// is the one place that measurement lives, so all four composers behave
// identically instead of four copies of the same scrollHeight dance. See
// "Auto-grow composer textareas" in .claude/docs/claude-chat-panel.md.

// ~12rem — about 8 lines of text at the composers' text-xs size. Past this
// the textarea scrolls internally (autoGrowTextarea below sets overflow-y)
// instead of pushing the surrounding column ever taller.
const MAX_COMPOSER_HEIGHT_PX = 192

// autoGrowTextarea resizes `el` to fit its current content, capped at
// MAX_COMPOSER_HEIGHT_PX. Call it from an `@input` binding on every keystroke
// AND once after programmatically seeding `.value` (prefillField below) —
// setting `.value` in JS fires no `input` event, so a restored multi-line
// draft would otherwise sit clipped until the next keystroke.
export function autoGrowTextarea(el) {
  if (!el) return
  el.style.height = 'auto'
  const h = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX)
  el.style.height = h + 'px'
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT_PX ? 'auto' : 'hidden'
}

// resetTextareaHeight puts a composer back to its natural (CSS-driven)
// height right after it was cleared by a successful send — otherwise the
// inline `style.height` set above would keep it at its last grown height
// even though it's empty again. Only needed where the field stays mounted
// after sending (the Claude composer, the inline-thread reply); a composer
// that unmounts on send (the new-comment composer, the PR-wide reply) mounts
// fresh next time and needs no reset.
export function resetTextareaHeight(el) {
  if (!el) return
  el.style.height = ''
  el.style.overflowY = ''
}
