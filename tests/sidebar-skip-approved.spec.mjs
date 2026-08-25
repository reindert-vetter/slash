import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: ArrowDown/ArrowUp in the blokken-index used to step state.selected
// as a raw index into the FULL state.blocks array, ignoring that a fully-approved
// block is hidden from the rendered list (BlockList.mjs's renderList, default
// state.showApproved === false — see blockstats.spec.mjs). Landing on such a
// hidden index left the sidebar with NO row highlighted at all — the selection
// silently pointed past the DOM. A reviewer who approves blocks while walking
// down/up a long PR would eventually land on one of these "dead" steps and see
// a block become unselectable (reported live against PR 12895's `api.php`).
// Fixed via stepVisibleSelected (home.mjs), which walks past any hidden index
// to the next/previous *rendered* row — see keyboard-navigation.md.
//
// Same fixture as postapprove-menu.spec.mjs. Blocks are selected by label,
// not by raw index — see "Sort order of the left list" in
// blocks-and-ingest.md. Order::address is approved here rather than
// CreatePaymentAction::execute: it has a still-visible row on BOTH sides
// (Address::billingAddress before it, the migration's `up` after it) — a
// genuine "sandwiched" hidden row, which is what this regression needs.
// execute itself now sorts first (see blocks-and-ingest.md), so hiding it
// would never require skipping OVER it from an adjacent row.
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

test.describe('PR Review Tree — sidebar navigation skips hidden (approved) blocks', () => {
  test('ArrowDown/ArrowUp never leave the sidebar with nothing highlighted', async ({ page }) => {
    await page.goto('/pr/12903')
    const block6Row = page.getByTestId('block-row').filter({ hasText: 'Order::address' })
    const prevRow = page.getByTestId('block-row').filter({ hasText: 'Address::billingAddress' })
    // Select + fully approve Order::address via the top checkbox — a direct
    // toggle that never runs afterApproveAction/findNextUnapproved (see its
    // own doc comment in home.mjs), unlike the command palette's approve
    // action. That matters here: findNextUnapproved only searches FORWARD
    // from the approved block, and nothing after Order::address has any
    // changed rows, so approving it via the palette would (wrongly, for
    // this test's purpose) open the review-submit follow-up menu instead of
    // just toggling the checkbox — CreatePaymentAction::execute, earlier in
    // the list, stays unapproved throughout.
    await block6Row.click()
    await leaveSearchBox(page)
    expect(selParam(page)).toBe(BLOCK6_SEL)

    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await approve.click()
    await expect(approve).toBeChecked()

    // Order::address is now fully approved and hidden from the rendered list.
    await expect(block6Row).toHaveCount(0)

    // Reset the selection to the still-visible row right before it, then step
    // past the hidden row with a single ArrowDown.
    await prevRow.click()
    await page.keyboard.press('ArrowDown')

    // Exactly one row is highlighted, and it's not the hidden Order::address
    // row — before the fix, state.selected pointed at the hidden index here
    // and nothing in the DOM highlighted.
    const highlighted = page.locator('[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).not.toContainText('Order::address')
    expect(selParam(page)).not.toBe(BLOCK6_SEL)

    // Stepping back up must return cleanly to the previous row — not get
    // stuck on the hidden row with no row highlighted.
    await page.keyboard.press('ArrowUp')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toContainText('Address::billingAddress')
  })
})
