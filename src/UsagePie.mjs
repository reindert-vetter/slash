// UsagePie — how much of the 5-hour Claude session budget is still left, as a
// small pie next to the analog clock in the /pr/<id> corner (JiraBellHost,
// home.mjs). Data: GET /api/claude/usage, the latest rate_limit_event reading
// from a Claude call slash itself made (modules/claude/usage.go) — so it is only
// as fresh as slash's last Claude call.
//
// The filled slice is the share LEFT, and the percentage is always shown as
// text next to it (colourblind rule: shape + text carry the meaning, colour is
// extra). Colour reuses the clock's palette on share USED: >80% warn, >95% late.
// A reading taken before the window's resetsAt has passed is stale: dimmed,
// with "?" instead of a number.

import { html, reactive } from './vendor/arrow.js'
import { BASE, STATE_CLS } from './AnalogClock.mjs'
import { t } from './i18n.mjs'

const usage = reactive({ ok: false, utilization: 0, resetsAt: 0, seenAt: 0, now: Date.now() })

/** 'normal' | 'warn' | 'late' | 'stale' for a reading at time `now` (ms). */
export function usageState(u, now) {
  if (now >= u.resetsAt * 1000) return 'stale'
  const used = u.utilization * 100
  if (used > 95) return 'late'
  if (used > 80) return 'warn'
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

export function usagePie(cls = 'h-8 shadow-sm') {
  start()
  const state = () => usageState(usage, usage.now)
  const left = () => Math.round((1 - usage.utilization) * 100)
  const label = () => (state() === 'stale' ? '?' : left() + '%')
  const title = () =>
    state() === 'stale'
      ? t('5-uurs Claude-sessie is gereset sinds de laatste meting ({seen})', { seen: hhmm(usage.seenAt) })
      : t('{left}% over van je 5-uurs Claude-sessie · reset {reset} · gemeten {seen}', {
          left: left(),
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
            <svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
              <path
                data-testid="claude-usage-slice"
                d="${() => (state() === 'stale' ? '' : slicePath(1 - usage.utilization))}"
                fill="currentColor"
              ></path>
            </svg>
            <span data-testid="claude-usage-text" class="text-xs font-semibold tabular-nums">${label}</span>
          </div>`
        : ''}
  </div>`
}
