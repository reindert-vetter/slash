import { test, expect } from './_fixtures.mjs'

// Verifies the "return" mirror of drill-open-animation.spec.mjs: stepping
// back out of a drilled column — via ← or a collapsed-rail click — plays the
// short entrance-from-the-left animation (.drill-return, drillReturnMarker in
// home.mjs) on the column that regains the keyboard focus, exactly once, and
// never replays on a later plain navigation step within that same column.
//
// Fixture setup mirrors drill-open-animation.spec.mjs / drill-collapse.spec.mjs:
// PR 12903 (the only fixture PR backed by a real worktree) with a synthetic
// relation nesting findOrCreateCustomer under CreatePaymentAction::execute.
test.describe('stepping back out of a drilled column animates the column that regains focus', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            kind: 'event_listener',
          },
        ],
      })
    })
  })

  test('← pops the drilled column and animates the top-level card it returns to', async ({ page }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    const child = page.getByTestId('related-item')
    await expect(child).toContainText('findOrCreateCustomer')
    await child.click()

    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await expect(drillColumn).toHaveClass(/drill-enter/)

    // Step back out: the drilled column closes, the top-level card regains
    // the keyboard and carries the mirrored return animation.
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(200)
    await expect(drillColumn).toHaveCount(0)

    const detailCard = page.getByTestId('detail-card').first()
    await expect(detailCard).toHaveClass(/drill-return/)

    // Tag the live DOM node — a later, unrelated navigation step must not
    // remount it (and thus must not replay the animation).
    await detailCard.evaluate((el) => el.setAttribute('data-node-marker', 'same-node'))
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(150)
    await expect(detailCard).toHaveAttribute('data-node-marker', 'same-node')
  })

  test('clicking a collapsed rail (expandColumn) animates the column it jumps back to', async ({ page }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    const child = page.getByTestId('related-item')
    await expect(child).toContainText('findOrCreateCustomer')
    await child.click()

    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await page.waitForTimeout(300)

    // The top-level block collapsed to a rail while the drilled column owns
    // the keyboard — click it to jump straight back (expandColumn).
    const rail = page.getByTestId('block-collapsed')
    await expect(rail).toBeVisible()
    await rail.click()
    await page.waitForTimeout(200)
    await expect(drillColumn).toHaveCount(0)

    const detailCard = page.getByTestId('detail-card').first()
    await expect(detailCard).toHaveClass(/drill-return/)
  })
})
