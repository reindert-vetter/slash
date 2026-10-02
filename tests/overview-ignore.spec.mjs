import { test, expect, appReady } from './_fixtures.mjs'

// "Negeren" on a "Migrations & API changes" row — see "Negeren" in
// .claude/docs/pr-overview.md. Real pr_ignore workflow against the per-worker
// server; the M&A section itself is injected into the inbox response.
const TOUCHED = 'Migrations & API changes'
const PR = 970911

test.describe('PR overview — ignore a PR in Migrations & API changes', () => {
  test.afterEach(async ({ page }) => {
    const { runId } = await (await page.request.post('/api/workflows/pr_ignore')).json()
    await page.request.post('/api/workflows/' + runId + '/signals/pr_ignore', { data: { pr: PR, ignore: false } })
  })

  test('ignore moves the row to the bottom block, un-ignore brings it back; other menus have no item', async ({ page }) => {
    await page.route('**/api/inbox', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.sections = body.sections || []
      body.sections.push({
        title: TOUCHED,
        prs: [{ number: PR, title: 'Alter orders', author: 'alice', updatedAt: '2026-09-30T10:00:00Z', baseRefName: 'main', headRefName: 'feat/x' }],
      })
      await route.fulfill({ response: res, json: body })
    })
    await page.goto('/pr-overview')
    await appReady(page)

    // Not offered outside the M&A section.
    await page.locator('[data-testid="pr-row"][data-pr="12888"]').click()
    await expect(page.locator('[data-testid="pr-popover"]')).toBeVisible()
    await expect(page.locator('[data-testid="ignore-pr"]')).toHaveCount(0)
    await page.keyboard.press('Escape')

    const row = page.locator(`[data-testid="section"][data-title="${TOUCHED}"] [data-testid="pr-row"][data-pr="${PR}"]`)
    await row.click()
    const popover = page.locator('[data-testid="pr-popover"]')
    const labels = await popover.locator('button, a').allInnerTexts()
    const iIgnore = labels.findIndex((l) => l.includes('Negeren'))
    const iSnooze = labels.findIndex((l) => l.includes('Snooze'))
    expect(iIgnore).toBeGreaterThan(0)
    expect(iIgnore).toBe(iSnooze - 1)
    await popover.locator('[data-testid="ignore-pr"]').click()

    await expect(row).toHaveCount(0)
    const bottom = page.locator('[data-testid="snoozed-section"]')
    await expect(bottom.locator('[data-testid="snoozed-toggle"]')).toContainText('Gesnoozed & genegeerd (1)')

    await page.reload()
    await appReady(page)
    await expect(row).toHaveCount(0)
    await page.locator('[data-testid="snoozed-toggle"]').click()
    await bottom.locator(`[data-testid="pr-row"][data-pr="${PR}"]`).click()
    await expect(page.locator('[data-testid="ignore-pr"]')).toContainText('Negeren opheffen')
    await page.locator('[data-testid="ignore-pr"]').click()
    await expect(row).toBeVisible()
  })

  async function injectSection(page) {
    await page.route('**/api/inbox', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.sections = body.sections || []
      body.sections.push({
        title: TOUCHED,
        prs: [{ number: PR, title: 'Alter orders', author: 'alice', updatedAt: '2026-09-30T10:00:00Z', baseRefName: 'main', headRefName: 'feat/x' }],
      })
      await route.fulfill({ response: res, json: body })
    })
  }

  test('the row leaves at once even when the Signal POST is slow', async ({ page }) => {
    await injectSection(page)
    await page.route('**/signals/pr_ignore', async (route) => {
      await new Promise((r) => setTimeout(r, 4000))
      await route.continue()
    })
    await page.goto('/pr-overview')
    await appReady(page)
    const row = page.locator(`[data-testid="section"][data-title="${TOUCHED}"] [data-testid="pr-row"][data-pr="${PR}"]`)
    await row.click()
    await page.locator('[data-testid="ignore-pr"]').click()
    await expect(row).toHaveCount(0, { timeout: 1000 })
    await expect(page.locator('[data-testid="pr-popover"]')).toHaveCount(0)
  })

  test('a failed Signal puts the row back and shows the error', async ({ page }) => {
    await injectSection(page)
    await page.route('**/signals/pr_ignore', (route) => route.fulfill({ status: 500, body: 'boom' }))
    await page.goto('/pr-overview')
    await appReady(page)
    const row = page.locator(`[data-testid="section"][data-title="${TOUCHED}"] [data-testid="pr-row"][data-pr="${PR}"]`)
    await row.click()
    await page.locator('[data-testid="ignore-pr"]').click()
    await expect(row).toBeVisible()
    await expect(page.locator('[data-testid="ignore-error"]')).toBeVisible()
  })
})
