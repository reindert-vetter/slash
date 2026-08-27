// relativeTime.mjs — "3 uur geleden" for an ISO timestamp. A shared pure
// utility (like theme.mjs/urlState.mjs), not a component: it lives here
// because BOTH pages render the very same "Bijgewerkt … geleden" wording —
// the PR overview's row meta, and the review tree's "sinds jouw laatste
// review" block, which deliberately repeats that overview line verbatim (see
// "Sinds jouw laatste review" in .claude/docs/detail-layout.md). Two
// implementations would be two wordings.

import { t, uiLang } from './i18n.mjs'

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
    // The locale follows the interface language (i18n.mjs), so an English UI
    // says "3 hours ago" instead of "3 uur geleden" — Intl does the wording
    // here, so there is nothing for the dictionary to translate.
    const rtf = new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto' })
    for (const [unit, secs] of units) {
      if (Math.abs(diffSec) >= secs || unit === 'second') {
        return rtf.format(Math.round(diffSec / secs), unit)
      }
    }
  } catch (e) {
    const abs = Math.abs(diffSec)
    if (abs < 60) return t('zojuist')
    if (abs < 3600) return t('{n} min geleden', { n: Math.round(abs / 60) })
    if (abs < 86400) return t('{n} u geleden', { n: Math.round(abs / 3600) })
    return t('{n} d geleden', { n: Math.round(abs / 86400) })
  }
  return ''
}
