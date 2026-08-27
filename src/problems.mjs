// problems.mjs — shared "what went wrong out of sight" building blocks: a
// fetch wrapper around GET /api/problems plus the pure render helpers for one
// failed workflow run (FailedRun) or one mirrored glue-log line (LogProblem).
// Extracted out of overview.mjs (the /pr-overview "Mislukte taken" drawer) so
// the review tree (/pr/<id>) can show the SAME rows, scoped to the open PR,
// instead of a second implementation — see "mislukte taken ook zichtbaar op
// /pr/<id>" in .claude/docs/detail-layout.md. Both call sites own their own
// state (state.failedRuns/logErrors/problemsLoaded on overview.mjs,
// state.pageProblems on home.mjs); this module is deliberately state-free —
// every function takes exactly the data it renders as an argument.

import { html } from './vendor/arrow.js'
import { labelForWorkflow } from './workflowLabels.mjs'
import { relativeTime } from './relativeTime.mjs'
import { t } from './i18n.mjs'

// fetchProblems — thin read-only wrapper around GET /api/problems. Always
// resolves (never throws) with non-null arrays/object, so a caller never has
// to guard for a missing field or a transient network failure; on failure it
// simply reports ok:false and empty data, leaving whatever the caller already
// had on screen untouched.
export async function fetchProblems() {
  try {
    const res = await fetch('/api/problems')
    if (!res.ok) return { ok: false, failedRuns: [], logErrors: [], prTitles: {} }
    const body = await res.json()
    if (!body || !body.ok) return { ok: false, failedRuns: [], logErrors: [], prTitles: {} }
    return {
      ok: true,
      failedRuns: Array.isArray(body.failedRuns) ? body.failedRuns : [],
      logErrors: Array.isArray(body.logErrors) ? body.logErrors : [],
      prTitles: body.prTitles && typeof body.prTitles === 'object' ? body.prTitles : {},
    }
  } catch (_) {
    return { ok: false, failedRuns: [], logErrors: [], prTitles: {} }
  }
}

// problemMark — the shared "this went wrong" marker: a ⚠ glyph plus a word, so
// it reads without colour perception. The rose tint is decoration on top.
export function problemMark(word) {
  return html`<span class="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300"
    ><span aria-hidden="true">⚠</span><span>${word}</span></span
  >`
}

export const PROBLEM_ROW_CLASS =
  'flex items-start gap-3 border-b border-slate-100 dark:border-zinc-800/70 px-4 py-3 last:border-b-0'

// problemPrChip — "#13098 · <PR title>", or the bare number when prTitles
// knows no title (an old/purged PR). Shared by both row kinds: a number alone
// tells the reviewer nothing about which PR went wrong. The whole chip may
// shrink so the timestamp beside it never gets pushed out.
export function problemPrChip(pr, prTitles) {
  if (!pr) return ''
  const title = (prTitles && prTitles[String(pr)]) || ''
  return html`<span class="min-w-0 truncate text-[12px] text-slate-500 dark:text-zinc-500" title="${'#' + pr + (title ? ' · ' + title : '')}"
    >#${pr}${title ? ' · ' + title : ''}</span
  >`
}

// problemCommentLine — WHICH comment a failed task_code_comment run was about:
// the file (basename) + line, then a snippet of the body. Only the wording
// carries the meaning (no colour-only signal, see the colorblind rule).
// Both slots are always STRINGS — never a conditionally interpolated template,
// which a static slot would render as the template function's source text (see
// the arrow.js pitfalls).
export function problemCommentLine(c) {
  const where = baseName(c.file) + (c.line ? ':' + c.line : '')
  const snippet = c.snippet ? ' · “' + c.snippet + '”' : ''
  return html`<p data-testid="problem-run-comment" class="line-clamp-1 text-[12px] text-slate-600 dark:text-zinc-400">
    <span class="font-mono">${where}</span><span>${snippet}</span>
  </p>`
}

// baseName trims a repo path down to its file name for the comment line above.
export function baseName(path) {
  const s = String(path || '')
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

// problemRunRow — one workflow run that ended in `failed`. showPr (default
// true) hides the PR chip when the caller already scopes the whole list to one
// PR (the review-tree page) — the chip would just repeat what the page is
// already about.
export function problemRunRow(run, prTitles, { showPr = true } = {}) {
  return html`
    <div data-testid="problem-run" class="${PROBLEM_ROW_CLASS}">
      ${problemMark(t('mislukt'))}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="shrink-0 text-[13px] font-semibold text-slate-900 dark:text-zinc-100">${labelForWorkflow(run.workflow)}</span>
          ${() => (showPr ? problemPrChip(run.pr, prTitles) : '')}
          <span class="shrink-0 text-[11px] text-slate-400 dark:text-zinc-600">${relativeTime(run.updatedAt)}</span>
        </div>
        <div class="contents">${() => (run.comment ? problemCommentLine(run.comment) : '')}</div>
        <p class="line-clamp-2 text-[12px] text-slate-500 dark:text-zinc-500" title="${run.error || ''}">${run.error || t('geen foutmelding vastgelegd')}</p>
      </div>
    </div>
  `.key('problem-run:' + run.runId)
}

// problemLogRow — one mirrored log line. `scope` is the subsystem prefix the
// line itself carries ("import comments", "pr_status", …); "overgeslagen"
// because every such line reports work that was skipped, not a hard failure.
// showPr — see problemRunRow.
export function problemLogRow(entry, i, prTitles, { showPr = true } = {}) {
  return html`
    <div data-testid="problem-log" class="${PROBLEM_ROW_CLASS}">
      ${problemMark(t('overgeslagen'))}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="shrink-0 truncate text-[13px] font-semibold text-slate-900 dark:text-zinc-100">${entry.scope || t('Achtergrondtaak')}</span>
          ${() => (showPr ? problemPrChip(entry.pr, prTitles) : '')}
          <span class="shrink-0 text-[11px] text-slate-400 dark:text-zinc-600">${relativeTime(entry.at)}</span>
        </div>
        <p class="line-clamp-2 text-[12px] text-slate-500 dark:text-zinc-500" title="${entry.message || ''}">${entry.message || ''}</p>
      </div>
    </div>
  `.key('problem-log:' + i + ':' + (entry.at || '') + ':' + (entry.message || '').slice(0, 40))
}
