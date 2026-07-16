import { test, expect } from './_fixtures.mjs'

// Regression coverage for "arrow-down navigation gets hijacked by hover":
// src/overview.mjs's paintSelection() calls scrollIntoView on every keyboard
// step, and browsers (Chromium in particular) resync :hover state by
// dispatching a *synthetic* `mousemove` DOM event at the cursor's last known,
// unchanged position whenever content scrolls underneath it. A prior version
// of the mousemove listener couldn't tell that apart from a genuine mouse
// move, so it kept re-enabling `hoverEnabled` right after a keypress disabled
// it, and the next mouseenter (on whatever row now sits under the idle
// cursor) yanked the keyboard selection back — "the items keep sliding
// along" while pressing the down arrow.
//
// We couldn't reproduce the exact browser-native trigger (a scroll-caused
// synthetic mousemove) deterministically under Playwright — see the existing
// note in overview.spec.mjs's selectRowByKeyboard about synthetic
// hover/mouseenter being unreliable there. This test instead drives the
// underlying mechanism directly: dispatch real `mousemove`/`mouseenter` DOM
// events (indistinguishable to the app from "real" ones) and prove the gate
// itself — same coordinates never re-arm hoverEnabled, a genuine coordinate
// change always does — which is exactly the fix for the reported bug
// regardless of which real-world event happens to trigger it.
test.describe('PR overview — keyboard nav is not hijacked by a same-position mousemove', () => {
  test('a same-coordinate mousemove leaves the keyboard selection alone; a real move re-arms hover', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(4)

    const isSelected = (i) =>
      rows.nth(i).evaluate((el) => el.classList.contains('ring-emerald-500/50'))

    // Land the keyboard selection on row 0.
    await page.keyboard.press('Home')
    await expect.poll(() => isSelected(0)).toBe(true)

    // Establish a baseline "real" mouse position (first mousemove is always
    // real — there is no previous position to compare against yet) and
    // confirm the hover mechanism can hijack the selection when genuinely
    // live, as a sanity check that the rest of this test isn't vacuous.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    })
    await page.locator('[data-nav-row]').nth(1).dispatchEvent('mouseenter')
    await expect.poll(() => isSelected(1)).toBe(true)

    // Now navigate with the keyboard again — this disables hoverEnabled,
    // same as every ArrowDown/ArrowUp/Home/End press.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => isSelected(2)).toBe(true)

    // A mousemove at the exact same coordinates as before (simulating the
    // browser's own scroll-triggered hover resync, which fires at the
    // cursor's unchanged position) must NOT re-arm hoverEnabled.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }))
    })
    await page.locator('[data-nav-row]').nth(0).dispatchEvent('mouseenter')
    // Selection must still be on row 2 — the same-position mousemove did not
    // hijack it.
    expect(await isSelected(2)).toBe(true)
    expect(await isSelected(0)).toBe(false)

    // A mousemove with genuinely different coordinates DOES re-arm hover,
    // and a subsequent mouseenter is honored as before.
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 120 }))
    })
    await page.locator('[data-nav-row]').nth(0).dispatchEvent('mouseenter')
    await expect.poll(() => isSelected(0)).toBe(true)
  })
})
