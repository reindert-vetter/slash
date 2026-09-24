import { test, expect } from './_fixtures.mjs'

// Reviewer report: "als ik iets selecteer op onderliggende code, wil ik niet
// dat het inklapt als ik los laat" — dragging to select text inside an
// Onderliggende-code card (relatedCard, RelatedPanel.mjs) still fired the
// card's own `@click` on mouseup (same mousedown/mouseup target, regardless
// of any drag in between), which called drill(r) and opened the card as its
// own drilled column — collapsing whatever column was focused before. See
// hasTextSelection's own doc comment in RelatedPanel.mjs.
//
// Same fixture as drill-preview.spec.mjs (proven deterministic): parent
// CreatePaymentAction::execute with two relation children, Order::address and
// findOrCreateCustomer.
test('dragging to select text inside a related-item card does not drill it', async ({ page }) => {
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
  const targetItem = items.filter({ hasText: 'address' })
  const code = targetItem.locator('code').first()
  await expect(code).toBeVisible()

  const box = await code.boundingBox()
  // Drag diagonally across two lines of the code excerpt to make a genuine,
  // non-collapsed browser text selection — mirrors
  // diff-row-mouse-select.spec.mjs's own drag.
  await page.mouse.move(box.x + 10, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 10, box.y + 60, { steps: 20 })
  await page.mouse.up()

  const selectedText = await page.evaluate(() => window.getSelection().toString())
  expect(selectedText.length).toBeGreaterThan(0)

  // No drill happened: no drilled column mounted, no ?drill= in the URL.
  await expect(page.getByTestId('drill-column')).toHaveCount(0)
  await expect(page).not.toHaveURL(/[?&]drill=/)

  // A genuine, later plain click still drills as before. Collapse the
  // selection with a neutral click first — clicking straight back onto the
  // just-selected text is its own native browser corner case (a mousedown
  // landing inside an existing selection defers collapsing it until mouseup,
  // which a same-tick synthetic click can otherwise race) and not what the
  // reported bug is about; a real reviewer's next click is a separate,
  // later gesture.
  await page.mouse.click(5, 5)
  await targetItem.click()
  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  await expect(page.getByTestId('drill-column')).toContainText('Order')
})
