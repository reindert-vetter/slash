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
const TARGET_ID = '113:app/Actions/TestCallHideAction.php:TestCallHideAction::execute'

test.describe('PR Review Tree — a resolved call from a TEST caller keeps its target visible', () => {
  test('the changed target stays a navigable row, in the ordinary list', async ({ page }) => {
    // PR 113 has no worktree (see tests/_setup.mjs), so the real
    // /api/blockstats reads no source and reports 0 for every block — give it
    // a deterministic non-zero total so this test exercises the ordinary
    // "target stays visible" case, not the confirmed-zero-total exception
    // below.
    await page.route('**/api/blockstats?pr=113', async (route) => {
      await route.fulfill({ json: { pr: 113, totals: { [TARGET_ID]: 2 } } })
    })
    await page.goto('/pr/113')

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)

    // A target only underlying because of a TEST follows the ordinary
    // file/category rank (before the TEST band), with no "Onderliggende code"
    // heading.
    await expect(rows.nth(0)).toContainText('TestCallHideAction::execute')
    await expect(rows.nth(1)).toContainText('TestCallHideActionTest')
    await expect(page.getByTestId('underlying-heading')).toHaveCount(0)
  })

  // A testCallTargetIds row with a CONFIRMED server-side total of 0 has no
  // checkbox on its own card already (see "A block with zero changed rows has
  // nothing to approve" in .claude/docs/approval.md) — giving it its own
  // "Onderliggende code" index row on top of that is a dead entry with
  // nothing to do. Reported on PR 13392's DeleteTenantSubscriptionsActivity.php
  // (a real, whitespace/trivial-only diff called from a test).
  test('a target with a confirmed zero approval total gets no index row', async ({ page }) => {
    await page.route('**/api/blockstats?pr=113', async (route) => {
      await route.fulfill({ json: { pr: 113, totals: { [TARGET_ID]: 0 } } })
    })
    await page.goto('/pr/113')

    // Only the test itself gets an index row now; no "Onderliggende code" heading.
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('TestCallHideActionTest')
    await expect(page.getByTestId('underlying-heading')).toHaveCount(0)

    // Still fully reachable via the Onderliggende-code panel and drillable.
    const child = page.getByTestId('related-item')
    await expect(child).toHaveCount(1)
    await expect(child).toContainText('TestCallHideAction::execute')
    await child.click()
    await expect(page.getByTestId('drill-column')).toContainText('TestCallHideAction::execute')
  })
})
