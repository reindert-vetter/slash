import { test, expect, appReady } from './_fixtures.mjs'

// Coverage for the `?pr=` auto-select: the ← nav-chain exit (home.mjs) links
// to /pr-overview?pr=<id> so the reviewer lands back on the row they just
// came from (see trySelectPendingPr/pendingSelectPr in overview.mjs).
test.describe('PR overview — ?pr= auto-selects the row we came from', () => {
  test('a PR in the main sections gets the keyboard ring, no drawer needed', async ({ page }) => {
    await page.goto('/pr-overview?pr=12903')
    await appReady(page)

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await expect.poll(() => row.evaluate((el) => el.classList.contains('ring-indigo-500/50'))).toBe(true)
    await expect(page.locator('[data-testid="recent-item"]')).toHaveCount(0)
  })

  test('a PR that only lives in "Recent gegenereerd" opens the drawer and selects it there', async ({ page }) => {
    // PR 90 has blocks seeded (relations fixture) but isn't in the inbox.json
    // sections fixture — it only shows up via GET /api/prs, i.e. the drawer.
    await page.goto('/pr-overview?pr=90')
    await appReady(page)

    const item = page.locator('[data-testid="recent-item"][data-pr="90"]')
    await expect(item).toBeVisible()
    await expect.poll(() => item.evaluate((el) => el.classList.contains('ring-indigo-500/50'))).toBe(true)
  })

  // The review tree's own "back to overview" link (overviewExitUrl, home.mjs)
  // sends the SHORT repo NAME, not the full "owner/name" slug — prUidHere()
  // there builds "<repo-name>#<n>". matchesPrRef must accept that spelling too
  // (it isn't the same as this page's own prUid, which uses the full slug), or
  // returning from a second repo's review tree would silently fail to ring the
  // row it came from.
  test('a second repo\'s short-name uid (as the review tree itself sends it) rings its row', async ({ page }) => {
    await page.goto('/pr-overview?pr=' + encodeURIComponent('plug-and-pay-ops#12'))
    await appReady(page)

    const row = page.locator('[data-testid="pr-row"][data-pr="plug-and-pay/plug-and-pay-ops#12"]')
    await expect.poll(() => row.evaluate((el) => el.classList.contains('ring-indigo-500/50'))).toBe(true)
  })

  test('a PR that appears nowhere is a silent no-op', async ({ page }) => {
    await page.goto('/pr-overview?pr=999999')
    await appReady(page)

    const anySelected = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.some((el) => el.classList.contains('ring-indigo-500/50')))
    expect(anySelected).toBe(false)
  })
})
