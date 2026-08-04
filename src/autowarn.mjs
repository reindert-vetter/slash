// autowarn.mjs — the reviewer's on/off switch for the AUTOMATIC AI risk check
// (code_warning), placed next to the theme toggle in prInfoCard's
// pr-info-theme-row (see .claude/rules/conventions.md, "Theme" — same slot,
// same style). A manual "Diepgravend onderzoek" from the "/" menu is NEVER
// gated by this switch — only the automatic trigger (fired from
// build_relations on real new code, see .claude/docs/workflows-analysis.md,
// "AI risk check") checks it.
//
// Unlike the dark/light theme (a pure frontend preference, localStorage is
// enough — see theme.mjs), this switch gates BACKEND behaviour: a workflow
// Activity decides, at the moment it wants to fire, whether the automatic
// trigger runs at all. The server therefore needs to be able to read the
// current value instantly, which localStorage (per-browser, never reaches the
// server) and settings.json (read once per process, a restart to take effect
// — see settings.go) both cannot offer. So this preference rides the same
// workflow-Signal write path as every other reviewer preference (task snooze,
// ignore-comment, approval): POST /api/workflows/auto_warn ensures the one
// repo-wide auto_warn tracker Execution exists, then POST
// .../signals/autowarn persists a toggle via its own Activity (see
// workflows.go, WorkflowAutoWarn/SignalAutoWarn). Read side: GET /api/autowarn
// — a plain read of the same autowarn module, never a direct write from here.
import { reactive, html } from './vendor/arrow.js'

export const autoWarn = reactive({ enabled: true, runId: null })

let ensured = null

// ensureAutoWarn ensures the tracker Execution exists (POST, idempotent) and
// loads the current preference (GET) — called once per page load, mirroring
// loadApprovals'/EnsureApprovals' own bootstrap (home.mjs). Safe to call more
// than once (dedup via `ensured`).
export function ensureAutoWarn() {
  if (ensured) return ensured
  ensured = (async () => {
    try {
      const res = await fetch('/api/workflows/auto_warn', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.runId) autoWarn.runId = data.runId
      }
    } catch (err) {
      console.error('auto_warn ensure failed:', err)
    }
    await refreshAutoWarn()
  })()
  return ensured
}

async function refreshAutoWarn() {
  try {
    const res = await fetch('/api/autowarn')
    if (res.ok) {
      const data = await res.json()
      autoWarn.enabled = data.enabled !== false
    }
  } catch (err) {
    console.error('auto_warn refresh failed:', err)
  }
}

// toggleAutoWarn flips the on/off preference and persists it via the
// sanctioned Signal write path — never a direct write, per
// .claude/rules/workflows-write-boundary.md. Optimistic, mirrors
// theme.mjs's cycleTheme.
export async function toggleAutoWarn() {
  const next = !autoWarn.enabled
  autoWarn.enabled = next
  if (!autoWarn.runId) {
    await ensureAutoWarn()
  }
  if (!autoWarn.runId) return
  try {
    await fetch(`/api/workflows/${autoWarn.runId}/signals/autowarn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
  } catch (err) {
    console.error('auto_warn toggle failed:', err)
  }
}

// autoWarnToggleButton renders next to themeToggleButton in prInfoCard's
// pr-info-theme-row. Never colour-only (the reviewer is colorblind, see
// MEMORY.md): the label text itself ("aan"/"uit") plus a filled/open dot carry
// the state — the same filled-vs-open convention .claude/docs/approval.md
// uses for a call-segment's approved state.
export function autoWarnToggleButton(cls = '') {
  return html`
    <button
      type="button"
      data-testid="auto-warn-toggle"
      title="${() => 'Automatische risicocontrole: ' + (autoWarn.enabled ? 'aan' : 'uit') + ' (klik om te wisselen)'}"
      class="${() =>
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (autoWarn.enabled
          ? 'text-emerald-700 dark:text-emerald-400 ring-emerald-200 dark:ring-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
          : 'text-slate-500 dark:text-zinc-400 ring-slate-200 dark:ring-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800') +
        ' ' +
        cls}"
      @click="${toggleAutoWarn}"
    >
      <span
        data-testid="auto-warn-toggle-dot"
        class="${() =>
          'inline-block h-2 w-2 shrink-0 rounded-full ' +
          (autoWarn.enabled ? 'bg-emerald-500' : 'border border-slate-400 dark:border-zinc-500')}"
      ></span>
      <span>${() => (autoWarn.enabled ? 'Risicocontrole aan' : 'Risicocontrole uit')}</span>
    </button>
  `
}
