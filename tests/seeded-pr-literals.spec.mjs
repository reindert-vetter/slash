// Deliberately imports from @playwright/test, NOT ./_fixtures.mjs — the one
// spec in this suite that does. It reads spec SOURCES off disk and never opens
// a page, so pulling in the worker fixture would boot a Go server and seed a
// SQLite DB for nothing.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// A spec that SEEDS data at runtime (places a comment, starts a workflow) must
// take its PR number from seededPr(testInfo) (tests/_fixtures.mjs) instead of
// typing one in. The rule itself is older than this guard and lived only in
// .claude/rules/conventions.md — and got broken twice anyway (970010 shared by
// comment-author-avatar.spec.mjs and navigate.spec.mjs, 970011 by
// comment-author-avatar.spec.mjs and comment-last-reply.spec.mjs), because a
// collision is invisible until the scheduler happens to put both specs on the
// same worker. Nothing about a hand-picked number tells you it is already
// taken, so this turns the convention into something a run can actually fail
// on, at the moment the literal is added rather than months later as flake.
//
// Scope is exactly the synthetic 97xxxx range. The small read-only fixture PRs
// (90-112) and the shared anchor (12903) are deliberately NOT covered: several
// specs legitimately read the same pre-seeded worktree fixture without writing
// anything, which is no collision at all.
const SEEDED_PR_PATTERN = /\b97\d{4,}\b/g

// The only synthetic numbers allowed to be literal, each because it names data
// that exists BEFORE any test runs (so it cannot be allocated per test) or no
// data at all. Add an entry here only for one of those two reasons — never to
// silence a spec that seeds its own comments at runtime.
const ALLOWED = new Map([
  // Block/comment fixtures seeded once per worker by _fixtures.mjs' seed(),
  // so the number is baked into tests/fixtures/*.json.
  [970500, 'commentactivity-blocks.json / -relations.json'],
  [970600, 'orphan-blocks.json / orphan-comments.json'],
  // Not a PR in any store: a mocked /api/problems payload rendered by the UI.
  [970099, 'mocked log line in overview-problems.spec.mjs'],
])

test('no spec hardcodes a synthetic PR number (use seededPr instead)', () => {
  const dir = path.resolve('tests')
  const offenders = []
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.spec.mjs'))) {
    if (name === path.basename(import.meta.url)) continue // this file lists them on purpose
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(SEEDED_PR_PATTERN)) {
        const n = Number(m[0])
        if (ALLOWED.has(n)) continue
        offenders.push(`${name}:${i + 1}: ${n} — ${line.trim()}`)
      }
    })
  }
  expect(
    offenders,
    'Hardcoded synthetic PR number(s) found. Use seededPr(testInfo) from ' +
      'tests/_fixtures.mjs so the number is unique per test and per retry; ' +
      'only a number naming pre-seeded fixture data belongs in ALLOWED here.',
  ).toEqual([])
})
