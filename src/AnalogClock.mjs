// AnalogClock — a round analog clock styled like the Jira bell button
// (jiraBell.mjs), pinned next to it in the /pr/<id> corner. Always visible;
// its colour escalates by local time: normal, orange from 14:30, red from
// 15:00, normal again from 17:00. Colour is the only signal by request;
// data-state/title exist for tests and screen readers.

import { html, reactive } from './vendor/arrow.js'

const BASE = 'inline-flex shrink-0 items-center justify-center rounded-full ring-1 transition-colors '
const STATE_CLS = {
  normal:
    'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700',
  warn: 'bg-orange-100 text-orange-700 ring-orange-400 dark:bg-orange-500/20 dark:text-orange-300 dark:ring-orange-500/60',
  late: 'bg-red-100 text-red-700 ring-red-400 dark:bg-red-500/20 dark:text-red-300 dark:ring-red-500/60',
}

/** Clock state for a Date: 14:30-15:00 warn, 15:00-17:00 late, else normal. */
export function clockState(d) {
  const m = d.getHours() * 60 + d.getMinutes()
  if (m >= 15 * 60 && m < 17 * 60) return 'late'
  if (m >= 14 * 60 + 30 && m < 15 * 60) return 'warn'
  return 'normal'
}

const clock = reactive({ now: Date.now() })
setInterval(() => {
  // Only write when the minute changed, so the hands re-render at most once a minute.
  const n = Date.now()
  if (Math.floor(n / 60000) !== Math.floor(clock.now / 60000)) clock.now = n
}, 15000)

function hand(len, deg) {
  const r = (deg * Math.PI) / 180
  return { x: (12 + len * Math.sin(r)).toFixed(2), y: (12 - len * Math.cos(r)).toFixed(2) }
}

export function analogClock(cls = 'h-8 w-8 shadow-sm') {
  const d = () => new Date(clock.now)
  const hourHand = () => {
    const t = d()
    return hand(6.5, ((t.getHours() % 12) + t.getMinutes() / 60) * 30)
  }
  const minHand = () => hand(10, d().getMinutes() * 6)
  return html`<div
    data-testid="tree-clock"
    data-state="${() => clockState(d())}"
    title="${() => d().toTimeString().slice(0, 5)}"
    class="${() => BASE + cls + ' ' + STATE_CLS[clockState(d())]}"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      class="h-full w-full"
      aria-hidden="true"
    >
      <line x1="12" y1="12" x2="${() => hourHand().x}" y2="${() => hourHand().y}"></line>
      <line x1="12" y1="12" x2="${() => minHand().x}" y2="${() => minHand().y}"></line>
    </svg>
  </div>`
}
