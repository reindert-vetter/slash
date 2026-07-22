import { test, expect } from './_fixtures.mjs'

// Regression: → in list mode must always step into the diff — even for a
// real PR block whose own body has 0 navigable change groups (old === new,
// so it only exists as the parent of Onderliggende-code children).
// enterDiff() (home.mjs) used to bail out silently for such a block
// (`groupsFor(b).length === 0`), so a reviewer who selected it directly from
// the sidebar (not by drilling into it as someone else's child — see
// drill-sibling-walk.spec.mjs) saw nothing happen on →, unlike → in the
// PR-summary card (stop 1, state.showDescription), which always steps
// forward deterministically. The guard is removed (see enterDiff's own
// comment); ensureCode's separate "diff + 0 groups → back to list" fallback
// is removed too, since it would otherwise immediately undo this very same →
// once the block's code lands (see the comment above scrollChangeIntoView in
// ensureCode).
//
// Fixture: PR 12903, CreatePaymentAction::findOrCreateCustomer (0 groups,
// old === new) with a routed relation making it the PARENT of Order::address
// (patched to 'modified' so the child has one real group) — the same
// relation drill-mode-flip.spec.mjs uses, but entered directly from the
// sidebar here instead of via a postApprove drill.
test('→ on a block with 0 own change groups still enters the diff, and a further → opens Onderliggende code', async ({
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
          parentId:
            '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          childId: '12903:app/Models/Order.php:Order::address',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'findOrCreateCustomer' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  // List-mode preview: 0 groups means nothing to highlight.
  await expect(page.locator('[data-change-active]')).toHaveCount(0)
  await expect(panel).toHaveClass(/left-\[29rem\]/)

  // → still steps into the diff — the panel expands to its full-width diff
  // layout — even though there's nothing to highlight.
  await page.keyboard.press('ArrowRight')
  await expect(panel).toHaveClass(/left-6/)
  await expect(page.locator('[data-change-active]')).toHaveCount(0)

  // Give ensureCode's (now-removed) "0 groups → back to list" fallback a
  // window to fire if it still existed — diff mode must stick, not bounce
  // back to the narrow list layout once the block's code has fully landed.
  await page.waitForTimeout(300)
  await expect(panel).toHaveClass(/left-6/)

  // A further → opens Onderliggende code, showing the resolved relation child.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('related-code')).toBeVisible()
  const items = page.getByTestId('related-item')
  await expect(items).toHaveCount(1)
  await expect(items).toContainText('address')
})
