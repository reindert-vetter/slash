import { test, expect, appReady } from './_fixtures.mjs'

// Reviewer report: "ik refresh, maar pr staan hier nog" — the server had been
// killed, and the overview's refresh swallowed every fetch error, so the
// spinner stopped as if the refresh worked while the list stayed stale. A
// refresh that cannot reach the server now shows an error line naming the
// time of the last snapshot that did load (refreshErrorLine, src/overview.mjs).
test.describe('PR overview — refresh error line', () => {
  test('a refresh that cannot reach the server says so, and a later good read clears it', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const err = page.locator('[data-testid="overview-refresh-error"]')
    await expect(err).toHaveCount(0)

    // Simulate the server being gone: the signal and the snapshot re-read fail.
    await page.route('**/api/workflows/*/signals/refresh', (route) => route.abort())
    await page.route('**/api/inbox', (route) => route.abort())

    const section = page.locator('[data-testid="section"][data-title="Needs your review"]')
    const btn = section.locator('[data-testid="section-refresh"]')
    await btn.click()
    await expect(btn).toBeEnabled({ timeout: 10_000 })
    await expect(err).toBeVisible()
    await expect(err).toContainText(/\d{2}:\d{2}/)
    // The rows stay — a failed refresh never blanks the list.
    await expect(page.locator('[data-testid="pr-row"]').first()).toBeVisible()

    // Server back: the next successful refresh clears the line.
    await page.unroute('**/api/workflows/*/signals/refresh')
    await page.unroute('**/api/inbox')
    await btn.click()
    await expect(err).toHaveCount(0, { timeout: 10_000 })
  })
})
