import { test, expect, appReady } from './_fixtures.mjs'

// Regression coverage for "als je in pr overview omhoog of naar beneden
// scroll, moet het geselecteerde niet gescrolled worden, wel als ik navigeer
// met mijn keys". src/overview.mjs's paintSelection() used to call
// `scrollIntoView()` unconditionally on every repaint — not just the ones
// driven by a keyboard step, but also the ones driven by a data/UI change
// (the Planning/Todo rows landing, the "Mislukte taken" drawer toggling, an
// inbox reload tick). None of those originate from the reviewer's own
// scrollwheel, but the repeated `scrollIntoView()` call fought a reviewer who
// had scrolled away from the selected row to look at something else,
// yanking the viewport back to it. The fix (`lastScrolledSelKey` in
// overview.mjs) only scrolls when the SELECTED ROW ITSELF just changed
// identity (a real navigation step), never on a mere repaint of an unchanged
// selection. See ".claude/docs/pr-overview.md", "Scrolling to the selection
// only happens on a real navigation step".
test.describe('PR overview — scrolling to the selection only happens on a real navigation step', () => {
  test('a data-driven repaint (toggling the "Mislukte taken" drawer) does not scroll the selected row back into view', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(5) // 4 primary-repo rows + plug-and-pay-ops#12

    // Select the first row (a real navigation step) — this legitimately
    // scrolls, which is expected and not under test here.
    await page.keyboard.press('Home')
    await expect
      .poll(() => rows.first().evaluate((el) => el.classList.contains('ring-indigo-500/50')))
      .toBe(true)

    // Scroll far down the page, away from the selected (top) row — simulating
    // the reviewer looking around with the mouse/trackpad.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const scrollYAfterManualScroll = await page.evaluate(() => window.scrollY)
    expect(scrollYAfterManualScroll).toBeGreaterThan(0)

    // Trigger a data/UI-driven repaint that goes through the exact same
    // paintSelection() path as a background poll landing — the selection
    // itself never changes here.
    await page.locator('[data-testid="problems-drawer"]').click()
    await page.waitForTimeout(150) // scheduleRepaint runs in a requestAnimationFrame

    // The viewport must stay where the reviewer scrolled it — the repaint
    // must not have pulled it back to the still-selected top row.
    const scrollYAfterRepaint = await page.evaluate(() => window.scrollY)
    expect(scrollYAfterRepaint).toBe(scrollYAfterManualScroll)
  })

  test('a keyboard step still scrolls the newly selected row into view', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(5)

    await page.keyboard.press('Home')
    await expect
      .poll(() => rows.first().evaluate((el) => el.classList.contains('ring-indigo-500/50')))
      .toBe(true)

    // Scroll the freshly selected (first) row out of view.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const scrolledAway = await page.evaluate(() => window.scrollY)
    expect(scrolledAway).toBeGreaterThan(0)

    // Walk to the end with the keyboard — a real navigation step must bring
    // the newly selected row back into view.
    const totalRows = await rows.count()
    for (let i = 0; i < totalRows - 1; i++) await page.keyboard.press('ArrowDown')
    const lastRow = rows.last()
    await expect.poll(() => lastRow.evaluate((el) => el.classList.contains('ring-indigo-500/50'))).toBe(true)
    await expect
      .poll(() => lastRow.evaluate((el) => el.getBoundingClientRect().top < window.innerHeight && el.getBoundingClientRect().bottom > 0))
      .toBe(true)
  })
})
