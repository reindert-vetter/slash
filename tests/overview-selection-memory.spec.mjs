import { test, expect, appReady } from './_fixtures.mjs'

// The /pr-overview selection is REMEMBERED across visits (task 21): leaving
// the page — into a review tree, into a /plan/<KEY> page, or just a refresh —
// and coming back must put the ring back on the row you were standing on
// instead of dropping you on an unselected list.
//
// What is stored is the row's stable `data-nav-key` identity (the same thing
// `selKey` already is, see "Selection identity" in
// .claude/docs/pr-overview.md), in localStorage — a UI preference that has to
// survive a refresh, exactly like the theme, never a workflow write. An
// explicit `?pr=`/`?approved=` in the URL WINS over that memory.
test.describe('PR overview — the selection is remembered on return', () => {
  const isSelected = (loc) => loc.evaluate((el) => el.classList.contains('ring-indigo-500/50'))

  test('a selected row is selected again on the next visit', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()
    await expect.poll(() => isSelected(row)).toBe(true)

    // Leave the page entirely and come back — a full document load, so
    // nothing but the store can carry the selection over.
    await page.goto('/settings')
    await page.goto('/pr-overview')
    await appReady(page)

    const again = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await expect.poll(() => isSelected(again)).toBe(true)
    // And only that one row.
    const selectedCount = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.filter((el) => el.classList.contains('ring-indigo-500/50')).length)
    expect(selectedCount).toBe(1)
  })

  test('an explicit ?pr= wins over the remembered row', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const remembered = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await remembered.click()
    await expect.poll(() => isSelected(remembered)).toBe(true)

    // Coming back through the ← round trip of a DIFFERENT PR: that PR's row
    // must own the ring, not the remembered one.
    await page.goto('/pr-overview?pr=12801')
    await appReady(page)
    const fromUrl = page.locator('[data-testid="pr-row"][data-pr="12801"]')
    await expect.poll(() => isSelected(fromUrl)).toBe(true)
    expect(await isSelected(page.locator('[data-testid="pr-row"][data-pr="12888"]'))).toBe(false)
  })

  test('focusing the search box forgets the selection, so the next visit starts clean', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    // Keyboard-only here: a click would open the row's popover, which owns
    // ↑/↓ for as long as it is open (handlePopoverKey).
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    const row = page.locator('[data-nav-row]').nth(1)
    await expect.poll(() => isSelected(row)).toBe(true)

    // ↑ from the first row hands the keyboard to the search box and RELEASES
    // the selection (focusSearch) — a released selection must not come back.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator('[data-testid="search"]')).toBeFocused()

    await page.goto('/pr-overview')
    await appReady(page)
    const anySelected = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.some((el) => el.classList.contains('ring-indigo-500/50')))
    expect(anySelected).toBe(false)
  })
})
