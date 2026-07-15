import { test, expect } from './_fixtures.mjs'

// The PR overview (/pr-overview) is a live GitHub-style inbox. Under test the Go
// bridge serves tests/fixtures/inbox.json (SLASH_GITHUB=off + SLASH_INBOX), so
// the sections/rows/pills are deterministic and never touch the network. An
// ingested PR (hasGraph, from the seeded blocks DB) links into /pr/<id>.
// See src/overview.mjs + inbox.go/inbox_api.go.
test.describe('PR Review Tree — PR inbox', () => {
  test('renders sections and rows from the live inbox', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="inbox"]')).toBeVisible()

    // Sections mirror GitHub's /pulls.
    await expect(
      page.locator('[data-testid="section"][data-title="Needs your review"]')
    ).toBeVisible()

    // Every fixture PR renders as a row (12888 standalone, 12903+12904 stacked,
    // 12801 ready-to-merge).
    const rows = page.locator('[data-testid="pr-row"]')
    await expect(rows).toHaveCount(4)
  })

  test('stacked PRs surface as their own group', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const stack = page.locator('[data-testid="stack"]')
    await expect(stack).toHaveCount(1)
    // The chain (12903 → 12904) lives in the stack group, lifted out of the
    // flat section lists.
    await expect(stack.locator('[data-testid="pr-row"]')).toHaveCount(2)
    await expect(stack.locator('[data-pr="12903"]')).toBeVisible()
    await expect(stack.locator('[data-pr="12904"]')).toBeVisible()
  })

  test('an ingested PR links into its review page', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const ingested = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await expect(ingested).toHaveAttribute('href', '/pr/12903')

    await ingested.click()
    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect(page.locator('[data-testid="block-row"]').first()).toBeVisible()
  })

  test('status pills backfill after first paint', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    // The approved "Ready to merge" PR shows its review chip once status lands.
    const chip = page
      .locator('[data-testid="pr-row"][data-pr="12801"] [data-testid="review-chip"]')
    await expect(chip).toBeVisible()
  })

  test('search filters over all open PRs', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="search"]').fill('address')
    const results = page.locator('[data-testid="search-results"]')
    await expect(results).toBeVisible()
    await expect(results.locator('[data-testid="pr-row"]')).toHaveCount(2)
  })

  test('bare / redirects to the overview', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  // 12801 has no graph yet (not seeded into the blocks DB), so its row opens
  // the popover instead of linking straight into /pr/<id>.
  test('generating a review tree from the popover redirects into /pr/<id>', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.route('**/api/ingest', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      expect(body.pr).toBe(12801)
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()
    const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
    await expect(generate).toBeVisible()
    await expect(generate).toHaveText(/Genereer review-boom/)

    await generate.click()
    await expect(page).toHaveURL(/\/pr\/12801$/)
  })

  test('a failed generate keeps the popover open with an inline error', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.route('**/api/ingest', async (route) => {
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"gh unreachable"}' })
    })

    const row = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await row.click()
    const generate = page.locator('[data-testid="pr-popover"] [data-testid="generate-page"]')
    await generate.click()

    await expect(page.locator('[data-testid="generate-error"]')).toHaveText(/gh unreachable/)
    // Still on the overview, the row is untouched (no graph yet).
    await expect(page).toHaveURL(/\/pr-overview$/)
    await expect(generate).toBeEnabled()
  })
})
