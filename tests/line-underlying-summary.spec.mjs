import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The per-line "onderliggende code" badge (Block.mjs's lineSummaryBadge, fed
// by home.mjs's lineChildSummaries — an avatar+N comment-activity indicator
// plus a done/total approve fraction, rendered at the right edge of the diff
// line the underlying code is anchored to). Reuses PR 100's existing
// call-arrow fixture (tests/fixtures/arrow-blocks.json + arrow-callresolve.json,
// materializeArrowWorktrees in tests/_setup.mjs — real worktrees on disk):
// ArrowCallerAction::execute calls ArrowHelperService::arrowHelper on a
// changed line; arrowHelper itself calls ArrowNestedService::arrowNested on
// its own changed line, so approving both rolls up into a combined
// done/total on the CALLER's own diff line — exactly like
// subtreeApproveCount's sidebar rollup, just anchored to one line instead of
// the whole block.
//
// arrowHelper has 2 changed rows of its own ($value=1→2, the arrowNested(1→2)
// call), arrowNested has 1 (return $x*2→3) — total 3, gran-independent (the
// badge shows regardless of the current navigation cursor, unlike the
// Onderliggende-code panel itself).
test.describe('PR Review Tree — per-line onderliggende-code badge', () => {
  test('shows a done/total approve fraction on the call-site line, updating as the underlying code is approved', async ({
    page,
  }) => {
    await page.goto('/pr/100')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the diff

    const badge = page.getByTestId('line-underlying-summary')
    await expect(badge).toBeVisible()
    // Not yet approved: no checkmark, 0 of 3 underlying rows done.
    await expect(badge).toContainText('0/3')
    await expect(badge).not.toContainText('✓')
    // Anchored on the actual call-site row, not some other row.
    const row = page.locator('[data-row]').filter({ has: badge })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('arrowHelper')

    // Drill into arrowHelper (Onderliggende code → first child, prio 0 since
    // its own definition is a changed PR block) and approve its one group
    // (both its changed rows) via the command palette.
    await page.keyboard.press('ArrowRight') // → related panel
    const arrowHelperItem = page.getByTestId('related-item').first()
    await expect(arrowHelperItem).toContainText('arrowHelper')
    await arrowHelperItem.click() // drill in

    await expect(page.getByTestId('drill-column')).toContainText('ArrowHelperService::arrowHelper')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').nth(1).click() // "Keur ... goed"
    // A follow-up menu always opens here (either "Ga door" or the
    // PR-submit choice, depending on what's left) — dismiss it.
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // Drill one level deeper into arrowNested (arrowHelper's own resolved
    // call) and approve it too.
    await page.keyboard.press('ArrowRight') // → arrowHelper's own related panel
    const arrowNestedItem = page.getByTestId('related-item').first()
    await expect(arrowNestedItem).toContainText('arrowNested')
    await arrowNestedItem.click()

    await expect(page.getByTestId('drill-column')).toContainText('ArrowNestedService::arrowNested')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').nth(1).click()
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // Pop back out of both drilled columns to the top-level caller's own
    // diff — the badge must reflect the now-complete underlying subtree.
    await page.keyboard.press('ArrowLeft') // close arrowNested column
    await page.keyboard.press('ArrowLeft') // close arrowHelper column

    await expect(badge).toContainText('✓ 3/3')
  })
})
