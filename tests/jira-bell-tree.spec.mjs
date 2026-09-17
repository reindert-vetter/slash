import { test, expect, seededPr, appReady } from './_fixtures.mjs'

// The Jira-notifications bell (src/jiraBell.mjs), always pinned to the
// top-right corner of the WHOLE /pr/<id> page — see the "JiraBellHost" doc
// comment in src/home.mjs and "The same bell, smaller and independent" in
// .claude/docs/pr-overview.md. Reviewer request: "het belletje moet ALTIJD
// rechtsboven op de pagina staan, los van of de chatkolom open staat" — a
// generalization of an earlier, narrower ask that only showed the bell while
// stop 1 (the PR-info card) was in view. Only regression-sensitive bit tested
// here: the bell survives navigating away from stop 1 (proving it isn't
// nested inside prInfoCard any more), and still only appears when there are
// notifications.
test.describe('/pr/<id> — Jira bell, fixed top-right corner', () => {
  function stubNotifications(page, items) {
    return page.route('**/api/jira/notifications', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, runId: 'fake-run', items }),
      })
    })
  }

  test('shows in the fixed corner regardless of which stop is focused, and stays out of prInfoCard', async ({
    page,
  }) => {
    // The shared, read-only anchor fixture (PR 12903) — no writes here, only
    // navigation + a stubbed Jira feed, which is exactly the "reading it
    // without writing" case .claude/docs/testing-playwright.md allows. Needed
    // (rather than a fresh `seededPr`) because a genuinely empty PR has no
    // blocks to select, which leaves the block-index unable to walk the
    // diff/list/description nav chain this test exercises — same fixture
    // `tests/nav-chain.spec.mjs` uses for the identical stop-1 walk.
    await stubNotifications(page, [
      {
        id: '1',
        at: new Date().toISOString(),
        title: 'Notification',
        issueKey: 'AB-1',
        actor: '',
        avatarUrl: '',
        url: 'https://example.atlassian.net/browse/AB-1',
        unread: true,
      },
    ])
    await page.goto('/pr/12903')
    await appReady(page)

    // The test harness's own page.goto already steps past stop 1 (the
    // PR-info card) onto the block index — the bell must already be visible
    // there, proving it isn't nested inside prInfoCard any more.
    await expect(page.locator('[data-testid="pr-info-summary"]')).toHaveCount(0)
    const bell = page.locator('[data-testid="jira-bell-button"]')
    await expect(bell).toBeVisible()

    // Step back INTO stop 1 — the bell must stay visible there too (it's the
    // one place the older, now-removed mount point used to live).
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('[data-testid="pr-info-summary"]')).toBeVisible()
    await expect(bell).toBeVisible()
    // Not nested inside prInfoCard's own icon row any more — one canonical
    // mount, not a duplicate (jiraBellButton() shares one module-level
    // `bell` store, so two mounted instances would double-render the
    // dropdown, see the JiraBellHost doc comment in home.mjs).
    await expect(page.locator('[data-testid="pr-info-theme-row"] [data-testid="jira-bell-button"]')).toHaveCount(0)

    await bell.click()
    await expect(page.locator('[data-testid="jira-bell-panel"]')).toBeVisible()
  })

  // Marking a row read and then UNREAD again, from the bell's own per-row
  // buttons — the writes themselves are the shared ones in
  // src/jiraNotifyActions.mjs (used by /pr-overview's bell too), so this only
  // pins that this bell really offers both directions and updates optimistically.
  test('a row can be marked read and then unread again', async ({ page }) => {
    await stubNotifications(page, [
      {
        id: '1',
        at: new Date().toISOString(),
        title: 'Notification',
        issueKey: 'AB-1',
        actor: '',
        avatarUrl: '',
        url: 'https://example.atlassian.net/browse/AB-1',
        unread: true,
      },
    ])
    // The jira_notify writes go to the jira_inbox tracker; stub both hops so
    // the test asserts the UI, not the tracker (which has its own Go tests).
    const signals = []
    await page.route('**/api/workflows/jira_inbox', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, runId: 'fake-run' }) }),
    )
    await page.route('**/signals/jira_notify', async (route) => {
      signals.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    await page.goto('/pr/12903')
    await appReady(page)
    await page.locator('[data-testid="jira-bell-button"]').click()
    await expect(page.locator('[data-testid="jira-unread-dot"]')).toHaveCount(1)

    await page.locator('[data-testid="jira-mark-read"]').click()
    await expect(page.locator('[data-testid="jira-unread-dot"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="jira-mark-unread"]')).toHaveCount(1)

    await page.locator('[data-testid="jira-mark-unread"]').click()
    await expect(page.locator('[data-testid="jira-unread-dot"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="jira-mark-read"]')).toHaveCount(1)
    await expect.poll(() => signals.map((s) => s.kind)).toEqual(['read', 'unread'])
  })

  test('renders nothing when there are no notifications', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    await stubNotifications(page, [])
    await page.goto('/pr/' + pr)
    await appReady(page)

    await expect(page.locator('[data-testid="jira-bell-button"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="jira-bell-absent"]')).toHaveCount(1)
  })
})
