import { test, expect } from './_fixtures.mjs'

// Ignoring a PR hides it from the main inbox (client-side filter on the ignore
// read-model, written durably via the per-repo ignore workflow), it shows up in
// the "Toon alle verborgen pull requests" view, and un-ignoring restores it.
// Also covers "Kopieer GitHub URL" (clipboard mock) and ArrowUp-to-searchbox.
test.describe('PR overview — ignore / hidden / copy-url / arrowup', () => {
  test('ignore with a termijn hides the row, then un-ignore from the hidden view restores it', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await expect(row).toBeVisible()

    // Open the popover and ignore for 7 days.
    await row.click()
    await page.locator('[data-testid="ignore-7d"]').click()

    // The row disappears from the main inbox.
    await expect(page.locator('[data-testid="pr-row"][data-pr="12888"]')).toHaveCount(0)

    // It shows up in the hidden view.
    await page.locator('[data-testid="filter-drawer"]').click()
    await page.locator('[data-testid="show-hidden"]').click()
    const hidden = page.locator('[data-testid="hidden-row"][data-hidden-pr="12888"]')
    await expect(hidden).toBeVisible()
    await expect(hidden).toContainText('genegeerd tot')

    // Un-ignore restores it: back to the inbox, the row is present again.
    await hidden.locator('[data-testid="hidden-unignore"]').click()
    await page.locator('[data-testid="back-to-inbox"]').click()
    await expect(page.locator('[data-testid="pr-row"][data-pr="12888"]')).toBeVisible()
  })

  test('"Altijd" ignore uses until 0 and still hides the row', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()
    await page.locator('[data-testid="ignore-altijd"]').click()
    await expect(page.locator('[data-testid="pr-row"][data-pr="12888"]')).toHaveCount(0)

    await page.locator('[data-testid="filter-drawer"]').click()
    await page.locator('[data-testid="show-hidden"]').click()
    await expect(page.locator('[data-testid="hidden-row"][data-hidden-pr="12888"]')).toContainText('altijd')
  })

  test('Kopieer GitHub URL writes the PR url to the clipboard', async ({ page }) => {
    await page.addInitScript(() => {
      window.__copied = null
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t) => {
            window.__copied = t
            return Promise.resolve()
          },
          readText: () => Promise.resolve(window.__copied),
        },
      })
    })
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="pr-row"][data-pr="12888"]').click()
    await page.locator('[data-testid="copy-url"]').click()
    await expect.poll(() => page.evaluate(() => window.__copied)).toContain('/pull/12888')
  })

  test('ArrowUp past the first row focuses the search box (which searches all PRs)', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="pr-row"]').first()).toBeVisible()

    await page.keyboard.press('ArrowDown') // select the first row
    await page.keyboard.press('ArrowUp') // past the top → search box
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    expect(focused).toBe('search')
  })
})
