import { test, expect } from './_fixtures.mjs'

// Regression: ensureCode's "block with 0 navigable groups → fall back to
// list mode" guard (home.mjs) must NOT fire while a drilled column is open.
//
// The flow that hit it: approving via the palette, then "Ga door" landing in
// the next top-level block's CHILD subtree (findNextUnapproved step 4 →
// applyNextUnapproved). The new root's own /api/code fetch is often still in
// flight at plan time (the look-ahead preview requested it, so the subtree
// walk's own `await ensureCode(b)` returns immediately via the codeRequested
// dedup while b.code is still null). "Ga door" then selects that root and
// drills into its child (focusLevel=1, mode='diff', the parent collapsed to a
// rail on the left). When the delayed fetch finally lands and the root has 0
// own change groups (its own body is unchanged — exactly the kind of block
// whose only reviewable content is that drilled child), the old unguarded
// fallback flipped state.mode to 'list' while state.drill/focusLevel still
// pointed at the drilled child: the blocks index slid back in, and the next
// ArrowLeft missed the diff-mode peel branch entirely — reported as "← gaat
// naar de blokken index i.p.v. de ingeklapte kolom te openen". The fallback
// is now guarded on the rest position (focusLevel===0 && drill empty), which
// keeps the URL-restore case (page load, drill always empty) intact.
//
// Fixture: PR 12903. CreatePaymentAction::findOrCreateCustomer is a real PR
// block whose own body has NO changed lines (0 navigable groups — the same
// property drill-sibling-walk.spec.mjs leans on); a routed relation makes it
// the parent of Order::address (patched to 'modified' so the child has one
// real group). Its /api/code response is delayed so it resolves only after
// "Ga door" has drilled.
test('delayed 0-group root code keeps diff mode while drilled; ← peels back to the parent', async ({
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
  // Delay findOrCreateCustomer's own code so it resolves only after "Ga door"
  // has selected it and drilled into its child.
  await page.route('**/api/code**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('name') === 'findOrCreateCustomer') {
      await new Promise((r) => setTimeout(r, 2500))
    }
    await route.fallback()
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()
  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight') // into execute's diff

  // Approve execute's groups one by one via the palette. The same-block skip
  // auto-advances within the block; the last approve opens the postApprove
  // menu with the plan pointing into findOrCreateCustomer's child subtree.
  const menu = page.getByTestId('command-menu')
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    await page.waitForTimeout(250)
    if ((await menu.isVisible()) && (await menu.textContent()).includes('Ga door')) break
  }
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
  await expect(menu).not.toBeVisible()

  // Drilled into Order::address under findOrCreateCustomer: one drill column,
  // the (0-group) parent collapsed to a rail on the left.
  const drill = page.getByTestId('drill-column')
  await expect(drill).toHaveCount(1)
  await expect(drill).toContainText('Order::address')
  await expect(page.getByTestId('block-collapsed')).toBeVisible()

  // Wait past the delayed root-code fetch — the buggy list-flip happened here.
  await page.waitForTimeout(3500)

  // Still diff mode: the pr-index stays slid away (list mode would show
  // translate-x-0 plus the indigo list-focus ring).
  const aside = page.getByTestId('pr-index')
  await expect(aside).toHaveClass(/-translate-x-\[28rem\]/)
  await expect(drill).toHaveCount(1)

  // ← peels the drilled column: focus back on the (now expanded) parent's own
  // diff — never to the blocks index, and never opening the description column.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('drill-column')).toHaveCount(0)
  await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
  await expect(aside).toHaveClass(/-translate-x-\[28rem\]/)
  await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
})
