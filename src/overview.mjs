// overview.mjs — the /pr-overview page: a live GitHub PR inbox modeled on
// github.com/pulls (and styled after the reference dash app's home.mjs /
// icons.mjs). Sections mirror GitHub's own dashboard buckets (English
// titles); everything else is read-only — this page never mutates state (per
// .claude/rules/workflows-write-boundary.md). Rows paint fast from GET
// /api/inbox, then their status pills (review/checks/reviewers) backfill from
// GET /api/inbox/status without the row jumping. Falls back to a static
// /data/inbox.json snapshot when the live endpoint is unreachable.

import { reactive, html, watch } from './vendor/arrow.js'
import { t, syncUiLang } from './i18n.mjs'
import CommandMenu, { filterCommands } from './CommandMenu.mjs'
import { initTheme, themeToggleButton } from './theme.mjs'
import { initDebugLog } from './debugLog.mjs'
import { ensureAutoIngestPref, autoIngestPrefToggleButton } from './autoingestpref.mjs'
import { ensureAutoWarn, autoWarnToggleButton } from './autowarn.mjs'
import { settingsButton } from './settingsLink.mjs'
import { avatarHTML, avatarUrlOf, displayNameOf, ensureMe, ensureNames, fullNameOf, meLogin } from './avatar.mjs'
import { relativeTime } from './relativeTime.mjs'
import { fetchProblems, problemRunRow, problemLogRow } from './problems.mjs'
import FailedTasksHost, { initFailedTasksPopup, isFailedTasksOpen, handleFailedTasksKeydown } from './failedTasks.mjs'
import AuthStatusHost, { initAuthStatusPopup, isAuthProblemOpen, handleAuthProblemKeydown } from './authStatus.mjs'

initTheme()
// Reconcile the cached interface language with the server's own preference
// (GET /api/langpref) once per page load — see src/i18n.mjs.
syncUiLang()
// Debug mode: records this page load and every following key/click when the
// reviewer has it on (src/debugLog.mjs). A reproduction often starts here —
// opening the overview and then a PR's review tree.
initDebugLog()

// Configure this to your Jira instance — used only to build the "Open
// Jira-ticket" popover link when a PR title contains a KEY-123-style key.
const JIRA_BASE = 'https://plugandpaybv.atlassian.net/browse/'

const state = reactive({
  repo: '',
  // repos — every configured repo in canonical form ("" = the primary one), from
  // GET /api/inbox. Defaults to just the primary repo so the very first paint
  // (and the offline /data/inbox.json fallback) behaves like a single-repo build.
  repos: [''],
  generatedFor: '',
  loading: true,
  error: '',
  cached: false,
  inboxRunId: '', // pr_inbox workflow Run ID — target for refresh signal + heartbeat
  // jira — the reviewer's own Jira notification feed, read from
  // GET /api/jira/notifications (the jira_inbox tracker's read-model). Shown
  // ONLY inside the header bell's dropdown (jiraBellButton/jiraBellPanel) —
  // it used to also pin an always-visible section above the PR list, removed
  // per reviewer request once the bell existed ("haal deze sectie weg").
  jira: [],
  jiraUnreadOnly: true, // mirrors Jira's own "Only show unread" toggle, on by default
  jiraRunId: '', // jira_inbox Run ID — target for the "read" signal
  // jiraBellOpen — whether the header bell's own dropdown is open, badge-dotted
  // via jiraBellDot whenever jiraUnreadCount() > 0.
  jiraBellOpen: false,
  sections: [], // [{ title, prs: Row[] }]
  statuses: {}, // prUid -> Status, backfilled async
  approvals: {}, // prUid -> { done, total }, backfilled async (ingested PRs only)
  // pendingPush — prUid -> the PR's landed-but-unpushed Claude edits
  // ({ headRef, ahead, ... }, see pending_push.go), backfilled async by
  // kickOffPendingPush. Only ingested rows can have any: the edits come from
  // this app's own Claude chat.
  pendingPush: {},
  // checkout — prUid -> this PR's shared local checkout state ({ dir,
  // dirName, branch, ... }, see chat_checkout.go's buildCheckoutView),
  // backfilled async by kickOffCheckout. Only ingested rows can have one.
  checkout: {},
  query: '',
  searching: false,
  searchResults: null, // null = no active search
  recentOpen: false,
  recentLoading: false,
  recentPrs: [], // [{ pr, blocks, files, title, author?, additions?, deletions?, changedFiles?, headRefName?, updatedAt? }]
  // Preset-filter drawer (a second expandable button like "Recent gegenereerd").
  // filterOpen: the drawer menu is expanded. activePreset: the key of the preset
  // whose live gh-search results currently replace the main sections (null =
  // none).
  filterOpen: false,
  activePreset: null,
  presetLoading: false,
  presetResults: [],
  // "Mislukte taken" drawer (GET /api/problems): work that went wrong out of
  // sight. problemsOpen: expanded. failedRuns: workflow runs that ended in
  // status `failed` (durable, repo-wide). logErrors: the mirrored glue log
  // lines — poller/startup errors that are no workflow run of their own, kept
  // in an in-memory server-side ring buffer, so they reset on a server
  // restart (see run_errors.go). Loaded on page load — not lazily on open,
  // unlike "Recent gegenereerd" — because the count shows on the closed
  // button.
  runningCount: 0, // GET /api/running-count — repo-wide count of tembed.StatusRunning runs
  problemsOpen: false,
  problemsLoaded: false,
  failedRuns: [],
  logErrors: [],
  // prTitles: { "<pr>": "<title>" } for every PR either list references, so a
  // row can name the PR instead of only its number (see problemPrChip). A PR
  // prmeta has no title for is simply absent.
  prTitles: {},
})

// ui is separate from state so opening/closing a popover doesn't touch the
// bits bound into url-less local reactivity elsewhere.
// ingestingByPr / ingestStageByPr: prUid -> true / prUid -> current ingest
// pipeline stage ("worktrees"/"scan"/"relations"/""), keyed per PR (like
// state.statuses/approvals/pendingPush) so several rows can be generating a
// review tree AT THE SAME TIME — clicking "Genereer review-boom" on one row
// no longer blocks a click on another (Reindert: "meerdere trees kunnen
// genereren door meerdere achter elkaar aan te klikken"). ingestBusy(pr)
// reads ingestingByPr[prUid(pr)]; ingestLabel(pr, ...) reads
// ingestStageByPr[prUid(pr)], both polled per PR from GET
// /api/ingest/progress while busy — see INGEST_STAGE_LABELS below.
// ingestError + ingestErrorFor: the last ingest failure message and which PR it
// belongs to (cleared on a fresh attempt or when its popover closes) —
// ingestErrorFor lets the standalone regenerate button on an already-ingested
// row show the error under the right row even though that PR's own
// ingestingByPr entry has already reset by the time the catch runs. These stay
// plain scalars (not per-PR) because only one popover is ever open at a time
// and togglePopover always clears them on every open, so they can never leak
// between rows.
// readyFor: the prUid whose reviewer picker is expanded (null = collapsed);
// reviewers: the fetched candidate list (repo collaborators, most-used-first);
// reviewersLoading/reviewersError: fetch state; selectedReviewers: a login→true
// map of the checked reviewers (reassigned wholesale so arrow.js re-renders);
// readySubmitting: a ready_for_review POST in flight.
// removingReviewer: the prUid whose remove_reviewer POST is in flight;
// removeReviewerError: that call's last failure message, shown inline in the
// popover (both cleared whenever a popover opens or closes).
// popoverAbove: whether the currently open popover should render ABOVE its row
// instead of below — measured once right after it mounts (see
// positionPopover below), so a row near the bottom of the viewport never opens
// a popover that's clipped off-screen.
const ui = reactive({
  openPopover: null, ingestingByPr: {}, ingestStageByPr: {}, ingestError: null, ingestErrorFor: null, copiedFor: null,
  readyFor: null, reviewers: [], reviewersLoading: false, reviewersError: null, selectedReviewers: {}, readySubmitting: false,
  removingReviewer: null, removeReviewerError: null,
  popoverAbove: false,
})

// INGEST_STAGE_LABELS — Dutch labels for the busy button while /api/ingest is
// in flight, backed by the real (ephemeral, in-memory) server-side progress
// tracked in ingest_progress.go/GET /api/ingest/progress. An unknown/not-yet-
// polled stage falls back to the generic "Bezig met genereren…".
const INGEST_STAGE_LABELS = {
  worktrees: 'Werktrees voorbereiden…',
  scan: 'Blocks scannen…',
  relations: 'Relaties opbouwen…',
}

// ── icons (lucide-style outline set, matching the dash reference exactly) ──

const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  'git-pull-request':
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  'git-branch':
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  'external-link':
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  // 'arrow-up' — the "still has to go up to GitHub" glyph next to the
  // "Ongepusht" chip (unpushedPill).
  'arrow-up': '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  // 'tree' — the "review tree" glyph: the graphChip for a PR that has no
  // review tree yet ("Op GitHub"), and the idle icon of the generate /
  // regenerate action in the row popover (ingestIcon). It replaced the
  // earlier external-link icon on the chip (that icon stays in use for the
  // real link-open actions, see popover()).
  //
  // Lucide's "tree-deciduous" — a rounded crown on a visible TRUNK. It
  // deliberately replaced Lucide's "tree-pine", whose stacked triangles read
  // as a CHRISTMAS tree rather than as the review tree this app is named
  // after (Reindert). Same 24x24/stroke-2 convention as the rest of this set.
  tree: '<path d="M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z"/><path d="M12 19v3"/>',
  // 'user-minus' — the popover's "Verwijder mij als reviewer" glyph (a person
  // with a minus sign). Lucide's own user-minus, same 24x24/stroke-2 set.
  'user-minus':
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
  // 'git-merge-x' — the conflictChip's glyph: this PR cannot be merged as it
  // stands (GitHub's mergeable == CONFLICTING). Lucide's own git-merge, but
  // with its target circle replaced by a cross — the merge line simply doesn't
  // arrive. Same 24x24/stroke-2 convention as the rest of this set. The chip's
  // WORD carries the meaning; this shape only has to be distinguishable from
  // the check/x/clock glyphs of the neighbouring chips (see
  // user_colorblind.md).
  'git-merge-x':
    '<circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/><path d="m21 15-6 6"/><path d="m15 15 6 6"/>',
  // 'folder' — the checkoutPill's glyph: this PR has a local checkout
  // assigned for Claude write turns (chat_checkout.go). Lucide's own folder,
  // same 24x24/stroke-2 set.
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  // 'bell' — the header's Jira-notifications entry point (jiraBellButton).
  // Lucide's own bell, same 24x24/stroke-2 set.
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
}

