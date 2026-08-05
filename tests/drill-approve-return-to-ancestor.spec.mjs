import { test, expect } from './_fixtures.mjs'

// findNextUnapproved's step 3 (home.mjs, see "Finishing a drilled column's
// subtree returns to an unapproved ancestor" in drilling.md): once a drilled
// column's own subtree (its own rows + every Underlying-code descendant) is
// fully approved, the reviewer is sent back UP the drill stack to the nearest
// ancestor that itself still has an unapproved unit of its own — skipping an
// ancestor that has NOTHING of its own to approve (0 change groups) rather
// than treating it as "done, stop looking further up" — before falling back
// to the pre-existing sibling-walk. The postApprove confirm menu's default
// item is labelled "Ga terug" for this kind of plan (isReturn), not "Ga door".
//
// Reuses PR 12903's main anchor fixture (see materializeMainWorktrees in
// tests/_setup.mjs), synthetically chained three levels deep via a
// **relations** route mock, same technique as drill-sibling-walk.spec.mjs/
// drill-collapse.spec.mjs:
//   CreatePaymentAction::execute (real, single-line change, the eventual
//   landing target) → CreatePaymentAction::findOrCreateCustomer (real block,
//   but ZERO change groups of its own — deliberately the "ancestor with
//   nothing of its own to approve" in the middle) → Order::address (real,
//   single-line change — patched to status 'modified' via a **blocks** route
//   mock, exactly like drill-sibling-walk.spec.mjs, since its fixture status
//   is 'removed' otherwise).
test('approving the deepest drilled column returns to the nearest unapproved ancestor, skipping one with nothing of its own', async ({
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
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          kind: 'event_listener',
        },
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          childId: '12903:app/Models/Order.php:Order::address',
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
  await page.keyboard.press('ArrowRight') // step into execute's own diff
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  // Drill level 1: execute → findOrCreateCustomer (0 own change groups).
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const child1 = page.getByTestId('related-item').first()
  await expect(child1).toContainText('findOrCreateCustomer')
  await child1.click()

  const drill = page.getByTestId('drill-column')
  await expect(drill).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drill).toContainText('findOrCreateCustomer')

  // Drill level 2, from inside the now-focused drilled column: findOrCreateCustomer → Order::address.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const child2 = page.getByTestId('related-item').first()
  await expect(child2).toContainText('address')
  await child2.click()
  await page.waitForTimeout(300)
  await expect(drill).toContainText('address')
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  // Approve the deepest column's only group via the palette.
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').nth(1).click()

  // findOrCreateCustomer (the immediate parent) has NOTHING of its own to
  // approve (0 change groups) — findNextUnapproved's step 3 skips it and
  // returns to `execute` (the grandparent), which still has its one
  // unapproved line. Still the postApprove confirm menu (a different block
  // than the one just approved), but labelled "Ga terug".
  await expect(menu).toBeVisible()
  const postApproveRows = page.getByTestId('command-row')
  await expect(postApproveRows).toHaveCount(2)
  await expect(postApproveRows.nth(0)).toContainText('Sluit menu')
  await expect(postApproveRows.nth(1)).toContainText('Ga terug')
  await postApproveRows.filter({ hasText: 'Ga terug' }).click()
  await expect(menu).not.toBeVisible()

  // Both drilled columns close in one go and focus lands back on `execute`'s
  // own diff — not on `findOrCreateCustomer` (which has nothing to land on).
  await expect(page.getByTestId('drill-column')).toHaveCount(0)
  await expect(page.getByTestId('drill-collapsed')).toHaveCount(0)
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await expect(page.getByTestId('block-column')).toContainText('CreatePaymentAction::execute')

  // The approval landed on Order::address; execute was never touched.
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/approvals?pr=12903')
      const list = await res.json()
      const row = Array.isArray(list) ? list.find((r) => r.blockId === '12903:app/Models/Order.php:Order::address') : null
      return row && Array.isArray(row.rows) ? row.rows.length : 0
    })
    .toBeGreaterThan(0)

  const approvals = await (await page.request.get('/api/approvals?pr=12903')).json()
  const executeRow = approvals.find(
    (r) => r.blockId === '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
  )
  expect(!executeRow || ((executeRow.rows || []).length === 0 && (executeRow.calls || []).length === 0)).toBe(true)
})
