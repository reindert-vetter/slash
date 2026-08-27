import { test, expect } from './_fixtures.mjs'

// Reviewer request: "als je spatie drukt in een diff, dan ga je naar
// onderliggende blokken als die nog niet zijn goedgekeurd. laat de blok
// bovenaan zien die nog niet zijn goedgekeurd" — the Onderliggende-code
// panel's own top-to-bottom order should agree with where Space actually
// lands (findNextUnapproved walks depth-first, see command-palette.md), not
// just the pre-existing prio/size tiers (see "Ordering within a tier" in
// underlying-code.md). relatedChildren now sorts a still-pending child (ANY
// unapproved unit in its own OR nested subtree, via subtreeApproveCount)
// before a fully-done one, ahead of prio/size.
//
// Same fixture as drill-sibling-walk.spec.mjs/drill-preview.spec.mjs (proven
// deterministic): parent CreatePaymentAction::execute with two SIBLING
// children — findOrCreateCustomer (a real PR block with zero changed lines of
// its own, nothing left to approve — prio 0, but never pending) and
// Order::address (a real single-line change, patched from 'removed' to
// 'modified' so both panes render — still unapproved). Both tie on prio 0
// (both are relation children), so before this change their relative order
// came only from `size`/source order; now `pending` decides first.
test('a still-unapproved sibling sorts before a fully-done one, ahead of prio/size', async ({ page }) => {
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
  await page.waitForTimeout(300)

  const items = page.getByTestId('related-item')
  await expect(items).toHaveCount(2)
  // address still has an unapproved group → pending → sorts first, even
  // though findOrCreateCustomer ties it on groupTier/prio (both prio 0).
  await expect(items.nth(0)).toContainText('Order')
  await expect(items.nth(1)).toContainText('findOrCreateCustomer')
})
