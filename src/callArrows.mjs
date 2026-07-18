// callArrows.mjs — the flowing indigo arrow from the selected *changed* code in
// the diff (the call-site row inside the active navigation unit, new/right pane)
// to the matching *changed* underlying-code child card in the Onderliggende-code
// panel (a method_call child whose definition is itself a PR block).
//
// Deliberately an IMPERATIVE drawing layer, not a reactive template (the
// updateHints/positionMenu model): home.mjs computes the pairs inside its
// existing setRelated watch *callback* (untracked — so no new reactive reader
// of b.code can co-subscribe with the diff render, see the stuck-on-loading
// pitfall in conventions.md) and pushes them here via setCallArrows. Everything
// after that is plain DOM: querySelector + getBoundingClientRect + an innerHTML
// write into one statically-mounted fixed <svg> overlay. No arrow.js binding in
// this module ever reads reactive state.
//
// The overlay is positioned exactly over <main> (the detail panel) on every
// draw, and an <svg> clips its own contents by default — so arrows can never
// draw over the pr-index, the PR-info column, the comments/taken sidebar or the
// footer, even though both anchor points are measured in viewport coordinates.
// z-[15] stacks it above <main> (z-10) but below the comments sidebar (z-20)
// and the command menu (z-40/50); pointer-events:none so it never eats a click.
import { html } from './vendor/arrow.js'

// The pairs home.mjs pushed last: [{ row, childId }] — `row` is the aligned-row
// index of the call site (matched in the DOM via paneHTML's data-row), and
// `childId` the panel descriptor id (matched via relatedCard's data-child-id).
// A plain module variable on purpose (not reactive): the draw is imperative.
let pairs = []
let raf = 0

// ARROW is the shared stroke style: the call-underline indigo (#6366f1),
// half-transparent, matching the panel's existing accent language.
const STROKE = '#6366f1'

// setCallArrows receives the fresh pairs from home.mjs' setRelated watch and
// schedules a redraw. The extra 250ms settle-draw mirrors openMenu's 220ms
// re-position: <main>/the cards animate width/position for 200ms (entering the
// diff, the `a` toggle, the sidebar margin), so one late draw re-measures the
// settled layout.
export function setCallArrows(next) {
  pairs = Array.isArray(next) ? next : []
  scheduleArrowDraw()
  setTimeout(scheduleArrowDraw, 250)
}

// scheduleArrowDraw coalesces any number of triggers (watch fire, scroll,
// resize) into one requestAnimationFrame — measuring after the current
// reactive flush has reached the DOM.
export function scheduleArrowDraw() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    drawCallArrows()
  })
}

// drawCallArrows measures both anchors and rewrites the overlay's paths. Reads
// only the DOM — never reactive state (see the module note above).
function drawCallArrows() {
  const svg = document.querySelector('[data-testid="call-arrows"]')
  if (!svg) return
  const hide = () => {
    svg.style.display = 'none'
    svg.innerHTML = ''
  }
  if (pairs.length === 0) return hide()
  const main = document.querySelector('[data-testid="detail-panel"]')
  if (!main) return hide()
  // The selected top-level card's NEW pane (the first match under <main> — the
  // selected card renders before the look-ahead preview, same selector
  // precedent as home.mjs' menuRegion) and the Onderliggende-code panel. The
  // collapsed related rail (laptop width) renders no child cards, so arrows
  // simply disappear with it.
  const pane = main.querySelector('[data-pane="new"]')
  const panel = main.querySelector('[data-testid="related-code"]')
  if (!pane || !panel) return hide()
  const scroller = pane.querySelector('[data-scrollsync]')
  const paneRect = (scroller || pane).getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  const mainRect = main.getBoundingClientRect()
  const parts = []
  for (const p of pairs) {
    const rowEl = pane.querySelector(`[data-row="${p.row}"]`)
    const childEl = panel.querySelector(`[data-child-id="${CSS.escape(p.childId)}"]`)
    if (!rowEl || !childEl) continue
    const rRect = rowEl.getBoundingClientRect()
    // Call-site row scrolled out of the diff viewport → no arrow for it (the
    // same visibility rule updateHints uses for the green scroll chevrons).
    if (rRect.bottom <= paneRect.top + 0.5 || rRect.top >= paneRect.bottom - 0.5) continue
    const cRect = childEl.getBoundingClientRect()
    const x1 = paneRect.right - 2
    const y1 = (rRect.top + rRect.bottom) / 2
    const x2 = cRect.left - 4
    // Aim at the child card's header line; clamp to the panel's visible box so
    // a card scrolled out of the panel keeps a (clamped) arrow pointing at
    // where it went.
    const y2 = Math.max(panelRect.top + 10, Math.min(cRect.top + 16, panelRect.bottom - 10))
    if (x2 <= x1 + 8) continue
    const dx = Math.max(40, Math.min((x2 - x1) * 0.4, 160))
    // Coordinates are svg-local: the overlay sits exactly over <main>.
    const sx = (v) => (v - mainRect.left).toFixed(1)
    const sy = (v) => (v - mainRect.top).toFixed(1)
    parts.push(
      `<path d="M ${sx(x1)} ${sy(y1)} C ${sx(x1 + dx)} ${sy(y1)}, ${sx(x2 - dx)} ${sy(y2)}, ${sx(x2)} ${sy(y2)}"` +
        ` fill="none" stroke="${STROKE}" stroke-opacity="0.45" stroke-width="1.5" stroke-linecap="round"` +
        ` marker-end="url(#call-arrow-head)" data-testid="call-arrow"></path>`,
    )
  }
  if (parts.length === 0) return hide()
  svg.style.display = 'block'
  svg.style.top = mainRect.top + 'px'
  svg.style.left = mainRect.left + 'px'
  svg.style.width = mainRect.width + 'px'
  svg.style.height = mainRect.height + 'px'
  svg.innerHTML =
    '<defs><marker id="call-arrow-head" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    `<path d="M 1 1.5 L 8 5 L 1 8.5" fill="none" stroke="${STROKE}" stroke-opacity="0.7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>` +
    '</marker></defs>' +
    parts.join('')
}

// Reposition on resize and on any scroll — capture catches the inner scrollers
// too (the diff body, the panel body, <main>'s horizontal scroll), exactly like
// home.mjs' repositionMenu listeners. rAF-coalesced, so this stays cheap.
window.addEventListener('resize', scheduleArrowDraw)
window.addEventListener('scroll', scheduleArrowDraw, true)

// CallArrowsHost mounts the one static overlay element at the top level
// (sibling of MenuHost — NOT nested inside <main>, which is a z-10 stacking
// context that would cap the overlay below the comments sidebar). All
// attributes are static; the contents are written imperatively by
// drawCallArrows, so no keyed-node/binding pitfall applies.
export function CallArrowsHost() {
  return html`<svg
    data-testid="call-arrows"
    class="pointer-events-none fixed z-[15]"
    style="display:none;top:0;left:0"
  ></svg>`
}
