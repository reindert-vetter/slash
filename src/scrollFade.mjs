// scrollFade.mjs — shared "there is more above/below" scroll cue for a
// capped, internally-scrolling pane: `claude-chat-thread` (ClaudeChat.mjs),
// `comment-thread`/`comment-detail-thread` (RelatedPanel.mjs) and the
// standalone code-preview `pane()` (CodePreview.mjs). Reviewer request: hide
// the visible native scrollbar these four used to show, but keep the
// scrolling itself discoverable — reuse the exact green up/down
// `scrollHint` chevron pair Block.mjs's diff panes already use, instead of
// inventing a second visual language (colourblind rule: a shape, not a
// gradient/colour, carries the meaning). This module used to toggle a CSS
// top-fade (`.scroll-fade-top`) instead; that approach only ever covered
// "more above", never "more below" (that direction relied on the native
// scrollbar itself being visible) — removed together with the scrollbar.
//
// POSITION IS STATIC (rewritten; "don't reintroduce"): the hint pair is a
// direct child of a `relative` host that wraps ONLY the scroller, with the
// fixed top-0/bottom-0 classes of Block.mjs's scrollHint. The old version
// measured getBoundingClientRect and wrote inline top/bottom, but only on
// scroll events, so any size change without a scroll (card expand, highlight
// arriving, resize) left the chevron stranded mid-code. Now only `opacity` is
// computed, and observers keep it fresh. Block.mjs's diff `updateHints` is a
// separate mechanism and still measures.
//
// `updateScrollHints(scroller)` mirrors Block.mjs's `updateHints(container)`
// for a plain scrollable pane with no "changed row" concept: "more above/
// below" is answered purely by `scrollTop`/`scrollHeight`. `scroller` is the
// actual scrolling element (carries `data-scroll-body`); its own immediate
// parent is the static-positioned host wrapping only it (see above).
export function updateScrollHints(scroller) {
  if (!scroller) return
  const container = scroller.parentElement
  const up = container && container.querySelector(':scope > [data-hint="up"]')
  const down = container && container.querySelector(':scope > [data-hint="down"]')
  if (!up || !down) return
  // Position is static CSS (top-0/bottom-0 of a host wrapping ONLY the
  // scroller); only the on/off state is computed. Never write top/bottom here.
  const u = scroller.scrollTop > 4 ? '1' : '0'
  const d = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4 ? '1' : '0'
  if (up.style.opacity !== u) up.style.opacity = u
  if (down.style.opacity !== d) down.style.opacity = d
}

// Self-healing on/off state: a scroller whose size or content changes without
// a scroll event (highlight arriving via .innerHTML, card expand, resize)
// re-evaluates itself. One ResizeObserver + one MutationObserver, attached to
// every [data-scroll-body] as it appears.
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((es) => es.forEach((e) => updateScrollHints(e.target))) : null
const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver((ms) => ms.forEach((m) => updateScrollHints((m.target.nodeType === 1 ? m.target : m.target.parentElement).closest('[data-scroll-body]')))) : null
const watched = new WeakSet()
function watchScroller(el) {
  if (watched.has(el)) return
  watched.add(el)
  if (ro) ro.observe(el)
  if (mo) mo.observe(el, { childList: true, subtree: true, characterData: true })
  updateScrollHints(el)
}
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  // Coalesced to one native selector scan per frame (not a per-node walk), so
  // big diff renders stay cheap.
  let scheduled = false
  const scan = () => {
    scheduled = false
    document.querySelectorAll('[data-scroll-body]').forEach(watchScroller)
  }
  new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(scan)
  }).observe(document, { childList: true, subtree: true })
  scan()
}

// refreshScrollHints re-evaluates every rendered scroll-hint host on the
// page — the same "cover the cases nothing scrolls" role home.mjs's own
// `refreshHints()` plays for the diff panes (right after content renders
// with new/different size, and on window resize). Deferred a frame so
// layout is settled before measuring, same reasoning as `refreshHints`.
export function refreshScrollHints() {
  requestAnimationFrame(() => {
    document.querySelectorAll('[data-scroll-body]').forEach(updateScrollHints)
  })
}
