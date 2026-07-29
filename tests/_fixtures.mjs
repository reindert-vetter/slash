// Per-worker isolated server. Each Playwright worker gets its own seeded SQLite
// DB (and, since newTasks puts the workflow/comments/relations/... DBs next to
// it, its own copy of ALL write state) plus its own Go server on its own port.
// The read-only base/head worktrees under tests/.tmp/data (TEST_DATA_DIR,
// materialized by globalSetup and passed to every worker via -data) stay
// shared — the live data/ tree is never touched. This removes the
// cross-worker write races (comment/workflow SQLite contention) and page-load
// contention that made the suite flaky under a single shared server, and lets us
// scale workers freely.
//
// The harness forces both SLASH_GITHUB=off and SLASH_CLAUDE=off on every
// worker server, regardless of the invoking shell's environment — the suite
// must never touch the real network. Without a forced SLASH_CLAUDE=off, a
// worker started from a shell that hadn't exported it would shell out to the
// real `claude` CLI for the automatic call-resolution search (resolve_call),
// which stalls/times out and made comment-flow specs (e.g.
// repro-live-comment.spec.mjs) fail non-deterministically depending on how the
// suite happened to be invoked. No spec exercises a non-Fake claude client —
// the LLM-resolved paths are covered via seed fixtures (see
// tests/fixtures/callresolve.json) — so forcing the Fake everywhere is safe.
//
// The binary is built once by globalSetup (_setup.mjs); here we only seed + spawn.
// Spec files import { test, expect } from './_fixtures.mjs' instead of
// '@playwright/test' so every page.goto() targets this worker's own server via the
// baseURL override below.
import { test as base, expect, request as apiRequest } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { TEST_DATA_DIR } from './_setup.mjs'

const BIN = path.resolve('tests/.tmp/slash')

// APPROVAL_RESET_PRS — the fixture PRs whose stored approvals the auto
// `_cleanApprovals` fixture below wipes before every test: the shared main
// anchor (12903) plus every small fixture PR some spec approves (95's tree,
// 102's Shift+range selection, 106's drilled line-skip, 107's translation
// keys, 108's fresh-open default).
// Add a PR here as soon as a new spec approves anything on it durably.
const APPROVAL_RESET_PRS = [95, 102, 106, 107, 108, 110, 12903]

