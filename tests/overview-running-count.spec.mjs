import { test, expect, appReady } from './_fixtures.mjs'

// The live busy counts on /pr-overview, from the read-only
// GET /api/running-count (run_errors.go's RunningCounts): workflow runs really
// tembed.StatusRunning (never StatusWaiting — an idle tracker must not inflate
// it) plus Claude chat turns actively working. `running` feeds the "N actief"
// badge next to the "N PR's" pill (headerBlock), `byPr` the per-row "N bezig"
// chip (busyPill). Both are hidden at 0.
function stubRunningCount(page, running, byPr = {}) {
  return page.route('**/api/running-count', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running, byPr }) }),
  )
}

test.describe('PR overview — live "actief" badge', () => {
  test('hides the header badge and every row chip at 0', async ({ page }) => {
    await stubRunningCount(page, 0)
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="pr-row"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="running-count"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="row-running-count"]')).toHaveCount(0)
  })

  test('reflects a non-zero count in the header and on the busy row only', async ({ page }) => {
    await stubRunningCount(page, 3, { 12903: 2 })
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.locator('[data-testid="running-count"]')
    await expect(badge).toContainText('3 actief')
    // A pulsing dot (mirrors the Claude-chat live-status dot), not a spinner.
    await expect(badge.locator('[data-testid="running-count-dot"]')).toHaveClass(/animate-pulse/)

    await expect(page.locator('[data-testid="pr-row"][data-pr="12903"] [data-testid="row-running-count"]')).toContainText('2 bezig')
    await expect(page.locator('[data-testid="row-running-count"]')).toHaveCount(1)
  })
})
