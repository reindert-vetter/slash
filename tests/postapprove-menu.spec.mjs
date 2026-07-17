import { test, expect } from './_fixtures.mjs'

// The postApprove follow-up menu: approving via the command palette (not the
// top checkbox — that stays a direct toggle) opens a small follow-up menu when
// there's a next not-yet-approved unit still ahead: "Ga door naar de volgende
// niet-goedgekeurde code" or "Sluit menu". See afterApproveAction /
// findNextUnapproved / POSTAPPROVE_COMMANDS in home.mjs.
//
// The seeded PR 12903 fixture (tests/fixtures/blocks.json) only carries a real
// diff on two of its nine blocks: CreatePaymentAction::execute (one
// single-line group) and Order::address (also one group) — every other block
// has no changed rows at all. That shape is exactly what's needed to exercise
// the block-overstijgend "volgende" search without relying on incidental diff
// content elsewhere in the PR.
//
// The left list sorts by category priority (ROUTE, then CONTROLLER, then the
// rest — see categoryRank in home.mjs), so ContractController::index (the
// sole CONTROLLER) sorts to index 0 even though it has no local diff of its
// own; CreatePaymentAction::execute is index 1. Order::address happens to
// still land on index 6 (the CONTROLLER moving from its original index 4 to
// index 0 shifts everything between them by exactly one, and index 6 sits
// beyond that shifted range) — a coincidence of this fixture's shape, not a
// guarantee to lean on elsewhere.
//
// The selected block's identity is asserted via the `?sel=` URL param (see
// urlState.mjs/bindUrlState) rather than the sidebar's `[data-idx]` rows: a
// fully-approved top-level block is hidden from the sidebar by default
// (state.showApproved, see BlockList.mjs) — exactly what approving
// execute's only group does to it — so its row disappears from the DOM the
// moment the approve command runs.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}
test.describe('PR Review Tree — postApprove follow-up menu', () => {
  test('approving opens the follow-up; "Sluit menu" just closes it (no navigation)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first) has no local
    // diff; select block 1 (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // step it into its diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Approve execute's only group via the palette.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // The follow-up opens automatically with exactly the two choices.
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Ga door naar de volgende niet-goedgekeurde code')
    await expect(rows.nth(1)).toContainText('Sluit menu')

    // Choosing "Sluit menu" just closes it — no navigation.
    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
    expect(selParam(page)).toBe(BLOCK1_SEL)
  })

  test('"Ga door" jumps block-overstijgend to the next not-approved unit', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first) has no local
    // diff; select block 1 (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    // Blocks 2-5 have no changes at all, so "volgende" skips straight past them
    // to block 6 (Order::address) — the next block that actually has an
    // unapproved unit — landing in its diff on the first (only) group.
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
  })

  test('un-approving (revoking) does not open the follow-up', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first) has no local
    // diff; select block 1 (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Approve, then dismiss the follow-up without navigating away.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Un-approve the same unit — the command now reads "Trek … in" — and
    // confirm no follow-up appears this time. ("trek goedk" rather than just
    // "trek": the bare substring is also a fuzzy subsequence match of "Comment
    // op deze regel … task", so it doesn't uniquely narrow the list.)
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('trek goedk')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await expect(page.getByTestId('command-row').first()).toContainText('Trek goedkeuring')
    await page.getByTestId('command-row').first().click()
    await expect(menu).not.toBeVisible()
    // Give an (absent) delayed follow-up a moment to have shown up were it
    // going to — findNextUnapproved awaits a network fetch, so a false
    // positive here would appear a beat later, not instantly.
    await page.waitForTimeout(300)
    await expect(menu).not.toBeVisible()
  })

  // Approving from the blokken-index itself (Enter with no ArrowRight — state.mode
  // stays 'list') must keep you there: "Ga door" only moves the sidebar selection
  // forward, it never drops you into a block's diff. See isIndexMenu (menuAnchor/
  // menuRegion) and the keepList branch of applyNextUnapproved/afterApproveAction.
  test('approving from the blokken-index stays there: "Ga door" only moves the selection, no diff-instap', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first) has zero changed
    // rows, so it would already read as vacuously approved; select block 1
    // (CreatePaymentAction::execute), which has a real unit to approve.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page).not.toHaveURL(/mode=diff/)

    // Approve execute's only group via the palette, straight from the index.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // The follow-up opens with the list-mode wording ("... block", not "... code").
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows.nth(0)).toContainText('Ga door naar het volgende niet-goedgekeurde block')
    await expect(rows.nth(1)).toContainText('Sluit menu')

    await rows.filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    // Lands on block 6 (the next not-yet-approved block, same skip-past-2-5 as
    // the diff-mode case above) but never enters its diff: no `mode=diff` in
    // the URL, and the sidebar keeps its normal on-screen list-mode placement
    // (in diff mode it slides fully off-screen — see BlockList.mjs).
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('pr-index')).toHaveClass(/translate-x-0/)
    await expect(page.getByTestId('pr-index')).not.toHaveClass(/-translate-x-\[28rem\]/)
  })

  test('nothing left ahead: approving the last not-yet-approved unit closes normally', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape')

    // Select block 6 (Order::address) directly and step into its diff — it's
    // the last block in the fixture with any changed rows at all (7 and 8 have
    // none), so approving it leaves nothing ahead to jump to.
    await page.locator('[data-idx="6"]').click()
    await expect(page.locator('[data-idx="6"]')).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()
    // findNextUnapproved awaits a fetch per candidate block before giving up —
    // give that a moment to settle and confirm it really stays closed.
    await page.waitForTimeout(300)
    await expect(menu).not.toBeVisible()
  })
})
