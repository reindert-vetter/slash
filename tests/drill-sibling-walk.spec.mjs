import { test, expect } from './_fixtures.mjs'

// Verifies the sibling-walk at the edge of a drilled column: running off its
// own last (or first) change no longer just clamps — it steps SIDEWAYS to the
// next (or previous) sibling in the PARENT's Onderliggende-code list, REPLACING
// the drilled column at the same depth (never stacking a second, deeper
// column). See drillNextChange/drillPrevChange/drillSiblingContext in home.mjs
// and the "Kolom-navigatie" section in detail-layout.md.
//
// Parent: CreatePaymentAction::execute, with two SIBLING children (both direct
// relations of execute, not chained): CreatePaymentAction::findOrCreateCustomer
// (a real PR block whose own body has NO changed lines — old === new — so it
// has zero navigable change groups, meaning drilling into it overflows on the
// very first ArrowDown) and Order::address (a real single-line change —
// morphOne(...) → billingAddress() — exactly ONE group unit, the same fixture
// drill-focus.spec.mjs's f/d/s test uses; its fixture status is 'removed',
// patched to 'modified' here so both panes render, same trick as that test).
// Entering via findOrCreateCustomer (targeted by its label text, not list
// position — relatedChildren's prio/size sort can re-order once each child's
// code has loaded, so an index-based locator would race that reorder) gives a
// deterministic, single-keypress overflow: it has zero groups of its own.
test('running off the end of a drilled column steps sideways to the next sibling (and back with ↑)', async ({
  page,
}) => {
  await page.route('**/api/blocks?pr=12903', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const b of json) {
      if (b.class === 'Order' && b.name === 'address') b.status = 'modified'
    }
    await route.fulfill({ response: res, json })
  })
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Models/Order.php:Order::address',
          kind: 'event_listener',
        },
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

  const items = page.getByTestId('related-item')
  await expect(items).toHaveCount(2)
  // Target children by their known label text, not list position — the two
  // siblings tie on relatedChildren's prio/groupTier sort key at first (both
  // start at size 0 before their code has loaded) and can re-sort once
  // ensureCode resolves, so an index-based locator would race against that
  // reorder. Enter via findOrCreateCustomer (0 groups — old === new — so the
  // very first ArrowDown overflows immediately) and expect Order::address next.
  const enterItem = items.filter({ hasText: 'findOrCreateCustomer' })
  await enterItem.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('findOrCreateCustomer')

  // ↓ past the drilled column's own last unit (immediately — it has zero
  // change groups of its own) steps sideways to the OTHER sibling, replacing
  // this column at the same depth — still exactly one drill-column.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('address')

  // ↑ from the freshly-entered sibling's first (and only) unit steps back —
  // the symmetric direction, same replace-at-the-same-level behaviour.
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('findOrCreateCustomer')
})

// Verifies there's no wrap-around: at the last sibling, running off the end
// clamps exactly as before this feature (no jump, no crash) — a single-child
// parent has nowhere to walk sideways to.
test('with only one sibling, running off the end still clamps (no wrap-around)', async ({ page }) => {
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

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('findOrCreateCustomer')

  // No other sibling to flow into: ↓ (and ↑) are no-ops, still one column.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('findOrCreateCustomer')

  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(150)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('findOrCreateCustomer')
})
