import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: "toon x goedgekeurde blok, moet gelijk naar de index item
// gaan met een goedgekeurde blok" — clicking "Toon N goedgekeurde blocks"
// used to only unfold the section while the selection/keyboard stayed on the
// toggle row itself, so the reviewer had to walk ↑ manually to reach one of
// the newly revealed blocks. See revealApprovedBlocks (home.mjs) and its
// onRevealApproved callback into BlockList.mjs's toggleRow.
test.describe('Toon N goedgekeurde blocks — clicking it jumps to the revealed block', () => {
  test('a click on the toggle-approved row selects the first now-visible approved block', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // Fully approve block 1 (CreatePaymentAction::execute) so a
    // toggle-approved row exists, same setup as list-nav-wrap.spec.mjs.
    await page.locator('[data-idx="1"]').click()
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await approve.click()
    await expect(approve).toBeChecked()

    // Select some other, still-visible row first, so the toggle click is the
    // only thing that could move the selection.
    await page.locator('[data-idx="0"]').click()
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    const toggle = page.getByTestId('toggle-approved')
    await toggle.click()
    await expect(toggle).toHaveText(/Verberg/)

    // The section is unfolded AND the keyboard/selection jumped straight to
    // the newly revealed block — not left on the toggle row, and not left on
    // the previously selected row 0 either.
    const revealed = page.locator('[data-idx="1"]')
    await expect(revealed).toBeVisible()
    await expect(revealed).toHaveClass(/bg-indigo-50/)
    await expect(revealed).toContainText('CreatePaymentAction::execute')
    await expect(toggle).not.toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="0"]')).not.toHaveClass(/bg-indigo-50/)

    // Clicking it again (hiding) is a plain flip: it stays on the toggle row,
    // like every other toggle-row click.
    await toggle.click()
    await expect(toggle).toHaveText(/Toon/)
    await expect(toggle).toHaveClass(/bg-indigo-50/)
  })
})
