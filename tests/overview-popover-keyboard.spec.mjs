import { test, expect } from './_fixtures.mjs'

// Regression test for: while a row's popover menu is open on /pr-overview,
// ↑/↓ must drive the popover's own items (a real menu widget — cycling with
// wrap-around, Enter activates, Escape closes) instead of shifting the
// underlying row-list selection. See src/overview.mjs (handlePopoverKey/
// movePopover/focusPopoverItem) and the "Zodra een popover open is…" section
// in .claude/rules/pages-and-routing.md.
test.describe('PR Review Tree — popover keyboard navigation', () => {
  // 12888 ("Fix comment notification retry backoff (BLOG-1421)") is not yet
  // ingested and its title carries a Jira key, so its popover has exactly
  // three items in document order: Genereer review-boom, Open op GitHub, Open
  // Jira-ticket — enough to exercise wrap-around in both directions.
  test('↑/↓ cycle the popover items, Escape closes it, and the row list stays put', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()

    const popover = page.locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()

    const generate = popover.locator('[data-testid="generate-page"]')
    const github = popover.locator('a', { hasText: 'Open op GitHub' })
    const jira = popover.locator('a', { hasText: 'Open Jira-ticket' })

    // Opening the popover focuses its first item automatically.
    await expect(generate).toBeFocused()

    // ↓ steps forward through the menu…
    await page.keyboard.press('ArrowDown')
    await expect(github).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(jira).toBeFocused()
    // …and wraps back to the first item past the last one.
    await page.keyboard.press('ArrowDown')
    await expect(generate).toBeFocused()

    // ↑ from the first item wraps backward to the last one.
    await page.keyboard.press('ArrowUp')
    await expect(jira).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(github).toBeFocused()

    // The underlying row-list keyboard nav is suspended: none of these ↑/↓
    // presses reached move()/moveTo(), so the row itself never picked up the
    // keyboard-selection ring (paintSelection's ring-1/ring-emerald classes).
    await expect(row).not.toHaveClass(/ring-emerald-500/)

    // Escape closes the popover without navigating anywhere.
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  // Enter activates whichever item currently has focus — not just the first
  // one — proving ↑/↓ genuinely moved the "selection" rather than merely
  // being swallowed.
  test('Enter activates the currently focused popover item', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()

    const popover = page.locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()

    // Move focus off the first item onto "Open op GitHub" (a target="_blank"
    // link) and confirm Enter follows it instead of running the first item's
    // (Generate) action.
    await page.keyboard.press('ArrowDown')
    const github = popover.locator('a', { hasText: 'Open op GitHub' })
    await expect(github).toBeFocused()

    const [popup] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('Enter')])
    await popup.waitForLoadState('domcontentloaded').catch(() => {})
    expect(popup.url()).toContain('github.com/blog-org/blog-platform/pull/12888')
    await popup.close()

    // The original tab is untouched — no ingest kicked off, still on the
    // overview.
    await expect(page).toHaveURL(/\/pr-overview$/)
  })
})
