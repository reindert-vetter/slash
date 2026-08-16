import { test, expect } from './_fixtures.mjs'

// Mouse-navigation audit follow-up (part C): there was no mouse way BACK out
// of a diff session or out of a drilled Underlying-code column — only ←.
// block-close-column calls the exact same function ← already runs
// (closeDrilledColumn, home.mjs), per the "click runs the same function a
// key runs" rule in mouse-navigation.md.
//
// The top-level card's own way back used to be a two-icon "diff-leave-rail"
// glued to the card (block-leave-diff + block-open-description, the latter a
// mouse-only shortcut jumping straight to stop 1 in one click). Both are
// gone: replaced by MainScrollLeftHint (home.mjs), a single, always-in-place
// button mirroring MainScrollRightHint — one column per click, no shortcut.
// See main-scroll-left-hint.spec.mjs for that button's own tests.

test('block-close-column closes a drilled column and returns to its parent, like ←', async ({ page }) => {
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
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)

  // The top-level card is now collapsed to a rail and shows no leave-diff
  // button of its own; the drilled column shows the close-column button.
  const closeButton = drillColumn.getByTestId('block-close-column')
  await expect(closeButton).toBeVisible()

  await closeButton.dispatchEvent('click')
  await page.waitForTimeout(200)

  // Same end state as pressing ← once from the drilled column: it closes and
  // the top-level card's own diff owns the keyboard again.
  await expect(drillColumn).toHaveCount(0)
  await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
  const blockArticle = page.locator('[data-testid="block-column"] article').first()
  await expect(blockArticle).toHaveClass(/border-indigo-300/)
})