// icon renders one outline SVG (24x24 viewBox, stroke=currentColor). The path
// markup is a static, trusted string (never user data), so it goes through
// the .innerHTML binding per the arrow.js raw-HTML convention.
function icon(name, cls = 'h-3.5 w-3.5') {
  return html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="${'inline-block shrink-0 ' + cls}"
    aria-hidden="true"
    .innerHTML="${ICON_PATHS[name] || ''}"
  ></svg>`
}

// chevronFilled — the small filled 20x20 chevron dash uses at the right edge
// of every row/card and on the recent-drawer toggle.
function chevronFilled(cls) {
  return html`<svg class="${cls}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path
      fill-rule="evenodd"
      d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
      clip-rule="evenodd"
    />
  </svg>`
}

// ── helpers ────────────────────────────────────────────────────────────────

function chip(text, cls, testid, iconName) {
  return html`<span
    class="${'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ' + cls}"
    data-testid="${testid || ''}"
    >${iconName ? icon(iconName, 'h-3 w-3') : null}<span>${text}</span></span
  >`
}

// iconChip — a chip that shows ONLY the icon, no text. Used where the
// tooltip/aria-label carries the meaning instead of a label, so two chips
// distinguished only by color also stay distinguishable by shape (see
// user_colorblind.md) — `title`/`aria-label` are plain static attribute
// values (never mixed with a ${} slot, see .claude/rules/arrowjs-pitfalls.md).
function iconChip(iconName, cls, testid, title) {
  return html`<span
    class="${'inline-flex items-center justify-center rounded-full p-1 ring-1 ring-inset ' + cls}"
    data-testid="${testid || ''}"
    title="${title}"
    aria-label="${title}"
    >${icon(iconName, 'h-3 w-3')}</span
  >`
}

// ── status pills (review chip, checks chip, reviewer avatars) ──────────────

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

function reviewChip(pr, status) {
  if (pr.isDraft) return chip(t('Concept'), 'bg-slate-100 dark:bg-zinc-500/15 text-slate-500 dark:text-zinc-400 ring-slate-300/50 dark:ring-zinc-500/30', 'review-chip', 'git-pull-request')
  const d = status.reviewDecision
  if (d === 'APPROVED') return chip(t('Goedgekeurd'), 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'review-chip', 'check')
  if (d === 'CHANGES_REQUESTED')
    return chip(t('Wijzigingen gevraagd'), 'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30', 'review-chip', 'x')
  return chip(t('Wacht op review'), 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', 'review-chip', 'clock')
}

// checksChip deliberately does NOT show a count anymore — GitHub's rollup
// only gives a total + an overall state, no per-check pass/fail breakdown,
// so a number like "76 checks" read as "76 passed" while it was really just
// the total (see the checksPassed doc note in tembed-workflows.md). On
// explicit request the pill now only answers the one question that matters:
// did something fail, or did everything pass (or is it still running)? The
// word ("Gefaald"/"Geslaagd"/"Bezig") carries the meaning per the colourblind
// rule — the icon + tint are decoration on top, never the sole signal.
function checksChip(status) {
  if (!status.checksTotal) return null
  const s = status.checksState
  if (s === 'FAILURE' || s === 'ERROR')
    return chip(t('Checks gefaald'), 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/30', 'checks-chip', 'x')
  if (s === 'PENDING' || s === 'EXPECTED')
    return chip(t('Checks bezig'), 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/30', 'checks-chip', 'clock')
  if (s === 'SUCCESS')
    return chip(t('Checks geslaagd'), 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'checks-chip', 'check')
  return chip(t('Checks'), 'bg-slate-100 dark:bg-zinc-500/10 text-slate-500 dark:text-zinc-400 ring-slate-300/50 dark:ring-zinc-500/30', 'checks-chip', 'clock')
}

// conflictChip — GitHub says this PR cannot be merged as it stands
// (prStatus.mergeable === 'CONFLICTING', see inbox.go's heavyFields). The
// field was already carried all the way to the browser but never rendered, so
// a conflicting PR looked exactly like a mergeable one — GitHub's own inbox
// queries don't filter conflicts out either, so such a PR can even sit in
// "Ready to merge".
//
// Only CONFLICTING gets a chip: 'UNKNOWN' means GitHub is still computing the
// merge state (or has given up), which is deliberately shown as nothing at all
// rather than as an invented signal. The WORD carries the meaning per the
// colourblind rule; icon + tint are decoration, exactly like checksChip.
function conflictChip(status) {
  if (status.mergeable !== 'CONFLICTING') return null
  return chip(
    t('Merge-conflict'),
    'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30',
    'conflict-chip',
    'git-merge-x',
  )
}

function reviewerAvatar(r) {
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

function reviewersStrip(status) {
  const reviewers = Array.isArray(status.reviewers) ? status.reviewers : []
  if (!reviewers.length) return null
  // Approved first, then changes-requested/commented, then pending — the eye
  // lands on who still owes a review.
  const order = { APPROVED: 0, CHANGES_REQUESTED: 1, COMMENTED: 2 }
  const sorted = [...reviewers].sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3))
  return html`
    <span class="flex shrink-0 flex-wrap items-center gap-1.5" data-testid="reviewers">
      ${sorted.map((r, i) => reviewerAvatar(r).key('rev:' + i + ':' + r.login))}
    </span>
  `
}

// prUid(pr) — a row's identity ACROSS repos, and the single key every per-PR
// map/DOM attribute on this page uses: the bare number for the primary repo
// (`row.repo` absent — so every existing `data-pr="12801"` selector, nav key and
// state key is byte-identical to the single-repo build) and `<owner/name>#<n>`
// for a PR in any other configured repo. Mirrors Go's statusKey (inbox.go)
// exactly, which is why the same string works as the `?prs=` value for the
// status/approval/pending-push backfills.
function prUid(pr) {
  return pr && pr.repo ? pr.repo + '#' + pr.number : String(pr ? pr.number : '')
}

// matchesPrRef(pr, ref) — does this row answer to `ref`, a PR reference handed
// over by the review tree (?pr= / ?approved=) or held in a nav key? Accepts both
// spellings, because the two pages know different amounts about a repo: this page
// has the full "owner/name" slug from the snapshot, while /pr/<repo-name>/<n> only
// carries the bare repo NAME. A bare number always means the primary repo.
function matchesPrRef(pr, ref) {
  if (!ref) return false
  const s = String(ref)
  return prUid(pr) === s || (pr.repo ? repoLabel(pr) + '#' + pr.number === s : false)
}

// repoLabel(pr) — the short WORD shown on a row from a non-primary repo (never a
// colour on its own, per the colourblind rule): the repo's bare name without the
// owner. Empty for the primary repo, whose rows look exactly as before.
function repoLabel(pr) {
  if (!pr || !pr.repo) return ''
  const parts = String(pr.repo).split('/')
  return parts[parts.length - 1]
}

// rowRepoSlug(pr) — the "owner/name" a row's "#<number>" line is prefixed with:
// the row's own repo when it has one, otherwise the snapshot's repo (the primary
// one). Before multi-repo this was always state.repo.
function rowRepoSlug(pr) {
  return (pr && pr.repo) || state.repo || ''
}

// repoBadge(pr) — a WORD badge marking a row that is NOT from the primary repo
// ("plug-and-pay-ops"). Returned as a keyed array (never a bare element/null) so
// the presence/absence flip can't hit arrow.js's single↔array slot pitfall, and
// the meaning is carried by the word itself, never by the colour alone (Reindert
// is colourblind). The primary repo gets nothing — its rows look exactly as they
// did when there was only one repo.
function repoBadge(pr) {
  const label = repoLabel(pr)
  if (!label) return []
  return [
    html`<span
      data-testid="repo-badge"
      class="shrink-0 rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-zinc-300 ring-1 ring-slate-300/60 dark:ring-zinc-700"
      >${label}</span
    >`.key('repo:' + label),
  ]
}

// repoParam(pr) — the `&repo=<owner/name>` suffix a per-PR API call needs for a
// row outside the primary repo, and the empty string for the primary one (whose
// requests stay byte-identical to the single-repo build).
function repoParam(pr) {
  return pr && pr.repo ? '&repo=' + encodeURIComponent(pr.repo) : ''
}

// treeSupported(pr) — whether a review tree can exist for this row. The
// ingest/comment/chat pipeline is repo-aware from the storage layer up; a row
// whose repo is not configured at all (an unknown `repo` in a stored snapshot)
// has no clone to scan, so its popover only offers the GitHub actions.
function treeSupported(pr) {
  return !pr || !pr.repo || (state.repos || []).some((r) => r === pr.repo)
}

// repoReady(pr) — a SEPARATE, TEMPORARY gate on top of treeSupported: only
// the primary repo's ingest/comment/chat pipeline has actually been run
// end-to-end on a real PR. plug-and-pay-ops is already "configured"
// (state.repos lists it, so treeSupported(pr) is true for it) but the
// multi-repo work (74d9631..85d0aa8) has never pushed a real PR through the
// full pipeline for it, so its popover should offer no ingest-dependent
// action for now (generate/open tree, copy-url, Jira link, remove-reviewer)
// — except the plain "Open op GitHub" link (githubLinkAction), which needs
// no local clone/ingest at all and stays available so the reviewer always
// has at least one way to reach the PR. Deliberately generic — keyed off "is
// this row's repo non-empty", never the literal
// "plug-and-pay/plug-and-pay-ops" slug — so it also covers any future repo
// added to state.repos before ITS pipeline is proven.
//
// TEMPORARY: delete this gate (and repoUnavailableAction/its two call sites
// in popover()/openOrGenerate()) once a non-primary repo has actually been
// ingested and reviewed end-to-end for real — do not read this as permanent
// multi-repo design.
function repoReady(pr) {
  return !pr || !pr.repo
}

// statusFor resolves a PR's Status either from the async inbox-status
// backfill (state.statuses, keyed by prUid) or, for search results (whose
// Row already carries the Status fields inline per the API contract), from
// the row itself.
function statusFor(pr) {
  const live = state.statuses[prUid(pr)]
  if (live) return live
  if (pr.reviewDecision !== undefined || pr.reviewers !== undefined || pr.checksTotal !== undefined) return pr
  return null
}

// newSinceMark — appended to the "Bijgewerkt … geleden" line: only shown once
// the async status backfill (statusFor) confirms something happened on the PR
// AFTER the reviewer's OWN last comment/review (newSinceKind, from
// GET /api/inbox/status — see myLastActivity in inbox.go). Deliberately no
// "you were last" affirmative state — silence means either nothing happened
// since, or the reviewer never commented/reviewed at all; this is a
// stand-out signal, not a status readout. The two words ("comment" vs
// "review") carry the distinction, not colour (colourblind rule) — no colour
// class is used here at all.
//
// Wrapped in a static `<span class="contents">` root so the reactive toggle
// (template ↔ null) never becomes the WHOLE body of the returned template —
// see "Never key a template whose entire body is one toggling expression" in
// .claude/rules/arrowjs-pitfalls.md.
function newSinceMark(pr) {
  return html`<span class="contents">${() => {
    const status = statusFor(pr)
    const kind = status && status.newSinceKind
    if (!kind) return null
    const label = t(kind === 'review' ? 'nieuw sinds jouw review' : 'nieuw sinds jouw comment')
    return html`
      <span class="inline-flex items-center gap-2" data-testid="new-since-mark">
        <span class="text-slate-300 dark:text-zinc-700">·</span>
        <span class="font-medium text-slate-600 dark:text-zinc-400">${label}</span>
      </span>
    `
  }}</span>`
}

// A single shimmering placeholder pill, sized like a real chip so the row
// never reflows when the real status lands. A draft's review chip is already
// known from the light query, so that shows immediately instead.
function statusSkeleton(pr) {
  if (pr.isDraft) return reviewChip(pr, {})
  return html`<span
    class="inline-flex w-20 animate-pulse items-center rounded-full bg-slate-200/40 dark:bg-zinc-700/40 px-2 py-0.5 text-[11px] ring-1 ring-inset ring-slate-200/40 dark:ring-zinc-700/40"
    aria-hidden="true"
    >${' '}</span
  >`
}

function statusPills(pr, status) {
  // Always return a keyed array (never a bare template, never nulls in the
  // array): a stable slot shape keeps arrow.js from reusing a mounted chunk
  // across the skeleton→pills flip, whose statics patcher would write a nested
  // template into a Text slot — leaking the template source (`i=>je(n,i)`) as
  // literal text. The keys encode the chip variant so a status change builds
  // fresh nodes instead of patching statics. Same house pattern as the
  // "no-comments" wrap (see .claude/rules/conventions.md).
  if (!status) return [statusSkeleton(pr).key('skeleton')]
  const pills = []
  const strip = reviewersStrip(status)
  if (strip) pills.push(strip.key('reviewers'))
  const reviewVariant = pr.isDraft ? 'draft' : status.reviewDecision || 'none'
  const review = reviewChip(pr, status)
  // Stack the review chip and whatever secondary chips apply (checks, a merge
  // conflict) vertically (on explicit request) instead of side by side, so
  // they read as related lines of status rather than a run-on row of pills —
  // the reviewers-avatar strip stays a sibling, not part of the stack.
  //
  // Every branch below interpolates ONLY templates that really exist in that
  // branch — never `${maybeTemplate || ''}`, which would be a statically
  // interpolated template↔string slot and can leak the template function as
  // literal text (see .claude/rules/arrowjs-pitfalls.md). The key encodes the
  // whole composition (review variant, checks, merge state), so a status
  // change builds fresh nodes instead of patching statics.
  const checks = checksChip(status)
  const conflict = conflictChip(status)
  const stackKey =
    'review-checks:' +
    reviewVariant +
    ':' +
    (status.checksState || '') +
    ':' +
    status.checksTotal +
    ':' +
    (status.mergeable || '')
  if (checks && conflict) {
    pills.push(html`<div class="flex flex-col items-start gap-1">${review}${checks}${conflict}</div>`.key(stackKey))
  } else if (checks) {
    pills.push(html`<div class="flex flex-col items-start gap-1">${review}${checks}</div>`.key(stackKey))
  } else if (conflict) {
    pills.push(html`<div class="flex flex-col items-start gap-1">${review}${conflict}</div>`.key(stackKey))
  } else {
    pills.push(review.key('review:' + reviewVariant))
  }
  return pills
}

function statusArea(pr) {
  return html`
    <div class="flex min-h-[22px] shrink-0 items-center gap-1.5" data-testid="status-slot">
      ${() => statusPills(pr, statusFor(pr))}
    </div>
  `
}

function graphChip(pr) {
  if (pr.hasGraph) return iconChip('sparkles', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'graph-chip', t('Gegenereerd'))
  return iconChip('tree', 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', 'graph-chip', t('Op GitHub'))
}

// openOrGenerate's guard: a row whose repo has no local clone configured can
// never get a tree, so → falls back to opening it on GitHub instead of firing an
// ingest that would fail.
function openOnGithub(pr) {
  window.open(pr.url, '_blank', 'noreferrer')
}

// approvalPill — the per-PR reviewer-approval badge (done/total changed rows over
// the whole PR, from GET /api/approvalsummary via kickOffApprovals). Mirrors the
// /pr/<id> sidebar pill: hidden until total>0, green + ✓ once fully approved,
// neutral grey while still in progress. Returned as a keyed array (never a bare
// element/null) so the backfill flip from "nothing" → pill can't hit the
// arrow.js single↔array slot pitfall (see .claude/rules/conventions.md).
function approvalPill(pr) {
  const a = pr.hasGraph ? state.approvals[prUid(pr)] : null
  if (!a || !a.total) return []
  const done = a.done || 0
  const full = done >= a.total
  const cls = full
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30'
    : 'bg-slate-100 dark:bg-zinc-500/15 text-slate-500 dark:text-zinc-400 ring-slate-300/50 dark:ring-zinc-500/30'
  return [chip(done + '/' + a.total, cls, 'approval-badge', full ? 'check' : null).key('approval:' + done + '/' + a.total + ':' + full)]
}

// unpushedPill — this PR has Claude edits that landed on its branch LOCALLY but
// are not pushed to GitHub yet (state.pendingPush, from GET /api/pending-push
// via kickOffPendingPush). It belongs on the overview because that is where the
// reviewer decides what to pick up next: "this one still has something of mine
// waiting" must be visible without opening the review tree first.
//
// Word + glyph, never colour alone (the reviewer is colour-blind). Returned as a
// keyed array like approvalPill, so the async backfill's "nothing" → pill flip
// can't hit the single↔array slot pitfall (see .claude/rules/conventions.md).
function unpushedPill(pr) {
  const p = pr.hasGraph ? state.pendingPush[prUid(pr)] : null
  if (!p || !p.ahead) return []
  const label = p.state === 'failed' ? t('Push mislukt') : t('Ongepusht {n}', { n: p.ahead })
  const cls =
    p.state === 'failed'
      ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30'
      : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30'
  return [
    chip(label, cls, 'unpushed-badge', 'arrow-up').key('unpushed:' + p.ahead + ':' + (p.state || 'ready')),
  ]
}

// checkoutPill — this PR has a local checkout assigned for Claude write turns
// (state.checkout, from GET /api/chat/checkout via kickOffCheckout). Shows the
// directory's own last path segment — a colourless, neutral fact, not a
// warning like unpushedPill, so it gets its own sky tint rather than reusing
// amber/rose. Word + glyph, never colour alone, same as every other pill
// here; returned as a keyed array for the same async-backfill reason.
function checkoutPill(pr) {
  const c = pr.hasGraph ? state.checkout[prUid(pr)] : null
  if (!c || !c.dirName) return []
  return [
    chip(c.dirName, 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', 'checkout-badge', 'folder').key(
      'checkout:' + c.dirName,
    ),
  ]
}

function commentsBit(pr) {
  if (!pr.comments) return null
  return html`<span class="inline-flex items-center gap-1 text-[12px] text-slate-500 dark:text-zinc-500"
    >${icon('message', 'h-3.5 w-3.5')}${pr.comments}</span
  >`
}

// ── rows ─────────────────────────────────────────────────────────────────

// diffStatFragment — no leading separator anymore (it now sits on its own
// line, see rowMeta below, so a bullet in front of it would dangle at the
// start of that line).
function diffStatFragment(pr) {
  const add = Number(pr.additions) || 0
  const del = Number(pr.deletions) || 0
  const files = Number(pr.changedFiles) || 0
  if (!add && !del && !files) return null
  return html`
    <span class="inline-flex items-center gap-1.5 text-[11.5px]">
      <span class="font-medium text-emerald-600 dark:text-emerald-400">+${add}</span>
      <span class="font-medium text-rose-600 dark:text-rose-400">−${del}</span>
      ${files
        ? html`<span class="flex items-center gap-1"
            ><span class="text-slate-400 dark:text-zinc-600">·</span
            ><span class="text-slate-500 dark:text-zinc-500">${files} file${files === 1 ? '' : 's'}</span></span
          >`
        : null}
    </span>
  `
}

// The PR's own (current) branch — shown in the same sky color on every row so
// you can spot which branch a PR lives on at a glance. Deliberately no target
// branch here (even inside a stack): the stack indentation already conveys
// the merge order. No leading separator, same reason as diffStatFragment
// above — rowMeta inserts one between the two only when both are present.
function branchFragment(pr) {
  if (!pr.headRefName) return null
  return html`
    <span
      class="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-sky-600/90 dark:text-sky-400/90"
      title="${t('Huidige branch')}"
    >
      ${icon('git-branch', 'h-3 w-3')}<span class="truncate">${pr.headRefName}</span>
    </span>
  `
}

// rowMeta stacks in a FIXED, predictable 2-line layout — "Bijgewerkt … geleden"
// on its own line, then the diff stats + branch on the line below — instead of
// one long `flex-wrap` row that used to wrap wherever it ran out of width.
// That single wrapping row broke unpredictably per row: the middle (title +
// meta) column is `flex-1`, so its available width shrinks with however many
// review-avatar/status pills the RIGHT column happens to carry (more
// reviewers/pills => less room here) — a row with a long title and many
// reviewers could wrap its meta line one line earlier than a plainer row,
// so `+1472 −35 · 17 files · feature/TOOL-412` landed on a 3rd line while
// every other row stopped at 2, and nothing lined up between rows anymore.
// Forcing two explicit block-level lines makes the stacking identical on
// every row regardless of how much room the right-hand pills take — each
// line may still wrap internally on a very narrow viewport, but always
// starts at the same predictable vertical spot.
function rowMeta(pr) {
  const stat = diffStatFragment(pr)
  const branch = branchFragment(pr)
  return html`
    <div class="mt-0.5 text-[11.5px] text-slate-500 dark:text-zinc-500">
      <div class="flex items-center gap-2">
        <span class="font-mono">${() => rowRepoSlug(pr)}#${pr.number}</span>
        ${repoBadge(pr)}
        <span class="text-slate-300 dark:text-zinc-700">·</span>
        <span title="${pr.updatedAt || ''}">${t('Bijgewerkt {time}', { time: relativeTime(pr.updatedAt) })}</span>
        ${rowStateMark(pr)} ${newSinceMark(pr)}
      </div>
      ${stat || branch
        ? html`<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            ${stat} ${stat && branch ? html`<span class="text-slate-300 dark:text-zinc-700">·</span>` : null} ${branch}
          </div>`
        : null}
    </div>
  `
}

// rowStateMark — "Gesloten" / "Samengevoegd" on a PR that is no longer open.
// Only a search result can be non-open (the inbox sections and the presets are
// all state-scoped, and `state` is omitted from those rows entirely), and the
// search view has no headings left to group by — so this word IS the only thing
// that tells a closed hit apart from an open one. Hence a WORD plus a glyph,
// never the tint alone (the reviewer is colourblind); the slate tint is
// decoration.
//
// A row with no `state` field at all (every inbox row, every pre-existing
// fixture/snapshot) renders nothing, exactly as before.
const ROW_STATE_LABELS = { MERGED: 'Samengevoegd', CLOSED: 'Gesloten' }

// Same static `<span class="contents">` + `${() => …}` shape as newSinceMark
// right below: rowMeta is ONE template shape shared by every row, and only
// some rows carry a mark, so a statically interpolated template<->null slot
// would eventually render the template FUNCTION as text in a reused chunk
// (see "A statically interpolated template↔string slot leaks the template
// function as text" in .claude/rules/arrowjs-pitfalls.md). The closure reads
// only the plain, non-reactive `pr.state`, so it registers no dependency.
function rowStateMark(pr) {
  return html`<span class="contents">${() => {
    const label = ROW_STATE_LABELS[pr.state]
    if (!label) return null
    return html`
      <span
        data-testid="row-state-mark"
        class="shrink-0 rounded-full bg-slate-200/70 dark:bg-zinc-800 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:text-zinc-300"
        title="${t('Deze PR is niet meer open')}"
        >${pr.state === 'MERGED' ? '⤵' : '✕'} ${t(label)}</span
      >
    `
  }}</span>`
}

// authorMark — who wrote this PR, at the head of the row: the avatar with the
// first name right under it. It replaces the git-pull-request glyph that used to
// sit here; that glyph only distinguished draft from open by COLOUR (grey vs
// green), which carries no meaning for a colourblind reviewer — draft is still
// spelled out in words by statusArea's own "Concept" chip and by the "Your
// drafts" section heading, so nothing is lost by dropping it.
//
// The name comes from ensureNames (see avatar.mjs) and falls back to the bare
// login when GitHub/names.json know no real name; the title always carries the
// full name plus the login, so the account behind a first name stays findable.
// The avatar was 2x the original size (h-6 -> h-12) to make the author more
// prominent at the left edge of the row; the wrapper width grew along
// (w-14 -> w-20). On a later request the avatar shrank slightly again
// (h-12 -> h-10) and the name below it grew bolder/bigger
// (text-[10.5px] -> text-[12px] font-semibold, slate-500 -> slate-700 /
// zinc-500 -> zinc-300 for contrast) so the first name reads as prominent
// as the avatar itself.
function authorMark(pr) {
  const login = pr.author || ''
  const full = fullNameOf(login)
  const title = full ? full + ' (' + login + ')' : login
  return html`
    <span class="flex w-20 shrink-0 flex-col items-center gap-1" data-testid="row-author" data-author="${login}" title="${title}">
      ${avatarHTML(full || login, avatarUrlOf(login), 'h-10 w-10')}
      <span class="max-w-full truncate text-[12px] font-semibold leading-none text-slate-700 dark:text-zinc-300">${displayNameOf(login)}</span>
    </span>
  `
}

// sectionBadge — inside a stack we lift PRs out of their normal buckets, so a
// small badge reminds you which section each one would otherwise sit in.
function sectionBadge(label) {
  return html`<span
    class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:text-zinc-400"
    title="${t('Hoort normaal in deze sectie')}"
    >${label}</span
  >`
}

// connectorMark — the little └ that links a stacked row to the one above it.
function connectorMark() {
  return html`<span class="-ml-4 shrink-0 select-none font-mono text-[13px] leading-none text-slate-400 dark:text-zinc-600" aria-hidden="true"
    >└</span
  >`
}

function rowInner(pr, opts) {
  return [
    opts.depth ? connectorMark() : null,
    authorMark(pr),
    html`
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="truncate text-[13.5px] font-semibold text-slate-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white">${pr.title}</h3>
          ${opts.badge ? sectionBadge(opts.badge) : null}
        </div>
        ${rowMeta(pr)}
      </div>
    `,
    html`
      <div class="flex shrink-0 items-center gap-3">
        ${statusArea(pr)}
        <div class="flex flex-col items-end gap-1">
          ${() => checkoutPill(pr)} ${() => unpushedPill(pr)} ${() => approvalPill(pr)}
        </div>
        ${commentsBit(pr)} ${() => graphChip(pr)} ${chevronFilled('h-4 w-4 text-slate-400 dark:text-zinc-600 group-hover:text-slate-600 dark:group-hover:text-zinc-300')}
      </div>
    `,
  ]
}

// togglePopover opens/closes a row's popover, clearing any stale ingest error
// from a previous row so it never bleeds into a different PR's menu. Opening
// a popover hands it real keyboard ownership (see the "popover keyboard
// navigation" section near the list keydown handler below): the first
// actionable item gets focus once arrow.js has painted the menu, so ↑/↓
// immediately cycle through it instead of the underlying row list.
function togglePopover(uid) {
  const opening = ui.openPopover !== uid
  ui.openPopover = opening ? uid : null
  ui.ingestError = null
  ui.ingestErrorFor = null
  ui.popoverAbove = false
  // Collapse any ready-for-review picker from a previous row so it never bleeds
  // into a different PR's menu.
  ui.readyFor = null
  ui.reviewersError = null
  ui.removeReviewerError = null
  // Default focus lands on the 2nd item (the first real action) — the pinned
  // "Sluit menu" item (see popover() below) always sits first so a stray
  // Enter never merely closes the menu; focusPopoverItem clamps, so a
  // popover with only that one item still focuses it.
  if (opening) {
    // Claim the keyboard selection ring for the row being opened, exactly
    // like `Enter` already gets it for free (Enter runs `move`/`moveTo`
    // before `activateSelected()` clicks the row). Without this a MOUSE
    // click never painted the ring at all, so a mouse-driven "Genereer
    // review-boom" gave no visible "this is the row I'm working on" cue
    // during/after the async ingest (reviewer request: "laat item tijdens
    // en na genereren geselecteerd"). Nothing else needs to change to keep
    // it released "as soon as I want to do something else" — hovering a
    // different row, clicking a different row (this same branch moves the
    // ring there), a keyboard step, or focusing the search box already
    // reassign/clear `selKey` (see reanchorSelection/paintSelection below).
    selKey = 'row:' + uid
    hoverEnabled = false
    paintSelection()
    requestAnimationFrame(() => {
      positionPopover(uid)
      focusPopoverItem(1)
    })
    // A page refresh (or a fresh load landing on this PR) wipes
    // ui.ingestingByPr/ingestStageByPr — plain module state, not persisted
    // anywhere client-side —
    // even though the ingest itself may still be running server-side. Check
    // for that on every open so a reopened popover shows the real live state
    // instead of silently going back to "Genereer review-boom". See
    // resumeIngestIfActive below.
    resumeIngestIfActive(findPrByUid(uid))
  }
}

// positionPopover measures the just-mounted popover of row `number` (it's
// still rendered top-full/below the row at this point, see popoverPanelCls
// below) against the viewport: if it would run off the bottom of the screen,
// ui.popoverAbove flips it to render above the row instead. This is a plain,
// one-shot measurement at open time (no resize/scroll listener like
// home.mjs's positionMenu) — a row's own position on this page doesn't move
// while its popover is open, unlike the always-fixed command palette.
function positionPopover(uid) {
  const row = document.querySelector('[data-testid="pr-row"][data-pr="' + uid + '"]')
  const pop = row && row.querySelector('[data-testid="pr-popover"]')
  if (!row || !pop) return
  const rowRect = row.getBoundingClientRect()
  const popRect = pop.getBoundingClientRect()
  const fitsBelow = rowRect.bottom + popRect.height <= window.innerHeight
  ui.popoverAbove = !fitsBelow
}

// generatePage runs the existing ingest workflow endpoint (the sanctioned
// write path per .claude/rules/workflows-write-boundary.md — this starts a
// Workflow Execution, it never writes to a module directly). handleIngest
// (api.go) only answers 200 once the ingest pipeline AND the build_relations
// workflow have run synchronously, so a plain full-page redirect on success
// is safe for a *non-ingested* row: the fresh /pr/<id> load has everything it
// needs. On failure the popover stays open and surfaces the error inline
// (generateAction/ingestedActions below); the row itself is untouched, so a
// retry or a page refresh reflects the real state.
//
// `redirect` defaults to true, which is now used by exactly ONE caller:
// openOrGenerate (the → key, "act now") — a keystroke that explicitly means
// "take me into the tree". Both popover BUTTONS pass `redirect: false`:
// ingestedActions' "Opnieuw genereren" (an already-ingested row's regenerate
// only refreshes the existing tree's data in the background) and, since
// Reindert's explicit request, generateAction's "Genereer review-boom" too —
// clicking that button means "build it, but let me carry on in the overview",
// not "navigate me away". After such a non-redirecting run the popover stays
// open and focus moves to its pinned "Sluit menu" item (see
// focusCloseAfterGenerate below) so Enter/Escape immediately closes the menu
// instead of re-triggering the generate button the reviewer just used.
//
// The row itself keeps showing "Op GitHub" until the next inbox refresh/poll
// catches up with the freshly ingested PR — deliberately no extra
// reloadSnapshot() here, which would repaint the popover out from under that
// focus.
//
// While the POST is in flight, generatePage polls GET /api/ingest/progress —
// a purely in-memory, ephemeral read of which pipeline stage the server is
// currently running for this PR (see ingest_progress.go) — into
// ui.ingestStageByPr[prUid], so the busy button shows real progress instead of
// a static "Bezig met genereren…" (see INGEST_STAGE_LABELS +
// generateAction/ingestedActions below).
//
// ingestPollTimers is keyed per PR (prUid -> interval id), NOT a single shared
// timer: several rows can be mid-ingest at once (Reindert: "meerdere trees
// kunnen genereren door meerdere achter elkaar aan te klikken"), and a single
// shared timer would have one row's stopIngestPoll() kill another row's poll.
const ingestPollTimers = new Map()

function stopIngestPoll(uid) {
  const timer = ingestPollTimers.get(uid)
  if (timer) {
    clearInterval(timer)
    ingestPollTimers.delete(uid)
  }
}

async function pollIngestStage(pr) {
  const uid = prUid(pr)
  try {
    const res = await fetch('/api/ingest/progress?pr=' + pr.number + repoParam(pr))
    if (!res.ok) return
    const body = await res.json()
    // Drop a stale response if this PR's ingest is no longer active — mirrors
    // the ingestErrorFor guard below.
    if (ui.ingestingByPr[uid] && body && body.ok) ui.ingestStageByPr[uid] = body.stage || ''
  } catch (e) {
    // best-effort — the button just keeps its last-known/generic label
  }
}

async function generatePage(pr, { redirect = true } = {}) {
  const uid = prUid(pr)
  if (ui.ingestingByPr[uid]) return // this row is already busy; button is disabled anyway
  ui.ingestingByPr[uid] = true
  ui.ingestStageByPr[uid] = ''
  ui.ingestError = null
  ui.ingestErrorFor = null
  stopIngestPoll(uid)
  pollIngestStage(pr)
  ingestPollTimers.set(uid, setInterval(() => pollIngestStage(pr), 800))
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: pr.number, repo: pr.repo || undefined }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error((body && body.error) || t('Genereren mislukt ({status})', { status: res.status }))
    }
    if (redirect) {
      location.href = treeUrl(pr)
    } else {
      // No reloadSnapshot() here (see the comment above) — but the reviewer
      // still needs visible proof the generate succeeded, so flip this row's
      // own hasGraph locally: the reactive graphChip/popover-action bindings
      // above pick this straight up (chip -> "Gegenereerd", popover ->
      // "Open review-boom"/"Opnieuw genereren") without waiting for the next
      // refresh/60s poll.
      pr.hasGraph = true
      ui.ingestingByPr[uid] = false
      focusCloseAfterGenerate(pr)
    }
  } catch (e) {
    ui.ingestingByPr[uid] = false
    ui.ingestError = t(e.message) || t('Genereren mislukt')
    ui.ingestErrorFor = uid
  } finally {
    stopIngestPoll(uid)
    ui.ingestStageByPr[uid] = ''
  }
}

