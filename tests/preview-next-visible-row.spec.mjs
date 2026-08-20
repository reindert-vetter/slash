import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The look-ahead preview card stacked under the selected block's diff must show
// the next VISIBLE index row — the exact row ↓ lands on (stepVisibleSelected) —
// not the raw next state.blocks index.
//
// Reported bug: with a hidden row directly after the selection, that hidden row
// was previewed anyway. Live case (PR 13431): a RESOLVED, orphaned comment about
// a file no longer in the PR ("verouderd — code verdwenen") sat as a full card
// under an unrelated PHP test diff. Its index row was hidden because a comment
// item scores "resolved == approved" (blockApproveCount) and renderList drops a
// fully-approved row while state.showApproved is false — so the index listed no
// such row and ↓ skipped it, while the preview showed it.
//
// Same fixture/shape as sidebar-skip-approved.spec.mjs: PR 12903, category-sorted,
// so index 0 = ContractController::index, 1 = CreatePaymentAction::execute (the
// one block with a single-group diff that can be fully approved from the index,
// which then hides its row), 2 = CreatePaymentAction::findOrCreateCustomer.
const cards = (page) => page.locator('[data-testid=block-column] [data-testid=detail-card]')

test.describe('the look-ahead preview follows the next VISIBLE row', () => {
  test('a hidden (fully-approved) row directly after the selection is not previewed', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)

    // Fully approve block 1 from the index, so its row disappears from the list.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    await expect(page.locator('[data-idx="1"]')).toHaveCount(0)

    // Select the row before it. The preview must skip the now-hidden block 1.
    await page.locator('[data-idx="0"]').click()
    await expect(cards(page)).toHaveCount(2)
    await expect(cards(page).nth(0)).toContainText('ContractController::index')
    await expect(cards(page).nth(1)).toContainText('findOrCreateCustomer')
    await expect(cards(page).nth(1)).not.toContainText('::execute')

    // …and that preview is exactly where ↓ goes: the previewed card becomes the
    // selected one, one step later.
    await page.keyboard.press('ArrowDown')
    await expect(cards(page).nth(0)).toContainText('findOrCreateCustomer')
  })
})
