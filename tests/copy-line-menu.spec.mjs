import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Kopieer deze regel" (COMMANDS, home.mjs's copySelectedCode/dedentCode) —
// reviewer request: copy the currently focused unit's own code from the
// block/line palette, without its shared leading indentation. Reuses the
// same clipboard mechanism as the native right-click menu's own "Kopieer
// selectie" (copyReviewSummary) — see .claude/docs/command-palette.md's
// `Enter` block palette section.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs/review-submit-menu.spec.mjs:
// block index 1 (CreatePaymentAction::execute) carries a real, single-line
// diff group — its one changed line (`$order->billingAddress->update([`) is
// indented 8 spaces in the fixture's own source, exactly what dedentCode
// must strip. Read-only: no write happens here, so no
// APPROVAL_RESET_PRS/seededPr concern (see testing-playwright.md).
async function mockClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied = t
          return Promise.resolve()
        },
        readText: () => Promise.resolve(window.__copied),
      },
    })
  })
}

test('Enter → "Kopieer deze regel" copies the focused line, minus its leading indentation', async ({ page }) => {
  await mockClipboard(page)
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // By label, not by raw index — see "Sort order of the left list" in
  // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
  // real changed row.
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await page.keyboard.press('ArrowRight') // list -> diff
  await expect(page).toHaveURL(/mode=diff/)

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  const item = menu.getByTestId('command-row').filter({ hasText: 'Kopieer deze regel' })
  await expect(item).toHaveCount(1)
  await item.click()
  await expect(menu).toHaveCount(0)

  // runCommand defers the actual run() to the next animation frame (see
  // runCommand's own doc comment in home.mjs), so poll rather than reading
  // the clipboard synchronously right after the click.
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    // The fixture's own source line is indented 8 spaces — dedentCode strips
    // exactly that shared indentation, leaving no leading whitespace at all.
    .toBe("$order->billingAddress->update([")
})

test('the menu item is absent while multiple rows/methods are selected (rangeCommandsFor)', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.up('Shift')

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('Kopieer deze regel')
})
