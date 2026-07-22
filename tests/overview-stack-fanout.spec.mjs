import { test, expect } from './_fixtures.mjs'
import { readFileSync } from 'node:fs'

// computeStacks (src/overview.mjs) used to model a stack as a strict linear
// chain (one parent → at most one recognized child), via a `childOf` map
// guarded to only ever remember the FIRST child claiming a given parent. A
// real-world PR fan-out — several sibling PRs all branched directly off the
// same not-yet-merged branch, rather than off each other — broke that
// assumption: only one sibling got lifted into "Gestapelde PR's", the rest
// stayed stranded in their normal section even though their baseRefName
// unambiguously points at an in-view PR's headRefName.
//
// tests/fixtures/inbox-fanout.json is a literal reproduction of that real
// case (INTEG-616 as the common base, INTEG-617..621 all branched directly
// off it) — used here purely as synthetic input data, not wired through
// SLASH_INBOX (the server's /api/inbox snapshot is a single, shared,
// worker-wide read-model, see _fixtures.mjs; a second inbox fixture can't
// coexist with the one every other overview test already counts rows
// against). We feed its flattened PR list straight into the exported,
// pure `computeStacks` function inside an already-loaded page's module
// registry — the same "import an already-loaded page module and call its
// exported pure function with synthetic data" pattern as navigate.spec.mjs's
// `changeGroups` test.
test.describe('PR Review Tree — stack fan-out', () => {
  test('computeStacks lifts every sibling PR branched off the same base into one tree', async ({ page }) => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/inbox-fanout.json', 'utf8'))
    const all = fixture.sections.flatMap((sec) => sec.prs)

    // Any page load works here — we only need the browser's module registry
    // primed so importing /src/overview.mjs returns the already-executed
    // module instead of re-running its page-bootstrap side effects fresh.
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const chains = await page.evaluate(async (prs) => {
      const { computeStacks } = await import('/src/overview.mjs')
      return computeStacks(prs).map((nodes) => nodes.map(({ pr, depth }) => ({ number: pr.number, depth })))
    }, all)

    // Exactly one tree, containing the root plus all five siblings.
    expect(chains).toHaveLength(1)
    const [tree] = chains
    expect(tree).toHaveLength(6)

    // Root (INTEG-616) is first, at depth 0.
    expect(tree[0]).toEqual({ number: 13030, depth: 0 })

    // The five siblings — all branched directly off the root's branch, not
    // off each other — share depth 1, and are ordered by PR number ascending.
    expect(tree.slice(1)).toEqual([
      { number: 13040, depth: 1 },
      { number: 13041, depth: 1 },
      { number: 13042, depth: 1 },
      { number: 13043, depth: 1 },
      { number: 13044, depth: 1 },
    ])
  })

  test('a plain linear chain (no fan-out) still renders as before', async ({ page }) => {
    const all = [
      { number: 1, baseRefName: 'develop', headRefName: 'feature/a' },
      { number: 2, baseRefName: 'feature/a', headRefName: 'feature/b' },
      { number: 3, baseRefName: 'feature/b', headRefName: 'feature/c' },
    ]

    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const chains = await page.evaluate(async (prs) => {
      const { computeStacks } = await import('/src/overview.mjs')
      return computeStacks(prs).map((nodes) => nodes.map(({ pr, depth }) => ({ number: pr.number, depth })))
    }, all)

    expect(chains).toHaveLength(1)
    expect(chains[0]).toEqual([
      { number: 1, depth: 0 },
      { number: 2, depth: 1 },
      { number: 3, depth: 2 },
    ])
  })
})
