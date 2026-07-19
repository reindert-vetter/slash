import { test, expect } from './_fixtures.mjs'

// Verifies the drill-hint chips in the Onderliggende-code panel: a child card
// whose block itself has changed underlying code (nestedChangedKids in
// home.mjs) shows a dashed connector to a narrow recursive chip column on its
// right (data-testid=related-nested) — one chip per changed (grand)child with
// its FULL class::method label (wrapped, never truncated — no more
// "ProductGroupStoreReq…"), its own +A −B diff-stat and its approval
// done/total (a precomputed string — regression for the `i=>je(n,i)` template
// leak) — while a child without changed underlying code shows no chips at
// all. Chips nest recursively (depth-capped): a grandchild's own changed
// child renders as its OWN further chip column to the RIGHT (nestedChipColumn,
// the one recursive building block at every depth — there is no more
// indented-underneath "sub" variant). Clicking a chip at depth d — or
// pressing Enter on it once focused via →/↓/←, see below — drills d+1 levels
// in one go. The collapsed column rails show the same full class::method
// label (blockLabel). →/↓/↑/←/Enter navigate and drill the chip tree via
// cs.chipPath (RelatedPanel.mjs' handleRelatedKey), spatially mirroring the
// rightward chip layout: → descends into the focused item's own nested
// chips, ← climbs one level back (only leaving the panel once chipPath is
// already empty), ↓/↑ walk siblings at the current chip depth.
//
// Uses PR 12903 with routed relations (the drill-collapse.spec.mjs pattern):
// execute → findOrCreateCustomer → ProcessCartAction::handle →
// Address::billingAddress gives the findOrCreateCustomer card a chip for
// handle with a sub-chip for billingAddress. /api/blockstats and /api/code
// (for the handle block) are routed too, so the chip's approval total and
// diff-stat are deterministic (independent of the local worktree contents).
const EXECUTE_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const FIND_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer'
const HANDLE_ID = '12903:app/Actions/ProcessCartAction.php:ProcessCartAction::handle'
const BILLING_ID = '12903:app/Models/Address.php:Address::billingAddress'
const ORDER_ADDRESS_ID = '12903:app/Models/Order.php:Order::address'

