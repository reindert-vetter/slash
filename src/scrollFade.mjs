// scrollFade — a purely visual "there's more above" cue for a capped,
// internally-scrolling message thread (comment-thread in RelatedPanel.mjs,
// claude-chat-thread in ClaudeChat.mjs). Both threads now cap their own
// height (max-h) and scroll a VISIBLE native scrollbar internally instead of
// growing the whole comment-claude-row unboundedly — see "A capped, fading
// thread" in .claude/docs/comments-panel.md for why (a long comment/Claude
// conversation used to stretch <main>'s whole flex row via align-items:
// stretch, pushing the diff off the top of the screen and leaving a blank
// gap under the block column's own shorter content).
//
// updateScrollFade toggles `.scroll-fade-top` (defined in index.html's
// <style> block, a top mask-image) based on the container's OWN scrollTop —
// deliberately NOT a permanently-applied class: a short conversation that
// fits entirely (scrollTop stays 0) never fades anything, so the cue only
// ever appears once something genuinely sits scrolled out of view above the
// visible edge. Called from a `@scroll` binding on each thread container
// (live dragging/wheel scroll) and once after every programmatic
// `el.scrollTop = ...` write (scrollCommentThreadToBottom/
// scrollClaudeThreadToBottom in RelatedPanel.mjs), since a JS-driven scrollTop
// write isn't guaranteed to fire a 'scroll' event synchronously in every
// browser.
export function updateScrollFade(el) {
  if (!el) return
  el.classList.toggle('scroll-fade-top', el.scrollTop > 4)
}
