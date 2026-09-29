import { test, expect } from './_fixtures.mjs'

// Reviewer request: whenever the row (AppColumns, home.mjs — PrInfoPanel/
// <aside>/<main> sharing one scroll space, see "AppColumns as a horizontally
// scrolling row" in detail-layout.md) has content scrolled out of view to
// the right, a small always-in-place button (top-right corner of the
// viewport, mirroring Block.mjs's diffLeaveRail in visual language) lets you
// reach it with the mouse — one click hides exactly the current left-most
// column, a second click hides the next one, and so on ("stap voor stap",
// never a jump-all-the-way shortcut). It must never touch state.drill/
// state.focusLevel — purely a scroll-position change — and must disappear
// again once nothing is left off-screen.
//
// Uses PR 12903 (the default seeded fixture) with one synthetic relation so
// there's a drillable child to force enough column width for overflow, same
// setup as main-scroll-rest-left.spec.mjs/drill-collapse.spec.mjs.
const EXECUTE_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const FIND_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [{ pr: 12903, parentId: EXECUTE_ID, childId: FIND_ID, kind: 'event_listener' }],
    })
  })
})

test('a right-edge hint appears while <main> overflows and scrolls one column at a time', async ({ page }) => {
  // Wide viewport first so nothing overflows at all yet.
  await page.setViewportSize({ width: 3200, height: 1000 })
  await page.goto('/pr/12903')

  const hint = page.getByTestId('main-scroll-right-hint')
  const button = page.getByTestId('main-scroll-right-button')
  const appColumns = page.getByTestId('app-columns')

  await expect(hint).toBeHidden()

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await page.keyboard.press('ArrowRight') // enter diff
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowRight') // open Onderliggende code
  await page.waitForTimeout(150)
  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('findOrCreateCustomer')
  await child.dispatchEvent('click')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('drill-column')).toHaveCount(1)

  // Now narrow the viewport so the block column + drilled column genuinely
  // overflow, and reset scroll to a known position (0) — the resize alone
  // (no scroll) must already flip the hint on, since the sentinel's
  // IntersectionObserver reacts to the root's own geometry changing too.
  // 900px, not the original 1300: with an EMPTY Onderliggende-code column now
  // taking a flat narrow width instead of the 42rem/40rem clamp floor
  // (RELATED_EMPTY_WIDTH_CLS, RelatedPanel.mjs — see "An empty column is
  // narrow" in .claude/docs/underlying-code.md), this fixture's whole column
  // flow fits exactly at 1300 (measured: scrollWidth === clientWidth === 1252)
  // and there is no overflow left to test. 900 keeps it genuinely overflowing
  // (56px collapsed block rail + 609px drilled column + 288px panel).
  await page.setViewportSize({ width: 900, height: 900 })
  await appColumns.evaluate((el) => {
    el.scrollLeft = 0
  })
  await page.waitForTimeout(200)

  await expect(hint).toBeVisible()

  const scrollBefore = await appColumns.evaluate((el) => el.scrollLeft)

  await button.dispatchEvent('click')
  await page.waitForTimeout(150)
  const scrollAfterOneClick = await appColumns.evaluate((el) => el.scrollLeft)
  expect(scrollAfterOneClick).toBeGreaterThan(scrollBefore)

  // A pure scroll — never a drill-state change.
  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  await expect(page.getByTestId('drill-collapsed')).toHaveCount(0)

  // Clicking again advances further right, one more column.
  await button.dispatchEvent('click')
  await page.waitForTimeout(150)
  const scrollAfterTwoClicks = await appColumns.evaluate((el) => el.scrollLeft)
  expect(scrollAfterTwoClicks).toBeGreaterThan(scrollAfterOneClick)

  // Once everything fits (fully scrolled), the hint disappears.
  await appColumns.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  await page.waitForTimeout(200)
  await expect(hint).toBeHidden()
})