// resumeIngestIfActive — a page refresh (or a fresh page load) can land while
// an ingest this tab never started, or a previous /api/ingest fetch this tab
// DID start, is still running: ui.ingestingByPr/ingestStageByPr are plain
// module state and both are gone after a reload, but the ingest Workflow
// Execution itself is not — StartWorkflow (workflows.go) takes no request
// context, so it keeps running server-side to completion regardless of
// whether the browser tab/request that triggered it is still around. Called on
// every popover open (togglePopover above); a cheap read-only ping (see
// ingest_progress.go's write-boundary carve-out), skipped outright if this tab
// already tracks an ingest of THIS PR (another PR being busy never blocks
// this). Reviewer request: "als ik het menu weer open [na het sluiten], wil
// ik weer het laad icoontje zien en zien als het is gegenereerd (live status)
// — ook als je de pagina refresht."
async function resumeIngestIfActive(pr) {
  if (!pr || !treeSupported(pr)) return
  const uid = prUid(pr)
  if (ui.ingestingByPr[uid]) return
  try {
    const res = await fetch('/api/ingest/progress?pr=' + pr.number + repoParam(pr))
    if (!res.ok) return
    const body = await res.json()
    // The popover may already have closed again, or a fresh local generate
    // may have started meanwhile, while this request was in flight.
    if (!body || !body.ok || !body.stage || ui.openPopover !== uid || ui.ingestingByPr[uid]) return
    ui.ingestingByPr[uid] = true
    ui.ingestStageByPr[uid] = body.stage
    watchResumedIngest(pr)
  } catch (e) {
    // best-effort — the popover just stays on its idle action
  }
}

// watchResumedIngest polls the same GET /api/ingest/progress used by
// generatePage's own busy button (reusing ingestPollTimers/stopIngestPoll, per
// PR) until the stage clears — the Workflow Execution finished, success or
// failure. Unlike generatePage, this tab never awaited the original POST
// /api/ingest response, so success is confirmed the only other way
// available: whether the PR now actually has blocks (GET /api/prs). A
// resumed "Opnieuw genereren" that fails is indistinguishable from one that
// succeeds this way, since the PR already had a graph before it started —
// accepted: without the original response there is no failure message to
// show either way, and the tree itself is the ground truth a reviewer can
// always check.
function watchResumedIngest(pr) {
  const uid = prUid(pr)
  stopIngestPoll(uid)
  ingestPollTimers.set(
    uid,
    setInterval(async () => {
      if (!ui.ingestingByPr[uid]) {
        stopIngestPoll(uid)
        return
      }
      try {
        const res = await fetch('/api/ingest/progress?pr=' + pr.number + repoParam(pr))
        if (!res.ok) return
        const body = await res.json()
        if (!ui.ingestingByPr[uid]) return
        if (body && body.ok && body.stage) {
          ui.ingestStageByPr[uid] = body.stage
          return
        }
        stopIngestPoll(uid)
        const nowIngested = await isNowIngested(pr)
        if (ui.ingestingByPr[uid]) {
          ui.ingestingByPr[uid] = false
          ui.ingestStageByPr[uid] = ''
          if (nowIngested) pr.hasGraph = true
        }
      } catch (e) {
        // best-effort — keep polling on a transient network hiccup
      }
    }, 800),
  )
}

// isNowIngested — a lightweight "does this PR have blocks now" check via the
// existing GET /api/prs (recent-ingested list), for watchResumedIngest above.
async function isNowIngested(pr) {
  try {
    const res = await fetch('/api/prs')
    if (!res.ok) return false
    const list = await res.json()
    return Array.isArray(list) && list.some((p) => p.pr === pr.number && (p.repo || '') === (pr.repo || ''))
  } catch (e) {
    return false
  }
}

// focusCloseAfterGenerate parks keyboard focus on the popover's pinned "Sluit
// menu" item (index 0, see popover()) after a non-redirecting generate run, so
// the reviewer can close the menu with Enter/Space right away and carry on in
// the overview. Guarded on the popover still being the SAME row's (the run is
// async — the reviewer may have closed it or opened another row meanwhile) and
// deferred one frame, like togglePopover's own focusPopoverItem(1), because the
// button we just re-enabled only reappears in popoverItems() after arrow.js has
// repainted it.
function focusCloseAfterGenerate(pr) {
  if (ui.openPopover !== prUid(pr)) return
  requestAnimationFrame(() => {
    if (ui.openPopover !== prUid(pr)) return
    focusPopoverItem(0)
  })
}

// ingestBusy(pr) / ingestLabel(pr, idleLabel) / ingestIcon(pr) are read from
// their own nested ${() => …} bindings (not a plain `busy` value captured once
// when the popover opens) so they actually react to
// ui.ingestingByPr/ingestStageByPr changing while the popover stays open — the
// same arrow.js pitfall documented in .claude/rules/conventions.md ("een
// geneste ${() => canStep(...)}-binding"): a plain-JS ternary computed inside
// the outer, only-occasionally-rerun ${() => popover(pr)} slot never updates
// once busy flips mid-render. Each PR has its own entry (prUid-keyed), so
// several rows can show their own independent busy state at once.
function ingestBusy(pr) {
  return !!ui.ingestingByPr[prUid(pr)]
}

function ingestLabel(pr, idleLabel) {
  return ingestBusy(pr) ? t(INGEST_STAGE_LABELS[ui.ingestStageByPr[prUid(pr)]] || 'Bezig met genereren…') : t(idleLabel)
}

// The idle glyph is the TREE, not the sparkles: this row BUILDS the review
// tree ("Genereer review-boom"/"Opnieuw genereren"), so it should show the
// thing it produces — the same glyph graphChip already uses for a PR that has
// no tree yet. `sparkles` stays the "there IS a tree" glyph (graphChip's
// hasGraph branch, and the "Open review-boom" row right above this one), so
// the two icons now read as build-it vs. it-exists instead of both meaning
// "ingest".
function ingestIcon(pr) {
  return ingestBusy(pr) ? icon('loader', 'h-3.5 w-3.5 animate-spin') : icon('tree', 'h-3.5 w-3.5')
}

// Shared Tailwind building blocks for every popover row/link (close button,
// generate/ingested actions, GitHub/Jira links, ready-for-review controls
// below) — mirrors CommandMenu.mjs's commandRow: the same row shape
// (rounded-md, text-sm, py-2) and the same indigo focus-highlight commandRow
// shows for its reactively-selected row (menu.sel). This popover keeps its
// own, independent focus-based keyboard model (handlePopoverKey/movePopover/
// focusPopoverItem, see below) — only the Tailwind classes are shared here,
// so ↑/↓ moving real DOM focus lights up the identical indigo highlight
// without any new reactive state. Composed into one string per row before it
// reaches the template — an attribute value with ANY ${...} interpolation
// must be the whole value, never mixed literal+dynamic text (the arrow.js
// pitfall in .claude/rules/conventions.md).
const POPOVER_ROW_SHAPE = 'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm'
const POPOVER_FOCUS_CLS =
  'focus:outline-none focus:bg-indigo-50 dark:focus:bg-indigo-500/15 focus:text-indigo-700 dark:focus:text-indigo-300 ' +
  'focus:ring-1 focus:ring-indigo-200 dark:focus:ring-indigo-500/30'

// popoverRowCls — the common case: default row text color + hover tint, plus
// any per-row extra classes (disabled/opacity state, …).
function popoverRowCls(extra = '') {
  return (
    POPOVER_ROW_SHAPE +
    ' text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800/60 ' +
    POPOVER_FOCUS_CLS +
    (extra ? ' ' + extra : '')
  )
}

// generateAction — the not-yet-ingested case: "Genereer review-boom" runs the
// ingest workflow (generatePage above) WITHOUT redirecting: on success the
// reviewer stays in the overview with the popover open and focus on "Sluit
// menu". Only the → key (openOrGenerate) still lands you in the fresh tree.
function generateAction(pr) {
  return html`
    <button
      type="button"
      data-testid="generate-page"
      disabled="${() => ingestBusy(pr)}"
      class="${() => popoverRowCls(ingestBusy(pr) ? 'cursor-not-allowed opacity-60' : '')}"
      @click="${() => generatePage(pr, { redirect: false })}"
    >
      ${() => ingestIcon(pr)} ${() => ingestLabel(pr, 'Genereer review-boom')}
    </button>
    ${() =>
      ui.ingestError
        ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400 [overflow-wrap:anywhere]" data-testid="generate-error">${ui.ingestError}</p>`
        : ''}
  `
}

// ingestedActions — the already-ingested case: "Open review-boom" navigates
// straight into the existing tree; "Opnieuw genereren" reruns the ingest
// workflow in the background (redirect: false — the reviewer stays on the
// overview, mirrors the old standalone regenerateButton behaviour).
function ingestedActions(pr) {
  return html`
    <button
      type="button"
      data-testid="open-tree"
      class="${popoverRowCls()}"
      @click="${() => (location.href = treeUrl(pr))}"
    >
      ${icon('sparkles', 'h-3.5 w-3.5')} ${t('Open review-boom')}
    </button>
    <button
      type="button"
      data-testid="regenerate-page"
      disabled="${() => ingestBusy(pr)}"
      class="${() => popoverRowCls(ingestBusy(pr) ? 'cursor-not-allowed opacity-60' : '')}"
      @click="${() => generatePage(pr, { redirect: false })}"
    >
      ${() => ingestIcon(pr)} ${() => ingestLabel(pr, 'Opnieuw genereren')}
    </button>
    ${() =>
      ui.ingestError
        ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400 [overflow-wrap:anywhere]" data-testid="regenerate-error">${ui.ingestError}</p>`
        : ''}
  `
}

// copyGithubUrl copies a PR's GitHub URL to the clipboard and flashes brief
// feedback in the popover. Best-effort — clipboard access can be denied.
async function copyGithubUrl(pr) {
  try {
    await navigator.clipboard.writeText(pr.url || '')
    ui.copiedFor = prUid(pr)
    setTimeout(() => {
      if (ui.copiedFor === prUid(pr)) ui.copiedFor = null
    }, 1500)
  } catch (e) {
    // ignore — no clipboard permission
  }
}

// ── remove myself as a reviewer ────────────────────────────────────────────

// canRemoveSelf answers whether this row may offer "Verwijder mij als reviewer":
// only on a PR somebody ELSE opened — taking yourself off your own PR makes no
// sense. An unknown local login (offline, SLASH_GITHUB=off, /api/me answering
// {ok:false}) hides the item: without knowing who I am, "not my PR" cannot be
// established. `me` is primed by ensureMe in primeAuthorNames, i.e. long before
// a popover can be opened by hand.
function canRemoveSelf(pr) {
  const me = meLogin()
  return !!me && !!pr.author && pr.author !== me
}

// removedPrs — the PRs this tab took itself off as a reviewer, hidden from every
// section from that moment on (see isHiddenPr, the same mechanism `approvedPr`
// uses). Deliberately never emptied: /api/inbox keeps serving the pr_inbox
// read-model, which needs a background refresh — and GitHub itself a moment —
// before it agrees, so a cleared entry would make the row pop back on the very
// next reloadSnapshot or 60s poll.
const removedPrs = new Set()

// removeSelfAsReviewer starts the remove_reviewer workflow (the sanctioned write
// path — it starts a Workflow Execution, never a direct module write). The POST
// carries only the PR number: who gets removed is resolved server-side from the
// authenticated GitHub user.
//
// On success the row leaves the list IMMEDIATELY — hidden via removedPrs and
// filtered out of state.sections right here, without waiting for the /api/inbox
// round trip that would still list it — and the selection moves to the top row
// of the overview, exactly like the just-approved round trip
// (trySelectTopAfterApprove/selectTopRow). The repaint is explicit because the
// nav watch keys on state.sections.LENGTH, which a row leaving a section doesn't
// change. reloadSnapshot still runs afterwards to pull everything else in.
async function removeSelfAsReviewer(pr) {
  if (ui.removingReviewer) return // one at a time; the button is disabled anyway
  ui.removingReviewer = prUid(pr)
  ui.removeReviewerError = null
  try {
    const res = await fetch('/api/workflows/remove_reviewer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: pr.number, repo: pr.repo || undefined }),
    })
    if (!res.ok) throw new Error('remove_reviewer failed')
    closePopover()
    removedPrs.add(prUid(pr))
    state.sections = state.sections.map((s) => ({ ...s, prs: s.prs.filter((row) => prUid(row) !== prUid(pr)) }))
    selectTopRow()
    scheduleRepaint()
    reloadSnapshot()
  } catch (e) {
    ui.removeReviewerError = t('Verwijderen mislukt')
  } finally {
    ui.removingReviewer = null
  }
}

// removeReviewerAction — the popover's last item on a PR I didn't open. Rendered
// through a ${() => …} function binding by its caller (never a static
// template↔'' slot, see .claude/rules/arrowjs-pitfalls.md). The rose tint is
// decoration only: the WORD carries the meaning (colorblind rule).
function removeReviewerAction(pr) {
  return html`
    <div class="contents">
      <button
        type="button"
        data-testid="remove-reviewer"
        disabled="${() => ui.removingReviewer === prUid(pr)}"
        class="${() =>
          POPOVER_ROW_SHAPE +
          ' text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/15 ' +
          POPOVER_FOCUS_CLS +
          (ui.removingReviewer === prUid(pr) ? ' cursor-not-allowed opacity-60' : '')}"
        @click="${() => removeSelfAsReviewer(pr)}"
      >
        ${() => (ui.removingReviewer === prUid(pr) ? icon('loader', 'h-3.5 w-3.5 animate-spin') : icon('user-minus', 'h-3.5 w-3.5'))}
        ${() => t(ui.removingReviewer === prUid(pr) ? 'Bezig…' : 'Verwijder mij als reviewer')}
      </button>
      ${() =>
        ui.removeReviewerError
          ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400 [overflow-wrap:anywhere]" data-testid="remove-reviewer-error">${ui.removeReviewerError}</p>`
          : ''}
    </div>
  `
}

// ── preset filters (live gh-search for a fixed, allow-listed query) ─────────

let presetSeq = 0

async function runPreset(key) {
  const seq = ++presetSeq
  state.activePreset = key
  state.filterOpen = false
  state.presetLoading = true
  try {
    const res = await fetch('/api/prs/filter?preset=' + encodeURIComponent(key))
    if (!res.ok) {
      if (seq === presetSeq) state.presetResults = []
      return
    }
    const body = await res.json()
    if (seq !== presetSeq) return
    const rows = body && body.ok && Array.isArray(body.prs) ? body.prs : []
    await primeAuthorNames(rows) // real names before the rows mount (see avatar.mjs)
    if (seq !== presetSeq) return
    state.presetResults = rows
  } catch (e) {
    if (seq === presetSeq) state.presetResults = []
  } finally {
    if (seq === presetSeq) state.presetLoading = false
  }
}

// clearPresetView returns from a preset view back to the main inbox.
function clearPresetView() {
  state.activePreset = null
  state.presetResults = []
}

// ── ready for review (flip a draft PR to ready + request reviewers) ────────

// openReadyPicker expands the reviewer picker for a draft PR and fetches the
// candidate reviewers (repo collaborators, most-used-first — see
// GET /api/reviewers). Read-only; the actual write happens in submitReady.
async function openReadyPicker(pr) {
  ui.readyFor = prUid(pr)
  ui.selectedReviewers = {}
  ui.reviewersError = null
  ui.reviewersLoading = true
  try {
    const res = await fetch('/api/reviewers')
    const body = await res.json()
    ui.reviewers = (body && body.reviewers) || []
  } catch (e) {
    ui.reviewersError = t('Kon reviewers niet laden')
    ui.reviewers = []
  } finally {
    ui.reviewersLoading = false
  }
}

// toggleReviewer flips a reviewer login in/out of the selection (reassigned
// wholesale so arrow.js re-renders the checkmarks).
function toggleReviewer(login) {
  const next = { ...ui.selectedReviewers }
  if (next[login]) delete next[login]
  else next[login] = true
  ui.selectedReviewers = next
}

// submitReady starts the ready_for_review workflow (the sanctioned write path —
// starts a Workflow Execution, never a direct module write): it flips the draft
// PR to ready and requests the checked reviewers (bumping their local usage
// count for next time). On success it closes the popover and refreshes the
// inbox snapshot so the row leaves "Your drafts" without waiting for the 60s poll.
async function submitReady(pr) {
  const reviewers = Object.keys(ui.selectedReviewers)
  ui.readySubmitting = true
  ui.reviewersError = null
  try {
    const res = await fetch('/api/workflows/ready_for_review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: pr.number, repo: pr.repo || undefined, reviewers }),
    })
    if (!res.ok) throw new Error('ready_for_review failed')
    closePopover()
    reloadSnapshot()
  } catch (e) {
    ui.reviewersError = t('Omzetten mislukt')
  } finally {
    ui.readySubmitting = false
  }
}

// readyForReviewSection is the draft-only part of the popover: a "Klaar voor
// review" button that expands an inline reviewer checklist (most-used-first)
// plus a confirm button. All controls are plain <button>s so handlePopoverKey
// cycles them like every other item. Returned as a keyed array-of-one per
// branch (stable slot shape) to avoid the arrow.js single↔array pitfall.
function readyForReviewSection(pr) {
  return html`<div class="mt-1 border-t border-slate-100 dark:border-zinc-700 pt-1" data-testid="ready-section">
    ${() => {
      if (ui.readyFor !== prUid(pr)) {
        return [
          html`<button
            type="button"
            data-testid="ready-for-review"
            class="${popoverRowCls()}"
            @click="${() => openReadyPicker(pr)}"
          >
            ${icon('git-pull-request', 'h-3.5 w-3.5')} ${t('Klaar voor review')}
          </button>`.key('ready-open'),
        ]
      }
      return [
        html`<div data-testid="ready-picker">
          <p class="px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400 dark:text-zinc-500">${t('Kies reviewers')}</p>
          ${() => (ui.reviewersLoading ? html`<p class="px-2.5 py-1 text-[11px] text-slate-500 dark:text-zinc-400">${t('Laden…')}</p>` : '')}
          ${() => (ui.reviewersError ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400" data-testid="ready-error">${ui.reviewersError}</p>` : '')}
          <div class="max-h-48 overflow-auto">
            ${() =>
              ui.reviewers.map(
                (rv) =>
                  html`<button
                    type="button"
                    data-testid="${'reviewer-' + rv.login}"
                    class="${() =>
                      POPOVER_ROW_SHAPE +
                      ' hover:bg-slate-50 dark:hover:bg-zinc-800/60 ' +
                      POPOVER_FOCUS_CLS +
                      ' ' +
                      (ui.selectedReviewers[rv.login] ? 'text-slate-900 dark:text-zinc-50' : 'text-slate-600 dark:text-zinc-300')}"
                    @click="${() => toggleReviewer(rv.login)}"
                  >
                    <span class="inline-flex h-3.5 w-3.5 items-center justify-center">${() => (ui.selectedReviewers[rv.login] ? icon('check', 'h-3.5 w-3.5') : '')}</span>
                    <span class="flex-1 truncate">${rv.login}</span>
                    ${rv.count > 0 ? html`<span class="text-[10px] text-slate-400 dark:text-zinc-500">${rv.count}×</span>` : ''}
                  </button>`.key('rv:' + rv.login),
              )}
          </div>
          <button
            type="button"
            data-testid="ready-confirm"
            disabled="${() => ui.readySubmitting}"
            class="${() =>
              'mt-1 ' +
              POPOVER_ROW_SHAPE +
              ' font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/15 ' +
              POPOVER_FOCUS_CLS +
              ' ' +
              (ui.readySubmitting ? 'cursor-not-allowed opacity-60' : '')}"
            @click="${() => submitReady(pr)}"
          >
            ${icon('check', 'h-3.5 w-3.5')} ${() => t(ui.readySubmitting ? 'Bezig…' : 'Zet om naar review')}
          </button>
        </div>`.key('ready-picker'),
      ]
    }}
  </div>`
}

