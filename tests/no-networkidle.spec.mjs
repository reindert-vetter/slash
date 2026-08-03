// Deliberately imports from @playwright/test, NOT ./_fixtures.mjs — like its
// sibling seeded-pr-literals.spec.mjs it reads spec SOURCES off disk and never
// opens a page, so pulling in the worker fixture would boot a Go server and
// seed a SQLite DB for nothing.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// `networkidle` is unreachable in this app, so a spec waiting on it either
// hangs for its full timeout or passes by luck. /pr/<id> keeps GET /api/events
// (the SSE stream, .claude/docs/server-events.md) open for the life of the
// page — an in-flight request that never finishes — and every page polls on
// 800ms..15s cadences, which under 4 parallel workers closes the 500ms quiet
// window idle needs. Use appReady(page) (tests/_fixtures.mjs), which waits on
// the document's load event plus the app's first render instead of on traffic.
//
// This is a guard rather than a documented convention because the failure mode
// it prevents (a 30s hang in one spec, intermittently) reads as an unrelated
// flake and cost several review sessions before the cause was measured.
test('no spec waits for networkidle (use appReady instead)', () => {
  const dir = path.resolve('tests')
  const offenders = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.spec.mjs') && f !== '_fixtures.mjs') continue
    if (f === path.basename(new URL(import.meta.url).pathname)) continue
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    src.split('\n').forEach((line, i) => {
      // Comment lines are exempt — this file's own rule is explained in prose
      // in _fixtures.mjs, and that explanation must be allowed to quote the
      // call it forbids.
      if (line.trim().startsWith('//')) return
      if (/waitForLoadState\(\s*['"]networkidle['"]/.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  expect(offenders, `Use appReady(page) from ./_fixtures.mjs instead:\n${offenders.join('\n')}`).toEqual([])
})
