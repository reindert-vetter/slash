// snooze.mjs — the pure helpers behind /pr-overview's "Snooze…" popover item
// (see "Snoozen" in .claude/docs/pr-overview.md). No state, no fetch: the
// write goes through the pr_snooze workflow (overview.mjs), and the durable
// wake-up moment is computed THERE, from w.Now() (pr_snooze.go's snoozeUntil).
// snoozePreviewUntil below is the same rule, used only to label an option
// ("do 1 okt 08:00") before the reviewer picks it.

import { t, uiLang } from './i18n.mjs'

// The three options, in menu order. The keys are the Go constants in
// pr_snooze.go (SnoozeTomorrow/SnoozeNextMonday/SnoozeSevenDays).
export const SNOOZE_OPTIONS = [
  { key: 'tomorrow_8', label: 'Morgen 08:00' },
  { key: 'next_monday_8', label: 'Volgende week maandag 08:00' },
  { key: 'days_7', label: 'Over 7 dagen 08:00' },
]

// snoozePreviewUntil mirrors pr_snooze.go's snoozeUntil in the browser's local
// time: 08:00 on tomorrow / next calendar week's Monday / the day 7 days out.
export function snoozePreviewUntil(option, now = new Date()) {
  let days = 0
  if (option === 'tomorrow_8') days = 1
  else if (option === 'next_monday_8') days = 7 - ((now.getDay() + 6) % 7)
  else if (option === 'days_7') days = 7
  else return null
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 8, 0, 0, 0)
}

// formatSnoozeMoment — "ma 5 okt 08:00" (weekday + day + month + time), in the
// interface language.
export function formatSnoozeMoment(date) {
  if (!(date instanceof Date) || isNaN(date)) return ''
  const locale = uiLang() === 'en' ? 'en-GB' : 'nl-NL'
  const day = date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\.$/, '')
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return day + ' ' + time
}

// isSnoozeActive — does this stored snooze still hide the PR right now?
// Two ways to wake up, both decided HERE on the read side (never a write):
//  - its moment passed (until <= now);
//  - the PR saw new activity after it was snoozed: GitHub's own updatedAt
//    (bumped by a new commit, a new comment or review, a (re-)requested
//    review) is later than snoozedAt. `updatedAts` are every updatedAt this
//    page knows for the PR (the light inbox row and the heavy status
//    backfill), the latest one counts.
export function isSnoozeActive(snooze, updatedAts, now = Date.now()) {
  if (!snooze) return false
  const until = Date.parse(snooze.until)
  if (!(until > now)) return false
  const at = Date.parse(snooze.snoozedAt)
  const latest = Math.max(0, ...(updatedAts || []).map((u) => Date.parse(u || '') || 0))
  return !(at && latest > at)
}

// snoozeMarkText — the row's "gesnoozed tot ma 5 okt 08:00" word. The word
// carries the state, never a colour (colourblind rule).
export function snoozeMarkText(snooze) {
  return t('gesnoozed tot {time}', { time: formatSnoozeMoment(new Date(snooze.until)) })
}
