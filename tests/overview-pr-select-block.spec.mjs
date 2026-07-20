import { test, expect } from './_fixtures.mjs'

// Coverage for the `?sel=` round-trip through /pr-overview (see "?sel= reist
// mee in dezelfde round-trip" in .claude/rules/pages-and-routing.md): leaving
// a non-default block selected via the ← nav-chain exit, then returning via
// "Open review-boom", must land back on that same block — not the default
// first one.
test.describe('PR overview — ?sel= round-trip keeps the same block selected', () => {
  test('selecting block 1, exiting via ←←, and reopening the tree restores block 1', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    // Block 0 (ContractController::index) sorts first; pick a different block
    // (CreatePaymentAction::execute) so the default (index 0) restore would be
    // a visible regression, not accidentally correct.
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveAttribute('data-idx', '1')
    await expect(page).toHaveURL(/sel=app%2FActions%2FCreatePaymentAction\.php%3A26/)

    await page.keyboard.press('ArrowLeft') // block-index → stop 1 (description)
    await expect(page.getByTestId('pr-info-column')).toHaveCount(1)
    await page.keyboard.press('ArrowLeft') // stop 1 → the PR overview
    await expect(page).toHaveURL(/\/pr-overview/)

    // The exit URL must carry the block reference we left from alongside `pr`.
    expect(page.url()).toContain('sel=app%2FActions%2FCreatePaymentAction.php%3A26')

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await row.click()
    await page.getByTestId('open-tree').click()

    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect(page).toHaveURL(/sel=app%2FActions%2FCreatePaymentAction\.php%3A26/)
    await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveAttribute('data-idx', '1')
  })

  test('opening an unrelated PR from the overview never carries a stale sel along', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(/\/pr-overview/)

    // PR 90 only lives in the "Recent gegenereerd" drawer (see
    // overview-pr-select.spec.mjs) — it's a plain `<a href="/pr/<n>">` link
    // (recentItem), not gated behind the popover, and was never one of the
    // treeUrl() call sites — opening it must not inherit the sel we left
    // PR 12903 with.
    await page.getByTestId('recent').click()
    const item = page.locator('[data-testid="recent-item"][data-pr="90"]')
    await item.click()

    await expect(page).toHaveURL(/\/pr\/90(?:$|[?&])/)
    expect(page.url()).not.toContain('sel=')
  })
})
