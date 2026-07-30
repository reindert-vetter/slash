import { test, expect, leaveSearchBox } from './_fixtures.mjs'

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
// sole top-level block) and TreeChildAction::run (its event_listener child —
// shown in "Onderliggende code" AND, since relation children stay navigable
// index rows, at the bottom of the left list under that same heading).
test.describe('PR Review Tree — postApprove follow-up menu walks the tree', () => {
  test('"Ga door" descends into the Onderliggende-code child instead of stopping', async ({
    page,
  }) => {
    await page.goto('/pr/95')

    // The parent leads the left list; the child sits at the bottom under the
    // "Onderliggende code" heading (relation children stay navigable index
    // rows, see recomputeLeftList) and ALSO shows in the panel.
    await expect(page.getByTestId('block-row')).toHaveCount(2)
    await expect(page.getByTestId('block-row').first()).toContainText('TreeParentAction::execute')
    await expect(page.getByTestId('block-row').nth(1)).toContainText('TreeChildAction::run')
    const related = page.getByTestId('related-item')
    await expect(related).toContainText('TreeChildAction::run')

    // Step into the parent's diff and approve its only group via the palette.
    await leaveSearchBox(page)
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
    // 'reviewApprove' follow-up ("Keur de HELE PR goed"/"Sluit menu"), not the
    // plain "Ga door"/"Sluit menu" postApprove pair — see afterApproveAction/
    // REVIEW_APPROVE_COMMANDS in home.mjs, and
    // tests/review-submit-menu.spec.mjs for the actual submit_review call.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    // "Sluit menu" is pinned at the top of every palette (withClose, home.mjs);
    // the default selection opens on the 2nd item, "Keur de HELE PR goed".
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
  })
})