// popover — every row (ingested or not) opens this same menu on a click: a
// pinned "Sluit menu" first (mirrors the CommandMenu's own withClose pattern
// in home.mjs — closes via closePopover, but togglePopover deliberately
// default-focuses the 2nd item on open, see focusPopoverItem(1) there, so a
// stray Enter never merely closes the menu), then the ingest-related
// action(s) (which action depends on pr.hasGraph, see generateAction/
// ingestedActions above), then a plain link to GitHub, plus a Jira link when
// the title carries a KEY-123-style ticket key, and finally "Verwijder mij als
// reviewer" on a PR somebody else opened (canRemoveSelf/removeReviewerAction).
// That last item and the draft-only ready-for-review section below it are
// mutually exclusive in practice — a draft is your own PR — so their order
// never actually shows. The panel gets a solid (white
// in light mode) background plus a strong shadow + ring: it necessarily
// overlaps the status pills of the row below, and with a near-page-background
// tint that overlap read as the pill's text being cut off instead of a
// floating menu covering it. It normally opens below the row (`top-full`) but
// flips above it (`bottom-full`, see popoverPanelCls/positionPopover) when the
// row sits close enough to the bottom of the viewport that opening downward
// would run the popover off-screen — a real, reproducible case now that rows
// are taller (the 2x avatar, see authorMark), not just a short "Ready to
// merge" section on a short viewport in the test suite.
//
// Visually this now deliberately mirrors CommandMenu.mjs's palette (rounded-xl,
// an indigo border/ring instead of a neutral one, text-sm/py-2 rows, the same
// indigo focus-highlight) — see .claude/docs/pages-and-routing.md. That's a
// shared LOOK only: this popover keeps its own, independent, focus-based
// keyboard model (handlePopoverKey/movePopover/focusPopoverItem below) — no
// CommandMenu component reuse, no search field, no submenu mechanism, no
// shared `menu`/`ms` state. "Sluit menu" is no longer dimmed — it's a plain
// row with a grey hint badge on the right ("esc"), the same shape commandRow
// gives its own pinned "Sluit menu" item (withClose, home.mjs).
// popoverPanelCls — a whole-value reactive class binding (the arrow.js
// "entire attribute value" rule) so a flip of ui.popoverAbove (see
// positionPopover above) re-renders the panel's own vertical anchor without
// touching anything else about it.
function popoverPanelCls() {
  return (
    'absolute right-0 z-20 w-64 rounded-xl border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-zinc-900 p-1 shadow-2xl ring-1 ring-indigo-500/20 ' +
    (ui.popoverAbove ? 'bottom-full mb-1' : 'top-full mt-1')
  )
}

function popover(pr) {
  const m = (pr.title || '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
  return html`
    <div
      class="${() => popoverPanelCls()}"
      data-testid="pr-popover"
      @click="${(e) => e.stopPropagation()}"
    >
      <button
        type="button"
        data-testid="close-popover"
        class="${popoverRowCls()}"
        @click="${(e) => {
          // Stop propagation FIRST, before closePopover() removes the
          // popover from the DOM (and thus its own stopPropagation
          // listener) — otherwise bubbling continues past the
          // now-detached wrapper straight to the row's own
          // togglePopover(), which immediately reopens the very popover
          // this button just closed. See the popover() doc comment.
          e.stopPropagation()
          closePopover()
        }}"
      >
        ${icon('x', 'h-3.5 w-3.5')}<span class="flex-1 truncate">${t('Sluit menu')}</span
        ><span class="shrink-0 rounded bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 dark:text-zinc-500"
          >esc</span
        >
      </button>
      ${repoReady(pr)
        ? html`<div class="contents">
            ${() => (treeSupported(pr) ? (pr.hasGraph ? ingestedActions(pr) : generateAction(pr)) : '')}
            ${githubLinkAction(pr)}
            <button type="button" data-testid="copy-url" class="${popoverRowCls()}" @click="${() => copyGithubUrl(pr)}">
              ${() => (ui.copiedFor === prUid(pr) ? icon('check', 'h-3.5 w-3.5') : icon('copy', 'h-3.5 w-3.5'))}
              ${() => t(ui.copiedFor === prUid(pr) ? 'Gekopieerd!' : 'Kopieer GitHub URL')}
            </button>
            ${() =>
              m
                ? html`<a href="${JIRA_BASE + m[1]}" target="_blank" rel="noreferrer" class="${popoverRowCls()}">
                    ${icon('external-link', 'h-3.5 w-3.5')} ${t('Open Jira-ticket')}
                  </a>`
                : ''}
            ${() => (canRemoveSelf(pr) ? removeReviewerAction(pr) : '')}
            ${() => (pr.isDraft ? [readyForReviewSection(pr).key('ready-section')] : [])}
          </div>`
        : html`<div class="contents">${githubLinkAction(pr)} ${repoUnavailableAction()}</div>`}
    </div>
  `
}

// githubLinkAction — the plain "open this PR on github.com" link. Shared by
// both branches of popover() above: pr.url comes straight off the stored
// snapshot/API row and needs no local clone/ingest to resolve, so it stays
// available even when repoReady(pr) is false and every ingest-dependent
// action (generate/open tree, copy-url, Jira link, remove-reviewer) is
// hidden — a not-yet-proven repo shouldn't leave the reviewer with no way at
// all to reach the PR (reported: the popover for such a row offered nothing
// but "Sluit menu" and the disabled explanation).
function githubLinkAction(pr) {
  return html`<a href="${pr.url}" target="_blank" rel="noreferrer" class="${popoverRowCls()}">
    ${icon('external-link', 'h-3.5 w-3.5')} ${t('Open op GitHub')}
  </a>`
}

// repoUnavailableAction — the explanation shown alongside githubLinkAction
// (above) for a row from a not-yet-proven repo: every OTHER action is
// hidden (see repoReady above for why and when this goes away). A real
// `disabled` attribute (static — this item's disabled-ness never changes, so
// no need for the `disabled="${() => ...}"` function-binding form that a
// TOGGLING boolean attribute would require, see
// .claude/rules/arrowjs-pitfalls.md), and the WORD carries the meaning — no
// colour-only signal (Reindert is colourblind).
function repoUnavailableAction() {
  return html`
    <button type="button" data-testid="repo-unavailable" disabled class="${popoverRowCls('cursor-not-allowed opacity-60')}">
      ${t('Repo is niet beschikbaar')}
    </button>
  `
}

const ROW_CLASS =
  'group flex items-center gap-3 border-b border-slate-100 dark:border-zinc-800/70 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl last:border-b-0 hover:bg-slate-100 dark:hover:bg-zinc-800/40'

function indentStyle(opts) {
  return opts.depth ? 'padding-left:' + (16 + opts.depth * 22) + 'px' : ''
}

// prRow — every row (ingested or not) is a click-opens-popover button, so the
// menu's action set (see popover/ingestedActions/generateAction above) is the
// only thing that varies with pr.hasGraph. This is the single row renderer;
// there used to be a separate direct-linking prRowLink + hover-only
// regenerateButton for already-ingested rows, but "Open review-boom"/"Opnieuw
// genereren" now live inside the same popover as every other row's actions.
function prRow(pr, opts = {}) {
  return html`
    <div
      role="button"
      tabindex="0"
      data-testid="pr-row"
      data-pr="${prUid(pr)}"
      data-nav-row
      data-nav-key="${'row:' + prUid(pr)}"
      class="${'relative ' + ROW_CLASS}"
      style="${indentStyle(opts)}"
      @click="${() => togglePopover(prUid(pr))}"
      @dblclick="${() => openOrGenerate(pr)}"
    >
      ${rowInner(pr, opts)} ${() => (ui.openPopover === prUid(pr) ? popover(pr) : null)}
    </div>
  `.key('row:' + prUid(pr))
}

// listBox — the framed rounded-xl box every group of rows sits in, with thin
// dividers between rows and no gap (matches dash's listBox/prCard). No
// `overflow-hidden` here (on purpose): each row's popover menu is an
// absolutely positioned child that renders below the row, and an absolutely
// positioned child doesn't grow its normal-flow container's height. A short
// list (very common after computeStacks pulls chained PRs out — often
// leaving just 1 row in a section) has a container box that ends right at
// the row's bottom edge, so `overflow-hidden` clips the popover away
// entirely once the row correctly establishes its own positioning context
// (see the `relative`-toggle bugfix in paintSelection). The rounded corners
// still look right without it because each row already carries its own
// `first:rounded-t-xl last:rounded-b-xl` (see ROW_CLASS).
function listBox(items) {
  return html`<div class="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60">
    ${items.map(({ pr, opts }) => prRow(pr, opts || {}))}
  </div>`
}

// ── stacks ───────────────────────────────────────────────────────────────

// computeStacks detects TREES of stacked PRs (a PR whose baseRefName equals
// another in-view PR's headRefName) — not just linear chains. A single PR
// can be the direct base for several sibling PRs at once (a "fan-out": e.g.
// five independent feature branches all taken off the same not-yet-merged
// branch); those siblings share the same depth under their common parent,
// they are not stacked on each other. Returns an array of trees, each
// flattened via a depth-first walk into `[{pr, depth}, …]` ordered root
// (depth 0, merges first) → leaves; siblings at the same depth are sorted by
// PR number ascending. Only trees with >= 2 nodes are stacks worth calling
// out. `all` PR objects are read-only here — never mutated. Exported purely
// for testability (tests/overview-stack-fanout.spec.mjs) — the module has no
// other exports since it's a page bootstrap script (see navigate.spec.mjs's
// `changeGroups` import for the same "import an already-loaded page module,
// call its exported pure function with synthetic data" pattern).
export function computeStacks(all) {
  // Branch names are only unique WITHIN a repo, so both the head index and every
  // node key are scoped by repo: a `main`→`feature/x` chain in plug-and-pay-ops
  // must never adopt a same-named branch in plug-and-pay as its parent.
  const byHead = new Map()
  all.forEach((p) => {
    if (p.headRefName) byHead.set((p.repo || '') + '\u0000' + p.headRefName, p)
  })
  const parentOf = new Map() // prUid -> the pr it's stacked on
  all.forEach((p) => {
    const parent = p.baseRefName ? byHead.get((p.repo || '') + '\u0000' + p.baseRefName) : null
    if (parent && prUid(parent) !== prUid(p)) parentOf.set(prUid(p), parent)
  })
  const childrenOf = new Map() // parent prUid -> PR[] stacked directly on it
  parentOf.forEach((parent, uid) => {
    const child = all.find((p) => prUid(p) === uid)
    if (!child) return
    if (!childrenOf.has(prUid(parent))) childrenOf.set(prUid(parent), [])
    childrenOf.get(prUid(parent)).push(child)
  })
  childrenOf.forEach((kids) => kids.sort((a, b) => a.number - b.number))

  const trees = []
  const consumed = new Set()
  all.forEach((p) => {
    if (consumed.has(prUid(p)) || parentOf.has(prUid(p)) || !childrenOf.has(prUid(p))) return
    const nodes = []
    const visit = (pr, depth) => {
      if (consumed.has(prUid(pr))) return
      consumed.add(prUid(pr))
      nodes.push({ pr, depth })
      ;(childrenOf.get(prUid(pr)) || []).forEach((kid) => visit(kid, depth + 1))
    }
    visit(p, 0)
    if (nodes.length >= 2) trees.push(nodes)
  })
  return trees
}

// stackGroup renders one tree as its own top-level group, above all section
// blocks: a header (icon + "Gestapelde PR's" + count + caption) followed by
// the framed list, each node indented by its own depth with a └ connector —
// several sibling PRs sharing the same parent render at the same depth, one
// after another, rather than each one step deeper than the last.
function stackGroup(nodes, sectionOf) {
  const root = nodes[0].pr
  return html`
    <div data-testid="stack">
      <div class="mb-2 mt-10 flex items-center gap-2 first:mt-0">
        <span class="text-slate-500 dark:text-zinc-500">${icon('git-pull-request', 'h-3.5 w-3.5')}</span>
        <h2 class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${t("Gestapelde PR's")}</h2>
        <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[11px] text-slate-500 dark:text-zinc-400">${nodes.length}</span>
        <span class="truncate text-[11.5px] text-slate-500 dark:text-zinc-500"
          >${t('bouwt op')} <span class="font-mono text-slate-500 dark:text-zinc-400">${root.baseRefName || '?'}</span> ${t('— merge van onder naar boven')}</span
        >
      </div>
      ${listBox(nodes.map(({ pr, depth }) => ({ pr, opts: { depth, badge: sectionOf.get(prUid(pr)) } })))}
    </div>
  `.key('stack:' + root.number)
}

// ── sections & layout ────────────────────────────────────────────────────

// The key encodes the section's ROW SET, not just its title. listBox's row array
// is a STATIC interpolation (`${listBox(...)}`, evaluated eagerly rather than as
// a `${() => …}` slot), so a re-render that reuses this keyed <section> node goes
// through arrow.js's static patch path and does NOT reconcile the keyed row list
// inside it — a row LEAVING a section that still has other rows stayed in the
// DOM forever (visible as: "Verwijder mij als reviewer" left the row on screen,
// and a poll that dropped one PR from a multi-row section changed nothing).
// Encoding the uids forces a fresh node exactly when the row set changed, the
// same "let the key force a fresh node" pattern the block cards in home.mjs use
// (see .claude/rules/arrowjs-pitfalls.md). It only fires on a real set change,
// so an unchanged poll still repaints nothing.
function sectionBlock(sec, filteredPrs) {
  if (!filteredPrs.length) return null
  return html`
    <section data-testid="section" data-title="${sec.title}">
      <div class="mb-3 mt-16 flex items-center gap-2 first:mt-6">
        <h2 class="text-[15px] font-semibold text-slate-900 dark:text-zinc-100">${sec.title}</h2>
      </div>
      ${listBox(filteredPrs.map((pr) => ({ pr })))}
    </section>
  `.key('section:' + sec.title + ':' + filteredPrs.map(prUid).join(','))
}

function loadingSkeletonList() {
  return html`
    <div class="flex flex-col gap-2">
      ${[0, 1, 2].map((i) => html`<div class="h-14 animate-pulse rounded-xl bg-slate-50 dark:bg-zinc-900/60"></div>`.key('skel:' + i))}
    </div>
  `
}

function errorCard(msg) {
  return html`<div
    class="mx-auto max-w-xl rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-8 text-center text-sm text-rose-700 dark:text-rose-300"
  >
    ${msg}
  </div>`
}

function headerBlock() {
  return html`
    <header class="mb-4 flex items-end justify-between">
      <div>
        <h1 class="text-xl font-semibold text-slate-900 dark:text-zinc-100">Needs your review</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-zinc-500">
          ${() =>
            t('Pull requests die je aandacht nodig hebben — {repo}{forPart}', {
              repo: state.repo || '…',
              forPart: state.generatedFor ? t(' · voor {name}', { name: state.generatedFor }) : '',
            })}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span
          data-testid="running-count"
          class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2.5 py-1 text-xs text-slate-500 dark:text-zinc-400"
        >
          <span
            class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400"
            data-testid="running-count-dot"
          ></span>
          <span>${() => t('{n} actief', { n: state.runningCount })}</span>
        </span>
        <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2.5 py-1 text-xs text-slate-500 dark:text-zinc-400"
          >${() => {
            const n = state.sections.reduce((acc, s) => acc + s.prs.length, 0)
            return n + ' PR' + (n === 1 ? '' : 's')
          }}</span
        >
        ${autoIngestPrefToggleButton()}
        ${autoWarnToggleButton()}
        ${jiraBellButton()}
        ${themeToggleButton('h-7 w-7')}
        ${settingsButton('h-7 w-7')}
      </div>
    </header>
  `
}

function onSearchInput(e) {
  state.query = e.target.value
  clearTimeout(searchTimer)
  if (!state.query.trim()) {
    state.searchResults = null
    state.searching = false
    return
  }
  searchTimer = setTimeout(() => runSearch(state.query), 300)
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    e.target.value = ''
    state.query = ''
    state.searchResults = null
    // Also drop DOM focus so the row list's own ArrowDown/ArrowUp nav works
    // again immediately — otherwise kbHandler's `typing` guard (this is
    // still an INPUT) keeps swallowing arrow keys until the reviewer
    // manually clicks/Tabs away, which reads as "arrow keys do nothing".
    e.target.blur()
  }
  if (e.key === 'ArrowDown') {
    // Symmetric with focusSearch()'s ArrowUp-past-the-first-row jump into
    // this box: without this, landing here (by a click, by backspacing the
    // query to empty, or via that ArrowUp jump) was a one-way trap — every
    // later ArrowDown kept hitting kbHandler's `typing` guard (this is still
    // an INPUT) with no way back down to the row list. Drop focus and land
    // on the first visible row, mirroring the Escape branch above.
    e.preventDefault()
    e.target.blur()
    moveTo(0)
  }
}

