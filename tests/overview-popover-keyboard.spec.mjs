import { test, expect } from './_fixtures.mjs'

// Regression test for: while a row's popover menu is open on /pr-overview,
// ↑/↓ must drive the popover's own items (a real menu widget — cycling with
// wrap-around, Enter activates, Escape closes) instead of shifting the
// underlying row-list selection. See src/overview.mjs (handlePopoverKey/
// movePopover/focusPopoverItem) and the "Zodra een popover open is…" section
// in .claude/rules/pages-and-routing.md.
//
// A pinned "Sluit menu" is always the FIRST item (mirrors the CommandMenu's
// withClose pattern in home.mjs), but opening the popover default-focuses the
// SECOND item (the first real action) — see focusPopoverItem(1) in
// togglePopover — so a stray Enter never merely closes the menu.
test.describe('PR Review Tree — popover keyboard navigation', () => {
  // 12888 ("Fix comment notification retry backoff (BLOG-1421)") is not yet
  // ingested and its title carries a Jira key. Its popover's first three items
  // are stable in document order (Sluit menu, Genereer review-boom, Open op
  // GitHub); the rest (Kopieer GitHub URL, Open Jira-ticket) vary, so the
  // wrap-around is exercised over the actual item count rather than a
  // hardcoded number.
  test('"Sluit menu" is the first item, opens focused on the 2nd, and ↑/↓ cycle with wrap-around', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()

    const popover = page.locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()

    const closeItem = popover.locator('[data-testid="close-popover"]')
    const generate = popover.locator('[data-testid="generate-page"]')
    const github = popover.locator('a', { hasText: 'Open op GitHub' })

    // "Sluit menu" is literally the first focusable item in document order.
    const firstItemIsClose = await popover.evaluate(
      (el) => el.querySelectorAll('button:not([disabled]), a[href]')[0].dataset.testid === 'close-popover',
    )
    expect(firstItemIsClose).toBe(true)

    // The full ordered set of focusable menu items (buttons + links).
    const itemCount = await popover.evaluate(
      (el) => el.querySelectorAll('button:not([disabled]), a[href]').length,
    )
    expect(itemCount).toBeGreaterThan(4)

    // Opening the popover default-focuses the 2nd item (the first real
    // action), not the pinned "Sluit menu" — a direct Enter must not just close.
    await expect(generate).toBeFocused()
    await expect(closeItem).not.toBeFocused()

    // ↓ steps forward through the menu…
    await page.keyboard.press('ArrowDown')
    await expect(github).toBeFocused()

    // …and wraps back to the 2nd item (generate) after cycling through all of them.
    for (let i = 0; i < itemCount - 1; i++) await page.keyboard.press('ArrowDown')
    await expect(generate).toBeFocused()

    // ↑ from the 2nd item steps back to the pinned "Sluit menu" (the true first item).
    await page.keyboard.press('ArrowUp')
    await expect(closeItem).toBeFocused()

    // ↑ from "Sluit menu" wraps backward to the last item.
    await page.keyboard.press('ArrowUp')
    const lastFocused = await popover.evaluate((el) => {
      const items = el.querySelectorAll('button:not([disabled]), a[href]')
      return document.activeElement === items[items.length - 1]
    })
    expect(lastFocused).toBe(true)

    // The underlying row-list keyboard nav is suspended: none of these ↑/↓
    // presses reached move()/moveTo(), so the row itself never picked up the
    // keyboard-selection ring (paintSelection's ring-1/ring-indigo classes).
    await expect(row).not.toHaveClass(/ring-indigo-500/)

    // Step forward once more, back onto the pinned "Sluit menu" item (from the
    // last item, wrapping), then Enter closes the popover.
    await page.keyboard.press('ArrowDown')
    await expect(closeItem).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(popover).toHaveCount(0)
    await expect(page).toHaveURL(/\/pr-overview$/)
  })

  // Escape still closes it too, independent of where focus is.
  test('Escape closes the popover without navigating anywhere', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()

    const popover = page.locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()

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

    // togglePopover default-focuses the 2nd item via requestAnimationFrame
    // (see focusPopoverItem(1) in overview.mjs) — wait for that focus to
    // actually land (mirrors the other test in this file) before pressing
    // ArrowDown, otherwise the keypress can race the rAF and land on
    // whatever ui.openPopover happened to leave focused (or nothing at all),
    // which movePopover then treats as "no current item" and wraps to the
    // first one instead of stepping from the 2nd to the 3rd.
    const generate = popover.locator('[data-testid="generate-page"]')
    await expect(generate).toBeFocused()

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
