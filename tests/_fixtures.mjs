// Per-worker isolated server. Each Playwright worker gets its own seeded SQLite
// DB (and, since newTasks puts the workflow/comments/relations/... DBs next to
// it, its own copy of ALL write state) plus its own Go server on its own port.
// The read-only base/head worktrees under data/ stay shared. This removes the
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
import { test as base, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const BIN = path.resolve('tests/.tmp/slash')

// seed replicates the seed passes the old webServer command ran: the main
// blocks fixture (PR 12903), the relations/callresolve fixtures (PR 90/91),
// the testcovers fixtures (PR 92/93/94), the tree-descent fixture (PR 95,
// see _setup.mjs's materializeTreeWorktrees + postapprove-tree.spec.mjs), and
// the empty-child-code fixture (PR 96, related-empty-code.spec.mjs).
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
      const proc = spawn(BIN, ['-db', db, '-addr', `127.0.0.1:${port}`, '-static', '.'], {
        env: { ...process.env, SLASH_GITHUB: 'off', SLASH_CLAUDE: 'off', SLASH_INBOX: 'tests/fixtures/inbox.json' },
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
})

export { expect }
