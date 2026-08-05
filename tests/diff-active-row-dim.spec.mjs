import { test, expect } from './_fixtures.mjs'

// Regression test for the active-row cursor marker (the inset box-shadow bar
// in rowCellHTML/translationRowCls): it must dim to grey — and go one pixel
// thinner (2px vs 3px) — the moment the diff no longer owns the keyboard,
// even though the block stays selected and its cursor position
// (state.change) doesn't move at all. Before this fix, `activeGroup` (which
// only checks `state.selected`/`state.focusLevel`, not `state.mode` or
// `relatedActive()`) kept the bar indigo regardless of where the keyboard
// actually was — e.g. back in the block index (list mode) or inside a
// comment thread. `diffActive()` already drives the identical dimming on the
// card's own border (see "Focus highlight per stop" in
// keyboard-navigation.md); this test covers the bar getting the same
// treatment. Colour AND thickness change together, never colour alone (the
// reviewer is colourblind, see CLAUDE.md).
test('the active-row bar dims to grey (and thinner) when the diff loses keyboard focus', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute — a real diff
  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()

  const blockColumn = page.getByTestId('block-column')
  const focusedBars = blockColumn.locator('div[class*="inset_3px_0_0"]')
  const dimmedBars = blockColumn.locator('div[class*="inset_2px_0_0"]')

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)

  // Focused: the diff owns the keyboard — indigo, 3px bar lit, no dimmed bar.
  await expect(focusedBars.first()).toBeVisible()
  await expect(dimmedBars).toHaveCount(0)

  // Step back to the block index: same block still selected, same cursor
  // position (state.change untouched), but the keyboard left the diff.
  await page.keyboard.press('ArrowLeft')
  await expect(page).not.toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)

  await expect(focusedBars).toHaveCount(0)
  await expect(dimmedBars.first()).toBeVisible()

  // Stepping back into the diff relights the focused (indigo, 3px) bar.
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await page.waitForTimeout(200)
  await expect(focusedBars.first()).toBeVisible()
  await expect(dimmedBars).toHaveCount(0)
})
