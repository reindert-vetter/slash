import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "de type met de meeste te approven bovenaan (behalve TEST, die altijd
// laatste blijft)" — see recomputeLeftList's categoryRemaining/categoryOrder/
// midRank (home.mjs) and "Sort order of the left list" in
// .claude/docs/blocks-and-ingest.md.
//
// Fixture: PR 125 (tests/fixtures/categoryorder-blocks.json, worktrees
// materialized in _setup.mjs's materializeCategoryOrderWorktrees) — four
// blocks, each a real, fully changed-line diff with a known remaining count:
// CONFIG=4, WORKFLOW=3, PROVIDER=1, TEST=6 (deliberately the HIGHEST of the
// four, to prove TEST still sorts last even with the most left to approve).
const PR = 125

test.describe('index sorted by "most left to approve" per category, TEST always last', () => {
  test('most-remaining category first, TEST last even though it has the most of all; a zero-remaining category still sorts above TEST after a reload', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(4)
    // Descending by remaining (own-block count, no subtree): CONFIG(4) >
    // WORKFLOW(3) > PROVIDER(1); TEST(6) forced last despite the highest count.
    await expect(rows.nth(0)).toContainText('CONFIG')
    await expect(rows.nth(1)).toContainText('WORKFLOW')
    await expect(rows.nth(2)).toContainText('PROVIDER')
    await expect(rows.nth(3)).toContainText('TEST')

    // Fully approve the CONFIG block (top checkbox) — its remaining drops to 0.
    // Deliberately no assertion here that the order stays put right after this
    // click: recomputeLeftList itself never runs from the approve path (no new
    // call site was added there, by explicit reviewer decision — see
    // .claude/docs/blocks-and-ingest.md), but the index can still reshuffle
    // shortly after for an unrelated, pre-existing reason (the comments panel's
    // own ~5s poll re-triggers recomputeLeftList via the indexComments() watch
    // regardless of any approve action) — asserting "no reshuffle yet" would be
    // racing that ambient timer, not testing this feature.
    await rows.filter({ hasText: 'CONFIG' }).click()
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await approve.click()
    await expect(approve).toBeChecked()

    // Wait until the approval durably landed (persistApproval is fire-and-
    // forget), then reload to hit a real recompute trigger point.
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/approvals?pr=${PR}`)
        const list = await res.json()
        return Array.isArray(list) && list.some((r) => (r.rows || []).length > 0)
      })
      .toBe(true)

    await page.reload()
    await leaveSearchBox(page)
    await expect(rows).toHaveCount(4)
    // CONFIG's remaining is now 0: it drops to the bottom of the non-TEST
    // band (still above TEST, which never competes on its own count at all).
    await expect(rows.nth(0)).toContainText('WORKFLOW')
    await expect(rows.nth(1)).toContainText('PROVIDER')
    await expect(rows.nth(2)).toContainText('CONFIG')
    await expect(rows.nth(3)).toContainText('TEST')
  })
})
