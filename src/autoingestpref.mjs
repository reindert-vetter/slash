// autoingestpref.mjs — the reviewer's 3-way preference for AUTOMATIC
// review-tree generation: does the pr_inbox tracker's own refresh also start
// an ingest for a not-yet-generated PR, and for whose? Shared between the
// settings page (a row, see settings.mjs) and the /pr-overview header (next
// to the gear icon, see overview.mjs) — ONE implementation, exactly the way
// theme.mjs/autowarn.mjs are already shared between the two pages.
//
// Three states, same 3-way SHAPE as theme.mjs's system/light/dark cycle, but
// the content is unrelated to it:
//
//   - "off" — never automatic; "Generate review tree" stays a manual click,
//     the pre-existing behaviour.
//   - "own" — automatic only for the reviewer's OWN PRs, and only in
//     "Needs action" / "Waiting for review or checks" / "Your drafts" (NOT
//     "Ready to merge" — nothing left to review there, see
//     eligibleAutoIngestPRs/autoIngestOwnSections in inbox.go). Default when
//     nothing was ever saved.
//   - "all" — automatic for every PR the inbox shows, any author, any
//     section — including a PR someone else asked the reviewer to review, so
//     its tree is ready before they even open it.
//
// Unlike the dark/light theme (a pure frontend preference, localStorage is
// enough), this gates BACKEND behaviour: the pr_inbox tracker's own
// refreshInbox Activity decides, the moment it runs, whether to auto-ingest a
// PR — the server must be able to read the current value instantly, which
// neither localStorage (per-browser, never reaches the server) nor
// settings.json (read once per process) can offer. So it rides the same
// workflow-Signal write path as autowarn: POST /api/workflows/auto_ingest_pref
// ensures the one repo-wide tracker Execution exists, then
// POST .../signals/auto_ingest_pref persists the mode via its own Activity
// (see workflows.go, WorkflowAutoIngestPref/SignalAutoIngestPref). Read side:
// GET /api/autoingestpref — a plain read of the same module, never a direct
// write from here.
import { reactive, html } from './vendor/arrow.js'

export const autoIngestPref = reactive({ mode: 'own', runId: null })

const MODES = ['off', 'own', 'all']

// Word + icon per mode — never colour alone (the reviewer is colourblind,
// see MEMORY.md): the label text always names the state, and each mode gets
// its own glyph shape (not just a filled/open dot), mirroring
// theme.mjs's monitor/sun/moon icons.
const MODE_LABEL = { off: 'Automatisch genereren: uit', own: 'Automatisch genereren: mijn PR’s', all: 'Automatisch genereren: alle PR’s' }
const MODE_ICON = {
  // slash-circle — nothing happens automatically.
  off: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.6 5.4L7.4 18.6M12 2a10 10 0 1 1 0 20',
  // a single person — only the reviewer's own PRs.
  own: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z',
  // two overlapping people — every PR in view.
  all: 'M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20v-1c0-2.5 3.1-4.5 7-4.5s7 2 7 4.5v1H2Zm14.5-5.4c2.6.5 4.5 2.1 4.5 4v1.4h-3v-1c0-1.6-.6-3-1.5-4.4Z',
}

let ensured = null

// ensureAutoIngestPref ensures the tracker Execution exists (POST, idempotent)
// and loads the current preference (GET) — called once per page load on both
// /settings and /pr-overview. Safe to call more than once (dedup via `ensured`).
export function ensureAutoIngestPref() {
  if (ensured) return ensured
  ensured = (async () => {
    try {
      const res = await fetch('/api/workflows/auto_ingest_pref', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.runId) autoIngestPref.runId = data.runId
      }
    } catch (err) {
      console.error('auto_ingest_pref ensure failed:', err)
    }
    await refreshAutoIngestPref()
  })()
  return ensured
}

async function refreshAutoIngestPref() {
  try {
    const res = await fetch('/api/autoingestpref')
    if (res.ok) {
      const data = await res.json()
      if (MODES.includes(data.mode)) autoIngestPref.mode = data.mode
    }
  } catch (err) {
    console.error('auto_ingest_pref refresh failed:', err)
  }
}

// cycleAutoIngestPref steps off → own → all → off and persists it via the
// sanctioned Signal write path — never a direct write, per
// .claude/rules/workflows-write-boundary.md. Optimistic, mirrors
// theme.mjs's cycleTheme / autowarn.mjs's toggleAutoWarn.
export async function cycleAutoIngestPref() {
  const next = MODES[(MODES.indexOf(autoIngestPref.mode) + 1) % MODES.length]
  autoIngestPref.mode = next
  if (!autoIngestPref.runId) {
    await ensureAutoIngestPref()
  }
  if (!autoIngestPref.runId) return
  try {
    await fetch(`/api/workflows/${autoIngestPref.runId}/signals/auto_ingest_pref`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    })
  } catch (err) {
    console.error('auto_ingest_pref toggle failed:', err)
  }
}

// autoIngestPrefToggleButton renders in prInfoCard-style rows on /settings and
// next to the gear icon in /pr-overview's header — one shared component, both
// call sites.
export function autoIngestPrefToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="auto-ingest-pref-toggle"
      title="${() => MODE_LABEL[autoIngestPref.mode] + ' (klik om te wisselen)'}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (autoIngestPref.mode === 'off'
          ? 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800'
          : autoIngestPref.mode === 'own'
            ? 'text-emerald-700 dark:text-emerald-400 ring-emerald-200 dark:ring-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
            : 'text-indigo-700 dark:text-indigo-400 ring-indigo-200 dark:ring-indigo-500/30 hover:bg-indigo-50 dark:hover:bg-indigo-500/10') +
        ' ' +
        cls}"
      @click="${cycleAutoIngestPref}"
    >
      <svg
        data-testid="auto-ingest-pref-toggle-icon"
        class="h-3 w-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="${() => MODE_ICON[autoIngestPref.mode]}"></path>
      </svg>
      <span>${() => MODE_LABEL[autoIngestPref.mode]}</span>
    </button>
  `
}