// seed replicates the seed passes the old webServer command ran: the main
// blocks fixture (PR 12903), the relations/callresolve fixtures (PR 90/91),
// the testcovers fixtures (PR 92/93/94), the tree-descent fixture (PR 95,
// see _setup.mjs's materializeTreeWorktrees + postapprove-tree.spec.mjs), and
// the empty-child-code fixture (PR 96, related-empty-code.spec.mjs), the
// deleted-file fixture (PR 98, removed-file.spec.mjs), and the tests-group
// fixture (PR 99, related-tests-group.spec.mjs).
// Everything lands next to the DB (tests/.tmp/w<n>/), so the worker is isolated.
function seed(db) {
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/blocks.json'], { stdio: 'ignore' })
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/relations-blocks.json',
      '-relations',
      'tests/fixtures/relations.json',
      '-callresolve',
      'tests/fixtures/callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/testcovers-blocks.json',
      '-testcovers',
      'tests/fixtures/testcovers.json',
    ],
    { stdio: 'ignore' },
  )
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/tree-blocks.json',
      '-relations',
      'tests/fixtures/tree-relations.json',
    ],
    { stdio: 'ignore' },
  )
  // Footer AI-explanation fixture (PR 97, footer-explanation.spec.mjs): a
  // block whose change introduces an if-statement (worktrees materialized in
  // _setup.mjs) plus pre-seeded explanations, so the footer renders the AI
  // description without an LLM run (a fixture row's empty codeHash matches
  // any hash — see loadExplanations/updateFooter in home.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/explain-blocks.json',
      '-relations',
      'tests/fixtures/explain-relations.json',
      '-explanations',
      'tests/fixtures/explanations.json',
    ],
    { stdio: 'ignore' },
  )
  // Empty-code fixture (PR 96, related-empty-code.spec.mjs): a resolved call
  // whose embedded childCode is empty — must render "geen code gevonden"
  // immediately, never "code laden…".
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/emptycode-blocks.json',
      '-callresolve',
      'tests/fixtures/emptycode-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Tests-group fixture (PR 99, related-tests-group.spec.mjs): a production
  // method with TWO covering tests (covered_by children) AND a resolved call
  // (a non-test child) — drives the horizontal tests bar in the
  // Onderliggende-code panel. Worktrees materialized in _setup.mjs
  // (materializeTestsGroupWorktrees) so the diff is keyboard-navigable.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/testsgroup-blocks.json',
      '-testcovers',
      'tests/fixtures/testsgroup-testcovers.json',
      '-callresolve',
      'tests/fixtures/testsgroup-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Call-arrow fixture (PR 100, call-arrows.spec.mjs): a caller with two
  // adjacent changed call lines — one resolves to a changed PR block (arrow),
  // one to an unchanged file (no arrow). Worktrees materialized in _setup.mjs
  // (materializeArrowWorktrees) so the diff is keyboard-navigable.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/arrow-blocks.json',
      '-callresolve',
      'tests/fixtures/arrow-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Migration→model / model-usage fixture (PR 101, migration-model.spec.mjs): one
  // caller with two class-level callresolve children (kind model_usage and
  // migration_model) — both must render a bare model-name label ("ProductGroup",
  // not "ProductGroup::") and a "model" badge, never the Class:: template used by
  // a regular method_call child.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/migrationmodel-blocks.json',
      '-callresolve',
      'tests/fixtures/migrationmodel-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Translation fixture (PR 107, translation.spec.mjs): a changed lang block
  // (resources/lang/nl/checkout.php → the changes-only key overview + the en
  // companion card) plus a caller with four resolved translation children (two
  // keys × nl/en, one en value deliberately missing). Worktrees materialized in
  // _setup.mjs (materializeTranslationWorktrees).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/translation-blocks.json',
      '-callresolve',
      'tests/fixtures/translation-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Deleted-file fixture (PR 98, removed-file.spec.mjs): one block whose whole
  // file was deleted by the PR (fileDeleted: true) plus a loose removed method
  // in a file that still exists — drives the "Verwijderd bestand"/"Verwijderd"
  // markers (card badge, sidebar pill, diff banner).
  execFileSync(
    BIN,
    ['seed', '-db', db, '-from', 'tests/fixtures/filedeleted-blocks.json'],
    { stdio: 'ignore' },
  )
  // Shift+arrow range-select fixture (PR 102, range-select.spec.mjs): two
  // same-file blocks — `execute` changes four contiguous lines (worktree
  // materialized in _setup.mjs, materializeRangeSelectWorktrees) so a
  // Shift+ArrowDown/ArrowUp multi-line selection has something real to
  // select/approve, and `other` is its same-file neighbour, used to prove the
  // range clamps at the block boundary instead of flowing into it.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/rangeselect-blocks.json'], {
    stdio: 'ignore',
  })
  // Onderliggende-code column-width fixture (PR 103, related-code-grow.spec.mjs):
  // one caller whose resolved child has a single very long CODE line (must grow
  // the column beyond its narrow default), and one caller whose child has an
  // equally long PHPDoc COMMENT line but only short code (must NOT grow it —
  // comment lines are excluded from the width calculation, see
  // codeGrowthChars/relatedColumnWidthCls in RelatedPanel.mjs).
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/growcode-blocks.json',
      '-callresolve',
      'tests/fixtures/growcode-callresolve.json',
    ],
    { stdio: 'ignore' },
  )
  // Renamed-file fixture (PR 104, rename-file.spec.mjs): two blocks of a file
  // the PR moved (git-detected rename), each carrying oldFile (the pre-rename
  // path) alongside file (the new path) — drives the old-above-new stacked
  // path display in the block card. No worktrees needed (the path badge reads
  // b.oldFile/b.file directly).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/rename-blocks.json'], {
    stdio: 'ignore',
  })
  // Look-ahead-preview-width fixture (PR 105,
  // preview-matches-active-width.spec.mjs, Task 29): a one-sided `added`
  // block (selected, index 0) followed by a two-sided `modified` block (the
  // look-ahead preview, index 1) — worktrees materialized in _setup.mjs
  // (materializePreviewWidthWorktrees) so the preview's diff genuinely has
  // both an old and a new side to (correctly) hide.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/previewwidth-blocks.json'], {
    stdio: 'ignore',
  })
  // Drilled-column same-block-skip fixture (PR 106,
  // drill-approve-line-skip.spec.mjs): mold of the PR-95 tree fixture, but the
  // event_listener child has TWO adjacent changed lines (worktrees
  // materialized in _setup.mjs, materializeDrillLineSkipWorktrees) so
  // approving the first line via the palette, while a drilled Onderliggende-
  // code column owns the keyboard, has a second not-yet-approved line to jump
  // to WITHOUT the postApprove menu appearing in between.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/drilllineskip-blocks.json',
      '-relations',
      'tests/fixtures/drilllineskip-relations.json',
    ],
    { stdio: 'ignore' },
  )
  // Fresh-open default-selection fixture (PR 108,
  // fresh-open-default-selection.spec.mjs): two independent top-level blocks,
  // each with one real changed line (worktrees materialized in _setup.mjs,
  // materializeDefaultSelWorktrees) — its own PR number so it doesn't share
  // mutable approval state with PR 95 (which postapprove-tree.spec.mjs leaves
  // fully approved without cleanup).
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/defaultsel-blocks.json'], {
    stdio: 'ignore',
  })
  // SVG-preview fixture (PR 109, svg-preview.spec.mjs): a changed `.svg` file
  // (worktrees materialized in _setup.mjs, materializeSvgWorktrees) — drives
  // Block.mjs's svgSlot, which renders old/new <img> previews INSTEAD of the
  // raw text diff for an .svg block. A second block carries a hostile
  // `<script>`/`onload=` payload to prove that preview never executes it.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/svg-blocks.json'], {
    stdio: 'ignore',
  })
  // Test-class-grouping fixture (PR 110, test-class-grouping.spec.mjs): two
  // TEST-category classes — TriggersIndexTest (two methods) and
  // SettingsStoreTest (a single method, proving a class is grouped even with
  // just one changed method — see testClassRowItem/recomputeLeftList in
  // home.mjs) — worktrees materialized in _setup.mjs,
  // materializeTestClassGroupWorktrees.
  execFileSync(BIN, ['seed', '-db', db, '-from', 'tests/fixtures/testclassgroup-blocks.json'], {
    stdio: 'ignore',
  })
  // Comment-activity fixture (PR 970500, underlying-comment-activity.spec.mjs):
  // a parent action linked via an event_listener relation to a child listener
  // — exercises the sidebar's "there's an open comment somewhere in the
  // underlying code" indicator (state.commentActivity, commentActivityPill in
  // BlockList.mjs), which rolls up a comment anchored on the CHILD onto the
  // PARENT row (nestedPrBlocks). Its own PR number, per the
  // APPROVAL_RESET_PRS note above: a spec that places/resolves comments needs
  // a PR nobody else touches, so an exact count assertion never depends on
  // scheduling order.
  execFileSync(
    BIN,
    [
      'seed',
      '-db',
      db,
      '-from',
      'tests/fixtures/commentactivity-blocks.json',
      '-relations',
      'tests/fixtures/commentactivity-relations.json',
    ],
    { stdio: 'ignore' },
  )
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
  })
}