function searchBox() {
  return html`
    <div class="relative mb-5">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-zinc-500">${icon('search', 'h-4 w-4')}</span>
      <input
        type="text"
        data-testid="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="${() => t(`Zoek in alle PR's van {repo}… (titel, nummer of auteur; gesloten onderaan)`, { repo: state.repo || '' })}"
        class="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-900/60 py-2.5 pl-9 pr-3 text-[13px] text-slate-900 dark:text-zinc-100 outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-600 hover:border-slate-400 dark:hover:border-zinc-600 focus:border-indigo-300 dark:focus:border-indigo-500 focus:ring-1 focus:ring-indigo-200 dark:focus:ring-indigo-500/30"
        @input="${onSearchInput}"
        @keydown="${onSearchKeydown}"
      />
    </div>
  `
}

// searchResultsBlock — ONE flat, heading-less list of results. Reindert:
// "als je zoekt, wil ik alle categorieen weg hebben" — while a query is
// active there are no category headings at all: not the old
// `Alle open PR's — "q"` heading (and its count pill, which went with it —
// the empty-state line below covers the zero case), and not the three
// drawers either (App() hides them, see there). The inbox sections were
// already gone, since currentView() routes a non-empty query away from
// mainContent().
//
// The server already ordered the rows (own open, other open, own closed,
// other closed — sortSearchRows in inbox_api.go), so there is no sorting or
// partitioning here; a closed row is told apart purely by rowStateMark's
// word (see rowMeta), which is why that marker is load-bearing rather than
// decorative.
function searchResultsBlock() {
  return html`
    <div data-testid="search-results">
      ${() => {
        if (state.searching) return loadingSkeletonList()
        const results = state.searchResults || []
        return html`
          <div class="mt-6 first:mt-0">
            ${results.length
              ? listBox(results.map((pr) => ({ pr })))
              : html`<p class="py-10 text-center text-sm text-slate-500 dark:text-zinc-500">${t('Geen resultaten voor “{query}”.', { query: state.query })}</p>`}
          </div>
        `
      }}
    </div>
  `
}

const PRESET_LABELS = {
  'updated-oud': 'Gesorteerd op aanmaakdatum (oud eerst)',
  'alle-open': "Alle open PR's",
  'alle-draft': "Alle draft PR's",
  'ouder-3-dagen': "PR's ouder dan 3 dagen (per auteur)",
}

// backToInboxBar — the "← Terug naar inbox" affordance shown atop a preset
// view so the reviewer can return to the main sections.
function backToInboxBar(label) {
  return html`
    <div class="mb-4 flex items-center gap-3">
      <button
        type="button"
        data-testid="back-to-inbox"
        class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
        @click="${clearPresetView}"
      >
        ← ${t('Terug naar inbox')}
      </button>
      <h2 class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${t(label)}</h2>
    </div>
  `
}

// authorGroups groups rows by pr.author, returning [{ author, prs }] ordered by
// author name — used by the "ouder dan 3 dagen" preset (grouped per auteur).
function authorGroups(rows) {
  const by = new Map()
  rows.forEach((pr) => {
    const a = pr.author || '?'
    if (!by.has(a)) by.set(a, [])
    by.get(a).push(pr)
  })
  return [...by.keys()].sort().map((author) => ({ author, prs: by.get(author) }))
}

function authorGroupBlock(group) {
  return html`
    <div class="mb-6" data-testid="author-group" data-author="${group.author}">
      <div class="mb-2 flex items-center gap-2" title="${fullNameOf(group.author) || group.author}">
        ${avatarHTML(fullNameOf(group.author) || group.author, avatarUrlOf(group.author), 'h-5 w-5')}
        <h3 class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${displayNameOf(group.author)}</h3>
        <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[11px] text-slate-500 dark:text-zinc-400">${group.prs.length}</span>
      </div>
      ${listBox(group.prs.map((pr) => ({ pr })))}
    </div>
  `.key('authgroup:' + group.author)
}

// presetResultsBlock renders the active preset's live gh-search results. The
// "ouder-3-dagen" preset groups them per author; the others are a flat list.
function presetResultsBlock() {
  return html`
    <div data-testid="preset-results">
      ${backToInboxBar(PRESET_LABELS[state.activePreset] || 'Filter')}
      ${() => {
        if (state.presetLoading) return loadingSkeletonList()
        const results = state.presetResults || []
        if (!results.length)
          return html`<p class="py-10 text-center text-sm text-slate-500 dark:text-zinc-500">${t("Geen PR's voor dit filter.")}</p>`
        if (state.activePreset === 'ouder-3-dagen') {
          return html`<div>${authorGroups(results).map((g) => authorGroupBlock(g))}</div>`
        }
        return listBox(results.map((pr) => ({ pr })))
      }}
    </div>
  `
}

// filterDrawer — a second expandable button (mal of recentDrawer): its menu is
// a list of preset filters (each a live gh-search). Every branch returns a
// keyed array-of-one so the slot shape stays a stable keyed array (arrow.js
// single↔array pitfall, see conventions.md).
function filterMenuButton(key, label) {
  return html`<button
    type="button"
    data-testid="${'preset-' + key}"
    class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800/40"
    @click="${() => runPreset(key)}"
  >
    ${icon('git-pull-request', 'h-4 w-4 text-slate-500 dark:text-zinc-500')} ${t(label)}
  </button>`
}

function filterDrawer() {
  return html`
    <div class="mt-4">
      <button
        data-testid="filter-drawer"
        class="group flex w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-3 text-left transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800/40"
        @click="${() => (state.filterOpen = !state.filterOpen)}"
      >
        <span class="${() => 'inline-flex shrink-0 transition-transform ' + (state.filterOpen ? 'rotate-90' : '')}"
          >${chevronFilled('h-4 w-4 text-slate-500 dark:text-zinc-500')}</span
        >
        <span class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${t('Filters')}</span>
      </button>
      ${() => {
        if (!state.filterOpen) return [html`<span class="hidden"></span>`.key('filter:closed')]
        return [
          html`<div class="mt-2 overflow-hidden rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60">
            ${filterMenuButton('updated-oud', PRESET_LABELS['updated-oud'])}
            ${filterMenuButton('alle-open', PRESET_LABELS['alle-open'])}
            ${filterMenuButton('alle-draft', PRESET_LABELS['alle-draft'])}
            ${filterMenuButton('ouder-3-dagen', PRESET_LABELS['ouder-3-dagen'])}
          </div>`.key('filter:open'),
        ]
      }}
    </div>
  `
}

// ── Jira notifications ────────────────────────────────────────────────────
// The bell feed from Jira as ordinary rows, above the PR sections (Reindert:
// "deze feature van jira wil ik in pr-overview als eerste row item zien. elke
// notification wil ik als pr (net als need action) in een lijst zien"). Every
// row is a plain <a target="_blank"> straight to the Jira comment, so opening
// one never leaves the overview. See .claude/docs/pr-overview.md.

// loadJiraNotifications pulls the read-model. Read-only, like every other GET
// on this page: only the jira_inbox tracker ever talks to Jira itself.
async function loadJiraNotifications() {
  try {
    const res = await fetch('/api/jira/notifications')
    if (!res.ok) return
    const body = await res.json()
    if (!body || !body.ok) return
    state.jiraRunId = body.runId || ''
    state.jira = Array.isArray(body.items) ? body.items : []
  } catch (err) {
    // Keep whatever we already showed — a transient failure must never blank
    // the list (same reasoning as loadRunningCount).
  }
}

// visibleJiraNotifications applies the "Alleen ongelezen" filter.
function visibleJiraNotifications() {
  if (!state.jiraUnreadOnly) return state.jira
  return state.jira.filter((n) => n.unread)
}

function jiraUnreadCount() {
  return state.jira.filter((n) => n.unread).length
}

// markJiraRead is the ONE write this page does, and it goes the sanctioned
// way: start (or reuse) the jira_inbox Execution, then Signal it — the
// tracker's own Activity is what touches the read-model
// (.claude/rules/workflows-write-boundary.md). The row is updated optimistically
// so the filter reacts immediately; the next poll confirms it.
async function markJiraRead(n) {
  if (!n || !n.unread) return
  state.jira = state.jira.map((it) => (it.id === n.id ? { ...it, unread: false } : it))
  try {
    let runId = state.jiraRunId
    if (!runId) {
      const started = await fetch('/api/workflows/jira_inbox', { method: 'POST' })
      const body = await started.json()
      runId = (body && body.runId) || ''
      state.jiraRunId = runId
    }
    if (!runId) return
    await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/jira_notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'read', id: n.id }),
    })
  } catch (err) {
    console.error('mark jira notification read failed:', err)
  }
}

// jiraUnreadMark — the unread signal, on the RIGHT edge of the row (mirroring
// Jira's own layout — the dot sits there, not next to the avatar). Per the
// colourblind rule the SHAPE and the WORD carry it (a filled dot plus a bold
// title, see jiraRow), never the colour on its own.
function jiraUnreadMark(n) {
  if (!n.unread) return html`<span class="inline-block h-2 w-2 shrink-0"></span>`
  return html`<span
    data-testid="jira-unread-dot"
    title="${t('Ongelezen')}"
    class="inline-block h-2 w-2 shrink-0 rounded-full bg-indigo-500 dark:bg-indigo-400"
  ></span>`
}

// avatarHTML returns an arrow.js TEMPLATE, not an HTML string — so it goes in
// as an ordinary child slot, never through .innerHTML (which would stringify
// the template function into the row, see the statically-interpolated-template
// pitfall in .claude/rules/arrowjs-pitfalls.md). Block.mjs's avatarHtmlString is
// the variant for real string contexts.
function jiraAvatarMark(n) {
  return html`<span class="flex w-8 shrink-0 items-center justify-center"
    >${() => avatarHTML(n.actor || n.issueKey || '?', n.avatarUrl, 'h-6 w-6')}</span
  >`
}

// jiraRow — one notification. An <a target="_blank"> (not a popover row like
// prRow): the reviewer asked for "openen in een new venster naar jira comment",
// and the href already carries Jira's own focusedCommentId deep link.
//
// Reviewer request, comparing two side-by-side screenshots of the real Jira
// bell panel: "ik zie hier zoveel meer informatie... ik wil hetzelfde hebben."
// Beyond the original single title+meta line, a row now also shows (all
// read-only, sourced from jira.Notification's own richer fields — see that
// struct's doc comment): the issue's own type icon + summary (`issueIconUrl`/
// `issueTitle`), its key + workflow status ("PROD-254 • To Do"), a "+N updates
// from X" note when several notifications on the same thread collapsed into
// one (`groupSize`/`otherActor`), and — for a mention/comment notification —
// a short preview of what was actually said (`commentPreview`), in a bordered
// box mirroring Jira's own comment-preview card. No reactions/reply button:
// this app never writes into Jira (see the file header), so only the
// read-only preview is shown, not the write affordances around it.
function jiraRow(n) {
  const icon = n.issueIconUrl
    ? html`<img src="${n.issueIconUrl}" alt="" class="mt-0.5 h-3.5 w-3.5 shrink-0" />`.key('icon')
    : ''
  // Deliberately NOT run through t(): like n.title/n.issueStatus (Jira's own
  // feed content, always in whatever language Jira itself used), this mirrors
  // Jira's own "+2 updates from X" activity-log wording verbatim rather than
  // being interface chrome we author and translate ourselves.
  const groupNote =
    n.groupSize > 1 && n.otherActor
      ? html`<p class="mt-1 truncate text-xs font-medium text-indigo-600 dark:text-indigo-400">
          +${n.groupSize - 1} updates from ${n.otherActor}
        </p>`.key('group')
      : ''
  const preview = n.commentPreview
    ? html`<p
        class="mt-1.5 line-clamp-3 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300"
      >
        ${n.commentPreview}
      </p>`.key('preview')
    : ''
  return html`
    <a
      href="${n.url}"
      target="_blank"
      rel="noopener noreferrer"
      data-testid="jira-row"
      data-jira-id="${n.id}"
      data-nav-row
      data-nav-key="${'jira:' + n.id}"
      class="${ROW_CLASS + ' items-start'}"
      @click="${() => markJiraRead(n)}"
    >
      ${() => jiraAvatarMark(n)}
      <div class="min-w-0 flex-1">
        <h3
          class="${'truncate text-[13.5px] text-slate-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white ' +
          (n.unread ? 'font-semibold' : 'font-normal')}"
        >
          ${n.title || n.issueKey || n.url}
          <span class="font-normal text-slate-400 dark:text-zinc-600">· ${relativeTime(n.at)}</span>
        </h3>
        ${() =>
          n.issueTitle
            ? html`<p class="mt-0.5 flex items-start gap-1 text-xs text-slate-600 dark:text-zinc-400">
                ${icon}<span class="line-clamp-2">${n.issueTitle}</span>
              </p>`.key('issue-title')
            : ''}
        <p class="mt-0.5 truncate text-xs text-slate-500 dark:text-zinc-500">
          ${(n.issueKey ? n.issueKey + ' • ' : '') + (n.issueStatus || n.actor)}
        </p>
        <div class="contents">${() => groupNote}</div>
        <div class="contents">${() => preview}</div>
      </div>
      <div class="flex shrink-0 items-center gap-2 self-start pt-0.5">
        ${() => jiraUnreadMark(n)}
        ${chevronFilled('h-4 w-4 text-slate-400 dark:text-zinc-600 group-hover:text-slate-600 dark:group-hover:text-zinc-300')}
      </div>
    </a>
  `.key('jira:' + n.id)
}

// jiraUnreadToggle mirrors Jira's own "Only show unread" switch. The state is
// spelled out in words ("Alleen ongelezen" + aan/uit), not carried by colour.
function jiraUnreadToggle() {
  return html`<button
    data-testid="jira-unread-toggle"
    class="${'shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ' +
    (state.jiraUnreadOnly
      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-300'
      : 'border-slate-200 bg-white text-slate-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400')}"
    @click="${() => (state.jiraUnreadOnly = !state.jiraUnreadOnly)}"
  >
    ${() => t('Alleen ongelezen') + ': ' + (state.jiraUnreadOnly ? t('aan') : t('uit'))}
  </button>`
}

// ── Jira bell (header icon row) ─────────────────────────────────────────────
// Reviewer requests, in order: (1) "deze feature van jira wil ik in
// pr-overview als eerste row item zien" — an always-visible inline section
// above the PR list (the original jiraBlock/jiraSlot); (2) "ik wil hier een
// belletje zien... als ik daarop druk wil ik top 5 notifications zien... een
// rondje als er ongelezen zijn" — a bell icon in the header row; (3) "haal
// deze sectie weg, onder het belletje wil ik dat het hetzelfde eruit ziet als
// in jira" — the reviewer decided the bell dropdown should be the ONE place
// this feed lives, styled like request (1)'s section (title, unread count,
// "Alleen ongelezen" toggle, the same row list) rather than a page-pinned
// block, and closer to Jira's own scrollable notification panel. So
// jiraBlock/jiraSlot (the pinned section) are gone; everything they used to
// render now lives inside jiraBellPanel, which the bell opens.

// closeJiraBell / toggleJiraBell — a small, independent open/close flag
// (state.jiraBellOpen), deliberately NOT folded into the row-popover
// mechanism (ui.openPopover): that one also resets row-specific state
// (ingestError, readyFor, reviewersError) on close, which has nothing to do
// with this dropdown.
function closeJiraBell() {
  state.jiraBellOpen = false
}

function toggleJiraBell() {
  state.jiraBellOpen = !state.jiraBellOpen
}

// jiraBellDot — the unread signal ON THE BELL ITSELF. Same colourblind-safe
// shape as jiraUnreadMark (a filled dot, never colour alone; the bell shape
// plus this dot together are unambiguous regardless of colour vision).
function jiraBellDot() {
  if (!jiraUnreadCount()) return html`<span class="hidden"></span>`
  return html`<span
    data-testid="jira-bell-dot"
    title="${() => jiraUnreadCount() + ' ' + t('ongelezen')}"
    class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-2 ring-white dark:bg-indigo-400 dark:ring-zinc-950"
  ></span>`
}

// jiraBellPanel — the dropdown, styled after Jira's own notification panel:
// a title, unread count, "Alleen ongelezen" toggle, then a scrollable row
// list (most-recent-first — state.jira is already ordered that way by the
// jira_inbox read-model). Reuses jiraRow verbatim for each entry, so a click
// marks it read and opens it in a new window exactly as before. Its own key
// encodes the visible row set plus the filter (same reasoning as the old
// jiraBlock: the row list is a static interpolation, so only a changed key
// re-reconciles it), scoped to this panel's own reactive slot in
// jiraBellButton so toggling it never re-runs the header row's own closure.
function jiraBellPanel() {
  const rows = visibleJiraNotifications()
  return html`
    <div
      data-testid="jira-bell-panel"
      class="absolute right-0 top-full z-20 mt-2 w-96 max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-zinc-800">
        <h2 class="text-[13px] font-semibold text-slate-900 dark:text-zinc-100">Jira</h2>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-400"
          >${() => jiraUnreadCount() + ' ' + t('ongelezen')}</span
        >
        ${jiraUnreadToggle()}
      </div>
      <div class="max-h-96 overflow-y-auto">
        ${() =>
          rows.length
            ? html`<div>${() => visibleJiraNotifications().map((n) => jiraRow(n))}</div>`.key('jira-bell:list')
            : html`<p class="px-4 py-6 text-center text-sm text-slate-500 dark:text-zinc-500">
                ${() => (state.jira.length ? t('Alles gelezen.') : t('Geen notificaties.'))}
              </p>`.key('jira-bell:empty')}
      </div>
    </div>
  `.key('jira-bell:' + (state.jiraUnreadOnly ? 'unread' : 'all') + ':' + rows.map((n) => n.id + (n.unread ? '!' : '')).join(','))
}

