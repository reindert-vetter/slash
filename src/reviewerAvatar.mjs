// The reviewer avatar with its status badge (approved / changes requested /
// commented / pending), shared by /pr-overview (overview.mjs) and the review
// tree's PR-info column (home.mjs). Extracted from overview.mjs because that
// file is a page bootstrap script with side effects and cannot be imported.
import { html } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { avatarHTML, displayNameOf } from './avatar.mjs'

const BADGE_ICON_PATHS = {
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
}

function icon(name, cls) {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="${'inline-block shrink-0 ' + cls}"
    aria-hidden="true"
    .innerHTML="${BADGE_ICON_PATHS[name] || ''}"
  ></svg>`
}

// Approved first, then changes-requested/commented, then pending — the eye
// lands on who still owes a review.
export function sortReviewers(reviewers) {
  const order = { APPROVED: 0, CHANGES_REQUESTED: 1, COMMENTED: 2 }
  return [...reviewers].sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3))
}

const STATE_LABEL = {
  APPROVED: 'goedgekeurd',
  CHANGES_REQUESTED: 'wijzigingen gevraagd',
  COMMENTED: 'reactie geplaatst',
  DISMISSED: 'afgewezen',
  PENDING: 'in afwachting',
  // UNKNOWN: the backend's per-reviewer fold (inbox.go's mergeReviewers)
  // couldn't tell whether this reviewer's status is up to date — an
  // extremely active PR exceeded the reviews(first: N) pagination cap and
  // this author's true latest review may have been cut off. Deliberately a
  // distinct label from "in afwachting" (which means "genuinely awaiting a
  // first review") — this reviewer HAS reviewed, we just can't say for
  // certain what their current status is. reviewerAvatar already renders it
  // as the same dimmed placeholder as PENDING (anything outside
  // {APPROVED,CHANGES_REQUESTED,COMMENTED} falls into that bucket) — only the
  // tooltip differs.
  UNKNOWN: 'onduidelijk — te veel reviews om zeker te zijn',
}

export function reviewerAvatar(r) {
  const login = r.login || '?'
  const pending = r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'COMMENTED'
  const label = t(STATE_LABEL[r.state] || r.state || '')
  // Precompute per the branch avatarHTML takes internally (image vs
  // initials-fallback), so the pending-dimming keeps looking exactly like it
  // did before this circle was extracted into the shared avatarHTML helper.
  const extra = pending ? (r.avatarUrl ? 'opacity-50 grayscale' : 'opacity-60') : ''
  // avatarHTML derives initials from just the first two characters, so
  // passing "name — label" as the name keeps the same tooltip shape the
  // reviewer strip had before, without a separate title param. The name is the
  // reviewer's real first name once known (see ensureNames in avatar.mjs),
  // falling back to the login — same rule as the row's own author column.
  return html`
    <span class="relative inline-block">
      ${avatarHTML(displayNameOf(login) + ' — ' + label, r.avatarUrl, 'h-6 w-6', extra)}
      ${r.state === 'APPROVED'
        ? html`<span
            class="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white dark:ring-zinc-900"
            >${icon('check', 'h-2 w-2')}</span
          >`
        : r.state === 'CHANGES_REQUESTED'
          ? html`<span
              class="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-rose-500 text-white ring-2 ring-white dark:ring-zinc-900"
              >${icon('x', 'h-2 w-2')}</span
            >`
          : r.state === 'COMMENTED'
            ? html`<span
                class="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-400 dark:bg-zinc-500 text-white ring-2 ring-white dark:ring-zinc-900"
                >${icon('message', 'h-2 w-2')}</span
              >`
            : html`<span class="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-slate-300 dark:bg-zinc-600 ring-2 ring-white dark:ring-zinc-900"></span>`}
    </span>
  `
}
