import { test, expect, appReady } from './_fixtures.mjs'

// The header-icon-row Jira bell (jiraBellButton/jiraBellPanel, overview.mjs).
// Reviewer requests, in order: a bell icon next to the theme/settings icons,
// badge-dotted when there are unread items, opening a dropdown on click; then
// "haal deze sectie weg, onder het belletje wil ik dat het hetzelfde eruit
// ziet als in jira" — the older always-visible inline "Jira" section above
// the PR list is gone, and everything it used to show (title, unread count,
// "Alleen ongelezen" toggle, the full row list) now lives inside this
// dropdown instead.
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

  test('there is no pinned "Jira" section above the PR list', async ({ page }) => {
    await stubNotifications(page, [
      { id: '1', at: new Date().toISOString(), title: 'X', issueKey: 'AB-1', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true },
    ])
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="jira-section"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="jira-row"]')).toHaveCount(0) // not rendered until the bell is opened
  })

  test('shows an unread dot only when there are unread items, and the dropdown lists every item, newest first', async ({ page }) => {
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
    // "Alleen ongelezen" is on by default, so only the 2 unread rows show
    // first; switch it off to see all 7 — not just a handful, the dropdown is
    // now the ONLY place this feed is shown, so it must not truncate.
    await panel.locator('[data-testid="jira-unread-toggle"]').click()
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(7)
    await expect(panel.locator('[data-testid="jira-row"]').first()).toContainText('Notification 0')

    // A click outside closes it again.
    await page.mouse.click(20, 20)
    await expect(panel).toHaveCount(0)
  })

  test('"Alleen ongelezen" filters the dropdown, matching the count badge', async ({ page }) => {
    const items = [
      { id: '1', at: new Date().toISOString(), title: 'Unread one', issueKey: 'AB-1', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true },
      { id: '2', at: new Date().toISOString(), title: 'Read one', issueKey: 'AB-2', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-2', unread: false },
    ]
    await stubNotifications(page, items)
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel).toContainText('1 ongelezen')
    // On by default, mirroring Jira's own toggle.
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(1)
    await expect(panel.locator('[data-testid="jira-row"]')).toContainText('Unread one')

    await panel.locator('[data-testid="jira-unread-toggle"]').click()
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(2)
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
