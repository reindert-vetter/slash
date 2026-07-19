import { test, expect } from './_fixtures.mjs'

// Verifies the look-ahead preview of the NEXT Onderliggende-code sibling,
// stacked VERTICALLY BELOW the focused drilled column's own card
// (drillPreviewColumns/state.drillPreviewChild in home.mjs) — mirrors the
// top-level block-column's own look-ahead preview of the next sidebar block
// (see "Kolom-navigatie" in detail-layout.md): the reviewer should see what ↓
// would drill into (drillNextChange → drillToSibling) BEFORE actually
// stepping there, not just after, and it must sit UNDER the focused column
// (not beside it — a horizontally side-by-side preview was tried first and
// rejected: it read as a second column rather than a look-ahead).
//
// Same fixture as drill-sibling-walk.spec.mjs (proven deterministic): parent
// CreatePaymentAction::execute with two sibling children —
// findOrCreateCustomer (a real PR block with zero changed lines of its own,
// so drilling into it overflows on the very first ArrowDown) and
// Order::address (a real single-line change, patched from 'removed' to
// 'modified' so both panes render).
test('drilling shows a dimmed preview of the next sibling before navigating to it', async ({ page }) => {
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
  const enterItem = items.filter({ hasText: 'findOrCreateCustomer' })
  await enterItem.click()

  const drillColumn = page.getByTestId('drill-column')
  const previewColumn = page.getByTestId('drill-preview-column')
  // The preview reuses the existing vertical connector() (same dashed-line
  // component the top-level block-column uses between stacked cards, see
  // detail-layout.md) — data-testid="file-connector", not a separate
  // drilled-only testid — scoped to inside the drilled column so it can't
  // match anything else on the page.
  const previewConnector = drillColumn.getByTestId('file-connector')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('findOrCreateCustomer')

  // Before pressing ↓ at all: the sibling ↓ would eventually flow into
  // (Order::address) is already visible, dimmed, UNDER the real column.
  await expect(previewColumn).toHaveCount(1)
  await expect(previewConnector).toHaveCount(1)
  await expect(previewColumn).toContainText('address')
  // The preview is dimmed like the top-level look-ahead card (opacity via
  // Block's own preview styling) — spot-check it doesn't render as an active,
  // fully-opaque card by asserting it never claims the diff keyboard.
  await expect(previewColumn.locator('[data-testid="drill-left-hint"]')).toHaveCount(0)

  // Positioned BELOW the focused column's own card, not beside it: the
  // preview's bounding box starts further down the page than the drilled
  // column's, and stays within the same horizontal band (stacked, not a
  // second column to the right).
  const drillBox = await drillColumn.boundingBox()
  const previewBox = await previewColumn.boundingBox()
  expect(previewBox.y).toBeGreaterThan(drillBox.y)
  expect(Math.abs(previewBox.x - drillBox.x)).toBeLessThan(20)

  // ↓ overflows immediately (findOrCreateCustomer has zero change groups) and
  // promotes the previewed sibling into the real, focused column.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('address')

  // Only two siblings total, and we're now on the last one — no further
  // sibling to preview, so the look-ahead disappears entirely.
  await expect(previewColumn).toHaveCount(0)
  await expect(previewConnector).toHaveCount(0)

  // ↑ steps back to the other sibling — the preview reappears, now pointing
  // forward at Order::address again (proves the identity-guarded
  // state.drillPreviewChild field isn't stuck after a promote-then-revert).
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(250)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('findOrCreateCustomer')
  await expect(previewColumn).toHaveCount(1)
  await expect(previewColumn).toContainText('address')
})
