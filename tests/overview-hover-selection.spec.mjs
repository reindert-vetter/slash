import { test, expect, appReady } from './_fixtures.mjs'

// Regression coverage for "in de pr overview, wil ik dat een mouse hover het
// niet gelijk selecteerd, key navigatie moet zo blijven" — src/overview.mjs
// used to move the keyboard-selection ring on a plain `mouseenter`, gated by
// a `hoverEnabled` flag that tried to tell a genuine mouse move apart from a
// scroll-triggered synthetic one. That whole mechanism was a documented
// exception to "Rule 4: hover carries no state" in
// .claude/docs/mouse-navigation.md; it has been removed outright instead of
// patched further — hovering a row must never touch the selection at all,
// only a real click (which already claims the ring itself, via
// togglePopover) or a keyboard step does. See .claude/docs/pr-overview.md,
// "Selection identity" and "The selected-row highlight".
test.describe('PR overview — hover never moves the keyboard selection, keys still do', () => {
  test('a mouseenter leaves the selection alone; ArrowDown/Home still move it', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const rows = page.locator('[data-nav-row]')
    // 5 fixture rows: 4 from the primary repo + plug-and-pay-ops#12.
    await expect(rows).toHaveCount(5)

    const isSelected = (i) => rows.nth(i).evaluate((el) => el.classList.contains('ring-indigo-500/50'))

    // Nothing is selected on a fresh load.
    for (let i = 0; i < 5; i++) expect(await isSelected(i)).toBe(false)

    // Hovering a row (real mousemove + mouseenter, same events the browser
    // would dispatch) must not select it.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    })
    await rows.nth(2).dispatchEvent('mouseenter')
    for (let i = 0; i < 5; i++) expect(await isSelected(i)).toBe(false)

    // Hovering a second, different row still selects nothing.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 220 }))
    })
    await rows.nth(0).dispatchEvent('mouseenter')
    for (let i = 0; i < 5; i++) expect(await isSelected(i)).toBe(false)

    // Keyboard navigation is unaffected: Home selects the first row, ArrowDown
    // moves to the next one.
    await page.keyboard.press('Home')
    await expect.poll(() => isSelected(0)).toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => isSelected(1)).toBe(true)
    expect(await isSelected(0)).toBe(false)

    // Hovering yet another row while a keyboard selection is active must not
    // move it off row 1.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 400 }))
    })
    await rows.nth(3).dispatchEvent('mouseenter')
    expect(await isSelected(1)).toBe(true)
    expect(await isSelected(3)).toBe(false)
  })

  test('a click still opens the popover and claims the selection ring, exactly as before', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(5)
    const isSelected = (i) => rows.nth(i).evaluate((el) => el.classList.contains('ring-indigo-500/50'))

    // Hovering first proves hover truly carries no state going into the click.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 80 }))
    })
    await rows.nth(1).dispatchEvent('mouseenter')
    expect(await isSelected(1)).toBe(false)

    await rows.nth(1).click()
    await expect.poll(() => isSelected(1)).toBe(true)
    await expect(page.locator('[data-testid="pr-popover"]')).toBeVisible()
  })
})