// jiraBellButton — the header icon, same compact size/style as
// themeToggleButton/settingsButton next to it.
function jiraBellButton() {
  return html`
    <div class="relative" data-testid="jira-bell-wrapper">
      <button
        type="button"
        data-testid="jira-bell-button"
        title="${t('Jira notificaties')}"
        class="relative inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        @click="${toggleJiraBell}"
      >
        ${icon('bell', 'h-4 w-4')} ${() => jiraBellDot()}
      </button>
      <div class="contents">${() => (state.jiraBellOpen ? jiraBellPanel() : '')}</div>
    </div>
  `
}

function mainContent() {
  return html`
    <div>
      <div data-testid="inbox-sections">
      ${() => {
        if (state.loading) return loadingSkeletonList()
        if (state.error) return errorCard(state.error)

        const all = []
        // Which section each PR normally lives in — so a lifted stack row can
        // still show its home-section badge. A plain Map, never written onto
        // the reactive PR objects themselves (that would trigger reactivity
        // from inside this very render pass).
        const sectionOf = new Map()
        state.sections.forEach((sec) => {
          sec.prs.forEach((pr) => {
            all.push(pr)
            if (!sectionOf.has(prUid(pr))) sectionOf.set(prUid(pr), sec.title)
          })
        })

        const chains = computeStacks(all)
        const stacked = new Set()
        chains.forEach((nodes) => nodes.forEach(({ pr }) => stacked.add(prUid(pr))))

        const out = []
        if (state.cached) {
          out.push(
            html`<p class="mb-4 text-xs text-amber-600 dark:text-amber-400" data-testid="cached">cached — offline snapshot</p>`.key(
              'cached-label',
            ),
          )
        }
        // Stacks render as their own group, above every section.
        chains.forEach((chain) => out.push(stackGroup(chain, sectionOf)))
        state.sections.forEach((sec) => {
          const filtered = sec.prs.filter((pr) => !stacked.has(prUid(pr)))
          const block = sectionBlock(sec, filtered)
          if (block) out.push(block)
        })
        if (!chains.length && state.sections.every((s) => s.prs.length === 0)) {
          out.push(
            html`<p class="py-10 text-center text-sm text-slate-500 dark:text-zinc-500">${t('Even geen open pull requests.')}</p>`.key('empty'),
          )
        }
        return out
      }}
      </div>
    </div>
  `
}

async function toggleRecent() {
  state.recentOpen = !state.recentOpen
  if (state.recentOpen) await ensureRecentPrs()
}

// recentAvatarMark — the left-edge mark of a "Recent gegenereerd" row. Reuses
// authorMark (avatar + first name, same as the inbox rows) whenever handlePRs
// could enrich this row from the prmeta read-model (r.author present); falls
// back to the original bare sparkle glyph for a PR that was ingested but never
// opened via /pr/<id> (pr_status never ran, so prmeta has nothing to show —
// see the PRSummary doc comment in db.go). Both branches keep the same w-20
// column width so mixed rows (some enriched, some not) still line up.
function recentAvatarMark(r) {
  if (r.author) return authorMark(r)
  return html`<span class="flex w-20 shrink-0 items-center justify-center text-emerald-600 dark:text-emerald-400"
    >${icon('sparkles', 'h-5 w-5')}</span
  >`
}

// recentItemMeta — the meta block under a "Recent gegenereerd" title, mirroring
// rowMeta's two-line shape (updated-at on its own line, diffstat + branch on
// the next) but built from PRSummary's own field names, not pr.number/pr.title
// (rowMeta itself isn't reused: it hardcodes "#${pr.number}" and a reactive
// state.repo prefix that don't apply here, and pulls in newSinceMark, which
// depends on the live inbox status backfill this drawer never fetches —
// deliberately out of scope, see the "no review/checks chip" call in
// .claude/docs/pr-overview.md). diffStatFragment/branchFragment/relativeTime
// are reused as-is: they only read pr.additions/deletions/changedFiles/
// headRefName/updatedAt, which handlePRs now fills from the very same
// prmeta.Get call it already made for r.title — no extra request. Every field
// here is static per r (fetched once, never updated in place), the same
// non-reactive template↔null shape rowMeta itself already uses.
function recentItemMeta(r) {
  const stat = diffStatFragment(r)
  const branch = branchFragment(r)
  return html`
    <div class="mt-0.5 text-[12px] text-slate-500 dark:text-zinc-500">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span class="font-mono">#${r.pr}</span>
        <span class="text-slate-300 dark:text-zinc-700">·</span>
        <span>${t(r.blocks === 1 ? '{n} blok' : '{n} blokken', { n: r.blocks })} · ${t(r.files === 1 ? '{n} bestand' : '{n} bestanden', { n: r.files })}</span>
        ${r.updatedAt
          ? html`<span class="text-slate-300 dark:text-zinc-700">·</span
              ><span title="${r.updatedAt}">${t('Bijgewerkt {time}', { time: relativeTime(r.updatedAt) })}</span>`
          : null}
      </div>
      ${stat || branch
        ? html`<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            ${stat} ${stat && branch ? html`<span class="text-slate-300 dark:text-zinc-700">·</span>` : null} ${branch}
          </div>`
        : null}
    </div>
  `
}

// recentItemUrl mirrors treeUrl's repo-prefix rule for this row's own shape
// (PRSummary: `.pr`/`.repo`, not the `.number` other callers of treeUrl use) —
// a recently-generated PR from a second repo must still open at
// /pr/<repo-name>/<n>, not the primary repo's /pr/<n>.
function recentItemUrl(r) {
  return '/pr/' + (r.repo ? repoLabel({ repo: r.repo }) + '/' : '') + r.pr
}

// recentUid(r) — the same "bare number for the primary repo, repo#n
// otherwise" spelling trySelectPendingPr already matches a `recent:` nav key
// against (see the comment there). A bare `r.pr` alone would collide between
// two repos' same PR number, so both the row's own key and the auto-select
// path must agree on this exact form.
function recentUid(r) {
  return r.repo ? r.repo + '#' + r.pr : String(r.pr)
}

function recentItem(r) {
  return html`
    <a
      href="${recentItemUrl(r)}"
      data-testid="recent-item"
      data-pr="${r.pr}"
      data-nav-row
      data-nav-key="${'recent:' + recentUid(r)}"
      class="${ROW_CLASS}"
    >
      ${recentAvatarMark(r)}
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[13.5px] font-semibold text-slate-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white">${r.title || '#' + r.pr}</h3>
        ${recentItemMeta(r)}
      </div>
      ${chip(t('open boom'), 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', '', 'sparkles')}
      ${chevronFilled('h-4 w-4 text-slate-400 dark:text-zinc-600 group-hover:text-slate-600 dark:group-hover:text-zinc-300')}
    </a>
  `.key('recent:' + recentUid(r))
}

function recentDrawer() {
  return html`
    <div class="mt-8">
      <button
        data-testid="recent"
        class="group flex w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-3 text-left transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800/40"
        @click="${toggleRecent}"
      >
        <span class="${() => 'inline-flex shrink-0 transition-transform ' + (state.recentOpen ? 'rotate-90' : '')}"
          >${chevronFilled('h-4 w-4 text-slate-500 dark:text-zinc-500')}</span
        >
        <span class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${t('Recent gegenereerd')}</span>
      </button>
      ${() => {
        // Always return a keyed array with a distinct key per branch. The
        // skeleton/list choice used to be a *static* ternary inside the inner
        // template: arrow.js reused the mounted chunk on the loading→loaded
        // flip and its statics patcher cannot swap a nested template in a
        // static slot, so the DOM froze on the skeleton forever. Fresh keys
        // per branch force fresh nodes instead (see conventions.md).
        if (!state.recentOpen) return [html`<span class="hidden"></span>`.key('recent:closed')]
        if (state.recentLoading) return [html`<div class="mt-2">${loadingSkeletonList()}</div>`.key('recent:loading')]
        if (state.recentPrs.length === 0)
          return [
            html`<div class="mt-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-3 text-[12px] text-slate-500 dark:text-zinc-500">
              ${t('Nog niets gegenereerd.')}
            </div>`.key('recent:empty'),
          ]
        return [
          html`<div class="mt-2 overflow-hidden rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60">
            ${state.recentPrs.map((r) => recentItem(r))}
          </div>`.key('recent:list'),
        ]
      }}
    </div>
  `
}

// ── "Mislukte taken" drawer ────────────────────────────────────────────────
// Background work can fail without the reviewer ever noticing: a workflow run
// that ends in status `failed`, or a poller/startup error that only reached the
// terminal log. Both land here (GET /api/problems, read-only).
//
// Two deliberate properties:
//  * Always present, collapsed, with the count in the button — a block that
//    only appears when something is wrong is not findable when you want to
//    check that nothing IS wrong.
//  * The rows carry no data-nav-row, so they stay out of the overview's
//    keyboard navigation (currentRows/paintSelection would otherwise try to
//    put the selection ring on a failure line).

function problemCount() {
  return state.failedRuns.length + state.logErrors.length
}

// problemsToggleText — the closed button always says what it holds, in words
// (never colour alone: the count and the word carry the meaning).
function problemsToggleText() {
  const n = problemCount()
  if (!state.problemsLoaded) return t('Mislukte taken')
  if (n === 0) return t('Mislukte taken · geen')
  return t('Mislukte taken · {n}', { n })
}

// problemMark/PROBLEM_ROW_CLASS/problemPrChip/problemCommentLine/baseName/
// problemRunRow/problemLogRow moved to src/problems.mjs (imported above) so
// the review tree (/pr/<id>) can reuse the exact same rows instead of a
// second implementation — see .claude/docs/detail-layout.md.

function problemsDrawer() {
  return html`
    <div class="mt-4">
      <button
        data-testid="problems-drawer"
        class="group flex w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-3 text-left transition-colors hover:bg-slate-100 dark:hover:bg-zinc-800/40"
        @click="${() => (state.problemsOpen = !state.problemsOpen)}"
      >
        <span class="${() => 'inline-flex shrink-0 transition-transform ' + (state.problemsOpen ? 'rotate-90' : '')}"
          >${chevronFilled('h-4 w-4 text-slate-500 dark:text-zinc-500')}</span
        >
        <span data-testid="problems-count" class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">${() => problemsToggleText()}</span>
      </button>
      ${() => {
        // Every branch returns a keyed array with its own key, so the slot's
        // shape stays a stable keyed array and a branch flip always mounts
        // fresh nodes (the single↔array + reused-keyed-node pitfalls, see
        // conventions.md — recentDrawer above has the same shape for the same
        // reason).
        if (!state.problemsOpen) return [html`<span class="hidden"></span>`.key('problems:closed')]
        if (!state.problemsLoaded) return [html`<div class="mt-2">${loadingSkeletonList()}</div>`.key('problems:loading')]
        if (problemCount() === 0)
          return [
            html`<div
              data-testid="problems-empty"
              class="mt-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 px-4 py-3 text-[12px] text-slate-500 dark:text-zinc-500"
            >
              ${t('Geen mislukte taken sinds de server startte.')}
            </div>`.key('problems:empty'),
          ]
        return [
          // Both lists are their OWN `() =>` bindings, never a bare
          // `.map(...)` snapshot: this template is (re)created by the
          // conditional closure above, and once its chunk is reused a static
          // list slot is never re-diffed again — the "fifth variant" in
          // .claude/rules/arrowjs-pitfalls.md. Which is exactly what a row
          // ignoring itself needs: the list shrinks in place.
          html`<div class="mt-2 overflow-hidden rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60">
            ${() => state.failedRuns.map((run) => problemRunRow(run, state.prTitles, { onIgnore: ignoreProblemRun }))}
            ${() => state.logErrors.map((entry, i) => problemLogRow(entry, i, state.prTitles))}
          </div>`.key('problems:list'),
        ]
      }}
    </div>
  `
}

function App() {
  return html`
    <div class="mx-auto max-w-7xl px-6 py-8" data-testid="inbox">
      ${headerBlock()} ${searchBox()}
      ${() => currentView()} ${drawersSlot()} ${MenuHost()}
    </div>
  `
}

// drawersSlot holds the three always-below blocks (Filters / Recent
// gegenereerd / Mislukte taken) and empties itself while a search query is
// active — Reindert wants EVERY category gone the moment he searches, and
// these three are siblings of currentView(), so routing alone never hid them.
//
// Three things make this arrow.js-safe (see .claude/rules/arrowjs-pitfalls.md):
// the wrapper is a stable element with a STATIC class (never a keyed template
// whose whole body IS the toggling expression), the slot always returns the
// same KIND of value (an array — empty, not `''` — per the single<->array
// rule), and each drawer keeps its own `.key()`. Their open/closed state lives
// in state.filterOpen/recentOpen/problemsOpen, so it survives the unmount;
// loadProblems() keeps running on its own interval regardless.
//
// The row-set watch already lists state.query as a dep, so scheduleRepaint()
// fires when these blocks come and go — which is exactly the scroll-clamp case
// its hoverEnabled disarming exists for (the document height changes without
// the pointer moving).
function drawersSlot() {
  return html`<div class="contents">
    ${() =>
      state.query.trim()
        ? []
        : [filterDrawer().key('drawer:filter'), recentDrawer().key('drawer:recent'), problemsDrawer().key('drawer:problems')]}
  </div>`
}

// currentView routes the content region. A non-empty search query always wins
// (the search box stays responsive); then an active preset filter, else the
// main inbox sections.
function currentView() {
  if (state.query.trim()) return searchResultsBlock()
  if (state.activePreset) return presetResultsBlock()
  return mainContent()
}

// ── data loading ─────────────────────────────────────────────────────────

let loadGen = 0

async function loadInbox() {
  const gen = ++loadGen
  state.loading = true
  state.error = ''
  state.cached = false
  try {
    const res = await fetch('/api/inbox')
    if (res.ok) {
      const body = await res.json()
      if (gen !== loadGen) return
      if (body && body.ok && body.live) {
        await applyLive(body)
        kickOffStatuses(gen)
        kickOffApprovals(gen)
        kickOffPendingPush(gen)
        kickOffCheckout(gen)
        return
      }
    }
  } catch (e) {
    // fall through to the offline snapshot
  }
  if (gen !== loadGen) return
  try {
    const res2 = await fetch('/data/inbox.json')
    if (res2.ok) {
      const body2 = await res2.json()
      if (gen !== loadGen) return
      await applyCached(body2)
      return
    }
  } catch (e) {
    // both sources failed — show the error card below
  }
  if (gen !== loadGen) return
  state.error = t('Kan de inbox niet laden — probeer het later opnieuw.')
  state.loading = false
}

// normalizeSections guarantees every section has a prs array. The Go API
// marshals an empty section's prs slice as null, which would crash the
// .length/.forEach calls that iterate sections. Also drops `approvedPr`
// (below) from every section, so a PR just approved from the review tree is
// filtered out of the very FIRST render — never a flash of it followed by it
// disappearing once a background refresh catches up.
function normalizeSections(sections) {
  if (!Array.isArray(sections)) return []
  return sections
    .map((s) => ({ ...s, prs: Array.isArray(s.prs) ? s.prs : [] }))
    .map((s) => ({ ...s, prs: s.prs.filter((pr) => !isHiddenPr(pr)) }))
}

// isHiddenPr — a PR this tab is deliberately no longer showing, whatever the
// server still says: the one just approved from the review tree (`approvedPr`,
// below) and every PR I just took myself off as a reviewer (`removedPrs`, see
// removeSelfAsReviewer). Both outlive a single render on purpose — the pr_inbox
// read-model (and GitHub itself) needs a moment to catch up, so without this the
// row would come straight back on the next reloadSnapshot/60s poll. A real page
// load clears them, by which time the server agrees.
function isHiddenPr(pr) {
  // Both sets hold prUids (see prUid): the approved-PR one comes from the review
  // tree's own ?approved= param, which carries the primary repo's bare number
  // today and a full uid once another repo's tree links back here.
  const uid = prUid(pr)
  return matchesPrRef(pr, approvedPr) || removedPrs.has(uid)
}

// primeAuthorNames resolves the real names behind the author logins of these
// rows BEFORE they are pushed into reactive state — see the timing note on
// ensureNames in avatar.mjs (a late arrival can never repaint a keyed row).
// Always awaited, never awaited-on-error: ensureNames swallows its own failures.
function primeAuthorNames(rows) {
  // ensureMe rides along here because it is the one place EVERY row-loading path
  // already awaits before pushing rows into reactive state — and the popover's
  // "Verwijder mij als reviewer" item needs to know who I am to decide whether
  // this PR is mine (see canRemoveSelf). Both are plain, non-reactive caches, so
  // a late arrival could never repaint a mounted row (see avatar.mjs).
  return Promise.all([ensureNames(rows.map((pr) => pr.author)), ensureMe()])
}

// primeSectionNames is primeAuthorNames over a whole section list.
function primeSectionNames(sections) {
  return primeAuthorNames(sections.flatMap((s) => s.prs))
}

async function applyLive(body) {
  state.repo = body.repo || ''
  // The configured repos (canonical form, "" = primary) — see treeSupported.
  if (Array.isArray(body.repos)) state.repos = body.repos
  state.generatedFor = body.generatedFor || ''
  state.inboxRunId = body.runId || ''
  const sections = normalizeSections(body.sections)
  await primeSectionNames(sections)
  state.sections = sections
  state.cached = false
  state.loading = false
  // The list comes from the pr_inbox workflow's read-model, never a direct
  // GitHub call. On load we ask that workflow to re-check GitHub now and start
  // heartbeating so it keeps its fast poll cadence while this tab is active.
  startLiveSync()
  trySelectPendingPr()
  trySelectTopAfterApprove()
}

async function applyCached(body) {
  state.repo = body.repo || ''
  state.generatedFor = body.generatedFor || ''
  state.cached = true
  const allPrs = Array.isArray(body.prs) ? body.prs : []
  const prs = allPrs.filter((pr) => !isHiddenPr(pr))
  await primeAuthorNames(prs)
  state.sections = prs.length ? [{ title: 'Needs your review', prs }] : []
  state.loading = false
  trySelectPendingPr()
  trySelectTopAfterApprove()
}

// ── auto-select a PR coming back from /pr/<id> ──────────────────────────────
// The ← nav-chain exit (home.mjs) links here with `?pr=<id>` so the reviewer
// lands back on the row they just came from, instead of an unselected list.
// Read once at load; applied (and
// cleared) the first time the target PR turns up in either the main sections
// or the lazily-loaded "Recent gegenereerd" drawer — mirrors the
// restore-then-clear pattern of applyRelRestore/applyBlockRefRestore. A PR
// that never turns up anywhere (merged/dropped out of the inbox query, no
// longer ingested) is a silent no-op, same as an unresolved `sel` restore.
// Carries a prUid (see prUid): a bare number for the primary repo — the
// historical form every existing link and test uses — or "<owner/name>#<n>" for
// a PR from another repo.
let pendingSelectPr = (() => {
  const raw = new URLSearchParams(location.search).get('pr')
  return raw ? raw : null
})()

