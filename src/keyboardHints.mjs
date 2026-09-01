// keyboardHints.mjs — the reviewer's on/off switch for the contextual
// keyboard-hint line under each card (ShortcutHintBar, shortcutHints.mjs).
// Reviewer request: "ik wil een instelling dat ik keyboard hints kan
// uitzetten. default wil ik die aan hebben". The switch lives on the
// settings page (settings-row-keyboardhints, src/settings.mjs).
//
// Pure frontend preference, like theme.mjs/debugLog.mjs and unlike
// autowarn.mjs: the server never needs to read it, ShortcutHintBar just
// checks it client-side before rendering anything, so localStorage is
// enough — no workflow/Signal write path needed.
import { reactive, html } from './vendor/arrow.js'
import { t } from './i18n.mjs'

const STORAGE_KEY = 'keyboardHints'

// Default ON: only an explicit 'off' in localStorage disables it, so an
// install that never touched the setting keeps the hint line.
function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

// keyboardHints.enabled is the reactive source of truth ShortcutHintBar
// reads and the toggle button reads/writes.
export const keyboardHints = reactive({ enabled: readStored() })

// toggleKeyboardHints flips the switch and persists it immediately — same
// shape as theme.mjs's cycleTheme / debugLog.mjs's toggleDebugMode.
export function toggleKeyboardHints() {
  const next = !keyboardHints.enabled
  keyboardHints.enabled = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    // localStorage unavailable (private mode, quota) — the in-memory
    // preference still works for the rest of this session.
  }
}

// keyboardHintsToggleButton — same filled/open-dot + label convention as
// autoWarnToggleButton/debugModeToggleButton: never colour-only (the
// reviewer is colorblind, see MEMORY.md).
export function keyboardHintsToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="keyboard-hints-toggle"
      title="${() =>
        t('Keyboard hints: {state} — de hintregel met sneltoetsen onder elke kaart (klik om te wisselen)', {
          state: t(keyboardHints.enabled ? 'aan' : 'uit'),
        })}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (keyboardHints.enabled
          ? 'text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-500/30 hover:bg-sky-50 dark:hover:bg-sky-500/10'
          : 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800') +
        ' ' +
        cls}"
      @click="${toggleKeyboardHints}"
    >
      <span
        data-testid="keyboard-hints-toggle-dot"
        class="${() =>
          'inline-block h-2 w-2 shrink-0 rounded-full ' +
          (keyboardHints.enabled ? 'bg-sky-500' : 'border border-slate-400 dark:border-zinc-500')}"
      ></span>
      <span>${() => t(keyboardHints.enabled ? 'Keyboard hints aan' : 'Keyboard hints uit')}</span>
    </button>
  `
}
