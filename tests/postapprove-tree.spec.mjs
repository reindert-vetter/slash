import { test, expect } from './_fixtures.mjs'

// The postApprove follow-up menu ("Ga door naar de volgende niet-goedgekeurde
// code") walks the review TREE depth-first, not just the flat sidebar list:
// once the currently-focused block/column has nothing left to approve, it
// descends into that block's Onderliggende-code children before moving on to
// the next top-level block. See findNextUnapproved/firstUnapprovedInSubtree/
// applyNextUnapproved in home.mjs.
//
// PR 95 (tests/fixtures/tree-blocks.json + tree-relations.json,
// data/worktrees/pr-95-{base,head} materialized by _setup.mjs) has exactly
// two blocks, both with one real changed line: TreeParentAction::execute (the
// sole top-level block — the relation pulls TreeChildAction::run out of the
// left list) and TreeChildAction::run (its event_listener child, shown in
// "Onderliggende code").
test.describe('PR Review Tree — postApprove follow-up menu walks the tree', () => {
  test('"Ga door" descends into the Onderliggende-code child instead of stopping', async ({
    page,
  }) => {
    await page.goto('/pr/95')

    // Only the parent is in the left list; the child is pulled into
    // "Onderliggende code" instead (see relatedChildren/recomputeLeftList).
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    await expect(page.getByTestId('block-row').first()).toContainText('TreeParentAction::execute')
    const related = page.getByTestId('related-item')
    await expect(related).toContainText('TreeChildAction::run')

    // Step into the parent's diff and approve its only group via the palette.
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Ga door naar de volgende niet-goedgekeurde code')
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    // The parent has no further blocks after it in the sidebar (it's the only
    // one), so the only place left to go is DOWN into its Onderliggende-code
    // child — opened as its own drill column, landing on its first group.
    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('TreeChildAction::run')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The child's own diff now owns the keyboard — approving its group leaves
    // NOTHING left anywhere in the tree, and (parent + child both fully
    // approved) the whole PR is now fully approved too: this opens the
    // 'reviewApprove' follow-up ("Keur de PR goed"/"Sluit menu"), not the
    // plain "Ga door"/"Sluit menu" postApprove pair — see afterApproveAction/
    // REVIEW_APPROVE_COMMANDS in home.mjs, and
    // tests/review-submit-menu.spec.mjs for the actual submit_review call.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Keur de PR goed')
    await expect(rows.nth(1)).toContainText('Sluit menu')
    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
  })
})
