import { test, expect } from './_fixtures.mjs'

// Verifies the parent-column collapse: once a drilled column owns the
// keyboard, every column to its left (the top-level block, and any
// intermediate drilled columns) shrinks to a narrow rail (collapsedColumnHTML
// in home.mjs) so the focused column gets the freed horizontal room. Clicking
// a rail jumps the keyboard focus back to that column (expandColumn),
// discarding anything drilled further right — the same end state as pressing
// ← repeatedly.
//
// Uses PR 12903 (see drill-focus.spec.mjs's rationale) with two chained
// synthetic relations so a child can itself be drilled into a second time:
// CreatePaymentAction::execute → findOrCreateCustomer → ProcessCartAction::handle.
// All three are real PR blocks with real change groups.
test.describe('drilled columns collapse the parent to a rail', () => {
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
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            childId: '12903:app/Actions/ProcessCartAction.php:ProcessCartAction::handle',
            kind: 'event_listener',
          },
        ],
      })
    })
  })

  test('one level deep: the top-level block collapses to a rail, and expands again on click', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    // Before drilling: the top-level card renders its normal diff (selected +
    // look-ahead preview card), no rail.
    await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(2)
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)

    const child = page.getByTestId('related-item').first()
    await expect(child).toContainText('findOrCreateCustomer')
    await child.click()

    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await page.waitForTimeout(300)

    // Drilling in collapses the top-level block column to a rail: no article
    // left in block-column, a visible block-collapsed rail instead.
    await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(0)
    const rail = page.getByTestId('block-collapsed')
    await expect(rail).toBeVisible()
    await expect(rail).toContainText('execute')

    // Clicking the rail jumps focus straight back: the drilled column closes,
    // the rail disappears, and the top-level card's own diff owns the
    // keyboard again (same end state as pressing ← once).
    await rail.click()
    await page.waitForTimeout(200)
    await expect(drillColumn).toHaveCount(0)
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
    const blockArticle = page.locator('[data-testid="block-column"] article').first()
    await expect(blockArticle).toHaveClass(/border-indigo-300/)
  })

  test('two levels deep: every non-focused column collapses, the innermost click restores one level at a time', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    // Drill level 1: execute → findOrCreateCustomer.
    const child1 = page.getByTestId('related-item').first()
    await expect(child1).toContainText('findOrCreateCustomer')
    await child1.click()

    await expect(page.getByTestId('drill-column')).toHaveCount(1)
    await page.waitForTimeout(300)

    // Drill level 2, from inside the now-focused drilled column: step into its
    // own Onderliggende-code panel and drill its child.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(150)
    const child2 = page.getByTestId('related-item').first()
    await expect(child2).toContainText('ProcessCartAction')
    await child2.click()
    await page.waitForTimeout(300)

    // Both the top-level block and the (now unfocused) first drilled column
    // are collapsed to rails — only the deepest (level 2) one keeps the
    // data-testid=drill-column shape (a real, focused article); the level-1
    // one that was drilled from switched to data-testid=drill-collapsed.
    await expect(page.getByTestId('drill-column')).toHaveCount(1)
    await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(0)
    await expect(page.getByTestId('block-collapsed')).toBeVisible()
    const level1Rail = page.locator('[data-testid="drill-collapsed"][data-drill-idx="0"]')
    await expect(level1Rail).toBeVisible()
    await expect(level1Rail).toContainText('findOrCreateCustomer')
    const level2Article = page.getByTestId('drill-column').locator('article')
    await expect(level2Article).toHaveCount(1)
    await expect(level2Article).toHaveClass(/border-indigo-300/)

    // Clicking the level-1 rail restores it and discards the level-2 column
    // it was drilled from (mirrors ← twice from level 2, done in one click).
    await level1Rail.click()
    await page.waitForTimeout(200)
    await expect(page.getByTestId('drill-column')).toHaveCount(1)
    await expect(page.getByTestId('drill-collapsed')).toHaveCount(0)
    // The top-level block is still collapsed — level 1, not level 0, owns the
    // keyboard now.
    await expect(page.getByTestId('block-collapsed')).toBeVisible()
    const restoredArticle = page.getByTestId('drill-column').locator('article')
    await expect(restoredArticle).toHaveClass(/border-indigo-300/)
  })
})
