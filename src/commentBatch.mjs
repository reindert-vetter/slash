// commentBatch.mjs — the browser side of "laat Claude alle openstaande comments
// verwerken" (comment_batch.go): one shared reactive snapshot of that run, so
// three very different render spots can all say the same thing about the same
// comment without knowing about each other:
//
//   - the left index row of a comment (BlockList.mjs — the pulsing "Claude
//     bezig" / "verwerkt" pill),
//   - the log line under the selected comment (CommentClaudeFooter,
//     RelatedPanel.mjs — the SAME status element a Claude chat turn uses).
//
// This module only REPORTS on a run; it can no longer start one. The sidebar's
// checkbox selection + "Verwerk N comments met Claude" action row were removed
// on request (Space on such a row now hides it instead, see spaceKey in
// home.mjs), and with them the last UI entry point — a run is started by
// POSTing /api/workflows/comment_batch directly. Everything below keeps
// working unchanged for a run started that way.
//
// A shared pure-ish utility module like theme.mjs/events.mjs: it owns one
// reactive object plus its fetch/SSE plumbing and imports no component.
//
// The snapshot is deliberately NOT a read model: the server keeps it in memory
// only (comment_batch_progress.go), because a batch run leaves no durable
// per-comment trace — it only edits code and never replies to or resolves a
// thread, which stays the reviewer's own call. So a server restart simply
// leaves the comments as ordinary open comments again.
import { reactive } from './vendor/arrow.js'
import { repoParam } from './prContext.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'
import { t } from './i18n.mjs'

// The per-comment states the server reports; the WORD carries the meaning in
// every render spot, never a colour on its own (colourblind rule, see
// .claude/rules/conventions.md).
export const BATCH_STATE_LABEL = {
  open: 'in de wachtrij',
  busy: 'Claude bezig',
  done: 'verwerkt',
  skipped: 'overgeslagen',
}

// batch mirrors the server's commentBatchProgress. `items` is a plain array of
// {commentId, state, note} — replaced wholesale on every update rather than
// patched per item, so a keyed row's binding can't miss a change.
export const batch = reactive({
  pr: 0,
  running: false,
  total: 0,
  done: 0,
  skipped: 0,
  current: '',
  phase: '',
  tool: '',
  detail: '',
  startedAt: 0,
  error: '',
  items: [],
})

let wired = false

// applySnapshot writes one server snapshot into the reactive object. An absent
// progress (never ran, or the server restarted) resets to "nothing going on".
function applySnapshot(p) {
  if (!p) {
    batch.running = false
    batch.total = 0
    batch.done = 0
    batch.skipped = 0
    batch.current = ''
    batch.phase = ''
    batch.tool = ''
    batch.detail = ''
    batch.startedAt = 0
    batch.error = ''
    batch.items = []
    return
  }
  batch.running = !!p.running
  batch.total = p.total || 0
  batch.done = p.done || 0
  batch.skipped = p.skipped || 0
  batch.current = p.current || ''
  batch.phase = p.phase || ''
  batch.tool = p.tool || ''
  batch.detail = p.detail || ''
  batch.startedAt = p.startedAt || 0
  batch.error = p.error || ''
  batch.items = (p.items || []).map((it) => ({
    commentId: it.commentId,
    state: it.state || 'open',
    note: it.note || '',
  }))
}

// refreshCommentBatch is the resync read (GET /api/comment-batch) — called on
// PR change and on every SSE (re)connect, per events.mjs' rule 2.
export async function refreshCommentBatch(pr) {
  if (!pr) return
  try {
    const res = await fetch('/api/comment-batch?pr=' + encodeURIComponent(pr) + repoParam())
    const data = await res.json()
    applySnapshot(data && data.progress ? data.progress : null)
  } catch (_) {
    // Offline/SLASH_GITHUB=off test runs: leave whatever we had; the snapshot is
    // decoration on top of the ordinary comment rows, never their truth.
  }
}

// syncCommentBatch wires the tab up for one PR (idempotent): one initial read,
// the SSE push, and a resync handler. Called from the same place the comment
// poll is started.
export function syncCommentBatch(pr) {
  if (!pr) return
  if (batch.pr !== pr) {
    batch.pr = pr
    applySnapshot(null)
    refreshCommentBatch(pr)
  }
  if (wired) return
  wired = true
  ensureEvents(pr)
  onEvent('commentbatch.progress', (ev) => {
    if (!ev || ev.pr !== batch.pr) return
    applySnapshot(ev.data)
  })
  onEventsResync(() => refreshCommentBatch(batch.pr))
}

// batchItemFor returns {state, note} for one comment, or null when this run
// knows nothing about it (the normal case for most comments).
export function batchItemFor(commentId) {
  if (!commentId || !batch.items.length) return null
  for (const it of batch.items) if (it.commentId === commentId) return it
  return null
}

// batchProgressFor is what the log line under a comment reads: the volatile
// phase/tool/detail trio, but ONLY while this very comment is the one Claude is
// working on. Deliberately shaped exactly like chat progress
// ({phase, tool, detail}), so claudeStatusText (ClaudeChat.mjs) formats it
// without a second implementation.
export function batchProgressFor(commentId) {
  if (!batch.running || !commentId || batch.current !== commentId) return null
  // `running: true` is load-bearing: claudeStatusText words a non-running
  // progress as "Claude is klaar — bezig met opslaan…".
  return { running: true, phase: batch.phase || 'starting', tool: batch.tool, detail: batch.detail }
}

// batchNoteFor is the finished sentence for one comment: what Claude changed, or
// why it left this one alone. '' when there is nothing to say.
export function batchNoteFor(commentId) {
  const it = batchItemFor(commentId)
  if (!it) return ''
  const label = t(BATCH_STATE_LABEL[it.state] || it.state)
  if (it.state === 'busy' || it.state === 'open') return batch.running ? label : ''
  return it.note ? t('{label}: {note}', { label, note: it.note }) : label
}
