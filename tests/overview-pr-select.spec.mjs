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

  test('a PR that appears nowhere is a silent no-op', async ({ page }) => {
    await page.goto('/pr-overview?pr=999999')
    await appReady(page)

    const anySelected = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.some((el) => el.classList.contains('ring-indigo-500/50')))
    expect(anySelected).toBe(false)
  })
})
