// UsagePie — how much of the 5-hour Claude session budget is USED, plus the
// projected share at reset ("pace"), as two small pies next to the analog clock in the /pr/<id> corner (JiraBellHost,
// home.mjs). Data: GET /api/claude/usage, the latest rate_limit_event reading
// from a Claude call slash itself made (modules/claude/usage.go) — so it is only
// as fresh as slash's last Claude call.
//
// First pie: share USED; second pie: the pace, i.e. the share used at reset if
// you keep going at the same rate — the same number as the `5h:85% - 91%` pace
// in ~/.claude/statusline.py (working hours only, `~` = wall-clock fallback).
// Both percentages are always shown as text (colourblind rule: shape + text
// carry the meaning, colour is extra; a pace over 100% also gets a `!`).
// Colour reuses the clock's palette on the pace: ≤90 normal, 91–100 warn,
// >100 late. A reading taken before the window's resetsAt has passed is stale:
// dimmed, with "?" and no pace pie.

import { html, reactive } from './vendor/arrow.js'
import { BASE, STATE_CLS } from './AnalogClock.mjs'
import { t } from './i18n.mjs'

const usage = reactive({ ok: false, utilization: 0, resetsAt: 0, seenAt: 0, now: Date.now() })

const WINDOW_MS = 5 * 3600 * 1000
const TZ = 'Europe/Amsterdam'

