import { test, expect } from './_fixtures.mjs'

// The filter drawer (a second expandable button like "Recent gegenereerd")
// offers preset filters — each a live gh-search for a fixed, allow-listed query
// (offline: the fixture rows). Results replace the main sections; "ouder dan 3
// dagen" groups them per author.
test.describe('PR overview — preset filter drawer', () => {
  test('opening the drawer and picking "Alle open PRs" shows results, back returns to the inbox', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="filter-drawer"]').click()
    await page.locator('[data-testid="preset-alle-open"]').click()

    const results = page.locator('[data-testid="preset-results"]')
    await expect(results).toBeVisible()
    await expect(results.locator('[data-testid="pr-row"]').first()).toBeVisible()

    // Back to the inbox restores the main sections.
    await page.locator('[data-testid="back-to-inbox"]').click()
    await expect(page.locator('[data-testid="inbox-sections"]')).toBeVisible()
  })

  test('"PR\'s ouder dan 3 dagen" groups results per author', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="filter-drawer"]').click()
    await page.locator('[data-testid="preset-ouder-3-dagen"]').click()

    const groups = page.locator('[data-testid="author-group"]')
    await expect(groups.first()).toBeVisible()
    // At least one group carries an author and its own PR rows.
    await expect(groups.first().locator('[data-testid="pr-row"]').first()).toBeVisible()
  })
})
