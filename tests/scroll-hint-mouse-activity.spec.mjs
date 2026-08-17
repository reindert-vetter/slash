import { test, expect } from './_fixtures.mjs'

// Reviewer request: "ik wil het terug knopje altijd zichtbaar zien als ik
// waardan ook met mijn muis beweeg, hide het als ik voor 5 seconden niet
// beweeg" (also confirmed for main-scroll-right-hint; block-open-menu stays
// hover-per-card). `main-scroll-left-hint`/`main-scroll-right-hint` already
// exist and reveal on a direct per-element `hover:` — this spec covers the
// NEW `state.mouseActiveHints` OR-condition layered on top: any mouse
// movement anywhere on the page reveals the hint, and it hides again after
// 5s without further movement.
//
// Uses `main-scroll-left-hint` only (the mirror mechanism is identical on
// `main-scroll-right-hint`, see mouse-navigation.md/detail-layout.md) — a
// fresh load in list mode with the description not yet open already
// satisfies `canStepMainLeft()`, so the hint's underlying visibility gate
// (unrelated to this spec) is already true and the button exists in the DOM
// the whole time; only its *opacity* changes.
//
// Playwright's `toBeVisible()` ignores CSS opacity (only display/visibility/
// zero-size), so this spec reads the computed style directly instead. The
// opacity classes sit on the INNER box (the outer `main-scroll-left-hint`
// element only carries position/zone classes, see MainScrollLeftHint in
// home.mjs), so read the first child.
async function hintOpacity(page) {
  return page
    .getByTestId('main-scroll-left-hint')
    .locator('> div')
    .first()
    .evaluate((el) => getComputedStyle(el).opacity)
}

test('the left-scroll hint reveals on any mouse movement and hides again after 5s idle', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('main-scroll-left-hint')).toBeAttached()

  // Fresh load, before any mouse movement at all: hidden by default.
  await expect.poll(() => hintOpacity(page)).toBe('0')

  // A mouse move far away from the hint's own fixed corner still reveals it —
  // the whole point of the new mechanism, as opposed to the pre-existing
  // per-element `hover:`.
  await page.mouse.move(700, 500)
  await page.mouse.move(720, 520)
  await expect.poll(() => hintOpacity(page)).toBe('1')

  // Move the cursor away from the hint itself before waiting, so the
  // pre-existing `hover:opacity-100` on the rail can't keep it visible on its
  // own — this assertion is purely about the mouseActiveHints idle timeout.
  await page.mouse.move(700, 500)
  await page.waitForTimeout(5300)
  await expect.poll(() => hintOpacity(page)).toBe('0')

  // Purely a discoverability affordance: no navigation/selection state moved.
  await expect(page.getByTestId('pr-index')).toBeVisible()
})
