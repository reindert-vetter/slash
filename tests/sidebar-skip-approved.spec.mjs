import { test, expect } from './_fixtures.mjs'

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
// Same fixture/shape as postapprove-menu.spec.mjs: PR 12903, category-sorted so
// ContractController::index (CONTROLLER) is index 0 and CreatePaymentAction::execute
// (the only other block with a real, single-group diff) is index 1.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

test.describe('PR Review Tree — sidebar navigation skips hidden (approved) blocks', () => {
  test('ArrowDown/ArrowUp never leave the sidebar with nothing highlighted', async ({ page }) => {
    await page.goto('/pr/12903')
    // Select + fully approve block 1 (CreatePaymentAction::execute) straight from
    // the index, exactly like the "approving from the blokken-index" flow.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused search box
    expect(selParam(page)).toBe(BLOCK1_SEL)

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()

    // Block 1 is now fully approved and hidden from the rendered list.
    await expect(page.locator('[data-idx="1"]')).toHaveCount(0)

    // Reset the selection to the still-visible block 0, then step past the
    // hidden block 1 with a single ArrowDown.
    await page.locator('[data-idx="0"]').click()
    await page.keyboard.press('ArrowDown')

    // Exactly one row is highlighted, and it's NOT the hidden block 1 — before
    // the fix, state.selected became 1 here and nothing in the DOM highlighted.
    const highlighted = page.locator('[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).not.toHaveAttribute('data-idx', '1')
    expect(selParam(page)).not.toBe(BLOCK1_SEL)

    // Stepping back up must return cleanly to block 0 — not get stuck on the
    // hidden block 1 with no row highlighted.
    await page.keyboard.press('ArrowUp')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-idx', '0')
  })
})
