import { test, expect } from './_fixtures.mjs'

// Regression for "the row's horizontal column-flow must never show a
// scrollbar and must always be flush-left at rest": AppColumns (home.mjs,
// the row wrapping PrInfoPanel/<aside>/<main> — see "AppColumns as a
// horizontally scrolling row" in detail-layout.md) is the single
// `overflow-x-auto` scroll container for the whole row now (PrInfoPanel/
// <aside> included, not just <main>'s own block column + Onderliggende code +
// any drilled columns). A stray manual horizontal scroll (trackpad/scrollbar
// drag) used to persist across navigation, since nothing reset it back to 0
// except scrollFocusIntoView's drill-focused alignment — which deliberately
// does NOT return to 0 while a drilled column is focused (it leaves earlier
// columns scrolled off the left edge, with a chevron hint, see
// detail-layout.md). This tests the two things that changed: (1) AppColumns
// carries the `no-scrollbar` utility class, and (2) a hard scrollLeft=0 reset
// fires at the *rest* transitions — entering the diff, and popping/exiting
// back out to focusLevel===0 && drill.length===0 (either from a drilled
// column, or out of the diff into list-mode) — while leaving the
// drill-in-progress scroll (focusLevel > 0) untouched.
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
  // Narrow viewport so the row's content genuinely overflows and a scrollbar
  // would show if not suppressed.
  // 900px, not the original 1300: with an EMPTY Onderliggende-code column now
  // taking a flat narrow width instead of the 42rem/40rem clamp floor
  // (RELATED_EMPTY_WIDTH_CLS, RelatedPanel.mjs — see "An empty column is
  // narrow" in .claude/docs/underlying-code.md), this fixture's whole column
  // flow fits exactly at 1300 (measured: scrollWidth === clientWidth === 1252)
  // and there is no overflow left to test. 900 keeps it genuinely overflowing
  // (56px collapsed block rail + 609px drilled column + 288px panel).
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/pr/12903')

  const appColumns = page.getByTestId('app-columns')
  await expect(appColumns).toHaveClass(/no-scrollbar/)

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()

  // 1) Entering the diff (list -> diff, rest position) starts flush-left even
  // after simulating a stray manual scroll while still in list-mode.
  await appColumns.evaluate((el) => {
    el.scrollLeft = 200
  })
  await page.keyboard.press('ArrowRight') // enter diff
  await page.waitForTimeout(200)
  expect(await appColumns.evaluate((el) => el.scrollLeft)).toBe(0)

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
  const scrollLeftDrilled = await appColumns.evaluate((el) => el.scrollLeft)
  expect(scrollLeftDrilled).toBeGreaterThan(0)

  // 3) Popping back out of the drilled column (-> focusLevel 0, drill empty)
  // reaches the rest position again: hard reset to 0, even though the drilled
  // column's own alignment left scrollLeft > 0.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  expect(await appColumns.evaluate((el) => el.scrollLeft)).toBe(0)

  // 4) Drill back in, then simulate a stray manual scroll and exit the whole
  // diff session (list-mode is a rest position too) — must also snap to 0.
  await child.click()
  await page.waitForTimeout(300)
  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  await appColumns.evaluate((el) => {
    el.scrollLeft = el.scrollLeft + 50
  })
  await page.keyboard.press('ArrowLeft') // pop drilled column
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowLeft') // exit diff -> list
  await page.waitForTimeout(200)
  await expect(page.getByTestId('pr-index')).toBeVisible()
  expect(await appColumns.evaluate((el) => el.scrollLeft)).toBe(0)
})
