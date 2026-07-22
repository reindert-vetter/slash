import { test, expect } from './_fixtures.mjs'

// The symmetric counterpart to overview-ignore.spec.mjs's "ArrowUp past the
// first row focuses the search box" test: ArrowDown from the search box must
// hand the keyboard back to the row list — a one-way trap here was the root
// cause of "I can't navigate down with the arrow keys" (see
// .claude/rules/pages-and-routing.md, "Client" section).
test.describe('PR overview — ArrowDown escapes the search box', () => {
  test('clicking the search box, then ArrowDown selects the first row and drops focus', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const search = page.locator('[data-testid="search"]')
    await search.click()
    await expect(search).toBeFocused()

    await page.keyboard.press('ArrowDown')

    // Focus left the input …
    const focused = await page.evaluate(() => document.activeElement?.tagName)
    expect(focused).not.toBe('INPUT')

    // … and the first row is now the keyboard selection.
    const firstRow = page.locator('[data-testid="pr-row"]').first()
    await expect(firstRow).toHaveClass(/ring-emerald-500\/50/)
  })

  test('ArrowDown then ArrowUp then ArrowDown is not a dead end', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="pr-row"]').first()).toBeVisible()

    await page.keyboard.press('ArrowDown') // select the first row
    await page.keyboard.press('ArrowUp') // past the top → search box
    await expect(page.locator('[data-testid="search"]')).toBeFocused()

    await page.keyboard.press('ArrowDown') // back down → first row again
    const focused = await page.evaluate(() => document.activeElement?.tagName)
    expect(focused).not.toBe('INPUT')
    await expect(page.locator('[data-testid="pr-row"]').first()).toHaveClass(/ring-emerald-500\/50/)
  })
})
