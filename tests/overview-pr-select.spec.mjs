import { test, expect } from './_fixtures.mjs'

// Coverage for the `?pr=` auto-select: the ← nav-chain exit and the
// "Naar PR-overzicht" command in home.mjs both link to /pr-overview?pr=<id>
// so the reviewer lands back on the row they just came from (see
// trySelectPendingPr/pendingSelectPr in overview.mjs).
test.describe('PR overview — ?pr= auto-selects the row we came from', () => {
  test('a PR in the main sections gets the keyboard ring, no drawer needed', async ({ page }) => {
    await page.goto('/pr-overview?pr=12903')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await expect.poll(() => row.evaluate((el) => el.classList.contains('ring-emerald-500/50'))).toBe(true)
    await expect(page.locator('[data-testid="recent-item"]')).toHaveCount(0)
  })

  test('a PR that only lives in "Recent gegenereerd" opens the drawer and selects it there', async ({ page }) => {
    // PR 90 has blocks seeded (relations fixture) but isn't in the inbox.json
    // sections fixture — it only shows up via GET /api/prs, i.e. the drawer.
    await page.goto('/pr-overview?pr=90')
    await page.waitForLoadState('networkidle')

    const item = page.locator('[data-testid="recent-item"][data-pr="90"]')
    await expect(item).toBeVisible()
    await expect.poll(() => item.evaluate((el) => el.classList.contains('ring-emerald-500/50'))).toBe(true)
  })

  test('a PR that appears nowhere is a silent no-op', async ({ page }) => {
    await page.goto('/pr-overview?pr=999999')
    await page.waitForLoadState('networkidle')

    const anySelected = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.some((el) => el.classList.contains('ring-emerald-500/50')))
    expect(anySelected).toBe(false)
  })
})
