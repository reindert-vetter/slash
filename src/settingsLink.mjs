// settingsLink.mjs — the shared, side-effect-free pieces of the `/settings`
// entry point, imported by home.mjs/overview.mjs (for the button) AND
// settings.mjs itself (for the `?from=` origin it was opened with).
// Deliberately split out of settings.mjs: that module is a PAGE module (it
// mounts App() into #app and registers its own window keydown listener at
// load, exactly like home.mjs/overview.mjs) — importing it from home.mjs or
// overview.mjs just to reuse settingsButton would run all of that top-level
// page code on /pr/<id> and /pr-overview too. This file has no top-level
// side effect at all, the same shape as theme.mjs/autowarn.mjs.
import { html } from './vendor/arrow.js'

// originFrom/originPr are computed here (not in settings.mjs) so a future
// caller other than settings.mjs could read them too, and so settings.mjs's
// own copy is guaranteed to agree with whatever settingsButton just built.
// Read once, never nulled (mirrors originPr/originSel in overview.mjs) — this
// module is only ever loaded by a page that's about to navigate away or that
// just landed, so there is no later moment where a second read would matter.
// Validated against an open redirect: only a same-origin, ABSOLUTE path
// (starts with "/", not "//") is honoured; anything else (missing, external,
// protocol-relative) falls back to /pr-overview.
export const originFrom = (() => {
  const raw = new URLSearchParams(location.search).get('from')
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/pr-overview'
})()

// A /pr/<id> origin also carries a PR to show the checkout-directory row's
// status for (read-only, see settings.mjs's checkoutRow). No id → not opened
// from a PR, that row stays inactive/grey.
export const originPr = (() => {
  const m = /^\/pr\/(\d+)(?:[/?#]|$)/.exec(originFrom)
  return m ? Number(m[1]) : null
})()

// settingsButton — the shared entry-point component, imported by both
// home.mjs (pr-info-theme-row) and overview.mjs (headerBlock). A single
// tandwiel icon, exactly as compact as themeToggleButton/autoWarnToggleButton
// next to it — no label text (reviewer's own choice, see settings-page.md).
// Never colour-bound (pure navigation, not a toggle), so the colourblind rule
// doesn't apply here the way it does to the toggles beside it.
export function settingsButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="settings-button"
      title="Instellingen"
      class="${() =>
        'inline-flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors ' +
        cls}"
      @click="${() => {
        location.href = '/settings?from=' + encodeURIComponent(location.pathname + location.search)
      }}"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-4 w-4"
        aria-hidden="true"
        aria-label="Instellingen"
      >
        <circle cx="12" cy="12" r="3"></circle>
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        ></path>
      </svg>
    </button>
  `
}
