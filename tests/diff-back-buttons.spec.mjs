import { test, expect } from './_fixtures.mjs'

// Mouse-navigation audit follow-up (part C): there was no mouse way BACK out
// of a diff session or out of a drilled Underlying-code column — only ←.
// block-leave-diff / block-close-column call the exact same functions ←
// already runs (leaveDiffToList/closeDrilledColumn, home.mjs), per the
// "click runs the same function a key runs" rule in mouse-navigation.md.
//
// block-leave-diff now sits in a small "diff-leave-rail" block to the LEFT
// of the top-level card (moved out of the header row) together with
// block-open-description — the mouse equivalent of pressing ← TWICE,
// straight to stop 1 (the PR description), see leaveDiffToDescription
// (home.mjs).

test('block-leave-diff returns from the diff to the block list, like ←', async ({ page }) => {
  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.first().click()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)

  const blockColumn = page.getByTestId('block-column')
  await expect(blockColumn).toBeVisible()

  const rail = page.getByTestId('diff-leave-rail')
  await expect(rail).toBeVisible()
  await expect(rail).toHaveCount(1)
  // The rail sits OUTSIDE the <article> now, not in its header row.
  await expect(rail.locator('article')).toHaveCount(0)

  const backButton = page.getByTestId('block-leave-diff')
  await expect(backButton).toBeVisible()
  // Never on a preview/look-ahead card — only the one card that owns the diff.
  await expect(backButton).toHaveCount(1)
  // The passive selection-menu preview must never sit under this rail (see
  // "Every diff card/column also has a mouse way back" in
  // mouse-navigation.md) — a real overlap would make this dispatchEvent
  // click land on the wrong element in a real browser, though Playwright's
  // dispatchEvent bypasses hit-testing regardless.
  await expect(page.getByTestId('command-anchor')).toHaveCount(0)

  await backButton.dispatchEvent('click')

  // Same end state as pressing ← once at the top level: back to list mode
  // (sidebar reachable again, the diff no longer owns the keyboard so
  // neither the back button nor the active-diff border show up).
  await expect(page.getByTestId('pr-index')).toBeVisible()
  await expect(page.getByTestId('block-leave-diff')).toHaveCount(0)
  await expect(page.locator('[data-change-active]')).toHaveCount(0)
})

test('block-open-description jumps straight to stop 1, like ← twice', async ({ page }) => {
  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.first().click()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)

  const openDescription = page.getByTestId('block-open-description')
  await expect(openDescription).toBeVisible()
  await expect(openDescription).toHaveCount(1)

  await openDescription.dispatchEvent('click')

  // Same end state as pressing ← twice from the diff: stop 1 (the PR
  // description) is open, the diff no longer owns the keyboard.
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
  await expect(page.getByTestId('block-leave-diff')).toHaveCount(0)
  await expect(page.getByTestId('block-open-description')).toHaveCount(0)
  await expect(page.locator('[data-change-active]')).toHaveCount(0)
})

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
  await expect(page.getByTestId('block-leave-diff')).toHaveCount(0)
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
  await expect(page.getByTestId('block-leave-diff')).toBeVisible()
})
