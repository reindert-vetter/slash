// theme.mjs — the three-state (system / light / dark) theme preference,
// shared between /pr/<id> (index.html + home.mjs, via ThemeToggleCorner — an
// always-visible fixed element, deliberately not inside Footer.mjs, which is
// only shown in diff mode) and /pr-overview (overview.html + overview.mjs).
// Persisted in localStorage —
// deliberately *not* the URL (bindUrlState/urlState.mjs): a theme choice isn't
// a navigation position you'd want in a shareable link, but it should survive
// a refresh, so a plain efemeral reactive() alone (like state.showApproved)
// isn't enough either.
//
// Tailwind's Play CDN runs `darkMode: 'selector'` (see index.html/
// overview.html): a `.dark` class on <html> is what flips every existing
// `dark:` utility. The two hand-written CSS blocks in index.html (Prism token
// colours + .markdown-body typography, see conventions.md) are plain CSS, not
// Tailwind utilities, so they can't key off that class — they instead key off
// a `data-theme="light"|"dark"` attribute on <html>, mirrored alongside their
// existing `@media (prefers-color-scheme: dark)` block (kept as a fallback
// for the instant before this module has run).
import { reactive, html, watch } from './vendor/arrow.js'

const STORAGE_KEY = 'theme'
const ORDER = ['system', 'light', 'dark']

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return ORDER.includes(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

// theme.pref is the reactive source of truth the toggle button reads/writes;
// initTheme() (called once per page, from home.mjs/overview.mjs) is what
// actually applies it to the DOM and keeps it live.
export const theme = reactive({ pref: readStored() })

function prefersDarkOS() {
  return matchMedia('(prefers-color-scheme: dark)').matches
}

function isDark(pref) {
  return pref === 'dark' || (pref === 'system' && prefersDarkOS())
}

function applyTheme(pref) {
  const dark = isDark(pref)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
}

// initTheme applies the current preference (redundant with the inline
// anti-flash <script> in index.html/overview.html, which already set the
// class/attribute before Tailwind's CDN script even ran — this just takes
// over reactively) and wires up two live sources of change: theme.pref itself
// (the toggle button), and the OS-level setting while pref === 'system'.
export function initTheme() {
  applyTheme(theme.pref)
  watch(() => theme.pref, applyTheme)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme.pref === 'system') applyTheme(theme.pref)
  })
}

// cycleTheme rotates system -> light -> dark -> system, persisting the choice.
export function cycleTheme() {
  const i = ORDER.indexOf(theme.pref)
  theme.pref = ORDER[(i + 1) % ORDER.length]
  try {
    localStorage.setItem(STORAGE_KEY, theme.pref)
  } catch {
    // localStorage unavailable (private mode, quota) — the in-memory
    // preference still works for the rest of this session.
  }
}

// Outline icon per state (24x24, stroke=currentColor) — a monitor for
// "system", a sun for "light", a moon for "dark". Static, trusted markup, so
// it's fine through the .innerHTML binding (same convention as
// overview.mjs/CommandMenu.mjs's own icon sets).
const ICON_PATHS = {
  system: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
}

const LABELS = { system: 'Systeem', light: 'Licht', dark: 'Donker' }

// themeToggleButton renders the single button shared by both pages — a click
// cycles system -> light -> dark -> system. `cls` lets each caller position it
// (a corner slot in the footer strip vs. inline in the overview header)
// without duplicating the button markup.
export function themeToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="theme-toggle"
      title="${() => 'Thema: ' + LABELS[theme.pref] + ' (klik om te wisselen)'}"
      class="${() =>
        'inline-flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors ' +
        cls}"
      @click="${cycleTheme}"
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
        .innerHTML="${() => ICON_PATHS[theme.pref]}"
      ></svg>
    </button>
  `
}
