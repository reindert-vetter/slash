import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Footer.mjs's footer-diff code (data-testid=code-diff) wraps a diff line
// that no longer comfortably fits the column (WIDE_AT, ~110 chars) instead of
// letting it overflow to an invisible (no-scrollbar) horizontal scroll. The
// new/right (+) line already did this; the old/left (-) line did not, so a
// long changed line's removed side ran off-screen while the added side
// wrapped — see the WIDE_AT comment in Footer.mjs. Both sides must wrap.
test.describe('footer diff line wrap', () => {
  test('a long old (-) line wraps just like a long new (+) line', async ({ page }) => {
    const longOld = '    ' + 'a'.repeat(120) + ' = 1;'
    const longNew = '    ' + 'a'.repeat(120) + ' = 2;'
    await page.route('**/api/code**', async (route) => {
      await route.fulfill({
        json: {
          file: 'app/Actions/CreatePaymentAction.php',
          old: { start: 1, end: 1, text: longOld },
          new: { start: 1, end: 1, text: longNew },
        },
      })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // group -> line: land on the single changed line

    const diff = page.getByTestId('footer-diff').getByTestId('code-diff')
    await expect(diff).toBeVisible()
    const rows = diff.locator('> div')
    await expect(rows).toHaveCount(2)
    // Both the removed (-) and added (+) row must wrap once their content
    // exceeds WIDE_AT, not just the added one.
    await expect(rows.nth(0)).toHaveClass(/whitespace-pre-wrap/)
    await expect(rows.nth(1)).toHaveClass(/whitespace-pre-wrap/)
  })
})
