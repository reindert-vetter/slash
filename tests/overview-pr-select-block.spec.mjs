import { test, expect } from './_fixtures.mjs'

// Coverage for the `?sel=` round-trip through /pr-overview (see "?sel= reist
// mee in dezelfde round-trip" in .claude/docs/pages-and-routing.md): leaving
// a non-default block selected via the ← nav-chain exit, then returning via
// "Open review-boom", must land back on that same block — not the default
// first one.
test.describe('PR overview — ?sel= round-trip keeps the same block selected', () => {
  test('selecting block 6, exiting via ←←, and reopening the tree restores block 6', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()

    // Block 1 (CreatePaymentAction::execute) is now the fresh-open DEFAULT
    // itself (applyDefaultUnapprovedSelection tie-breaks unapproved ordinary
    // blocks by (file, line) — see "Land a fresh PR open on the first block of
    // the first-changed file" — and app/Actions/CreatePaymentAction.php sorts
    // first among this fixture's real changes), so picking it here would let a
    // BROKEN ?sel= restore fall back to the default and still land on the same
    // block — a false pass. Pick block 6 (Order::address) instead: a
    // different, later-sorting file, so a broken restore is visibly wrong.
    await page.locator('[data-idx="6"]').click()
    await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveAttribute('data-idx', '6')
    await expect(page).toHaveURL(/sel=app%2FModels%2FOrder\.php%3A88/)

    await page.keyboard.press('ArrowLeft') // block-index → stop 1 (description)
    await expect(page.getByTestId('pr-info-column')).toHaveCount(1)
    await page.keyboard.press('ArrowLeft') // stop 1 → the PR overview
    await expect(page).toHaveURL(/\/pr-overview/)

    // The exit URL must carry the block reference we left from alongside `pr`.
    expect(page.url()).toContain('sel=app%2FModels%2FOrder.php%3A88')

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await row.click()
    await page.getByTestId('open-tree').click()

    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect(page).toHaveURL(/sel=app%2FModels%2FOrder\.php%3A88/)
    await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveAttribute('data-idx', '6')
  })

  test('opening an unrelated PR from the overview never carries a stale sel along', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(/\/pr-overview/)

    // PR 90 only lives in the "Recent gegenereerd" drawer (see
    // overview-pr-select.spec.mjs) — it's a plain `<a href="/pr/<n>">` link
    // (recentItem), not gated behind the popover, and was never one of the
    // treeUrl() call sites — opening it must not inherit the sel we left
    // PR 12903 with.
    await page.getByTestId('recent').click()
    const item = page.locator('[data-testid="recent-item"][data-pr="90"]')

    // Assert the no-sel on the LINK, not on the settled page URL: once /pr/90
    // has loaded its own blocks, home.mjs' blockRef watch writes that PR's OWN
    // `sel` into the query string (every block has a real file:line, so `sel`
    // is structurally present — see the URL-state section in CLAUDE.md). So a
    // `page.url()` check after the navigation is a race against that write,
    // not a check of what was carried along. The href is what this test is
    // actually about (recentItem is not a treeUrl() call site).
    await expect(item).toHaveAttribute('href', '/pr/90')

    await item.click()
    await expect(page).toHaveURL(/\/pr\/90(?:$|[?&])/)
    // Whatever `sel` the app writes for itself must be PR 90's own block, never
    // the CreatePaymentAction reference we left PR 12903 with.
    expect(page.url()).not.toContain('CreatePaymentAction')
  })
})
