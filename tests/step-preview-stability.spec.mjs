import { test, expect } from './_fixtures.mjs'

// Regression test for the disappearing look-ahead preview card (and the tab
// hang that followed): stepping ↓ through block 0's changes into the same-file
// block 1 (stepBlock(1)) and then ↑ back, repeatedly, used to corrupt
// arrow.js's keyed reconcile of the block column after 1-2 cycles. Root cause:
// stepChevronSlot was a keyed bare-expression template (html`${...}`) whose
// content toggles (chevron ↔ '') — a chunk's DOM boundary (ref.f/ref.l) is
// only set at hydration, so the toggle left the chunk's ref pointing at
// removed nodes, and the next list reconcile anchored freshly mounted cards
// after a detached node (preview card gone) before locking the tab in an
// infinite reconcile loop on the following keypress. The slot now has a
// stable element root (contents/hidden toggle), so ref stays valid. See the
// "bare single-expression keyed template" pitfall in
// .claude/rules/conventions.md.
//
// PR 12903's blocks 0+1 are same-file (CreatePaymentAction::execute /
// ::findOrCreateCustomer), and block 0 reliably carries a change (see the
// data note in conventions.md), so the ↓/↑ flow-through is exercised for real.
test('look-ahead preview survives repeated down/up same-file block steps', async ({ page }) => {
  test.setTimeout(120000)
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/pr/12903')
  await page.waitForLoadState('networkidle')

  const cards = page.locator('[data-testid="block-column"] article')
  // List mode: selected block 0 + look-ahead preview of block 1.
  await expect(cards).toHaveCount(2)

  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)

  const sel = async () => page.evaluate(() => new URLSearchParams(location.search).get('sel'))
  const startSel = await sel()

  for (let cycle = 0; cycle < 6; cycle++) {
    // ↓ until the selection flows into the next same-file block.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowDown')
      if ((await sel()) !== startSel) break
    }
    expect(await sel(), `cycle ${cycle}: ↓ should flow into block 1`).not.toBe(startSel)
    expect(await cards.count(), `cycle ${cycle} after ↓: both cards present`).toBe(2)

    // ↑ back until we land on block 0 again (on its last change).
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowUp')
      if ((await sel()) === startSel) break
    }
    expect(await sel(), `cycle ${cycle}: ↑ should flow back into block 0`).toBe(startSel)
    // The preview card of block 1 must still sit below the selected card —
    // this is what used to vanish after 1-2 cycles.
    expect(await cards.count(), `cycle ${cycle} after ↑: both cards present`).toBe(2)
    // Back on block 0's last change the step-down chevron cue must be visible
    // again (this is the toggling slot that used to go stale).
    await expect(
      page.locator('[data-testid="step-chevron"][data-dir="down"]'),
      `cycle ${cycle}: step-down chevron visible`,
    ).toBeVisible()
  }

  expect(errors, 'no page errors during the cycles').toEqual([])
})
