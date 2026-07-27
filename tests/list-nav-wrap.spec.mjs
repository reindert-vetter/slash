import { test, expect } from './_fixtures.mjs'

// ↑ in the block index (list mode) at the topmost visible block wraps around
// to the bottom of the list instead of staying put — the mirror-image of the
// existing "↓ falls into the file boundary and stops" flow-through tests in
// navigate.spec.mjs. See stepListSelection/lastVisibleIndex in home.mjs and
// the corresponding paragraph in .claude/rules/keyboard-navigation.md.
test.describe('PR Review Tree — list-mode ArrowUp wraps to the bottom', () => {
  test('↑ on the first block selects the last visible block', async ({ page }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    const count = await rows.count()
    expect(count).toBeGreaterThan(1)

    await page.locator('[data-idx="0"]').click()
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('ArrowUp')

    // Wrapped straight to the last visible block, not stuck on the first one.
    await expect(page.locator(`[data-idx="${count - 1}"]`)).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="0"]')).not.toHaveClass(/bg-indigo-50/)
  })
})
