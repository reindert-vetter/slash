import { test, expect } from './_fixtures.mjs'

// afterApproveAction's "next unit stays in the SAME block, no menu" exception
// (home.mjs, see the doc comment above afterApproveAction and the section
// "After approving via the palette" in keyboard-navigation.md) used to only
// fire at the TOP level: its sameBlock check was `target.path.length === 0`,
// which is never true while a drilled Onderliggende-code column owns the
// keyboard (state.focusLevel > 0) — findNextUnapproved's own step-1 branch
// there always returns a non-empty path (state.drill.slice(0, level), the
// SAME drill stack, per the focusLevel === state.drill.length invariant, see
// detail-layout.md "Column navigation"), even when the next unapproved unit
// is still within that very same drilled block. So approving one line of a
// drilled child with another unapproved line still ahead in it wrongly
// opened the postApprove follow-up menu instead of jumping straight there —
// exactly like the top-level case already did.
//
// sameBlock is now derived from the landing block's id (the last entry of
// target.path, or the top-level block at target.root) matching the block
// that was just approved, instead of the path-length shortcut — correct at
// any drill depth.
//
// PR 106 fixture (mold of the PR-95 tree fixture used by drill-approve.spec.mjs):
// TreeParentAction2::execute (top-level, one changed line) →
// TreeChildAction2::run (its event_listener child) with TWO adjacent changed
// lines — one 'group' unit, but two separate 'line' units once zoomed in.
test.describe('PR Review Tree — approving a line inside a drilled column jumps straight to the next line', () => {
  test('no postApprove menu when another unapproved line is still ahead in the same drilled block', async ({
    page,
  }) => {
    await page.goto('/pr/106')

    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // step into the parent's diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // → into the Onderliggende-code panel

    const child = page.getByTestId('related-item').first()
    await expect(child).toContainText('TreeChildAction2::run')
    await child.click() // drill in — focus lands on the drilled column's diff

    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('TreeChildAction2::run')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Zoom in: the child's one group spans two lines, so f steps group → line
    // (not straight to call — see setGran's "single-line group" shortcut in
    // home.mjs, which only applies to a one-line group).
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/dgran=line/)
    await expect(page).not.toHaveURL(/dchg=/) // first line → index 0, omitted

    // Approve the first line via the palette while the DRILLED column owns
    // the keyboard.
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // "keur" doesn't fuzzy-match the pinned "Sluit menu" item, so it drops
    // out of the filtered list — "Keur deze regel goed" becomes the first
    // (and only) row, same convention as postapprove-tree.spec.mjs/
    // postapprove-menu.spec.mjs's own filter-then-.first() usage.
    await page.getByTestId('command-input').fill('keur')
    await expect(page.getByTestId('command-row').first()).toContainText('Keur deze regel goed')
    await page.getByTestId('command-row').first().click()

    // No follow-up menu — the cursor jumps straight to the second line of the
    // SAME drilled block instead.
    await expect(menu).not.toBeVisible()
    await expect(page).toHaveURL(/dgran=line/)
    await expect(page).toHaveURL(/dchg=1/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The first line is really approved (not merely navigated past).
    const approvals = await (await page.request.get('/api/approvals?pr=106')).json()
    const childRow = approvals.find(
      (r) => r.blockId === '106:app/Actions/TreeChildAction2.php:TreeChildAction2::run',
    )
    expect(childRow && Array.isArray(childRow.rows) ? childRow.rows.length : 0).toBe(1)
  })
})
