import { test, expect, appReady } from './_fixtures.mjs'

// The live "N actief" badge next to the "N PR's" pill in /pr-overview's header
// (headerBlock, src/overview.mjs) shows how many workflow runs are really
// tembed.StatusRunning right now, repo-wide — from the read-only
// GET /api/running-count (run_errors.go's RunningCount). Deliberately
// StatusRunning only, never StatusWaiting: a long-lived tracker sitting idle
// between steps must not inflate the count.
function stubRunningCount(page, running) {
  return page.route('**/api/running-count', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running }) }),
  )
}

test.describe('PR overview — live "actief" badge', () => {
  test('shows the running count, always visible even at 0', async ({ page }) => {
    await stubRunningCount(page, 0)
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.locator('[data-testid="running-count"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('0 actief')
  })

  test('reflects a non-zero count', async ({ page }) => {
    await stubRunningCount(page, 3)
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="running-count"]')).toContainText('3 actief')
  })
})