// Working hours per weekday (JS getDay: 0 = Sunday), in fractional hours.
// A copy of WORK_HOURS in ~/.claude/statusline.py — keep the two in sync.
const WORK_HOURS = {
  1: [8.5, 15.5],
  2: [10, 17],
  3: [8.5, 15.5],
  4: [10, 17],
  5: [9.5, 15],
  6: [17, 21],
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

// Amsterdam wall-clock parts of epoch ms `ms`.
function amsParts(ms) {
  const p = {}
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = Number(value)
  return p
}

// Epoch ms of Amsterdam wall-clock time (y, m, d, fractional hour h).
function amsEpoch(y, m, d, h) {
  const wall = Date.UTC(y, m - 1, d) + h * 3600 * 1000
  const off = (ms) => {
    const p = amsParts(ms)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  }
  let t = wall - off(wall)
  t = wall - off(t)
  return t
}

// Milliseconds between a and b that fall inside that day's WORK_HOURS (Amsterdam).
function workingMs(a, b) {
  if (b <= a) return 0
  const s = amsParts(a)
  const e = amsParts(b)
  const last = Date.UTC(e.year, e.month - 1, e.day)
  let total = 0
  for (let day = Date.UTC(s.year, s.month - 1, s.day); day <= last; day += 86400000) {
    const d = new Date(day)
    const hours = WORK_HOURS[d.getUTCDay()]
    if (!hours) continue
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    const lo = Math.max(amsEpoch(y, m, dd, hours[0]), a)
    const hi = Math.min(amsEpoch(y, m, dd, hours[1]), b)
    if (hi > lo) total += hi - lo
  }
  return total
}

/**
 * Projected share used at reset, in percent, as statusline.py's window_pace:
 * {pace, approx} or null. Measured up to the reading's own seenAt (not "now"),
 * because slash's reading may be older than the moment it is shown.
 */
export function usagePace(u) {
  const reset = u.resetsAt * 1000
  const start = reset - WINDOW_MS
  const end = Math.min(u.seenAt * 1000, reset)
  const pct = u.utilization * 100
  const elapsed = workingMs(start, end)
  const capacity = workingMs(start, reset)
  if (elapsed > 0 && capacity > 0) return { pace: (pct * capacity) / elapsed, approx: false }
  const wall = end - start
  if (wall > 0) return { pace: (pct * WINDOW_MS) / wall, approx: true }
  return null
}

/** 'normal' | 'warn' | 'late' | 'stale' for a reading at time `now` (ms), banded on the pace. */
export function usageState(u, now) {
  if (now >= u.resetsAt * 1000) return 'stale'
  const p = usagePace(u)
  const shown = p ? Math.min(Math.round(p.pace), 999) : 0
  if (shown > 100) return 'late'
  if (shown > 90) return 'warn'
  return 'normal'
}

async function refresh() {
  try {
    const r = await fetch('/api/claude/usage')
    const j = await r.json()
    usage.utilization = Number(j.utilization) || 0
    usage.resetsAt = Number(j.resetsAt) || 0
    usage.seenAt = Number(j.seenAt) || 0
    usage.ok = !!j.ok
  } catch {
    // Keep the last reading; an unreachable server is not a reason to hide it.
  }
  usage.now = Date.now()
}

let started = false
function start() {
  if (started) return
  started = true
  refresh()
  setInterval(refresh, 60000)
  window.addEventListener('focus', refresh)
}

const hhmm = (sec) => new Date(sec * 1000).toTimeString().slice(0, 5)

// SVG path of the slice for fraction f (0..1) of a circle at (12,12) r=9,
// starting at 12 o'clock, clockwise.
function slicePath(f) {
  if (f <= 0) return ''
  if (f >= 1) return 'M12 3 A9 9 0 1 1 11.99 3 Z'
  const a = f * 2 * Math.PI
  const x = (12 + 9 * Math.sin(a)).toFixed(2)
  const y = (12 - 9 * Math.cos(a)).toFixed(2)
  return `M12 12 L12 3 A9 9 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

function pie(testid, f) {
  return html`<svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
    <path data-testid="${testid}" d="${f}" fill="currentColor"></path>
  </svg>`
}

export function usagePie(cls = 'h-8 shadow-sm') {
  start()
  const state = () => usageState(usage, usage.now)
  const stale = () => state() === 'stale'
  const used = () => Math.round(usage.utilization * 100)
  const pace = () => usagePace(usage)
  const paceShown = () => {
    const p = pace()
    return p ? Math.min(Math.round(p.pace), 999) : 0
  }
  const paceText = () => {
    const p = pace()
    if (!p) return ''
    return (p.approx ? '~' : '') + paceShown() + '%' + (paceShown() > 100 ? '!' : '')
  }
  const label = () => (stale() ? '?' : used() + '%')
  const title = () =>
    stale()
      ? t('5-uurs Claude-sessie is gereset sinds de laatste meting ({seen})', { seen: hhmm(usage.seenAt) })
      : t('{used}% van je 5-uurs Claude-sessie verbruikt · bij dit tempo {pace} bij reset {reset} · gemeten {seen}', {
          used: used(),
          pace: paceText() || '?',
          reset: hhmm(usage.resetsAt),
          seen: hhmm(usage.seenAt),
        })
  const boxCls = () => {
    const s = state()
    return BASE + cls + ' gap-1 px-1.5 ' + (s === 'stale' ? STATE_CLS.normal + ' opacity-50' : STATE_CLS[s])
  }
  return html`<div class="contents">
    ${() =>
      usage.ok
        ? html`<div
            data-testid="claude-usage"
            data-state="${state}"
            title="${title}"
            aria-label="${title}"
            class="${boxCls}"
          >
            ${pie('claude-usage-slice', () => (stale() ? '' : slicePath(usage.utilization)))}
            <span data-testid="claude-usage-text" class="text-xs font-semibold tabular-nums">${label}</span>
            <div class="contents">
              ${() =>
                !stale() && pace()
                  ? html`<span class="inline-flex items-center gap-1" data-testid="claude-usage-pace">
                      ${pie('claude-usage-pace-slice', () => slicePath(Math.min(paceShown(), 100) / 100))}
                      <span data-testid="claude-usage-pace-text" class="text-xs font-semibold tabular-nums"
                        >${paceText}</span
                      >
                    </span>`
                  : ''}
            </div>
          </div>`
        : ''}
  </div>`
}
