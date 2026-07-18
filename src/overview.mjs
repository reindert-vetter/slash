// overview.mjs — the /pr-overview page: a live GitHub PR inbox modeled on
// github.com/pulls (and styled after the reference dash app's home.mjs /
// icons.mjs). Sections mirror GitHub's own dashboard buckets (English
// titles); everything else is read-only — this page never mutates state (per
// .claude/rules/workflows-write-boundary.md). Rows paint fast from GET
// /api/inbox, then their status pills (review/checks/reviewers) backfill from
// GET /api/inbox/status without the row jumping. Falls back to a static
// /data/inbox.json snapshot when the live endpoint is unreachable.

import { reactive, html, watch } from './vendor/arrow.js'
import { initTheme, themeToggleButton } from './theme.mjs'
import { avatarHTML } from './avatar.mjs'

initTheme()

// Configure this to your Jira instance — used only to build the "Open
// Jira-ticket" popover link when a PR title contains a KEY-123-style key.
const JIRA_BASE = 'https://plugandpaybv.atlassian.net/browse/'

const state = reactive({
  repo: '',
  generatedFor: '',
  loading: true,
  error: '',
  cached: false,
  inboxRunId: '', // pr_inbox workflow Run ID — target for refresh signal + heartbeat
  sections: [], // [{ title, prs: Row[] }]
  statuses: {}, // pr.number -> Status, backfilled async
  query: '',
  searching: false,
  searchResults: null, // null = no active search
  recentOpen: false,
  recentLoading: false,
  recentPrs: [], // [{ pr, blocks, files }]
})

// ui is separate from state so opening/closing a popover doesn't touch the
// bits bound into url-less local reactivity elsewhere.
// ingesting: the pr.number currently running /api/ingest (disables its "Genereer
// review-boom"/"Opnieuw genereren" button); ingestStage: the current ingest
// pipeline stage for that PR ("worktrees"/"scan"/"relations"/""), polled from
// GET /api/ingest/progress while busy — see INGEST_STAGE_LABELS below;
// ingestError + ingestErrorFor: the last ingest failure message and which PR it
// belongs to (cleared on a fresh attempt or when its popover closes) —
// ingestErrorFor lets the standalone regenerate button on an already-ingested
// row show the error under the right row even though ui.ingesting itself has
// already reset to null by the time the catch runs.
const ui = reactive({ openPopover: null, ingesting: null, ingestStage: '', ingestError: null, ingestErrorFor: null })

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

