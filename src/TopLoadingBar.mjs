// TopLoadingBar — a very thin, full-width, ANIMATED strip fixed at the true
// top of the screen (`data-testid=top-loading-bar`), shown while the
// currently active top-level block's code is still being fetched
// (`/api/code`, see ensureCode in home.mjs). Sibling of ProgressBar.mjs (the
// static bottom review-progress fill) but deliberately a different signal:
// this one is transient and only ever means "wait a moment, loading".
//
// Why this exists next to the per-card "loading code…" text (Block.mjs's
// codeDiff): that text sits wherever the loading card happens to be, which —
// right after an approve-triggered auto-advance to the next block — is often
// a different spot on screen than where the reviewer was just looking (the
// list can scroll/rebuild). A fixed strip at the very top is visible
// regardless of where the new card lands. Deliberately the SIMPLE variant:
// it lights up for ANY not-yet-loaded top-level block (a fresh page load, a
// manual ↓/click as much as an approve auto-advance) — no separate
// "was this an auto-advance" flag, see home.mjs's topLoadingActive().
//
// `active` is a plain getter function (`() => boolean`), not a `state` field
// read directly here — home.mjs's topLoadingActive() needs curBlock(), which
// is local to that module, so the caller passes the closure in (same shape as
// Block.mjs's activeGroup/hintsEnabled/diffActive options).
import { html } from './vendor/arrow.js'

export const TOP_LOADING_BAR_PX = 3

export default function TopLoadingBar(state, active) {
  return html`
    <div
      class="${() =>
        `fixed inset-x-0 top-0 z-30 ${active() ? 'block' : 'hidden'} h-[${TOP_LOADING_BAR_PX}px] overflow-hidden pointer-events-none`}"
      data-testid="top-loading-bar"
    >
      <div class="top-loading-bar-fill h-full bg-indigo-600 dark:bg-indigo-400" data-testid="top-loading-bar-fill"></div>
    </div>
  `
}
