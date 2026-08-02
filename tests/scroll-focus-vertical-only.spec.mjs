import { test, expect } from './_fixtures.mjs'

// Regression for "→ then ← should always leave the selected/focused column
// fully in view": scrollCodeIntoView/scrollChipIntoView/scrollTaskIntoView/
// scrollReactionIntoView (RelatedPanel.mjs) and the scrollChangeIntoView
// fallback (home.mjs) all keep a row in view while walking it with the
// arrows via `el.scrollIntoView({block: 'nearest'|'center'})`. Omitting
// `inline` there defaults it to 'nearest' too, so — since the
// Onderliggende-code card (and its drill-hint chips) live inside <main>'s
// horizontally-scrolling column flow — walking deeper into that panel could
// silently drag <main>'s own scrollLeft sideways, pushing the
// keyboard-focused diff column (to the panel's left) out of view. The fix
// (scrollIntoViewVertical) walks up to the first ancestor that actually
// scrolls *vertically* and adjusts only its scrollTop, never touching
// <main>'s horizontal scroll.
//
// Reuses the related-nested-chip.spec.mjs fixture wiring (PR 12903, routed
// relations execute → findOrCreateCustomer → handle → billingAddress) purely
// for its two-level-deep chip tree — this test only cares about scroll
// geometry, not chip content.
const EXECUTE_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const FIND_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer'
const HANDLE_ID = '12903:app/Actions/ProcessCartAction.php:ProcessCartAction::handle'
const BILLING_ID = '12903:app/Models/Address.php:Address::billingAddress'

test('walking deeper into the Onderliggende-code chip tree never scrolls <main> horizontally', async ({
  page,
}) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        { pr: 12903, parentId: EXECUTE_ID, childId: FIND_ID, kind: 'event_listener' },
        { pr: 12903, parentId: FIND_ID, childId: HANDLE_ID, kind: 'event_listener' },
        { pr: 12903, parentId: HANDLE_ID, childId: BILLING_ID, kind: 'event_listener' },
      ],
    })
  })
  await page.route('**/api/blockstats?pr=12903', async (route) => {
    await route.fulfill({ json: { pr: 12903, totals: { [HANDLE_ID]: 4, [BILLING_ID]: 2 } } })
  })
  await page.route(
    (url) => url.pathname === '/api/code' && url.searchParams.get('file') === 'app/Actions/ProcessCartAction.php',
    async (route) => {
      await route.fulfill({
        json: {
          file: 'app/Actions/ProcessCartAction.php',
          old: { start: 55, text: 'function handle()\n{\n    old();\n}' },
          new: { start: 55, text: 'function handle()\n{\n    newA();\n    newB();\n}' },
        },
      })
    },
  )

  // Narrow viewport so the Onderliggende-code card + its chip columns are
  // genuinely tight against <main>'s right edge — the scenario where a stray
  // horizontal nudge is most likely to actually cut something off.
  await page.setViewportSize({ width: 1300, height: 900 })
  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()

  const main = page.locator('main')
  const blockArticle = page.locator('[data-testid="block-column"] article').first()

  await page.keyboard.press('ArrowRight') // enter diff
  await page.waitForTimeout(200)
  // No comment thread on this unit yet, so → first reaches the embedded
  // Claude chat (unconditionally reachable, auto-creating an empty private
  // comment — see the "Embedded Claude chat" section of comments-panel.md);
  // ArrowDown with nothing to walk there falls through to the related panel
  // (codeSel 0 = findOrCreateCustomer).
  await page.keyboard.press('ArrowRight') // enter embedded Claude chat
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowDown') // fall through to the related panel
  await page.waitForTimeout(200)

  const scrollLeftBefore = await main.evaluate((el) => el.scrollLeft)
  // No "focused column still fully in view" sanity check here anymore: the
  // embedded Claude chat column (just entered/fallen through above) sits
  // between the diff and the related panel, so scrollFocusIntoView's own
  // left-alignment of that intermediate stop already scrolls the original
  // diff column partway out of view at this narrow viewport — expected,
  // pre-existing behaviour (see "Unfocused columns collapse into a narrow
  // rail" in drilling.md), not what this test guards. What DOES matter here —
  // and is checked below — is that walking DEEPER into the chip tree causes
  // no ADDITIONAL horizontal scroll.

  // Descend two chip levels (→ → ): handle, then its own billingAddress
  // sub-chip. Each step used to risk an implicit horizontal 'nearest' scroll
  // via scrollChipIntoView.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  const scrollLeftDeep = await main.evaluate((el) => el.scrollLeft)
  expect(scrollLeftDeep).toBe(scrollLeftBefore)

  // Climb back out of the chips (← ←), back through the (now-existing, from
  // the auto-create above) empty comment thread's own two stops, and finally
  // out of the panel entirely — the diff column must still be exactly where
  // it started, and own the keyboard again.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowLeft') // code -> the auto-created comment's own row
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowLeft') // comment -> diff
  await page.waitForTimeout(200)

  await expect(blockArticle).toHaveClass(/border-indigo-300/)
  const focusedLeftAfter = await blockArticle.evaluate((el) => el.getBoundingClientRect().left)
  const mainLeftAfter = await main.evaluate((el) => el.getBoundingClientRect().left)
  expect(focusedLeftAfter).toBeGreaterThanOrEqual(mainLeftAfter - 1)
})
