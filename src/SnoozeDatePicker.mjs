// SnoozeDatePicker.mjs — the "Kies moment" row every snooze menu shows below
// its fixed moments: a native datetime-local picker plus one confirm button.
// Reindert: "ik wil bij snoozen (overal) ook een date picker hebben". Used by
// /pr-overview's row popover (overview.mjs snoozeAction) and by every bell
// (bellReminders.mjs: a row's snooze options and the reminder composer).
//
// The picked moment travels as the option "at:<ISO>" (snooze.mjs
// snoozeAtOption), through the very same write path as the fixed options; the
// server re-checks that it lies in the future (pr_snooze.go snoozeUntil).
//
// It can sit inside a row's <a> (the bell), so every click stops there:
// propagation always, the default only off the input itself (the input needs
// its own default to open the native picker).

import { html, reactive } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { formatSnoozeMoment, snoozeAtOption } from './snooze.mjs'

const pad = (n) => String(n).padStart(2, '0')

// toLocalValue — a Date as datetime-local's "YYYY-MM-DDTHH:MM" (local time).
function toLocalValue(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// defaultValue — tomorrow 08:00, the same wall-clock time as the fixed moments.
function defaultValue(now = new Date()) {
  return toLocalValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0))
}

// parseLocalValue — datetime-local's value back to a Date (local time), or null.
function parseLocalValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '')
  if (!m) return null
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0)
  return isNaN(d) ? null : d
}

// SnoozeDatePicker({onPick, inputCls, buttonCls, disabled, testid, label}) — onPick
// receives the "at:<ISO>" option once a future moment is confirmed (button or
// Enter in the field). `disabled` is an optional getter that blocks only the
// confirm (a write in flight, an empty reminder text) — the field stays usable.
export function SnoozeDatePicker({ onPick, inputCls = '', buttonCls = '', disabled = () => false, testid = 'snooze-date', label = 'Snooze' }) {
  const st = reactive({ value: defaultValue() })
  const picked = () => {
    const d = parseLocalValue(st.value)
    return d && d.getTime() > Date.now() ? d : null
  }
  function confirm() {
    const d = picked()
    if (!d || disabled()) return
    onPick(snoozeAtOption(d))
  }
  return html`<div
    data-testid="${testid}"
    class="flex flex-wrap items-center gap-1.5"
    @click="${(e) => {
      if (!e) return
      e.stopPropagation()
      if (e.target.tagName !== 'INPUT') e.preventDefault()
    }}"
  >
    <input
      type="datetime-local"
      data-testid="${testid + '-input'}"
      aria-label="${t('Kies moment')}"
      min="${toLocalValue(new Date())}"
      class="${'rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-700 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 ' + inputCls}"
      value="${() => st.value}"
      @input="${(e) => (st.value = e.target.value)}"
      @keydown="${(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        confirm()
      }}"
    />
    <button
      type="button"
      data-testid="${testid + '-confirm'}"
      class="${buttonCls}"
      disabled="${() => !picked() || disabled()}"
      @click="${confirm}"
    >
      ${t(label)}
      <span class="text-slate-400 dark:text-zinc-500">${() => {
        const d = picked()
        return d ? '· ' + formatSnoozeMoment(d) : '· ' + t('kies een moment in de toekomst')
      }}</span>
    </button>
  </div>`
}
