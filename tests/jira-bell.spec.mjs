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

  test('a row shows the issue summary/status, a group note and a comment preview', async ({ page }) => {
    await stubNotifications(page, [
      {
        id: '1',
        at: new Date().toISOString(),
        title: 'Nick van Dalen mentioned you in a comment',
        issueKey: 'BUG-5241',
        actor: 'Nick van Dalen',
        avatarUrl: '',
        url: 'https://example.atlassian.net/browse/BUG-5241',
        unread: true,
        issueTitle: "'Volgende incassodatum' ongewenst aangepast door 'P&P Support' (#7887)",
        issueStatus: 'Closed',
        issueIconUrl: 'https://example.atlassian.net/bug.png',
        groupSize: 2,
        otherActor: 'Nick van Dalen',
        commentPreview: '@Reindert Vetter Helemaal top! Ik sluit deze.',
      },
    ])
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const row = page.locator('[data-testid="jira-row"]')
    await expect(row).toContainText("'Volgende incassodatum' ongewenst aangepast door 'P&P Support' (#7887)")
    await expect(row).toContainText('BUG-5241 • Closed')
    await expect(row).toContainText('+1 updates from Nick van Dalen')
    await expect(row).toContainText('@Reindert Vetter Helemaal top! Ik sluit deze.')
    await expect(row.locator('img[src="https://example.atlassian.net/bug.png"]')).toBeVisible()
  })

  test('an explicit per-row tick marks one notification read without opening it, and the bulk button marks the rest', async ({ page, context }) => {
    const items = [
      { id: '1', at: new Date().toISOString(), title: 'One', issueKey: 'AB-1', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true },
      { id: '2', at: new Date().toISOString(), title: 'Two', issueKey: 'AB-2', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-2', unread: true },
    ]
    await stubNotifications(page, items)
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel).toContainText('2 ongelezen')

    // Ticking the first row's own "mark as read" button must not navigate —
    // the row is a target="_blank" <a>, so a real navigation would open a
    // second tab.
    const pagesBefore = context.pages().length
    await panel.locator('[data-jira-id="1"] [data-testid="jira-mark-read"]').click()
    await expect(panel).toContainText('1 ongelezen')
    expect(context.pages().length).toBe(pagesBefore)
    // "Alleen ongelezen" is on, but the just-ticked row stays visible for its
    // own 5-minute grace period (jiraReadRespite) — it must not vanish out
    // from under the reviewer the instant it's read. See the dedicated grace
    // period test below for the expiry itself.
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(2)
    await expect(panel.locator('[data-jira-id="1"]')).toBeVisible()

    // "Alles gelezen maken" clears the rest in one go.
    const bulk = panel.locator('[data-testid="jira-mark-all-read"]')
    await expect(bulk).toBeEnabled()
    await bulk.click()
    await expect(panel).toContainText('0 ongelezen')
    await expect(bulk).toBeDisabled()
  })

  test('a just-read row stays visible for its own grace period, then disappears once it expires', async ({ page }) => {
    const items = [
      { id: '1', at: new Date().toISOString(), title: 'One', issueKey: 'AB-1', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-1', unread: true },
      { id: '2', at: new Date().toISOString(), title: 'Two', issueKey: 'AB-2', actor: '', avatarUrl: '', url: 'https://example.atlassian.net/browse/AB-2', unread: true },
    ]
    // A mutable route (not stubNotifications' fixed body) so the periodic
    // poll triggered by fast-forwarding the clock still reflects the read we
    // make locally below, instead of resetting it back to unread from a
    // stale snapshot.
    await page.route('**/api/jira/notifications', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, runId: 'fake-run', items }),
      })
    })

    // Fake clock so the 5-minute grace period (jiraReadRespite,
    // JIRA_READ_RESPITE_MS in overview.mjs) can be tested without a real
    // 5-minute wait.
    await page.clock.install({ time: new Date() })
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="jira-bell-button"]').click()
    const panel = page.locator('[data-testid="jira-bell-panel"]')
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(2)

    await panel.locator('[data-jira-id="1"] [data-testid="jira-mark-read"]').click()
    items[0].unread = false // keep the mocked feed in sync with the local read
    await expect(panel).toContainText('1 ongelezen')
    // Still visible — in its own grace period, marked in words (never colour
    // alone), and not counted as unread any more.
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(2)
    await expect(panel.locator('[data-jira-id="1"]')).toBeVisible()
    await expect(panel.locator('[data-jira-id="1"] [data-testid="jira-respite-mark"]')).toContainText('net gelezen')

    // Fast-forward past the 5-minute grace period.
    await page.clock.fastForward('06:00')

    // Close and reopen the panel (a fresh render) to observe the expiry —
    // deliberately not relying on the background poll alone to repaint an
    // already-open panel.
    await page.locator('[data-testid="jira-bell-button"]').click()
    await expect(panel).toHaveCount(0)
    await page.locator('[data-testid="jira-bell-button"]').click()
    await expect(panel.locator('[data-testid="jira-row"]')).toHaveCount(1)
    await expect(panel.locator('[data-jira-id="1"]')).toHaveCount(0)
    // Item "2" was never read — the grace period only ever applied to "1".
    await expect(panel).toContainText('1 ongelezen')
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
