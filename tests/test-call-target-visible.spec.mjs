import { test, expect } from './_fixtures.mjs'

// Regression for resolvedCallTargetIds/testCallTargetIds (home.mjs): a resolved
// method call whose CALLER is a TEST block must not hide the (changed,
// reviewable) target from the block index — only production-to-production
// calls do that (the target is then pure reference code, already shown as a
// child in the Onderliggende-code panel). A test literally calling the
// production method it exercises is the same "must not vanish" situation the
// existing testCoverTargetIds exemption already covers for @covers annotations
// — before the fix, PR 113 showed only ONE index row (the test), with the
// actually changed TestCallHideAction::execute reachable only by drilling from
// the test's own Onderliggende-code panel.
test.describe('PR Review Tree — a resolved call from a TEST caller keeps its target visible', () => {
  test('the changed target stays a navigable row, under "Onderliggende code"', async ({ page }) => {
    await page.goto('/pr/113')

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    await expect(page.getByText('2 startpunten')).toBeVisible()

    // The test sorts at its ordinary TEST rank; the action — now an
    // "Onderliggende code" row, rank 3 — sorts after it, mirroring how a
    // relation child sorts to the bottom (recomputeLeftList's `rank`).
    await expect(rows.nth(0)).toContainText('TestCallHideActionTest')
    await expect(rows.nth(1)).toContainText('TestCallHideAction::execute')

    // The "Onderliggende code" heading sits directly above the action's row —
    // it joined state.underlyingIds instead of being hidden outright.
    const heading = page.getByTestId('underlying-heading')
    await expect(heading).toBeVisible()
    await expect(heading).toContainText('Onderliggende code')
  })
})
