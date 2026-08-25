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
// Same fixture as sidebar-skip-approved.spec.mjs. Blocks are selected by
// label, not by raw index — see "Sort order of the left list" in
// blocks-and-ingest.md. Order::address (rather than
// CreatePaymentAction::execute) is the one approved+hidden here: it has a
// still-visible row on both sides (Address::billingAddress before it, the
// migration's `up` after it — see materializeMainWorktrees in _setup.mjs),
// which is what a "hidden row directly after the selection" needs. execute
// itself now sorts first, so hiding it never leaves a row before it to
// select in the first place.
const cards = (page) => page.locator('[data-testid=block-column] [data-testid=detail-card]')

test.describe('the look-ahead preview follows the next VISIBLE row', () => {
  test('a hidden (fully-approved) row directly after the selection is not previewed', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const block6Row = page.getByTestId('block-row').filter({ hasText: 'Order::address' })
    await block6Row.click()
    await leaveSearchBox(page)

    // Fully approve it via the top checkbox — a direct toggle that never
    // runs afterApproveAction/findNextUnapproved (see its own doc comment in
    // home.mjs), unlike the command palette's approve action. That matters
    // here: findNextUnapproved only searches FORWARD from the approved
    // block, and nothing after Order::address has any changed rows, so
    // approving it via the palette would open the review-submit follow-up
    // menu instead of just hiding its row.
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await approve.click()
    await expect(approve).toBeChecked()
    await expect(block6Row).toHaveCount(0)

    // Select the row before it. The preview must skip the now-hidden row.
    await page.getByTestId('block-row').filter({ hasText: 'Address::billingAddress' }).click()
    await expect(cards(page)).toHaveCount(2)
    await expect(cards(page).nth(0)).toContainText('Address::billingAddress')
    await expect(cards(page).nth(1)).not.toContainText('Order::address')

    // …and that preview is exactly where ↓ goes: the previewed card becomes the
    // selected one, one step later.
    const nextLabel = await cards(page).nth(1).locator('h2').first().innerText()
    await page.keyboard.press('ArrowDown')
    await expect(cards(page).nth(0)).toContainText(nextLabel.trim())
  })
})
