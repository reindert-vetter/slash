import { test, expect, appReady } from './_fixtures.mjs'

// The header-icon-row Jira bell (jiraBellButton/jiraBellPanel, overview.mjs):
// reviewer request — "ik wil hier een belletje zien. als ik daarop druk wil ik
// top 5 notifications zien. als er ongelezen zijn wil ik een rondje zien bij
// het belletje." A second, always-reachable entry point next to the
// always-visible inline "Jira" section above the PR list (jiraBlock) — this
// one sits permanently in the header, next to the theme/settings icons.
test.describe('PR overview — Jira bell', () => {
  function stubNotifications(page, items) {
    return page.route('**/api/jira/notifications', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, runId: 'fake-run', items }),
      })
    })
  }

  test('shows an unread dot only when there are unread items, and opens a top-5 dropdown', async ({ page }) => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      at: new Date(Date.now() - i * 3600e3).toISOString(),
      title: 'Notification ' + i,
      issueKey: 'AB-' + i,
      actor: 'Actor',
      avatarUrl: '',
      url: 'https://example.atlassian.net/browse/AB-' + i,
      unread: i < 2, // two unread, the rest read
    }))
    await stubNotifications(page, items)
    await page.goto('/pr-overview')
    await appReady(page)

    const bell = page.locator('[data-testid="jira-bell-button"]')
    await expect(bell).toBeVisible()
    await expect(page.locator('[data-testid="jira-bell-dot"]')).toBeVisible()

    // Closed by default.
    await expect(page.locator('[data-testid="jira-bell-panel"]')).toHaveCount(0)

    await bell.click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel).toBeVisible()
    // Top 5 of 7, most-recent-first (the read-model's own order).
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(5)
    await expect(panel.locator('[data-testid="jira-row"]').first()).toContainText('Notification 0')

    // A click outside closes it again.
    await page.mouse.click(20, 20)
    await expect(panel).toHaveCount(0)
  })

  test('no unread dot and an empty-state message when there are no notifications', async ({ page }) => {
    await stubNotifications(page, [])
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="jira-bell-dot"]')).toHaveCount(0)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Geen notificaties.')
  })

  test('Escape closes the dropdown', async ({ page }) => {
    await stubNotifications(page, [
      { id: '1', at: new Date().toISOString(), title: 'X', issueKey: 'AB-1', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true },
    ])
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
