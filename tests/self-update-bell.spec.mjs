import { test, expect, appReady } from './_fixtures.mjs'

// The slash self-update row in the header bell (src/selfUpdate.mjs, backend
// self_update.go). The test server is never a self-updatable ./slash binary,
// so the status is stubbed here; the backend itself is covered by
// self_update_test.go.
test.describe('Self-update row in the bell', () => {
  function stubStatus(page, get) {
    return page.route('**/api/update/status', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(get()) })
    })
  }

  test('a ready version shows the notice with both buttons, and "Doorgaan met de oude versie" sends skip', async ({ page }) => {
    const now = Date.now()
    let status = {
      ok: true,
      enabled: true,
      running: 'aaaaaaa1111',
      phase: 'notice',
      target: 'bbbbbbb2222',
      commits: ['Add a thing', 'Fix another thing'],
      noticeAt: new Date(now).toISOString(),
      autoAt: new Date(now + 120_000).toISOString(),
      busy: 0,
    }
    await stubStatus(page, () => status)
    const posted = []
    await page.route('**/api/workflows/self_update', async (route) => {
      posted.push(route.request().postDataJSON())
      status = { ...status, phase: 'idle', outcome: 'skipped' }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="jira-bell-dot"]')).toBeVisible()
    await page.locator('[data-testid="jira-bell-button"]').click()
    const row = page.locator('[data-testid="self-update-row"]')
    await expect(row).toHaveAttribute('data-phase', 'notice')
    await expect(row).toContainText('Add a thing')
    await expect(page.locator('[data-testid="self-update-countdown"]')).toContainText('automatisch')
    await expect(page.locator('[data-testid="self-update-now"]')).toBeVisible()

    await page.locator('[data-testid="self-update-skip"]').click()
    await expect.poll(() => posted.map((p) => p.action)).toEqual(['skip'])
    await expect(row).toHaveAttribute('data-phase', 'idle')
  })

  test('a tab reloads itself once the running commit changes', async ({ page }) => {
    let running = 'aaaaaaa1111'
    await stubStatus(page, () => ({ ok: true, enabled: true, running, phase: 'restarting', target: 'bbbbbbb2222', busy: 0 }))
    await page.goto('/pr-overview')
    await appReady(page)
    await page.evaluate(() => (window.__beforeReload = true))
    running = 'bbbbbbb2222'
    // restarting polls every 3s; the reload wipes the marker.
    await expect.poll(() => page.evaluate(() => window.__beforeReload === true), { timeout: 10_000 }).toBe(false)
  })
})