// approvedPr/trySelectTopAfterApprove — the counterpart for the "Goedkeuren en
// ga naar overzicht" confirm action (home.mjs, overviewExitUrlAfterApprove):
// that link carries `?approved=<pr>`, never `?pr=<pr>`, precisely so it does
// NOT trigger the pendingSelectPr behaviour above (select and remember THAT
// row) — the PR just got fully approved and is done, so instead it must
// already be gone from every section by the time this page renders
// (normalizeSections/applyCached's own filter, above) with the new TOP row of
// the list selected. `approvedPr` is a plain, never-nulled module const (the
// filter must keep applying on every later reloadSnapshot poll too);
// `pendingSelectTop` is the one-shot "still need to pick the top row" flag,
// mirroring pendingSelectPr's clear-after-use.
const approvedPr = (() => {
  const raw = new URLSearchParams(location.search).get('approved')
  return raw ? raw : null
})()
let pendingSelectTop = approvedPr != null

function trySelectTopAfterApprove() {
  if (!pendingSelectTop) return
  if (!selectTopRow()) return
  pendingSelectTop = false
}

// selectTopRow moves the selection to the FIRST row of the whole overview and
// reports whether there was one to move to. Shared by the just-approved round
// trip above and removeSelfAsReviewer: in both cases the row the reviewer was
// standing on has just left the list, so without this the selection would
// simply be released (reanchorSelection can't find selKey anymore) and the page
// would sit there with no ring at all.
function selectTopRow() {
  const firstRow = state.sections.flatMap((s) => s.prs)[0]
  if (!firstRow) return false
  selKey = 'row:' + prUid(firstRow)
  hoverEnabled = false
  return true
}

// originPr/originSel — the same `?pr=`/`?sel=` pair as pendingSelectPr above,
// but read into their own, never-nulled module lets: pendingSelectPr is
// deliberately one-shot (cleared within milliseconds of load, once the row is
// found/not-found), while these two need to survive until the reviewer
// eventually clicks back into the tree — seconds or minutes later. Kept
// separate rather than reusing pendingSelectPr for that reason. treeUrl(pr)
// below appends `sel` only when pr.number matches originPr, so navigating to
// a *different* PR than the one we came from never carries a stale sel along.
const originPr = pendingSelectPr
const originSel = new URLSearchParams(location.search).get('sel') || null
// originDrill/originDrillGran/originDrillChange — the same round-trip as
// originSel, for a drilled Onderliggende-code column left open on the way out
// (home.mjs' overviewExitUrl only appends these alongside sel, so a present
// originDrill implies a present originSel too).
const originDrill = new URLSearchParams(location.search).get('drill') || null
const originDrillGran = new URLSearchParams(location.search).get('dgran') || null
const originDrillChange = new URLSearchParams(location.search).get('dchg') || null
// originDrillCursorRef — the per-level cursor path (`?dcur=`, see
// state.drillCursorRef in home.mjs), forwarded the same way so an ANCESTOR
// drilled column's own {gran, change} — not just the deepest, focused one —
// survives this round trip too. Without it, returning via "Open review-boom"
// would restore the drill path but reset every ancestor's cursor back to
// {group, 0}, exactly the bug this round-trip already avoided for the
// deepest level.
const originDrillCursorRef = new URLSearchParams(location.search).get('dcur') || null

// treeUrl(pr) — the URL to navigate into pr's review tree (/pr/<n>), used by
// every place that opens/redirects into the tree (generatePage's redirect,
// "Open review-boom", and the → forward-nav in openOrGenerate). Hands back
// the block reference we left from (originSel) so the reviewer lands on the
// same block instead of the default first one — see the ← nav-chain exit /
// overviewExitUrl in home.mjs, and the "?pr=<id> auto-selecteert…" section in
// .claude/docs/pages-and-routing.md. Also hands back a drilled column
// (originDrill/originDrillGran/originDrillChange/originDrillCursorRef), so
// leaving a drilled Onderliggende-code column open and returning via "Open
// review-boom" lands back in that same column — with every level's own
// cursor, not just the deepest one — instead of just the top-level block —
// this also needs `mode=diff` (a drill path only has meaning inside a diff
// session, see applyDrillRefRestore in home.mjs), which overviewExitUrl only
// added to the URL we left from when there actually was a drilled column.
function treeUrl(pr) {
  let url = '/pr/' + (pr.repo ? repoLabel(pr) + '/' : '') + pr.number
  if (prUid(pr) === String(originPr) && originSel) {
    url += '?sel=' + encodeURIComponent(originSel)
    if (originDrill) {
      url += '&mode=diff'
      url += '&drill=' + encodeURIComponent(originDrill)
      if (originDrillGran) url += '&dgran=' + encodeURIComponent(originDrillGran)
      if (originDrillChange) url += '&dchg=' + encodeURIComponent(originDrillChange)
      if (originDrillCursorRef) url += '&dcur=' + encodeURIComponent(originDrillCursorRef)
    }
  }
  return url
}

// Shared by toggleRecent (manual click) and trySelectPendingPr (auto-select):
// fetches /api/prs once and caches it on state.recentPrs.
async function ensureRecentPrs() {
  if (state.recentPrs.length === 0 && !state.recentLoading) {
    state.recentLoading = true
    try {
      const res = await fetch('/api/prs')
      if (res.ok) {
        const body = await res.json()
        const rows = Array.isArray(body) ? body : []
        // Resolve author names/avatars BEFORE pushing the rows into reactive
        // state — same timing rule as primeAuthorNames/ensureNames elsewhere
        // (a late arrival can never repaint an already-mounted keyed row, see
        // .claude/rules/conventions.md). Only runs when the drawer is actually
        // opened (ensureRecentPrs is called from toggleRecent/
        // trySelectPendingPr), so this batched request never delays the
        // initial page load.
        await primeAuthorNames(rows)
        state.recentPrs = rows
      }
    } catch (e) {
      // keep the drawer usable even if this fetch fails
    } finally {
      state.recentLoading = false
    }
  }
  return state.recentPrs
}

async function trySelectPendingPr() {
  if (pendingSelectPr == null) return
  const uid = pendingSelectPr
  // The nav key must be the ROW's own uid, not the incoming reference — the two
  // can differ in spelling (see matchesPrRef).
  let match = null
  state.sections.forEach((sec) => sec.prs.forEach((row) => (match = match || (matchesPrRef(row, uid) ? row : null))))
  if (match) {
    selKey = 'row:' + prUid(match)
    hoverEnabled = false
    pendingSelectPr = null
    return
  }
  const recent = await ensureRecentPrs()
  pendingSelectPr = null // one-shot regardless of outcome — never re-applied on a later reload
  // The "Recent gegenereerd" drawer is fed by the blocks DB (GET /api/prs), so
  // its rows carry a bare PR number of whichever repo they were ingested from.
  // Match via matchesPrRef (row shaped as {repo, number}) so the SHORT repo
  // NAME spelling the review tree's own overviewExitUrl sends
  // (prUidHere() → "<repo-name>#<n>", see home.mjs) is accepted too, not just
  // the full slug#n form recentUid builds — then reuse that row's OWN
  // recentUid, never the possibly differently-spelled incoming `uid`, as the
  // nav key so it always agrees with that row's own `.key()`/data-nav-key.
  const recentMatch = recent.find((r) => matchesPrRef({ repo: r.repo, number: r.pr }, uid))
  if (recentMatch) {
    state.recentOpen = true
    selKey = 'recent:' + recentUid(recentMatch)
    hoverEnabled = false
  }
}

async function kickOffStatuses(gen) {
  const keys = []
  state.sections.forEach((sec) => sec.prs.forEach((pr) => keys.push(prUid(pr))))
  if (!keys.length) return
  try {
    const res = await fetch('/api/inbox/status?prs=' + encodeURIComponent(keys.join(',')))
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return // page moved on (reloaded / re-fetched) — drop this response
    if (body && body.ok && body.statuses) {
      // The reviewer avatars name their reviewer in the tooltip, so resolve
      // those logins before the strip mounts — same timing rule as the rows'
      // own author column (see ensureNames in avatar.mjs).
      const logins = []
      Object.values(body.statuses).forEach((st) => (st.reviewers || []).forEach((r) => !r.team && logins.push(r.login)))
      await ensureNames(logins)
      if (gen !== loadGen) return
      Object.keys(body.statuses).forEach((k) => {
        state.statuses[k] = body.statuses[k]
      })
    }
  } catch (e) {
    // status backfill is best-effort — rows just keep their skeleton
  }
}

// kickOffApprovals backfills the per-PR approval badge (GET /api/approvalsummary),
// mirroring kickOffStatuses. Only ingested rows (pr.hasGraph) have an approval
// concept, so we scope the request to those numbers — that also bounds the
// (worktree/LCS) server-side cost to just the visible ingested rows.
async function kickOffApprovals(gen) {
  const keys = []
  state.sections.forEach((sec) => sec.prs.forEach((pr) => pr.hasGraph && keys.push(prUid(pr))))
  if (!keys.length) return
  try {
    const res = await fetch('/api/approvalsummary?prs=' + encodeURIComponent(keys.join(',')))
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return // page moved on — drop this response
    if (body && body.ok && body.summaries) {
      Object.keys(body.summaries).forEach((k) => {
        state.approvals[k] = body.summaries[k]
      })
    }
  } catch (e) {
    // approval backfill is best-effort — rows just show no badge
  }
}

// kickOffPendingPush backfills the "ongepusht" badge (GET /api/pending-push),
// mirroring kickOffApprovals: only ingested rows can have landed chat edits, so
// the request is scoped to those numbers. Best-effort — a failure just leaves
// the rows without the badge.
async function kickOffPendingPush(gen) {
  const keys = []
  state.sections.forEach((sec) => sec.prs.forEach((pr) => pr.hasGraph && keys.push(prUid(pr))))
  if (!keys.length) return
  try {
    const res = await fetch('/api/pending-push?prs=' + encodeURIComponent(keys.join(',')))
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return // page moved on — drop this response
    if (body && body.ok && body.pending) {
      Object.keys(body.pending).forEach((k) => {
        state.pendingPush[k] = body.pending[k]
      })
    }
  } catch (e) {
    // pending-push backfill is best-effort — rows just show no badge
  }
}

// kickOffCheckout backfills the checkout badge (GET /api/chat/checkout),
// mirroring kickOffPendingPush exactly.
async function kickOffCheckout(gen) {
  const keys = []
  state.sections.forEach((sec) => sec.prs.forEach((pr) => pr.hasGraph && keys.push(prUid(pr))))
  if (!keys.length) return
  try {
    const res = await fetch('/api/chat/checkout?prs=' + encodeURIComponent(keys.join(',')))
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return // page moved on — drop this response
    if (body && body.ok && body.checkout) {
      Object.keys(body.checkout).forEach((k) => {
        state.checkout[k] = body.checkout[k]
      })
    }
  } catch (e) {
    // checkout backfill is best-effort — rows just show no badge
  }
}

let searchTimer = null
let searchSeq = 0

async function runSearch(q) {
  const seq = ++searchSeq
  state.searching = true
  try {
    const res = await fetch('/api/prs/search?q=' + encodeURIComponent(q))
    if (!res.ok) {
      if (seq === searchSeq) state.searchResults = []
      return
    }
    const body = await res.json()
    if (seq !== searchSeq) return // a newer query has already landed
    const rows = body && body.ok && Array.isArray(body.prs) ? body.prs : []
    await primeAuthorNames(rows) // real names before the rows mount (see avatar.mjs)
    if (seq !== searchSeq) return
    state.searchResults = rows
  } catch (e) {
    if (seq === searchSeq) state.searchResults = []
  } finally {
    if (seq === searchSeq) state.searching = false
  }
}

// ── keyboard navigation ──────────────────────────────────────────────────
// A capture-phase window keydown, rebuilt whenever the set of navigable rows
// could have changed (see scheduleRepaint). Every keyboard move resets
// hoverEnabled so a synthetic mouseenter fired by scrollIntoView can't
// hijack the selection; hoverEnabled only turns back on from a real
// mousemove.
//
// "Real" is load-bearing here: browsers (Chromium in particular) dispatch a
// synthetic `mousemove` DOM event at the cursor's last known position to
// resync :hover state whenever content scrolls/re-lays-out underneath a
// stationary cursor — exactly what our own `scrollIntoView` in
// paintSelection() triggers on every keyboard step. A plain
// `addEventListener('mousemove', ...)` can't tell that synthetic event apart
// from a genuine mouse move, so it kept re-enabling hoverEnabled right after
// a keypress disabled it, and the very next mouseenter (on whatever row now
// happens to sit under the idle cursor because the list scrolled) yanked
// selIndex back — which is exactly what looked like "the items keep sliding
// along" when navigating with the arrow keys. The fix: only treat a
// mousemove as real if the pointer's coordinates actually changed since the
// last one we saw.

// selIndex is the derived position used for painting/scrolling; selKey is
// the actual source of truth — the stable `data-nav-key` of the row the
// reviewer selected (see prRow/recentItem). Tracking identity instead of a
// bare array position matters because the underlying row set can change
// out from under the reviewer without any keypress of their own: a
// background snapshot reload (reloadSnapshot, every 60s) can reorder PRs
// across sections/stacks, toggling "Recent gegenereerd" appends/removes
// rows, and typing/clearing the search box swaps the entire row set for an
// unrelated one. Before this fix, selIndex stayed a raw number through all
// of that, so paintSelection() kept re-highlighting "whatever row now sits
// at that position" — often a completely different PR than the one the
// reviewer actually selected. reanchorSelection() (below) re-derives
// selIndex from selKey on every repaint; if the selected row is genuinely
// gone it releases the selection (no ring) instead of drifting onto an
// unrelated row.
let selIndex = -1
let selKey = null
let hoverEnabled = false

// ── popover keyboard navigation ─────────────────────────────────────────
// While a popover is open it owns ↑/↓ (and Enter/Escape) outright — the row
// list's own keyboard nav (move/moveTo/activateSelected below) is suspended
// for as long as ui.openPopover is set, handled by a dedicated branch at the
// very top of kbHandler so no key ever falls through to the list.

function popoverItems() {
  const pop = document.querySelector('[data-testid="pr-popover"]')
  if (!pop) return []
  return Array.from(pop.querySelectorAll('button:not([disabled]), a[href]'))
}

function focusPopoverItem(idx) {
  const items = popoverItems()
  if (!items.length) return
  const i = Math.max(0, Math.min(items.length - 1, idx))
  items[i].focus()
}

// movePopover cycles the focused item by `delta`, wrapping around both ends
// — a real menu-widget feel (↓ from the last item goes back to the first,
// ↑ from the first wraps to the last).
function movePopover(delta) {
  const items = popoverItems()
  if (!items.length) return
  const idx = items.indexOf(document.activeElement)
  const next = idx === -1 ? (delta > 0 ? 0 : items.length - 1) : (idx + delta + items.length) % items.length
  items[next].focus()
}

function closePopover() {
  ui.openPopover = null
  ui.ingestError = null
  ui.ingestErrorFor = null
  ui.readyFor = null
  ui.reviewersError = null
  ui.removeReviewerError = null
}

// handlePopoverKey is the entire keyboard surface while a popover is open:
// ↑/↓ cycle its items, Enter/Space activate the focused item natively (we
// deliberately do NOT call preventDefault there — the focused element is a
// real <button>/<a href>, so the browser's own Enter/Space activation just
// works, identical to a mouse click), Escape closes it. Every other key is
// swallowed so it can't leak through to the list nav below.
function handlePopoverKey(e) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      movePopover(1)
      return
    case 'ArrowUp':
      e.preventDefault()
      movePopover(-1)
      return
    case 'Escape':
      e.preventDefault()
      closePopover()
      return
    case 'Enter':
    case ' ':
      // Let the native button/link activation run.
      return
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'Home':
    case 'End':
    case '/':
      // These drive the row list (or the search box) the rest of the time —
      // swallow them here so they can't reach for the list underneath while
      // the popover has the keyboard, but leave anything else (notably Tab)
      // alone.
      e.preventDefault()
      return
    default:
      return
  }
}

function currentRows() {
  return Array.from(document.querySelectorAll('[data-nav-row]'))
}

// reanchorSelection re-derives selIndex from the stable selKey identity
// against the row list currently in the DOM. Called at the top of every
// paintSelection() — including the repaint-only path (scheduleRepaint,
// triggered by a data change, not a keypress) — so a reshuffled/replaced
// row set never leaves the ring on an unrelated row: if selKey's row is
// still present, the ring simply follows it to its new position; if it
// genuinely isn't there anymore, the selection is released (selIndex = -1)
// rather than drifting onto whatever now happens to occupy the old slot.
function reanchorSelection(rows) {
  if (selKey == null) {
    selIndex = -1
    return
  }
  selIndex = rows.findIndex((el) => el.dataset.navKey === selKey)
}

// SELECT_RING_CLS — the wel/niet-geselecteerd classes paintSelection() toggles,
// in the same indigo tone /pr/<id> uses for its own "selected/focused"
// convention (see the "Focus highlight per stop" section in
// .claude/docs/keyboard-navigation.md and BlockList.mjs's own rowFocused
// ring) — was emerald before this change, which had no meaning tied to it
// elsewhere in the app. Kept WITHOUT a separate dark: ring/bg variant,
// mirroring the emerald set it replaces: a semi-transparent ring/tint reads
// fine on both a white and a zinc-900 background, so this intentionally
// doesn't grow the toggle set. This ring+background tint is now the ONLY
// selection signal on this page — the earlier always-present `›` chevron
// (selectMark()/SELECT_MARK_ON/OFF, a deliberate colourblind-safe shape cue)
// was removed on explicit request; see .claude/docs/pages-and-routing.md.
const SELECT_RING_CLS = ['ring-1', 'ring-indigo-500/50', 'rounded-lg', 'z-10', 'bg-indigo-500/10']

function paintSelection() {
  const rows = currentRows()
  reanchorSelection(rows)
  rows.forEach((el, i) => {
    el.dataset.navIndex = String(i)
    el.onmouseenter = () => {
      if (!hoverEnabled) return
      selIndex = i
      selKey = el.dataset.navKey || null
      paintSelection()
    }
    // Note: `relative` is deliberately NOT part of this toggle set. prRow's
    // own template already carries `relative` permanently (its click-opened
    // popover is `position:absolute` and needs the row as its containing
    // block) — toggling it here alongside the keyboard-highlight ring used
    // to strip it from every non-selected row on the very first paint
    // (selIndex starts at -1, so `classList.remove` ran unconditionally for
    // every row), leaving the popover positioned relative to <body> instead
    // of its own row. `z-10` still gets a stacking context from the row's
    // own always-on `relative`, so nothing here relied on toggling it.
    if (i === selIndex) {
      el.classList.add(...SELECT_RING_CLS)
    } else {
      el.classList.remove(...SELECT_RING_CLS)
    }
  })
  if (selIndex >= 0 && rows[selIndex]) rows[selIndex].scrollIntoView({ block: 'nearest' })
}

function move(delta) {
  const rows = currentRows()
  if (!rows.length) return
  const base = selIndex < 0 ? (delta > 0 ? -1 : 0) : selIndex
  selIndex = Math.max(0, Math.min(rows.length - 1, base + delta))
  selKey = rows[selIndex] ? rows[selIndex].dataset.navKey || null : null
  hoverEnabled = false
  paintSelection()
}

function moveTo(idx) {
  const rows = currentRows()
  if (!rows.length) return
  selIndex = Math.max(0, Math.min(rows.length - 1, idx))
  selKey = rows[selIndex] ? rows[selIndex].dataset.navKey || null : null
  hoverEnabled = false
  paintSelection()
}

