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
// `updateScrollHints(scroller)` mirrors Block.mjs's `updateHints(container)`
// for a plain scrollable pane with no "changed row" concept: "more above/
// below" is answered purely by `scrollTop`/`scrollHeight`. `scroller` is the
// actual scrolling element (carries `data-scroll-body`); its own immediate
// parent is expected to be a `relative`-positioned host carrying the two
// `scrollHint('up')`/`scrollHint('down')` nodes as siblings — the same
// wrapper/scroller split Block.mjs's diff uses, and for the same reason: the
// wrapper and the scroller are not always the same box (see Block.mjs's own
// `updateHints`, "the down chevron floats mid-code"), so each hint is
// anchored to the SCROLLER's own measured edge, never a static `top-0`/
// `bottom-0` class.
export function updateScrollHints(scroller) {
  if (!scroller) return
  const container = scroller.parentElement
  const up = container && container.querySelector('[data-hint="up"]')
  const down = container && container.querySelector('[data-hint="down"]')
  if (!up || !down) return
  const cRect = container.getBoundingClientRect()
  const sRect = scroller.getBoundingClientRect()
  up.style.top = sRect.top - cRect.top + 'px'
  down.style.bottom = cRect.bottom - sRect.bottom + 'px'
  up.style.opacity = scroller.scrollTop > 4 ? '1' : '0'
  down.style.opacity = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4 ? '1' : '0'
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
