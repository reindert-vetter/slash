// autowarn.mjs — the reviewer's on/off switch for the automatic AI work the
// review tree does on its own: the "Live AI assistent". Placed next to the
// theme toggle in prInfoCard's pr-info-theme-row (see
// .claude/rules/conventions.md, "Theme" — same slot, same style).
//
// Three consumers, all automatic and all unasked-for:
//
//   1. the AI risk check (code_warning), fired from build_relations/pr_status
//      on real new code — see .claude/docs/workflows-analysis.md;
//   2. the footer's AI description of the focused unit (explain_code), fired
//      by home.mjs's footer watch — see .claude/docs/footer.md.
//   3. the short title a long comment gets (comment_titles), fired by
//      loadComments in RelatedPanel.mjs — see .claude/docs/comments-panel.md
//      ("A long comment gets a generated title").
//
// Off means neither fires, so no Claude call happens without the reviewer
// asking for one. What stays ON deliberately: resolve_call and
// resolve_test_covers. Those build the navigation structure itself (which
// child a call points at, which method a test covers) rather than describing
// anything, so turning them off would break the tree rather than quieten it.
// A manual "Diepgravend onderzoek" from the "/" menu is likewise NEVER gated
// by this switch — an explicit request is always honoured.
//
// The store/endpoint/workflow keep their original `autowarn` names: renaming
// them would be a migration with no functional gain.
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
import { t } from './i18n.mjs'

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
      title="${() =>
        t('Live AI assistent: {state} — automatische risicocontrole en beschrijvingen (klik om te wisselen)', {
          state: t(autoWarn.enabled ? 'aan' : 'uit'),
        })}"
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
      <span>${() => t(autoWarn.enabled ? 'Live AI assistent aan' : 'Live AI assistent uit')}</span>
    </button>
  `
}
