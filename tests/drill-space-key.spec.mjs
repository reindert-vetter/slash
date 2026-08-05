import { test, expect } from './_fixtures.mjs'

// Space on a focused Underlying-code child must drill exactly like Enter
// (and a click) — reviewer request: "spatie moet hetzelfde doen als enter".
// Mirrors the click-driven scenario in drill-focus.spec.mjs, but reaches the
// child purely via the keyboard (→ into the diff, → into the Underlying-code
// card, which lands on the first child) and presses Space instead of Enter.
test('Space on a focused Underlying-code child drills it, like Enter', async ({ page }) => {
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

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()

  // Into the diff, then into the Underlying-code card (lands on first child).
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const activeItem = page.locator('[data-testid="related-item"][data-active="true"]')
  await expect(activeItem).toContainText('findOrCreateCustomer')

  // Space, not Enter — must drill exactly like Enter/click do.
  await page.keyboard.press(' ')
  await page.waitForTimeout(300)

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  const drillArticle = drillColumn.locator('article').first()
  await expect(drillArticle).toHaveClass(/border-indigo-300/)
})
