import { test, expect } from './_fixtures.mjs'

// PR 99 (tests/fixtures/testsgroup-*.json + materializeTestsGroupWorktrees in
// _setup.mjs): a production method (TgOrder::billingAddress) with TWO covering
// tests (kind covered_by) AND a resolved method call (a non-test child). With
// both kinds present, the Onderliggende-code panel groups the covering tests
// into ONE horizontal bar (data-testid=related-tests-bar, built by
// groupTestChildren in home.mjs) instead of full cards; clicking/Enter on the
// bar expands the tests into ordinary child cards below it (the bar stays as
// the collapse toggle). With ONLY test children (PR 92) the bar never shows —
// the tests render as plain cards, exactly as before.
test.describe('PR Review Tree — grouped covering tests (tests bar)', () => {
  test('covering tests group into a horizontal bar when other children exist; clicking expands/collapses them', async ({
    page,
  }) => {
    await page.goto('/pr/99')

    // All three blocks stay in the left list (test coverage never hides a
    // block, see testcovers rules).
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(3)
    await rows.filter({ hasText: 'TgOrder::billingAddress' }).click()

    // Collapsed by default: the bar shows the grouped tests (count pill +
    // one chip per test method), the only full card is the non-test call
    // child.
    const bar = page.getByTestId('related-tests-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-expanded', 'false')
    await expect(bar).toContainText('2 tests')
    await expect(page.getByTestId('related-tests-chip')).toHaveCount(2)
    await expect(bar).toContainText('testBilling')
    await expect(bar).toContainText('testShipping')
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items).toContainText('AddressFormatter::formatAddress')
    await expect(page.getByTestId('related-code')).not.toContainText('tests/Feature/TgOrderBillingTest.php')

    // Click → the tests expand into ordinary child cards below the bar, which
    // stays put as the collapse toggle.
    await bar.click()
    await expect(bar).toHaveAttribute('data-expanded', 'true')
    await expect(items).toHaveCount(3)
    await expect(items.filter({ hasText: 'TgOrderBillingTest::testBilling' })).toHaveCount(1)
    await expect(items.filter({ hasText: 'TgOrderShippingTest::testShipping' })).toHaveCount(1)
    await expect(items.filter({ hasText: 'AddressFormatter::formatAddress' })).toHaveCount(1)

    // Click again → collapsed back to the bar.
    await bar.click()
    await expect(bar).toHaveAttribute('data-expanded', 'false')
    await expect(items).toHaveCount(1)
  })

  test('a block switch resets the expansion back to collapsed', async ({ page }) => {
    await page.goto('/pr/99')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'TgOrder::billingAddress' }).click()
    const bar = page.getByTestId('related-tests-bar')
    await expect(bar).toBeVisible()
    await bar.click()
    await expect(page.getByTestId('related-item')).toHaveCount(3)

    // Move to a test block: its panel shows the covered method as an ordinary
    // `covers` card — no bar (only one child, nothing to group).
    await rows.filter({ hasText: 'TgOrderBillingTest::testBilling' }).click()
    await expect(page.getByTestId('related-tests-bar')).toHaveCount(0)
    await expect(page.getByTestId('related-item')).toContainText('TgOrder::billingAddress')

    // Back to the production block: collapsed again (ephemeral, per block).
    await rows.filter({ hasText: 'TgOrder::billingAddress' }).click()
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-expanded', 'false')
    await expect(page.getByTestId('related-item')).toHaveCount(1)
  })

  test('keyboard: → lands on the bar, Enter expands, ↓ walks into a test card, Enter drills into it', async ({
    page,
  }) => {
    await page.goto('/pr/99')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'TgOrder::billingAddress' }).click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related panel, first row

    // The covering tests sort first (prio 0, ahead of the call child), so the
    // bar owns the first cursor slot.
    const bar = page.getByTestId('related-tests-bar')
    await expect(bar).toHaveAttribute('data-active', 'true')

    // Enter on the bar toggles the expansion (never drills) — the cursor
    // stays on the bar.
    await page.keyboard.press('Enter')
    await expect(bar).toHaveAttribute('data-expanded', 'true')
    await expect(bar).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('drill-column')).toHaveCount(0)

    // ↓ walks onto the first expanded test card; Enter drills into it as its
    // own diff column (the ordinary child-card behaviour).
    await page.keyboard.press('ArrowDown')
    const firstTest = page.getByTestId('related-item').filter({ hasText: 'TgOrderBillingTest::testBilling' })
    await expect(firstTest).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Enter')
    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('TgOrderBillingTest::testBilling')
  })

  test('with ONLY covering tests (no other children) the tests render as plain cards, no bar', async ({
    page,
  }) => {
    // PR 92: Order::billingAddress has exactly one child — the covering test —
    // and nothing else, so grouping must not kick in (regression for
    // testcovers.spec.mjs' drill-recursion case).
    await page.goto('/pr/92')

    await page.getByTestId('block-row').filter({ hasText: 'Order::billingAddress' }).click()
    await expect(page.getByTestId('related-tests-bar')).toHaveCount(0)
    const child = page.getByTestId('related-item')
    await expect(child).toHaveCount(1)
    await expect(child).toContainText('OrderCoverageTest::testBillingAddress')
  })
})