test.describe('drill-hint chips next to Onderliggende-code cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          { pr: 12903, parentId: EXECUTE_ID, childId: FIND_ID, kind: 'event_listener' },
          { pr: 12903, parentId: FIND_ID, childId: HANDLE_ID, kind: 'event_listener' },
          { pr: 12903, parentId: HANDLE_ID, childId: BILLING_ID, kind: 'event_listener' },
        ],
      })
    })
    // Deterministic approval total for the chip targets, regardless of what
    // the shared worktrees currently contain.
    await page.route('**/api/blockstats?pr=12903', async (route) => {
      await route.fulfill({ json: { pr: 12903, totals: { [HANDLE_ID]: 4, [BILLING_ID]: 2 } } })
    })
    // Deterministic diff for the handle chip: two added lines, one removed
    // (a paired modification counts +1/−1, the extra insert +1 → "+2 −1").
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
  })

  test('a child with changed underlying code gets a connector + chip (full label, diffstat, approval string, no file)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    // The findOrCreateCustomer card — whose block has a changed child
    // (handle) — carries the chip column as its flex-row sibling.
    const childCard = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(childCard).toBeVisible()
    // .first(): the card's own top-level chip column, in document order —
    // handle's chip carries its OWN further column (billingAddress) nested
    // inside it, so this same testid also matches one level deeper.
    const nested = childCard.locator('xpath=..').getByTestId('related-nested').first()
    await expect(nested.locator('> div > [data-testid="related-nested-chip"]')).toHaveCount(1)

    // Top-level chip: FULL class::method label, +2 −1 diffstat, approval
    // string 0/4 — and no file line anywhere in the chip.
    const chip = nested.getByTestId('related-nested-chip').first()
    await expect(chip.locator('> span').first()).toHaveText('ProcessCartAction::handle')
    await expect(chip.getByTestId('related-nested-diffstat').first()).toContainText('+2')
    await expect(chip.getByTestId('related-nested-diffstat').first()).toContainText('−1')
    await expect(chip.getByTestId('related-nested-approval').first()).toHaveText('0/4')
    await expect(chip).not.toContainText('.php')

    // Regression for the `i=>je(n,i)` leak: nothing in the chip column ever
    // renders a stringified function.
    await expect(nested).not.toContainText('=>')

    // The label wraps rather than truncates (point 1 of the "chips" task):
    // no `truncate` class on the label span.
    await expect(chip.locator('> span').first()).not.toHaveClass(/truncate/)

    // Recursion: the handle chip carries its OWN further chip column to the
    // right (nestedChipColumn again, not a separate "sub" shape) for its
    // changed child (Address::billingAddress), full label again.
    const subColumn = chip.locator('xpath=..').getByTestId('related-nested')
    await expect(subColumn).toHaveCount(1)
    const subChip = subColumn.getByTestId('related-nested-chip')
    await expect(subChip).toHaveCount(1)
    await expect(subChip.locator('> span').first()).toHaveText('Address::billingAddress')
  })

  test('→/↓/↑/←/Enter navigate and drill the chip tree', async ({ page }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    // Two presses: the click only selected the block (still 'list' mode, with
    // its own diff preview) — the first ArrowRight is the list→diff step, the
    // second is the actual enterRelated() into this panel (see the nav-chain
    // "stops" in keyboard-navigation.md).
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    const childCard = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(childCard).toBeVisible()
    await expect(childCard).toHaveAttribute('data-active', 'true')

    // → from the card descends into its first (only) top-level chip (handle).
    await page.keyboard.press('ArrowRight')
    const handleChip = page.getByTestId('related-nested-chip').filter({ hasText: 'ProcessCartAction::handle' })
    await expect(handleChip).toHaveAttribute('data-active', 'true')
    // The card itself is no longer the active related-item once a chip owns
    // the cursor.
    await expect(childCard).toHaveAttribute('data-active', 'false')

    // → again descends one level further into handle's own sub-chip
    // (billingAddress) — spatially to the right, per the new layout.
    await page.keyboard.press('ArrowRight')
    const billingChip = page.getByTestId('related-nested-chip').filter({ hasText: 'Address::billingAddress' })
    await expect(billingChip).toHaveAttribute('data-active', 'true')
    await expect(handleChip).toHaveAttribute('data-active', 'false')

    // ← climbs back up one level (to the handle chip), not straight out of
    // the panel.
    await page.keyboard.press('ArrowLeft')
    await expect(handleChip).toHaveAttribute('data-active', 'true')
    await expect(panel).toBeVisible() // the panel itself never closed

    // A second ← climbs back to the card (chipPath now empty).
    await page.keyboard.press('ArrowLeft')
    await expect(childCard).toHaveAttribute('data-active', 'true')
    await expect(handleChip).toHaveAttribute('data-active', 'false')

    // A third ← — chipPath is empty now — falls through to the existing
    // "leave the panel" behaviour: the keyboard returns to the diff.
    await page.keyboard.press('ArrowLeft')
    await expect(childCard).toHaveAttribute('data-active', 'false')

    // → re-enters the panel from the diff (enterRelated, unchanged), landing
    // back on the card itself (chipPath resets to []); → twice more descends
    // to the handle chip, then its billingAddress sub-chip; Enter then drills
    // through the WHOLE chain (findOrCreateCustomer → handle →
    // billingAddress) in one go, same as a click on the sub-chip.
    await page.keyboard.press('ArrowRight')
    await expect(childCard).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(handleChip).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(billingChip).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await expect(drillColumn).toContainText('Address::billingAddress')
    const rail0 = page.locator('[data-testid="drill-collapsed"][data-drill-idx="0"]')
    const rail1 = page.locator('[data-testid="drill-collapsed"][data-drill-idx="1"]')
    await expect(rail0).toBeVisible()
    await expect(rail1).toBeVisible()
  })

  test('clicking a depth-2 sub-chip drills three levels deep in one go; rails show class::method', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    // Click the nested sub-chip (Address::billingAddress, depth 2 under the
    // findOrCreateCustomer card, now rendered as its own further chip column
    // to the RIGHT of the handle chip rather than an indented block
    // underneath it): one click drills three levels — findOrCreateCustomer,
    // then handle, then billingAddress.
    const subChip = page.getByTestId('related-nested-chip').filter({ hasText: 'Address::billingAddress' })
    await expect(subChip).toBeVisible()
    await subChip.click()
    await page.waitForTimeout(300)

    // Deepest column is billingAddress's own focused diff column; the two
    // intermediate levels collapsed to rails, the top-level block too.
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await expect(drillColumn).toContainText('Address::billingAddress')
    const rail0 = page.locator('[data-testid="drill-collapsed"][data-drill-idx="0"]')
    const rail1 = page.locator('[data-testid="drill-collapsed"][data-drill-idx="1"]')
    await expect(rail0).toBeVisible()
    await expect(rail1).toBeVisible()

    // Rails show the FULL class::method label (blockLabel) — not just the
    // bare method name.
    await expect(rail0).toContainText('CreatePaymentAction::findOrCreateCustomer')
    await expect(rail1).toContainText('ProcessCartAction::handle')
    const blockRail = page.getByTestId('block-collapsed')
    await expect(blockRail).toBeVisible()
    await expect(blockRail).toContainText('CreatePaymentAction::execute')
  })

  // Regression for the `i=>je(n,i)` template leak (conventions.md): the bug
  // only manifests when two SIBLING chip instances — sharing the same
  // nestedChip call site/template shape — render in the same pass with
  // DIFFERING approval-badge presence (one with an approval total, one
  // without). The two earlier tests never exercise that: their chips are at
  // different nesting depths (handle at depth 1, billingAddress at depth 2),
  // never siblings under the same card. This test overrides the relations/
  // blockstats routes to give findOrCreateCustomer a SECOND depth-1 chip
  // (Order::address, a real PR-12903 block used elsewhere in the suite) with
  // blockstats total 0 — approveText === '' (hidden), sibling to handle's
  // 0/4 (visible) — reproducing the exact fan-out that corrupted the shared
  // template chunk before the `${() => …}` / precomputed-string fix.
  test('two sibling chips with differing approval presence never leak the template function', async ({ page }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          { pr: 12903, parentId: EXECUTE_ID, childId: FIND_ID, kind: 'event_listener' },
          { pr: 12903, parentId: FIND_ID, childId: HANDLE_ID, kind: 'event_listener' },
          { pr: 12903, parentId: FIND_ID, childId: ORDER_ADDRESS_ID, kind: 'event_listener' },
          { pr: 12903, parentId: HANDLE_ID, childId: BILLING_ID, kind: 'event_listener' },
        ],
      })
    })
    await page.route('**/api/blockstats?pr=12903', async (route) => {
      await route.fulfill({
        json: { pr: 12903, totals: { [HANDLE_ID]: 4, [BILLING_ID]: 2, [ORDER_ADDRESS_ID]: 0 } },
      })
    })
    // Deterministic (trivial) diff for the second sibling chip, independent
    // of whatever the shared worktree happens to contain.
    await page.route(
      (url) => url.pathname === '/api/code' && url.searchParams.get('file') === 'app/Models/Order.php',
      async (route) => {
        await route.fulfill({
          json: {
            file: 'app/Models/Order.php',
            old: { start: 10, text: 'function address()\n{\n    old();\n}' },
            new: { start: 10, text: 'function address()\n{\n    new_();\n}' },
          },
        })
      },
    )

    await page.goto('/pr/12903')
    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    const childCard = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(childCard).toBeVisible()
    // .first(): the card's own top-level chip column — handle's chip carries
    // its OWN further column (billingAddress) nested inside it, matching the
    // same testid one level deeper.
    const nested = childCard.locator('xpath=..').getByTestId('related-nested').first()
    // `> div > [...]`: each top-level chip is now a row (`<div><button
    // data-testid=related-nested-chip/>${optional further column}</div>`), so
    // its OWN recursive chip column (e.g. handle's billingAddress sub-chip)
    // lives nested a few levels deeper as a SIBLING of the button within that
    // row — this selector reaches only the immediate row's own chip, not
    // anything recursed further to the right.
    const chips = nested.locator('> div > [data-testid="related-nested-chip"]')
    await expect(chips).toHaveCount(2)

    // Neither sibling chip ever renders the stringified arrow.js template
    // function — the actual regression this test guards.
    await expect(nested).not.toContainText('=>')

    const handleChip = chips.filter({ hasText: 'handle' })
    // The full label, not just "address" — handle's OWN nested sub-chip
    // label ("Address::billingAddress") would otherwise also match a bare
    // "address" substring filter (hasText is a case-insensitive substring
    // match over the WHOLE subtree, including handle's nested sub-chip).
    const addressChip = chips.filter({ hasText: 'Order::address' })
    // .first(): handle's OWN approval span comes before its nested sub-chip's
    // (billingAddress) in document order — getByTestId matches the whole
    // subtree, not just this chip's own row.
    await expect(handleChip.getByTestId('related-nested-approval').first()).toHaveText('0/4')
    await expect(addressChip.getByTestId('related-nested-approval').first()).toHaveText('')
  })
})