// focusSearch hands the keyboard to the top search box and releases the row
// selection — the ArrowUp-past-the-first-row target (the search box searches
// all open PRs, not just the inbox).
function focusSearch() {
  const el = document.querySelector('[data-testid="search"]')
  if (el) el.focus()
  selKey = null
  selIndex = -1
  paintSelection()
}

function activateSelected() {
  const rows = currentRows()
  const el = rows[selIndex]
  if (!el) return
  if (el.matches('a[href]')) {
    // A row that opens in a new window (the Jira notifications) must do so
    // from the keyboard too — and its own @click handler (mark read) has to
    // run, which location.href would skip. A real click does both.
    if (el.getAttribute('target') === '_blank') {
      el.click()
      return
    }
    location.href = el.getAttribute('href')
    return
  }
  el.click()
}

// findPrByUid looks up a PR object (carrying hasGraph) by prUid across
// every place a pr-row can currently be rendered from: the live sections
// (including PRs lifted into a stack — those are the same object references
// pushed into `all` in mainContent, so they're found here too) and, when the
// search box is active, the search results. recentPrs is deliberately not
// searched: its rows are plain <a href> links (already handled by the
// a[href] branch in activateSelectedForward below), not popover rows, and it
// doesn't carry hasGraph anyway.
function findPrByUid(uid) {
  for (const sec of state.sections) {
    const found = sec.prs.find((p) => prUid(p) === uid)
    if (found) return found
  }
  if (Array.isArray(state.searchResults)) {
    const found = state.searchResults.find((p) => prUid(p) === uid)
    if (found) return found
  }
  return null
}

// openOrGenerate is the → ("go right") action for a pr-row: unlike Enter
// (which always just opens the popover menu, unchanged), → means "act now" —
// jump straight into the tree if it exists, or generate it and land there
// automatically once it's ready. A hasGraph PR navigates immediately, exactly
// like clicking "Open review-boom". A not-yet-ingested PR opens its popover
// (togglePopover — at this call site ui.openPopover is always null, since
// kbHandler only reaches here when no popover is already open, so this always
// opens rather than toggles closed) and immediately fires generatePage(pr)
// with the default redirect:true — this reuses 100% of the existing busy
// spinner/stage-label/inline-error UI (ingestBusy/ingestLabel/ingestIcon,
// generate-error) with zero new markup: it's functionally "click the row,
// click Genereer" collapsed into one keystroke. On success generatePage
// itself redirects into /pr/<id>; on failure the popover stays open with the
// same inline error a mouse-driven attempt would show.
function openOrGenerate(pr) {
  if (!repoReady(pr)) {
    // Same as a click: just reveal the popover (now showing only the
    // disabled "Repo is niet beschikbaar" item) — no external navigation.
    togglePopover(prUid(pr))
    return
  }
  if (!treeSupported(pr)) {
    openOnGithub(pr)
    return
  }
  if (pr.hasGraph) {
    location.href = treeUrl(pr)
    return
  }
  togglePopover(prUid(pr))
  generatePage(pr)
}

// activateSelectedForward is → 's row-activation counterpart to
// activateSelected (which Enter keeps using unchanged). A recent-drawer item
// is a plain <a href> and already means "go there now", so it's handled
// identically to Enter. A pr-row instead resolves its PR object (via
// data-pr + findPrByUid) and routes through openOrGenerate; if the PR
// can't be resolved (shouldn't happen — defensive only) it falls back to the
// existing activateSelected() so → never becomes a dead key.
function activateSelectedForward() {
  const rows = currentRows()
  const el = rows[selIndex]
  if (!el) return
  if (el.matches('a[href]')) {
    if (el.getAttribute('target') === '_blank') {
      el.click()
      return
    }
    location.href = el.getAttribute('href')
    return
  }
  const pr = findPrByUid(el.dataset.pr)
  if (!pr) {
    activateSelected()
    return
  }
  openOrGenerate(pr)
}

// ── the general command menu (`/`) ──────────────────────────────────────────
// `/` used to focus the search box. It now opens a general command menu, the
// same shape /pr/<id> uses for every one of its menus (contextMenuMode, see
// .claude/docs/command-palette.md): reviewer request — "in pr overview een
// geheel algemeen menu (nu zonder items behalve het typen en sluiten)". The
// search box stays reachable with ↑ from the first row and with the mouse.
//
// The per-row popover is deliberately NOT folded into this component (see
// .claude/docs/pr-overview.md): its reviewer picker and ingest spinner/stage/
// error UI are not command rows.
const menu = reactive({ open: false })

// omenu is the DISPOSABLE half, replaced wholesale on every open — the same
// stable-`menu` + fresh-`ms` split home.mjs uses, and for the same reason:
// arrow.js does not fully clean up a dropped subtree, so a previous open's
// (orphaned) CommandMenu bindings would otherwise fire against this open's
// state. See "Orphan bindings of a dropped subtree" in
// .claude/rules/arrowjs-pitfalls.md.
let omenu = reactive({ query: '', sel: 0, sub: null, mode: 'overview', commands: [] })

// OVERVIEW_COMMANDS is deliberately empty for now: the menu exists, you can
// type in it, and the pinned "Sluit menu" (mirroring withClose in home.mjs) is
// its only item — actions land here later. withClose's own rule applies: since
// the pinned row is index 0 and there is nothing else yet, defaultSel would
// clamp to 0 anyway.
const OVERVIEW_COMMANDS = []

function overviewCommands() {
  return [{ id: 'close-menu', label: t('Sluit menu'), hint: 'esc', run: () => closeMenu() }, ...OVERVIEW_COMMANDS]
}

function resolveOverviewCommands(query) {
  return filterCommands(omenu.commands, query)
}

function openMenu() {
  omenu = reactive({ query: '', sel: Math.min(1, Math.max(0, overviewCommands().length - 1)), sub: null, mode: 'overview', commands: overviewCommands() })
  menu.open = true
  requestAnimationFrame(() => {
    positionMenu()
    const el = document.querySelector('[data-testid="command-input"]')
    if (el) el.focus()
  })
}

function closeMenu() {
  // Only flip `open` — omenu is replaced on the next open, and leaving this
  // (now orphaned) one untouched is exactly what keeps the torn-down menu's
  // bindings from firing against freed slots.
  menu.open = false
}

function runOverviewCommand(cmd) {
  closeMenu()
  if (cmd && cmd.run) requestAnimationFrame(() => cmd.run())
}

// positionMenu anchors the palette under the selected row when there is one,
// else under the search box — the same "sit where the reviewer is looking"
// idea as home.mjs's positionMenu, minus its per-mode anchor/region table
// (this page has exactly one menu). Clamped inside the viewport, and flipped
// above its anchor when it would not fit below.
function positionMenu() {
  const el = document.querySelector('[data-testid="command-anchor"]')
  if (!el) return
  const rows = currentRows()
  const anchorEl = rows[selIndex] || document.querySelector('[data-testid="search"]')
  if (!anchorEl) return
  const a = anchorEl.getBoundingClientRect()
  const width = Math.min(a.width, window.innerWidth - 16)
  el.style.width = width + 'px'
  const h = el.offsetHeight || 320
  const below = a.bottom + 6
  const top = below + h > window.innerHeight - 8 ? Math.max(8, a.top - 6 - h) : below
  el.style.left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8)) + 'px'
  el.style.top = top + 'px'
  el.style.visibility = 'visible'
}

window.addEventListener('resize', () => menu.open && positionMenu())
window.addEventListener('scroll', () => menu.open && positionMenu(), true)

function menuOverlay() {
  return html`
    <div class="fixed inset-0 z-40" data-testid="command-overlay" @click="${() => closeMenu()}">
      <div
        class="fixed z-50 max-w-[calc(100vw-1rem)]"
        style="top:0;left:0;visibility:hidden"
        data-testid="command-anchor"
        @click="${(e) => e.stopPropagation()}"
      >
        ${CommandMenu(omenu, resolveOverviewCommands, runOverviewCommand)}
      </div>
    </div>
  `
}

// MenuHost mounts the overlay at the page root (see home.mjs's own MenuHost
// for the stacking-context reasoning). The toggling slot sits inside a stable
// element root and returns a keyed template, per the "bare toggling
// expression" pitfall in .claude/rules/arrowjs-pitfalls.md.
function MenuHost() {
  return html` <div>${() => (menu.open ? menuOverlay().key('command-overlay') : '')}</div> `
}

// handleMenuKey is the entire keyboard surface while the menu is open: it owns
// the keyboard, exactly like home.mjs's own menu branch. ↑/↓ move the
// selection, Enter runs it, Escape closes; typed characters flow into the
// focused input untouched.
function handleMenuKey(e) {
  const list = resolveOverviewCommands(omenu.query)
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    omenu.sel = Math.min(omenu.sel + 1, Math.max(0, list.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    omenu.sel = Math.max(omenu.sel - 1, 0)
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (list[omenu.sel]) runOverviewCommand(list[omenu.sel])
  }
  if (menu.open) requestAnimationFrame(positionMenu)
}

let kbHandler = null
function setupKeyboard() {
  if (kbHandler) window.removeEventListener('keydown', kbHandler, true)
  kbHandler = (e) => {
    // The global failed-tasks dialog owns the keyboard while it is up — same
    // "checked first" contract as home.mjs's own guard (failedTasks.mjs).
    // The auth dialog outranks it (src/authStatus.mjs), same contract.
    if (isAuthProblemOpen()) return handleAuthProblemKeydown(e)
    if (isFailedTasksOpen()) return handleFailedTasksKeydown(e)
    // The open menu owns the keyboard — checked before everything else,
    // mirroring home.mjs's own menu branch (and the popover branch below).
    if (menu.open) return handleMenuKey(e)
    if (ui.openPopover != null) return handlePopoverKey(e)
    // The Jira bell dropdown is a light, non-modal popover — only Escape does
    // something; every other key is swallowed so list navigation can't fire
    // underneath an open dropdown (same reasoning as the row popover above).
    if (state.jiraBellOpen) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeJiraBell()
      }
      return
    }
    const active = document.activeElement
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    if (e.key === '/' && !typing) {
      e.preventDefault()
      openMenu()
      return
    }
    if (typing) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        // At (or above) the first row, ArrowUp jumps up to the search box —
        // which searches all open PRs — instead of clamping on row 0.
        if (selIndex <= 0) {
          focusSearch()
          break
        }
        move(-1)
        break
      case 'Home':
        e.preventDefault()
        moveTo(0)
        break
      case 'End':
        e.preventDefault()
        moveTo(currentRows().length - 1)
        break
      case 'Enter':
        e.preventDefault()
        activateSelected()
        break
      case 'ArrowRight':
        e.preventDefault()
        activateSelectedForward()
        break
    }
  }
  window.addEventListener('keydown', kbHandler, true)
}

// scheduleRepaint runs on a data-driven change of the visible row set (see the
// watch below), never on a keypress. It disarms hoverEnabled for the same
// reason every keyboard move does: the row set just changed underneath a
// possibly stationary cursor, so the *next* mouseenter is very likely not the
// reviewer pointing at that row but a row sliding under the pointer — closing
// the "Recent gegenereerd" drawer, for instance, shrinks the document, the
// browser clamps scrollTop, and whatever row now lands under the idle cursor
// fires a perfectly genuine mouseenter that would hijack the selection.
//
// The coordinate gate on the mousemove listener below can't catch that case on
// its own: the pointer really is at the coordinates it last moved to (e.g. the
// drawer toggle it was just clicked on), so nothing distinguishes "moved here
// and stopped" from "content moved under here". What does distinguish them is
// that no real mouse movement happened *since the layout changed* — hence
// disarming here, synchronously as well as inside the frame, so a boundary
// event dispatched either side of the rAF is ignored either way. A genuine
// mousemove re-arms hover immediately, so hovering keeps working as before.
function scheduleRepaint() {
  hoverEnabled = false
  requestAnimationFrame(() => {
    hoverEnabled = false
    setupKeyboard()
    paintSelection()
  })
}

let lastMouseX = null
let lastMouseY = null
window.addEventListener(
  'mousemove',
  (e) => {
    if (lastMouseX !== null && e.clientX === lastMouseX && e.clientY === lastMouseY) return
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    hoverEnabled = true
  },
  { passive: true },
)

// Close an open popover on any click outside its owning row.
window.addEventListener('mousedown', (e) => {
  if (ui.openPopover == null) return
  const row = e.target.closest && e.target.closest('[data-pr="' + ui.openPopover + '"]')
  if (!row) closePopover()
})

// Close the Jira bell dropdown on any click outside it — same pattern as the
// row-popover listener right above: the toggle button itself sits INSIDE
// [data-testid=jira-bell-wrapper], so clicking it to open/close never
// races with this closing on its own mousedown (unlike a naive
// stopPropagation-on-click approach, which fires one event type too late —
// mousedown always precedes click).
window.addEventListener('mousedown', (e) => {
  if (!state.jiraBellOpen) return
  const wrap = e.target.closest && e.target.closest('[data-testid="jira-bell-wrapper"]')
  if (!wrap) closeJiraBell()
})

// Repaint the nav whenever the visible row set could have changed.
watch(
  () =>
    JSON.stringify([
      state.loading,
      state.error,
      state.sections.length,
      state.query,
      state.searching,
      state.searchResults ? state.searchResults.length : -1,
      state.recentOpen,
      state.recentLoading,
      state.recentPrs.length,
      state.filterOpen,
      state.activePreset,
      state.presetLoading,
      state.presetResults.length,
      // The "Mislukte taken" drawer adds no navigable rows, but expanding it
      // (or a row arriving in it) still changes the document height — exactly
      // the scroll-clamp case scheduleRepaint's own comment describes, where a
      // row can slide under a parked cursor. Repainting disarms hoverEnabled
      // for that frame, same as the recent drawer above.
      state.problemsOpen,
      state.failedRuns.length,
      state.logErrors.length,
      // The Jira block's rows are navigable too, and both the feed arriving
      // and the unread filter change how many there are.
      state.jira.length,
      state.jiraUnreadOnly,
    ]),
  () => scheduleRepaint(),
)

// ── live sync with the pr_inbox workflow ───────────────────────────────────
// The overview never calls GitHub itself; the pr_inbox workflow owns that and
// writes a read-model. Here we (a) tell the workflow to re-check GitHub on load
// (a "refresh" signal), (b) heartbeat while the tab is genuinely active so the
// workflow keeps its fast poll cadence, and (c) periodically re-pull the
// read-model so the page reflects the workflow's latest snapshot.

const HEARTBEAT_MS = 60_000 // ping cadence while the tab is active
const RELOAD_MS = 60_000 // re-pull the read-model while the tab is active
let liveSyncStarted = false

// Only beat/refresh when the tab is really being used — visible AND focused —
// so a parked background tab lets the workflow fall back to its idle cadence.
function activeTab() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

async function postWorkflow(path) {
  if (!state.inboxRunId) return
  try {
    await fetch('/api/workflows/' + state.inboxRunId + path, { method: 'POST' })
  } catch (e) {
    // best-effort — the workflow keeps its own cadence regardless
  }
}

function sendRefresh() {
  return postWorkflow('/signals/refresh')
}

function sendHeartbeat() {
  if (!activeTab()) return
  return postWorkflow('/heartbeat')
}

// Re-pull the snapshot without flashing the loading skeleton (a background
// refresh, not a user-triggered load).
async function reloadSnapshot() {
  const gen = ++loadGen
  try {
    const res = await fetch('/api/inbox')
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return
    if (body && body.ok && body.live) {
      state.repo = body.repo || state.repo
      state.generatedFor = body.generatedFor || state.generatedFor
      state.inboxRunId = body.runId || state.inboxRunId
      const sections = normalizeSections(body.sections)
      await primeSectionNames(sections)
      if (gen !== loadGen) return
      state.sections = sections
      state.cached = false
      kickOffStatuses(gen)
      kickOffApprovals(gen)
      kickOffPendingPush(gen)
      kickOffCheckout(gen)
    }
  } catch (e) {
    // keep the current snapshot on a transient failure
  }
}

// After a refresh signal the workflow fetches in the background, so pull the
// fresh snapshot in a few times shortly after (then settle to the slow cadence).
function repollAfterRefresh() {
  let n = 0
  const id = setInterval(() => {
    n++
    if (n > 4 || !activeTab()) {
      clearInterval(id)
      return
    }
    reloadSnapshot()
  }, 1500)
}

// loadProblems pulls the failure list (GET /api/problems, read-only).
// Deliberately its own fetch, NOT folded into loadInbox/reloadSnapshot: those
// await primeAuthorNames before pushing rows into state (see the ensureNames
// timing note in avatar.mjs), and a failure list has no author names to
// resolve — chaining it there would only make both slower and couple two
// unrelated endpoints. Both arrays are reassigned wholesale so arrow.js
// re-renders.
async function loadProblems() {
  const { ok, failedRuns, logErrors, prTitles } = await fetchProblems()
  // A transient failure here must never blank out the list (or the page) —
  // fetchProblems already resolves to empty data on ok:false, so only apply
  // it when the read genuinely succeeded.
  if (!ok) return
  state.failedRuns = failedRuns
  state.logErrors = logErrors
  state.prTitles = prTitles
  state.problemsLoaded = true
}

// ignoreProblemRun permanently deletes one failed run the reviewer decided
// needs no action, then reloads the list. Same endpoint and same reasoning as
// the global popup's own "Negeer" (see ignoreRuns in src/failedTasks.mjs):
// starting the ignore_runs Execution is the sanctioned write path, its own
// Activity does the deletion.
async function ignoreProblemRun(run) {
  if (!run || !run.runId) return
  try {
    await fetch('/api/workflows/ignore-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runIds: [run.runId] }),
    })
  } catch (err) {
    console.error('ignore run failed:', err)
  }
  await loadProblems()
}

// loadRunningCount pulls the live "how much is running right now" figure
// (GET /api/running-count, read-only) for the badge next to the PR count in
// headerBlock(). Its own fetch, same reasoning as loadProblems: unrelated to
// reloadSnapshot's author-name priming, and rides along on the same
// RELOAD_MS cadence in startLiveSync rather than a timer of its own.
async function loadRunningCount() {
  try {
    const res = await fetch('/api/running-count')
    if (!res.ok) return
    const body = await res.json()
    if (!body || !body.ok) return
    state.runningCount = typeof body.running === 'number' ? body.running : 0
  } catch (e) {
    // keep whatever we already showed — a transient failure here must never
    // blank the badge back to 0.
  }
}

function startLiveSync() {
  if (liveSyncStarted || !state.inboxRunId) return
  liveSyncStarted = true
  sendRefresh().then(() => {
    sendHeartbeat()
    repollAfterRefresh()
  })
  setInterval(sendHeartbeat, HEARTBEAT_MS)
  setInterval(() => {
    if (activeTab()) {
      reloadSnapshot()
      // These ride along on the existing cadence — no timer of their own. The
      // Jira read-model itself is refreshed server-side every 5 minutes (see
      // jira_notifications.go); this only re-reads it.
      loadProblems()
      loadRunningCount()
      loadJiraNotifications()
    }
  }, RELOAD_MS)
  document.addEventListener('visibilitychange', sendHeartbeat)
}

App()(document.getElementById('app'))
FailedTasksHost()(document.getElementById('app'))
AuthStatusHost()(document.getElementById('app'))
initFailedTasksPopup()
initAuthStatusPopup()
loadInbox()
loadProblems()
loadRunningCount()
loadJiraNotifications()
ensureAutoIngestPref()
ensureAutoWarn()
scheduleRepaint()
