// relativeTime.mjs — "3 uur geleden" for an ISO timestamp. A shared pure
// utility (like theme.mjs/urlState.mjs), not a component: it lives here
// because BOTH pages render the very same "Bijgewerkt … geleden" wording —
// the PR overview's row meta, and the review tree's "sinds jouw laatste
// review" block, which deliberately repeats that overview line verbatim (see
// "Sinds jouw laatste review" in .claude/docs/detail-layout.md). Two
// implementations would be two wordings.

// relativeTime formats an ISO timestamp as "3 uur geleden" style text via
// Intl.RelativeTimeFormat, falling back to a manual computation if that API
// throws (very old browsers / unsupported locale data).
export function relativeTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  const diffSec = Math.round((date.getTime() - Date.now()) / 1000)
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  try {
    const rtf = new Intl.RelativeTimeFormat('nl', { numeric: 'auto' })
    for (const [unit, secs] of units) {
      if (Math.abs(diffSec) >= secs || unit === 'second') {
        return rtf.format(Math.round(diffSec / secs), unit)
      }
    }
  } catch (e) {
    const abs = Math.abs(diffSec)
    if (abs < 60) return 'zojuist'
    if (abs < 3600) return Math.round(abs / 60) + ' min geleden'
    if (abs < 86400) return Math.round(abs / 3600) + ' u geleden'
    return Math.round(abs / 86400) + ' d geleden'
  }
  return ''
}
