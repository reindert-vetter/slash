import { test, expect, appReady } from './_fixtures.mjs'

// Snoozing a PR from its /pr-overview popover ("Snooze…", right below "Open
// Jira-ticket") — see "Snoozen" in .claude/docs/pr-overview.md. The first test
// runs against the real per-worker server: the pr_snooze workflow is local
// (no network), so the Signal really lands in the prsnooze read-model and is
// read back via GET /api/prsnoozes. The others stub that read to pin the two
// read-side wake-up rules.
test.describe('PR overview — snooze a PR', () => {
  // A real snooze outlives the test in this worker's DB; always lift it so no
  // later spec finds 12888 missing from its section.
  test.afterEach(async ({ page }) => {
    const res = await page.request.post('/api/workflows/pr_snooze')
    const { runId } = await res.json()
    await page.request.post('/api/workflows/' + runId + '/signals/pr_snooze', { data: { pr: 12888, option: 'clear' } })
  })

  test('snooze moves the row into a collapsed "Gesnoozed" block, unsnooze brings it back', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const section = page.locator('[data-testid="section"][data-title="Needs your review"]')
    const inSection = section.locator('[data-testid="pr-row"][data-pr="12888"]')
    await expect(inSection).toBeVisible()
    await inSection.click()

    const popover = page.locator('[data-testid="pr-popover"]')
    await popover.locator('[data-testid="snooze-pr"]').click()
    const options = popover.locator('[data-testid="snooze-option"]')
    await expect(options).toHaveCount(3)
    // The expanded options take the keyboard focus straight away.
    await expect(options.first()).toBeFocused()
    await expect(options.nth(1)).toContainText('Volgende week maandag 08:00')
    await options.first().click()

    await expect(inSection).toHaveCount(0)
    const snoozed = page.locator('[data-testid="snoozed-section"]')
    await expect(snoozed.locator('[data-testid="snoozed-toggle"]')).toContainText('Gesnoozed (1)')
    // Collapsed by default.
    await expect(snoozed.locator('[data-testid="pr-row"]')).toHaveCount(0)

    // It is durable: a reload still has it snoozed.
    await page.reload()
    await appReady(page)
    await expect(page.locator('[data-testid="snoozed-toggle"]')).toContainText('Gesnoozed (1)')
    await expect(inSection).toHaveCount(0)

    await page.locator('[data-testid="snoozed-toggle"]').click()
    const snoozedRow = page.locator('[data-testid="snoozed-section"] [data-testid="pr-row"][data-pr="12888"]')
    await expect(snoozedRow.locator('[data-testid="snooze-mark"]')).toContainText(/gesnoozed tot .*08:00/)

    await snoozedRow.click()
    await page.locator('[data-testid="pr-popover"] [data-testid="snooze-clear"]').click()
    await expect(inSection).toBeVisible()
    await expect(page.locator('[data-testid="snoozed-section"]')).toHaveCount(0)
  })

  async function stubSnoozes(page, snoozes) {
    await page.route('**/api/prsnoozes', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, snoozes }) }),
    )
  }

  test('new activity after the snooze (a later updatedAt) wakes the PR early', async ({ page }) => {
    const until = new Date(Date.now() + 86400000).toISOString()
    await stubSnoozes(page, [
      // 12888 was updated 2026-07-11T08:00Z — after this snooze was set.
      { repo: '', pr: 12888, until, snoozedAt: '2026-07-10T00:00:00Z' },
      // 12903 was updated 2026-07-10T09:00Z — before this snooze: stays snoozed.
      { repo: '', pr: 12903, until, snoozedAt: '2026-07-10T12:00:00Z' },
    ])
    await page.goto('/pr-overview')
    await appReady(page)
    const section = page.locator('[data-testid="section"][data-title="Needs your review"]')
    await expect(section.locator('[data-testid="pr-row"][data-pr="12888"]')).toBeVisible()
    await expect(section.locator('[data-testid="pr-row"][data-pr="12903"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="snoozed-toggle"]')).toContainText('Gesnoozed (1)')
  })

  test('a search hit that is snoozed still shows, with its snooze mark', async ({ page }) => {
    const until = new Date(Date.now() + 86400000).toISOString()
    await stubSnoozes(page, [{ repo: '', pr: 12903, until, snoozedAt: '2026-07-10T12:00:00Z' }])
    await page.goto('/pr-overview')
    await appReady(page)
    await page.locator('[data-testid="search"]').fill('scheduling')
    const hit = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await expect(hit.locator('[data-testid="snooze-mark"]')).toBeVisible()
  })
})
