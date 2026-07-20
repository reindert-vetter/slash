import { test, expect } from './_fixtures.mjs'

// Regression for "<main>'s horizontal column-flow must never show a scrollbar
// and must always be flush-left at rest": <main> (DetailPanel, home.mjs) is an
// `overflow-x-auto` flex-row (block column + Onderliggende code + any drilled
// columns). A stray manual horizontal scroll (trackpad/scrollbar drag) used to
// persist across navigation, since nothing reset it back to 0 except
// scrollFocusIntoView's drill-focused alignment — which deliberately does NOT
// return to 0 while a drilled column is focused (it leaves earlier columns
// scrolled off the left edge, with a chevron hint, see detail-layout.md). This
// tests the two things that changed: (1) <main> carries the `no-scrollbar`
// utility class, and (2) a hard scrollLeft=0 reset fires at the *rest*
// transitions — entering the diff, and popping/exiting back out to
// focusLevel===0 && drill.length===0 (either from a drilled column, or out of
// the diff into list-mode) — while leaving the drill-in-progress scroll
// (focusLevel > 0) untouched.
//
// Uses PR 12903 (the default seeded fixture, see _fixtures.mjs) with one
// synthetic relation so there's a drillable child, mirroring
// drill-collapse.spec.mjs's setup.
const EXECUTE_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const FIND_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [{ pr: 12903, parentId: EXECUTE_ID, childId: FIND_ID, kind: 'event_listener' }],
    })
  })
})

test('<main> hides its horizontal scrollbar and snaps back to flush-left at rest', async ({ page }) => {
  // Narrow viewport so <main>'s content genuinely overflows and a scrollbar
  // would show if not suppressed.
  await page.setViewportSize({ width: 1300, height: 900 })
  await page.goto('/pr/12903')

  const main = page.locator('main')
  await expect(main).toHaveClass(/no-scrollbar/)

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()

  // 1) Entering the diff (list -> diff, rest position) starts flush-left even
  // after simulating a stray manual scroll while still in list-mode.
  await main.evaluate((el) => {
    el.scrollLeft = 200
  })
  await page.keyboard.press('ArrowRight') // enter diff
  await page.waitForTimeout(200)
  expect(await main.evaluate((el) => el.scrollLeft)).toBe(0)

  // 2) Drill into a child column — this is the documented, intentional
  // scroll-right (earlier columns slide off the left edge). Simulate a manual
  // scroll first so we can tell the drill's own alignment moved it.
  await page.keyboard.press('ArrowRight') // enter related panel
  await page.waitForTimeout(150)
  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()
  await page.waitForTimeout(300)

  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  const scrollLeftDrilled = await main.evaluate((el) => el.scrollLeft)
  expect(scrollLeftDrilled).toBeGreaterThan(0)

  // 3) Popping back out of the drilled column (-> focusLevel 0, drill empty)
  // reaches the rest position again: hard reset to 0, even though the drilled
  // column's own alignment left scrollLeft > 0.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  expect(await main.evaluate((el) => el.scrollLeft)).toBe(0)

  // 4) Drill back in, then simulate a stray manual scroll and exit the whole
  // diff session (list-mode is a rest position too) — must also snap to 0.
  await child.click()
  await page.waitForTimeout(300)
  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  await main.evaluate((el) => {
    el.scrollLeft = el.scrollLeft + 50
  })
  await page.keyboard.press('ArrowLeft') // pop drilled column
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowLeft') // exit diff -> list
  await page.waitForTimeout(200)
  await expect(page.getByTestId('pr-index')).toBeVisible()
  expect(await main.evaluate((el) => el.scrollLeft)).toBe(0)
})
