import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "kijk naar het aantal onderliggende blokken. hoe meer, hoe verder naar
// boven" (reviewer request, replacing the earlier "meeste te approven
// bovenaan" heuristic and the fixed ROUTE/CONTROLLER Laravel-hierarchy
// tiers) — see recomputeLeftList's fileUnderlyingCount/fileOrder/fileRank
// (home.mjs) and "Sort order of the left list" in
// .claude/docs/blocks-and-ingest.md. A fixed category tier (MIGRATION,
// ROUTE, CONTROLLER, REQUEST, RESOURCE) sorts above all of that (fileTier).
// TEST still always sorts last,
// regardless of its own underlying-block count — unchanged, explicit
// reviewer instruction.
//
// Fixture: PR 125 (tests/fixtures/categoryorder-blocks.json +
// categoryorder-relations.json, worktrees materialized in _setup.mjs's
// materializeCategoryOrderWorktrees) — four top-level blocks, each with a
// known, distinct number of relation children (its own "Onderliggende code"
// subtree): CONFIG=1, WORKFLOW=3, PROVIDER=2, TEST=5 (deliberately the
// HIGHEST of the four, to prove TEST still sorts last despite having the
// most underlying blocks of any file here).
const PR = 125

test.describe('left list sorted by "most underlying blocks first", TEST always last', () => {
  test('the file with the most underlying blocks sorts first; TEST sorts last despite having the most of all', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)

    const rows = page.getByTestId('block-row')
    // 9 top-level rows (5 fixed-tier blocks, CONFIG's, WORKFLOW's,
    // PROVIDER's and TEST's test_class row) + 1 + 3 + 2 + 5 = 11
    // relation-child rows under "Onderliggende code" = 20 total.
    await expect(rows).toHaveCount(20)
    // Fixed category tier first, regardless of seed order (seeded in reverse)
    // and of their zero underlying blocks: MIGRATION, ROUTE, CONTROLLER,
    // REQUEST, RESOURCE.
    await expect(rows.nth(0)).toContainText('MIGRATION')
    await expect(rows.nth(1)).toContainText('ROUTE')
    await expect(rows.nth(2)).toContainText('CONTROLLER')
    await expect(rows.nth(3)).toContainText('REQUEST')
    await expect(rows.nth(4)).toContainText('RESOURCE')
    // Then the rest, descending by underlying-block count: WORKFLOW(3) >
    // PROVIDER(2) > CONFIG(1); TEST(5) forced last despite having the most.
    await expect(rows.nth(5)).toContainText('WORKFLOW')
    await expect(rows.nth(6)).toContainText('PROVIDER')
    await expect(rows.nth(7)).toContainText('CONFIG')
    await expect(rows.nth(8)).toContainText('TEST')
  })
})
