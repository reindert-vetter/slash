import { test, expect, appReady } from './_fixtures.mjs'

// Combined regression test for two changes together:
//
// 1. `?dcur=` (state.drillCursorRef, home.mjs) mirrors EVERY drilled level's
//    own {gran, change} cursor, not just the deepest/focused one (`dgran`/
//    `dchg`) — see "Refresh restore" in .claude/docs/drilling.md. Before this,
//    an ANCESTOR drilled column's cursor silently reset to {group, 0} on every
//    refresh (or a direct/shared-link load), even though it's never itself
//    visible on screen (it's collapsed to a rail) — it only mattered once the
//    reviewer popped back OUT to it.
// 2. findNextUnapproved's "return to an unapproved ancestor" step (see the
//    same doc section, commit "Return to an unapproved ancestor after
//    finishing a drilled column's subtree") reads exactly that saved
//    ancestor cursor (state.drillCursor[lvl-2]) once a deeper subtree is
//    fully approved. So a restore that carries an ancestor's non-default
//    cursor must still be the position "Ga terug" lands on, not the reset
//    default.
//
// Fixture chain (PR 12903, all real blocks — see materializeMainWorktrees in
// tests/_setup.mjs — nested via a synthetic /api/relations mock, same
// technique as drill-focus.spec.mjs/drill-approve-return-to-ancestor.spec.mjs):
//   CreatePaymentAction::findOrCreateCustomer (real block, ZERO own change
//   groups — selected top-level, uninteresting for this test) → drill level 1
//   CreatePaymentAction::execute (real block, ONE change group that splits
//   into 3 call segments — the ancestor whose own cursor must survive) →
//   drill level 2 Order::address (real block, patched to status 'modified' so
//   both panes render — the approve target).
//
// execute's own cursor is set to 'call' segment 1 directly via the URL (not
// through live keypresses): a relation child is deliberately hidden while its
// parent's OWN cursor sits at line/call granularity (see relatedChildren's
// `scoped` guard, home.mjs) — an unrelated, intentional scoping rule, not
// reachable together with "drill one level deeper from here" in the live UI.
// Injecting it via `?dcur=` instead is exactly the scenario this feature
// covers anyway: a shared link / a browser restart that reopens the session
// after execute's cursor had already been moved there.
test('a restored ANCESTOR column\'s own non-default cursor is what "Ga terug" lands on', async ({ page }) => {
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
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          kind: 'event_listener',
        },
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
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
  // findOrCreateCustomer has 0 own change groups — entering its diff and then
  // opening its Onderliggende-code panel is still allowed (see enterDiff's own
  // comment in home.mjs / drill-mode-flip.spec.mjs).
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)

  // Drill level 1: findOrCreateCustomer → execute.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const child1 = page.getByTestId('related-item').first()
  await expect(child1).toContainText('execute')
  await child1.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('execute')

  // Drill level 2, from inside the now-focused execute column: execute → address.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const child2 = page.getByTestId('related-item').first()
  await expect(child2).toContainText('address')
  await child2.click()
  await page.waitForTimeout(300)
  await expect(drillColumn).toContainText('address')

  await expect.poll(() => new URL(page.url()).searchParams.get('drill')).toContain('Order.php')

  // Inject execute's (level 1, the first id in the `drill` path) own cursor as
  // 'call' segment 1 into `?dcur=` — see the test's own comment on why this is
  // done via the URL rather than live keypresses.
  const restoreUrl = new URL(page.url())
  restoreUrl.searchParams.set('dcur', 'call:1>group:0')
  await page.goto(restoreUrl.toString())
  await appReady(page)
  await page.waitForTimeout(300)

  // The whole path restored: execute collapsed to a rail (ancestor, not
  // focused), address the focused drilled column.
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toContainText('address')
  await expect(page.getByTestId('drill-collapsed')).toHaveCount(1)

  // Approve address's own (only) group via the command palette.
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').nth(1).click()

  // address's subtree is now fully approved, but execute (the ancestor) still
  // has its own unapproved line — findNextUnapproved's step 3 returns there,
  // labelled "Ga terug".
  await expect(menu).toBeVisible()
  const postApproveRows = page.getByTestId('command-row')
  await expect(postApproveRows.nth(1)).toContainText('Ga terug')
  await postApproveRows.filter({ hasText: 'Ga terug' }).click()
  await expect(menu).not.toBeVisible()
  await page.waitForTimeout(200)

  // The deepest column closed; execute is focused again — and (the actual
  // regression this test guards) its restored cursor is exactly the one
  // carried in `?dcur=` (call segment 1), not the {group, 0} default a
  // restore used to silently fall back to for every non-deepest level.
  await expect(page.getByTestId('drill-column')).toContainText('execute')
  await expect.poll(() => new URL(page.url()).searchParams.get('dgran')).toBe('call')
  await expect.poll(() => new URL(page.url()).searchParams.get('dchg')).toBe('1')
})