async function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await canConnect(port)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server on port ${port} did not start within ${timeoutMs}ms`)
}

export const test = base.extend({
  // Worker-scoped: one seeded DB + server per worker, torn down at worker exit.
  _server: [
    async ({}, use, workerInfo) => {
      const i = workerInfo.workerIndex
      const dir = path.resolve('tests/.tmp', `w${i}`)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const db = path.join(dir, 'test.db')
      seed(db)

      const port = 4200 + i
      // -data points every worker at the throwaway test data tree
      // (tests/.tmp/data) that globalSetup materialized, so a run never reads
      // — let alone writes — the live data/ tree. See TEST_DATA_DIR in
      // _setup.mjs for why that split exists.
      const proc = spawn(BIN, ['-db', db, '-data', TEST_DATA_DIR, '-addr', `127.0.0.1:${port}`, '-static', '.'], {
        env: {
          ...process.env,
          SLASH_GITHUB: 'off',
          SLASH_CLAUDE: 'off',
          SLASH_INBOX: 'tests/fixtures/inbox.json',
          // Task-inbox (Fase 3, tests/inbox-tasks.spec.mjs) needs a deterministic
          // Jira source too — SLASH_JIRA=off avoids shelling out to the real
          // `acli` CLI (not installed in CI, and this must never touch the
          // network), SLASH_JIRA_ASSIGNED seeds the Fake's AssignedToMe result
          // (see tasks_api.go).
          SLASH_JIRA: 'off',
          SLASH_JIRA_ASSIGNED: 'tests/fixtures/jira-assigned.json',
        },
        stdio: 'ignore',
      })
      try {
        await waitForServer(port)
        await use({ port })
      } finally {
        proc.kill('SIGKILL')
      }
    },
    { scope: 'worker' },
  ],

  // Override Playwright's baseURL so every page.goto('/pr/…') hits this worker's
  // own server.
  baseURL: async ({ _server }, use) => {
    await use(`http://127.0.0.1:${_server.port}`)
  },

  // Auto, test-scoped: reset the shared fixture state (stored approvals, plus
  // the shared anchor PR's comments) before every test.
  //
  // The worker DB lives for the whole worker (one seed per worker, see above),
  // so an approval is DURABLE across tests AND across spec files that happen
  // to land on the same worker. Several specs deliberately approve block 1
  // (CreatePaymentAction::execute) of the shared main fixture — the palette
  // approve tests, postapprove-menu, review-submit-menu,
  // selected-reveal-hidden, sidebar-skip-approved, comment-revokes-approval —
  // and a FULLY approved top-level block is hidden from the sidebar by default
  // (state.showApproved, BlockList.mjs). Any later test that clicks
  // `[data-idx="1"]` then times out on a row that no longer exists, which read
  // as broad, unrelated flakiness across a dozen specs (whichever ones the
  // scheduler happened to run after an approving one). Several specs already
  // carried their own clearBlockApproval() helper precisely because of this;
  // doing it here once makes every spec order-independent instead, without
  // each having to know which of its neighbours approve what.
  //
  // Every fixture PR a spec ever approves is reset (APPROVAL_RESET_PRS), not
  // just the main one: PR 95 has exactly the same collision (drill-approve
  // approves its tree, postapprove-tree then wants both of its rows visible),
  // and that is precisely the hazard fresh-open-default-selection.spec.mjs
  // worked around by claiming its own PR 108. No spec seeds approvals outside
  // a test body (no beforeAll does), so resetting per test can't undercut
  // anyone's setup.
  //
  // Writes go through the sanctioned path — the approve workflow's `set`
  // Signal with an empty set removes the row (see workflows-write-boundary.md).
  _cleanApprovals: [
    async ({ _server }, use) => {
      const base = `http://127.0.0.1:${_server.port}`
      const ctx = await apiRequest.newContext({ baseURL: base })
      try {
        // Comments on the shared anchor PR go too: a PR-WIDE comment
        // (kind !== '') becomes a synthetic, navigable row in the "Start"
        // sidebar (commentBlockItem/recomputeLeftList, home.mjs), so one left
        // behind by an earlier spec shifts every row count and [data-idx]
        // position on 12903 for whatever runs next. Deleting goes through the
        // comment's own workflow `delete` Signal (its Run ID *is* the comment
        // id), i.e. the sanctioned write path.
        const cs = await ctx.get('/api/comments?pr=12903')
        const comments = cs.ok() ? await cs.json() : []
        if (Array.isArray(comments)) {
          for (const c of comments) {
            await ctx.post(`/api/workflows/${c.id}/signals/delete`, { data: {} })
          }
        }
        for (const pr of APPROVAL_RESET_PRS) {
          const res = await ctx.get(`/api/approvals?pr=${pr}`)
          const rows = res.ok() ? await res.json() : []
          if (!Array.isArray(rows) || !rows.length) continue
          const start = await ctx.post('/api/workflows/approve', { data: { pr } })
          const { runId } = await start.json()
          for (const r of rows) {
            await ctx.post(`/api/workflows/${runId}/signals/set`, {
              data: { blockId: r.blockId, rows: [], calls: [] },
            })
          }
        }
      } catch {
        // Best-effort: a failed reset must never fail the test that follows.
      }
      await ctx.dispose()
      await use()
    },
    { auto: true },
  ],
})

export { expect }
