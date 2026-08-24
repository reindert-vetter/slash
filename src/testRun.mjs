// testRun.mjs — the browser side of "Tests laten draaien" (test_run.go): one
// shared reactive snapshot of that run, following the exact shape of
// commentBatch.mjs (its own sibling on the server side, comment_batch.go).
//
// A shared pure-ish utility module like theme.mjs/events.mjs/commentBatch.mjs:
// it owns one reactive object plus its fetch/SSE plumbing and imports no
// component. The one render spot is prInfoCard's status block (home.mjs) —
// unlike comment_batch there is no per-comment index row to annotate, since a
// test run isn't scoped to any comment at all (reviewer decision: it's a
// PR-wide `/`-menu action, not a bottom action row — see PR_COMMANDS).
//
// The snapshot is deliberately NOT a read model: the server keeps it in
// memory only (test_run_progress.go). A server restart simply leaves no
// visible trace of a run that happened before it — the actual, durable
// outcome (which residue may still be swept later) lives in the test_run
// workflow's own history instead, never here.
import { reactive } from './vendor/arrow.js'
import { repoParam, repoField } from './prContext.mjs'
import { ensureEvents, onEvent, onEventsResync } from './events.mjs'

// The per-test states the server reports; the WORD carries the meaning in the
// render spot, never a colour on its own (colourblind rule, see
// .claude/rules/conventions.md).
export const TEST_RUN_STATE_LABEL = {
  busy: 'bezig',
  pass: 'geslaagd',
  fail: 'mislukt',
  interrupted: 'onderbroken',
}

// testRun mirrors the server's testRunProgress. `items` is a plain array of
// {name, state, note} — replaced wholesale on every update, same reasoning as
// commentBatch.mjs's own `items`.
export const testRun = reactive({
  pr: 0,
  running: false,
  plan: '',
  passed: 0,
  failed: 0,
  current: '',
  phase: '',
  tool: '',
  detail: '',
  cancelled: false,
  startedAt: 0,
  error: '',
  items: [],
})

let wired = false

// applySnapshot writes one server snapshot into the reactive object. An
// absent progress (never ran, or the server restarted) resets to "nothing
// going on".
function applySnapshot(p) {
  if (!p) {
    testRun.running = false
    testRun.plan = ''
    testRun.passed = 0
    testRun.failed = 0
    testRun.current = ''
    testRun.phase = ''
    testRun.tool = ''
    testRun.detail = ''
    testRun.cancelled = false
    testRun.startedAt = 0
    testRun.error = ''
    testRun.items = []
    return
  }
  testRun.running = !!p.running
  testRun.plan = p.plan || ''
  testRun.passed = p.passed || 0
  testRun.failed = p.failed || 0
  testRun.current = p.current || ''
  testRun.phase = p.phase || ''
  testRun.tool = p.tool || ''
  testRun.detail = p.detail || ''
  testRun.cancelled = !!p.cancelled
  testRun.startedAt = p.startedAt || 0
  testRun.error = p.error || ''
  testRun.items = (p.items || []).map((it) => ({
    name: it.name,
    state: it.state || 'busy',
    note: it.note || '',
  }))
}

// refreshTestRun is the resync read (GET /api/test-run) — called on PR change
// and on every SSE (re)connect, per events.mjs' rule 2.
export async function refreshTestRun(pr) {
  if (!pr) return
  try {
    const res = await fetch('/api/test-run?pr=' + encodeURIComponent(pr) + repoParam())
    const data = await res.json()
    applySnapshot(data && data.progress ? data.progress : null)
  } catch (_) {
    // Offline/SLASH_GITHUB=off test runs: leave whatever we had; the snapshot
    // is decoration, never the truth about anything durable.
  }
}

// syncTestRun wires the tab up for one PR (idempotent): one initial read, the
// SSE push, and a resync handler. Called from the same place syncCommentBatch
// is called.
export function syncTestRun(pr) {
  if (!pr) return
  if (testRun.pr !== pr) {
    testRun.pr = pr
    applySnapshot(null)
    refreshTestRun(pr)
  }
  if (wired) return
  wired = true
  ensureEvents(pr)
  onEvent('testrun.progress', (ev) => {
    if (!ev || ev.pr !== testRun.pr) return
    applySnapshot(ev.data)
  })
  onEventsResync(() => refreshTestRun(testRun.pr))
}

// startTestRun starts the run. Returns true when accepted, false on a
// network error or a 409 (already running — see test_run.go's file header,
// point 7). Writing only ever happens by starting a workflow (see
// .claude/rules/workflows-write-boundary.md).
export async function startTestRun(pr) {
  if (!pr) return false
  try {
    const res = await fetch('/api/workflows/test_run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, repo: repoField() }),
    })
    if (!res.ok) {
      console.error('test_run failed:', res.status, await res.text().catch(() => ''))
      return false
    }
    // Show "voorbereiden" right away instead of waiting for the first push —
    // the run's own first snapshot overwrites this within a second.
    applySnapshot({ running: true, phase: 'preparing', startedAt: Date.now(), items: [] })
    return true
  } catch (err) {
    console.error('test_run network error:', err)
    return false
  }
}

// cancelTestRun stops the ONE running test_run for this PR right now — a
// plain in-memory cancel (POST /api/test-run/cancel), never a workflow Signal,
// same reasoning as cancelClaudeChat's own doc comment (RelatedPanel.mjs).
export async function cancelTestRun(pr) {
  if (!pr) return
  try {
    await fetch('/api/test-run/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr }),
    })
  } catch (_) {
    // Same class of "don't surface a network hiccup for a best-effort stop"
    // as cancelClaudeChat.
  }
}

// hasTestRunActivity says whether there's anything worth rendering a status
// block for at all — running, or a finished run whose outcome hasn't been
// dismissed by navigating to a different PR yet.
export function hasTestRunActivity() {
  return testRun.running || testRun.items.length > 0 || !!testRun.error
}