// relativeTime formats an ISO timestamp as "3 uur geleden" style text via
// Intl.RelativeTimeFormat, falling back to a manual computation if that API
// throws (very old browsers / unsupported locale data).
function relativeTime(iso) {
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

function chip(text, cls, testid, iconName) {
  return html`<span
    class="${'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ' + cls}"
    data-testid="${testid || ''}"
    >${iconName ? icon(iconName, 'h-3 w-3') : null}<span>${text}</span></span
  >`
}

// ── status pills (review chip, checks chip, reviewer avatars) ──────────────

const STATE_LABEL = {
  APPROVED: 'goedgekeurd',
  CHANGES_REQUESTED: 'wijzigingen gevraagd',
  COMMENTED: 'reactie geplaatst',
  DISMISSED: 'afgewezen',
  PENDING: 'in afwachting',
}

function reviewChip(pr, status) {
  if (pr.isDraft) return chip('Concept', 'bg-slate-100 dark:bg-zinc-500/15 text-slate-500 dark:text-zinc-400 ring-slate-300/50 dark:ring-zinc-500/30', 'review-chip', 'git-pull-request')
  const d = status.reviewDecision
  if (d === 'APPROVED') return chip('Goedgekeurd', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'review-chip', 'check')
  if (d === 'CHANGES_REQUESTED')
    return chip('Wijzigingen gevraagd', 'bg-rose-500/15 text-rose-700 dark:text-rose-300 ring-rose-500/30', 'review-chip', 'x')
  return chip('Wacht op review', 'bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30', 'review-chip', 'clock')
}

function checksChip(status) {
  if (!status.checksTotal) return null
  const n = status.checksTotal
  const s = status.checksState
  if (s === 'FAILURE' || s === 'ERROR')
    return chip(n + ' checks', 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/30', 'checks-chip', 'x')
  if (s === 'PENDING' || s === 'EXPECTED')
    return chip(n + ' bezig', 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/30', 'checks-chip', 'clock')
  if (s === 'SUCCESS')
    return chip(n + ' checks', 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'checks-chip', 'check')
  return chip(n + ' checks', 'bg-slate-100 dark:bg-zinc-500/10 text-slate-500 dark:text-zinc-400 ring-slate-300/50 dark:ring-zinc-500/30', 'checks-chip', 'clock')
}

function reviewerAvatar(r) {
  const login = r.login || '?'
  const pending = r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'COMMENTED'
  const label = STATE_LABEL[r.state] || r.state || ''
  // Precompute per the branch avatarHTML takes internally (image vs
  // initials-fallback), so the pending-dimming keeps looking exactly like it
  // did before this circle was extracted into the shared avatarHTML helper.
  const extra = pending ? (r.avatarUrl ? 'opacity-50 grayscale' : 'opacity-60') : ''
  // avatarHTML derives initials from just the first two characters, so
  // passing "login — label" as the name keeps the same tooltip text the
  // reviewer strip had before, without a separate title param.
  return html`
    <span class="relative inline-block">
      ${avatarHTML(login + ' — ' + label, r.avatarUrl, 'h-6 w-6', extra)}
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

// statusFor resolves a PR's Status either from the async inbox-status
// backfill (state.statuses, keyed by number) or, for search results (whose
// Row already carries the Status fields inline per the API contract), from
// the row itself.
function statusFor(pr) {
  const live = state.statuses[pr.number]
  if (live) return live
  if (pr.reviewDecision !== undefined || pr.reviewers !== undefined || pr.checksTotal !== undefined) return pr
  return null
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
  pills.push(reviewChip(pr, status).key('review:' + (pr.isDraft ? 'draft' : status.reviewDecision || 'none')))
  const checks = checksChip(status)
  if (checks) pills.push(checks.key('checks:' + (status.checksState || '') + ':' + status.checksTotal))
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
  if (pr.hasGraph) return chip('generated', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', 'graph-chip', 'sparkles')
  return chip('op GitHub ›', 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-sky-500/30', 'graph-chip')
}

function commentsBit(pr) {
  if (!pr.comments) return null
  return html`<span class="inline-flex items-center gap-1 text-[12px] text-slate-500 dark:text-zinc-500"
    >${icon('message', 'h-3.5 w-3.5')}${pr.comments}</span
  >`
}

// ── rows ─────────────────────────────────────────────────────────────────

function diffStatFragment(pr) {
  const add = Number(pr.additions) || 0
  const del = Number(pr.deletions) || 0
  const files = Number(pr.changedFiles) || 0
  if (!add && !del && !files) return null
  return html`
    <span class="flex items-center gap-1.5">
      <span class="text-slate-300 dark:text-zinc-700">·</span>
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
    </span>
  `
}

// The PR's own (current) branch — shown in the same sky color on every row so
// you can spot which branch a PR lives on at a glance. Deliberately no target
// branch here (even inside a stack): the stack indentation already conveys
// the merge order.
function branchFragment(pr) {
  if (!pr.headRefName) return null
  return html`
    <span class="flex items-center gap-1">
      <span class="text-slate-300 dark:text-zinc-700">·</span>
      <span
        class="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-sky-600/90 dark:text-sky-400/90"
        title="Huidige branch"
      >
        ${icon('git-branch', 'h-3 w-3')}<span class="truncate">${pr.headRefName}</span>
      </span>
    </span>
  `
}

function rowMeta(pr) {
  return html`
    <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-slate-500 dark:text-zinc-500">
      <span class="font-mono">${() => state.repo || ''}#${pr.number}</span>
      <span class="text-slate-300 dark:text-zinc-700">·</span>
      <span>${pr.author}</span>
      <span class="text-slate-300 dark:text-zinc-700">·</span>
      <span title="${pr.updatedAt || ''}">Bijgewerkt ${relativeTime(pr.updatedAt)}</span>
      ${diffStatFragment(pr)} ${branchFragment(pr)}
    </div>
  `
}

function prIcon(pr) {
  return html`<span class="${'mt-0.5 shrink-0 ' + (pr.isDraft ? 'text-slate-500 dark:text-zinc-500' : 'text-emerald-600 dark:text-emerald-400')}"
    >${icon('git-pull-request', 'h-4 w-4')}</span
  >`
}

// sectionBadge — inside a stack we lift PRs out of their normal buckets, so a
// small badge reminds you which section each one would otherwise sit in.
function sectionBadge(label) {
  return html`<span
    class="shrink-0 rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:text-zinc-400"
    title="Hoort normaal in deze sectie"
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
    prIcon(pr),
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
        ${statusArea(pr)} ${commentsBit(pr)} ${graphChip(pr)} ${chevronFilled('h-4 w-4 text-slate-400 dark:text-zinc-600 group-hover:text-slate-600 dark:group-hover:text-zinc-300')}
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
function togglePopover(number) {
  const opening = ui.openPopover !== number
  ui.openPopover = opening ? number : null
  ui.ingestError = null
  ui.ingestErrorFor = null
  if (opening) requestAnimationFrame(() => focusPopoverItem(0))
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
// `redirect` defaults to true (generateAction's "Genereer review-boom" for a
// not-yet-ingested row: after generating for the first time you want to land
// straight in the fresh tree). ingestedActions' "Opnieuw genereren" passes
// `redirect: false` — an already-ingested row's regenerate only refreshes the
// existing tree's data in the background; the reviewer is still on the
// overview and didn't ask to be navigated away.
//
// While the POST is in flight, generatePage polls GET /api/ingest/progress —
// a purely in-memory, ephemeral read of which pipeline stage the server is
// currently running for this PR (see ingest_progress.go) — into ui.ingestStage,
// so the busy button shows real progress instead of a static "Bezig met
// genereren…" (see INGEST_STAGE_LABELS + generateAction/ingestedActions below).
let ingestPollTimer = null

function stopIngestPoll() {
  if (ingestPollTimer) {
    clearInterval(ingestPollTimer)
    ingestPollTimer = null
  }
}

async function pollIngestStage(prNumber) {
  try {
    const res = await fetch('/api/ingest/progress?pr=' + prNumber)
    if (!res.ok) return
    const body = await res.json()
    // Drop a stale response if a different (or no longer active) ingest has
    // since taken over — mirrors the ingestErrorFor guard below.
    if (ui.ingesting === prNumber && body && body.ok) ui.ingestStage = body.stage || ''
  } catch (e) {
    // best-effort — the button just keeps its last-known/generic label
  }
}

async function generatePage(pr, { redirect = true } = {}) {
  if (ui.ingesting) return // one ingest at a time; button is disabled anyway
  ui.ingesting = pr.number
  ui.ingestStage = ''
  ui.ingestError = null
  ui.ingestErrorFor = null
  stopIngestPoll()
  pollIngestStage(pr.number)
  ingestPollTimer = setInterval(() => pollIngestStage(pr.number), 800)
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: pr.number }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error((body && body.error) || 'Genereren mislukt (' + res.status + ')')
    }
    if (redirect) {
      location.href = '/pr/' + pr.number
    } else {
      ui.ingesting = null
    }
  } catch (e) {
    ui.ingesting = null
    ui.ingestError = e.message || 'Genereren mislukt'
    ui.ingestErrorFor = pr.number
  } finally {
    stopIngestPoll()
    ui.ingestStage = ''
  }
}

// ingestBusy(pr) / ingestLabel(pr, idleLabel) / ingestIcon(pr) are read from
// their own nested ${() => …} bindings (not a plain `busy` value captured once
// when the popover opens) so they actually react to ui.ingesting/ui.ingestStage
// changing while the popover stays open — the same arrow.js pitfall documented
// in .claude/rules/conventions.md ("een geneste ${() => canStep(...)}-binding"):
// a plain-JS ternary computed inside the outer, only-occasionally-rerun
// ${() => popover(pr)} slot never updates once busy flips mid-render.
function ingestBusy(pr) {
  return ui.ingesting === pr.number
}

function ingestLabel(pr, idleLabel) {
  return ingestBusy(pr) ? INGEST_STAGE_LABELS[ui.ingestStage] || 'Bezig met genereren…' : idleLabel
}

function ingestIcon(pr) {
  return ingestBusy(pr) ? icon('loader', 'h-3.5 w-3.5 animate-spin') : icon('sparkles', 'h-3.5 w-3.5')
}

// generateAction — the not-yet-ingested case: "Genereer review-boom" runs the
// ingest workflow (generatePage above) and redirects into /pr/<id> on success.
function generateAction(pr) {
  return html`
    <button
      type="button"
      data-testid="generate-page"
      ?disabled="${() => ingestBusy(pr)}"
      class="${() =>
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 ' +
        (ingestBusy(pr) ? 'cursor-not-allowed opacity-60' : '')}"
      @click="${() => generatePage(pr)}"
    >
      ${() => ingestIcon(pr)} ${() => ingestLabel(pr, 'Genereer review-boom')}
    </button>
    ${() =>
      ui.ingestError
        ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400" data-testid="generate-error">${ui.ingestError}</p>`
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
      class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700"
      @click="${() => (location.href = '/pr/' + pr.number)}"
    >
      ${icon('sparkles', 'h-3.5 w-3.5')} Open review-boom
    </button>
    <button
      type="button"
      data-testid="regenerate-page"
      ?disabled="${() => ingestBusy(pr)}"
      class="${() =>
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 ' +
        (ingestBusy(pr) ? 'cursor-not-allowed opacity-60' : '')}"
      @click="${() => generatePage(pr, { redirect: false })}"
    >
      ${() => ingestIcon(pr)} ${() => ingestLabel(pr, 'Opnieuw genereren')}
    </button>
    ${() =>
      ui.ingestError
        ? html`<p class="px-2.5 py-1 text-[11px] text-rose-600 dark:text-rose-400" data-testid="regenerate-error">${ui.ingestError}</p>`
        : ''}
  `
}

// popover — every row (ingested or not) opens this same menu on a click: the
// ingest-related action(s) first (which action depends on pr.hasGraph, see
// generateAction/ingestedActions above), then a plain link to GitHub, plus a
// Jira link when the title carries a KEY-123-style ticket key. The panel gets
// a solid (white in light mode) background plus a strong shadow + ring: it
// necessarily overlaps the status pills of the row below, and with a
// near-page-background tint that overlap read as the pill's text being cut
// off instead of a floating menu covering it.
function popover(pr) {
  const m = (pr.title || '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/)
  return html`
    <div
      class="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1 shadow-2xl ring-1 ring-black/5"
      data-testid="pr-popover"
      @click="${(e) => e.stopPropagation()}"
    >
      ${pr.hasGraph ? ingestedActions(pr) : generateAction(pr)}
      <a
        href="${pr.url}"
        target="_blank"
        rel="noreferrer"
        class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700"
      >
        ${icon('external-link', 'h-3.5 w-3.5')} Open op GitHub
      </a>
      ${() =>
        m
          ? html`<a
              href="${JIRA_BASE + m[1]}"
              target="_blank"
              rel="noreferrer"
              class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700"
            >
              ${icon('external-link', 'h-3.5 w-3.5')} Open Jira-ticket
            </a>`
          : ''}
    </div>
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
      data-pr="${pr.number}"
      data-nav-row
      class="${'relative ' + ROW_CLASS}"
      style="${indentStyle(opts)}"
      @click="${() => togglePopover(pr.number)}"
    >
      ${rowInner(pr, opts)} ${() => (ui.openPopover === pr.number ? popover(pr) : null)}
    </div>
  `.key('row:' + pr.number)
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

// computeStacks detects chains of stacked PRs (a PR whose baseRefName equals
// another in-view PR's headRefName). Returns chains ordered bottom (base,
// merges first) → top; only chains of length >= 2 are stacks worth calling
// out. `all` PR objects are read-only here — never mutated.
function computeStacks(all) {
  const byHead = new Map()
  all.forEach((p) => {
    if (p.headRefName) byHead.set(p.headRefName, p)
  })
  const parentOf = new Map() // pr.number -> the pr it's stacked on
  all.forEach((p) => {
    const parent = p.baseRefName ? byHead.get(p.baseRefName) : null
    if (parent && parent.number !== p.number) parentOf.set(p.number, parent)
  })
  const childOf = new Map() // parent.number -> the pr stacked on it
  parentOf.forEach((parent, num) => {
    if (!childOf.has(parent.number)) {
      const child = all.find((p) => p.number === num)
      if (child) childOf.set(parent.number, child)
    }
  })
  const chains = []
  const consumed = new Set()
  all.forEach((p) => {
    if (consumed.has(p.number) || parentOf.has(p.number) || !childOf.has(p.number)) return
    const chain = [p]
    consumed.add(p.number)
    let cur = p
    while (childOf.has(cur.number)) {
      const child = childOf.get(cur.number)
      if (consumed.has(child.number)) break
      chain.push(child)
      consumed.add(child.number)
      cur = child
    }
    if (chain.length >= 2) chains.push(chain)
  })
  return chains
}

// stackGroup renders one chain as its own top-level group, above all section
// blocks: a header (icon + "Gestapelde PR's" + count + caption) followed by
// the framed list, each level indented with a └ connector.
function stackGroup(chain, sectionOf) {
  const root = chain[0]
  return html`
    <div data-testid="stack">
      <div class="mb-2 mt-10 flex items-center gap-2 first:mt-0">
        <span class="text-slate-500 dark:text-zinc-500">${icon('git-pull-request', 'h-3.5 w-3.5')}</span>
        <h2 class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">Gestapelde PR's</h2>
        <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[11px] text-slate-500 dark:text-zinc-400">${chain.length}</span>
        <span class="truncate text-[11.5px] text-slate-500 dark:text-zinc-500"
          >bouwt op <span class="font-mono text-slate-500 dark:text-zinc-400">${root.baseRefName || '?'}</span> — merge van onder naar
          boven</span
        >
      </div>
      ${listBox(chain.map((pr, i) => ({ pr, opts: { depth: i, badge: sectionOf.get(pr.number) } })))}
    </div>
  `.key('stack:' + root.number)
}

// ── sections & layout ────────────────────────────────────────────────────

function sectionBlock(sec, filteredPrs) {
  if (!filteredPrs.length) return null
  return html`
    <section data-testid="section" data-title="${sec.title}">
      <div class="mb-3 mt-16 flex items-center gap-2 first:mt-6">
        <h2 class="text-[15px] font-semibold text-slate-900 dark:text-zinc-100">${sec.title}</h2>
      </div>
      ${listBox(filteredPrs.map((pr) => ({ pr })))}
    </section>
  `.key('section:' + sec.title)
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
            'Pull requests die je aandacht nodig hebben — ' +
            (state.repo || '…') +
            (state.generatedFor ? ' · voor ' + state.generatedFor : '')}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2.5 py-1 text-xs text-slate-500 dark:text-zinc-400"
          >${() => {
            const n = state.sections.reduce((acc, s) => acc + s.prs.length, 0)
            return n + ' PR' + (n === 1 ? '' : 's')
          }}</span
        >
        ${themeToggleButton('h-7 w-7')}
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
        placeholder="${() => `Zoek in alle open PR's van ${state.repo || ''}… (titel, nummer of auteur)`}"
        class="w-full rounded-lg border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/60 py-2.5 pl-9 pr-3 text-[13px] text-slate-900 dark:text-zinc-100 outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-600 focus:border-slate-400 dark:focus:border-zinc-600"
        @input="${onSearchInput}"
        @keydown="${onSearchKeydown}"
      />
    </div>
  `
}

function searchResultsBlock() {
  return html`
    <div data-testid="search-results">
      ${() => {
        if (state.searching) return loadingSkeletonList()
        const results = state.searchResults || []
        return html`
          <div>
            <div class="mb-2 mt-6 flex items-center gap-2 first:mt-0">
              <h2 class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">Alle open PR's — "${state.query}"</h2>
              <span class="rounded-full bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 text-[11px] text-slate-500 dark:text-zinc-400">${results.length}</span>
            </div>
            ${results.length
              ? listBox(results.map((pr) => ({ pr })))
              : html`<p class="py-10 text-center text-sm text-slate-500 dark:text-zinc-500">Geen resultaten voor “${state.query}”.</p>`}
          </div>
        `
      }}
    </div>
  `
}

function mainContent() {
  return html`
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
            if (!sectionOf.has(pr.number)) sectionOf.set(pr.number, sec.title)
          })
        })

        const chains = computeStacks(all)
        const stacked = new Set()
        chains.forEach((c) => c.forEach((pr) => stacked.add(pr.number)))

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
          const filtered = sec.prs.filter((pr) => !stacked.has(pr.number))
          const block = sectionBlock(sec, filtered)
          if (block) out.push(block)
        })
        if (!chains.length && state.sections.every((s) => s.prs.length === 0)) {
          out.push(
            html`<p class="py-10 text-center text-sm text-slate-500 dark:text-zinc-500">Even geen open pull requests.</p>`.key('empty'),
          )
        }
        return out
      }}
    </div>
  `
}

async function toggleRecent() {
  state.recentOpen = !state.recentOpen
  if (state.recentOpen && state.recentPrs.length === 0 && !state.recentLoading) {
    state.recentLoading = true
    try {
      const res = await fetch('/api/prs')
      if (res.ok) {
        const body = await res.json()
        state.recentPrs = Array.isArray(body) ? body : []
      }
    } catch (e) {
      // keep the drawer usable even if this fetch fails
    } finally {
      state.recentLoading = false
    }
  }
}

function recentItem(r) {
  return html`
    <a
      href="${'/pr/' + r.pr}"
      data-testid="recent-item"
      data-pr="${r.pr}"
      data-nav-row
      class="${ROW_CLASS}"
    >
      <span class="shrink-0 text-emerald-600 dark:text-emerald-400">${icon('sparkles', 'h-4 w-4')}</span>
      <div class="min-w-0 flex-1">
        <span class="text-[13.5px] font-semibold text-slate-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white"
          >#${r.pr} · ${r.blocks} ${r.blocks === 1 ? 'blok' : 'blokken'} · ${r.files} ${r.files === 1 ? 'bestand' : 'bestanden'}</span
        >
      </div>
      ${chip('open boom', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30', '', 'sparkles')}
      ${chevronFilled('h-4 w-4 text-slate-400 dark:text-zinc-600 group-hover:text-slate-600 dark:group-hover:text-zinc-300')}
    </a>
  `.key('recent:' + r.pr)
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
        <span class="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">Recent gegenereerd</span>
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
              Nog niets gegenereerd.
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

function App() {
  return html`
    <div class="mx-auto max-w-7xl px-6 py-8" data-testid="inbox">
      ${headerBlock()} ${searchBox()}
      ${() => (state.query.trim() ? searchResultsBlock() : mainContent())} ${recentDrawer()}
    </div>
  `
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
        applyLive(body)
        kickOffStatuses(gen)
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
      applyCached(body2)
      return
    }
  } catch (e) {
    // both sources failed — show the error card below
  }
  if (gen !== loadGen) return
  state.error = 'Kan de inbox niet laden — probeer het later opnieuw.'
  state.loading = false
}

// normalizeSections guarantees every section has a prs array. The Go API
// marshals an empty section's prs slice as null, which would crash the
// .length/.forEach calls that iterate sections.
function normalizeSections(sections) {
  if (!Array.isArray(sections)) return []
  return sections.map((s) => ({ ...s, prs: Array.isArray(s.prs) ? s.prs : [] }))
}

function applyLive(body) {
  state.repo = body.repo || ''
  state.generatedFor = body.generatedFor || ''
  state.inboxRunId = body.runId || ''
  state.sections = normalizeSections(body.sections)
  state.cached = false
  state.loading = false
  // The list comes from the pr_inbox workflow's read-model, never a direct
  // GitHub call. On load we ask that workflow to re-check GitHub now and start
  // heartbeating so it keeps its fast poll cadence while this tab is active.
  startLiveSync()
}

function applyCached(body) {
  state.repo = body.repo || ''
  state.generatedFor = body.generatedFor || ''
  state.cached = true
  const prs = Array.isArray(body.prs) ? body.prs : []
  state.sections = prs.length ? [{ title: 'Needs your review', prs }] : []
  state.loading = false
}

async function kickOffStatuses(gen) {
  const numbers = []
  state.sections.forEach((sec) => sec.prs.forEach((pr) => numbers.push(pr.number)))
  if (!numbers.length) return
  try {
    const res = await fetch('/api/inbox/status?prs=' + numbers.join(','))
    if (!res.ok) return
    const body = await res.json()
    if (gen !== loadGen) return // page moved on (reloaded / re-fetched) — drop this response
    if (body && body.ok && body.statuses) {
      Object.keys(body.statuses).forEach((k) => {
        state.statuses[k] = body.statuses[k]
      })
    }
  } catch (e) {
    // status backfill is best-effort — rows just keep their skeleton
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
    state.searchResults = body && body.ok && Array.isArray(body.prs) ? body.prs : []
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

let selIndex = -1
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

function paintSelection() {
  const rows = currentRows()
  rows.forEach((el, i) => {
    el.dataset.navIndex = String(i)
    el.onmouseenter = () => {
      if (!hoverEnabled) return
      selIndex = i
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
      el.classList.add('ring-1', 'ring-emerald-500/50', 'rounded-lg', 'z-10', 'bg-emerald-500/10')
    } else {
      el.classList.remove('ring-1', 'ring-emerald-500/50', 'rounded-lg', 'z-10', 'bg-emerald-500/10')
    }
  })
  if (selIndex >= 0 && rows[selIndex]) rows[selIndex].scrollIntoView({ block: 'nearest' })
}

function move(delta) {
  const rows = currentRows()
  if (!rows.length) return
  const base = selIndex < 0 ? (delta > 0 ? -1 : 0) : selIndex
  selIndex = Math.max(0, Math.min(rows.length - 1, base + delta))
  hoverEnabled = false
  paintSelection()
}

function moveTo(idx) {
  const rows = currentRows()
  if (!rows.length) return
  selIndex = Math.max(0, Math.min(rows.length - 1, idx))
  hoverEnabled = false
  paintSelection()
}

function activateSelected() {
  const rows = currentRows()
  const el = rows[selIndex]
  if (!el) return
  if (el.matches('a[href]')) {
    location.href = el.getAttribute('href')
    return
  }
  el.click()
}

let kbHandler = null
function setupKeyboard() {
  if (kbHandler) window.removeEventListener('keydown', kbHandler, true)
  kbHandler = (e) => {
    if (ui.openPopover != null) return handlePopoverKey(e)
    const active = document.activeElement
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    if (e.key === '/' && !typing) {
      e.preventDefault()
      const el = document.querySelector('[data-testid="search"]')
      if (el) el.focus()
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
        activateSelected()
        break
    }
  }
  window.addEventListener('keydown', kbHandler, true)
}

function scheduleRepaint() {
  requestAnimationFrame(() => {
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
      state.sections = normalizeSections(body.sections)
      state.cached = false
      kickOffStatuses(gen)
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

function startLiveSync() {
  if (liveSyncStarted || !state.inboxRunId) return
  liveSyncStarted = true
  sendRefresh().then(() => {
    sendHeartbeat()
    repollAfterRefresh()
  })
  setInterval(sendHeartbeat, HEARTBEAT_MS)
  setInterval(() => {
    if (activeTab()) reloadSnapshot()
  }, RELOAD_MS)
  document.addEventListener('visibilitychange', sendHeartbeat)
}

App()(document.getElementById('app'))
loadInbox()
scheduleRepaint()
