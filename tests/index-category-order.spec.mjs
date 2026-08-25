import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "kijk naar het aantal onderliggende blokken. hoe meer, hoe verder naar
// boven" (reviewer request, replacing the earlier "meeste te approven
// bovenaan" heuristic and the fixed ROUTE/CONTROLLER Laravel-hierarchy
// tiers) — see recomputeLeftList's fileUnderlyingCount/fileOrder/fileRank
// (home.mjs) and "Sort order of the left list" in
// .claude/docs/blocks-and-ingest.md. TEST still always sorts last,
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
    // 4 top-level rows (CONFIG's own row, WORKFLOW's, PROVIDER's, and TEST's
    // test_class row) + 1 + 3 + 2 + 5 = 11 relation-child rows under
    // "Onderliggende code" = 15 total.
    await expect(rows).toHaveCount(15)
    // Descending by underlying-block count: WORKFLOW(3) > PROVIDER(2) >
    // CONFIG(1); TEST(5) forced last despite having the most of all.
    await expect(rows.nth(0)).toContainText('WORKFLOW')
    await expect(rows.nth(1)).toContainText('PROVIDER')
    await expect(rows.nth(2)).toContainText('CONFIG')
    await expect(rows.nth(3)).toContainText('TEST')
  })
})
