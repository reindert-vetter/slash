import { test, expect } from './_fixtures.mjs'

// PR 111 (tests/fixtures/translationscroll-blocks.json, worktree materialized
// in tests/_setup.mjs's materializeTranslationScrollWorktrees): a dedicated,
// 20-changed-key lang block — more than fit in the block column's default
// height, so ↑/↓ genuinely walks the highlight out of view. This proves the
// actual fix (not just the chevron, see tests/translation-hints.spec.mjs):
// home.mjs's EXISTING scrollChangeIntoView now finds the active key row
// (data-change-active, added to translationBlockView) and brings it back
// into view within translation-overview's own scrollport — see the
// "Translation blocks" section in .claude/docs/blocks-and-ingest.md.
async function enterDiffAndSettle(page) {
  await expect(page.getByTestId('translation-row').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-testid="detail-card"] article').first()).toHaveClass(/border-indigo-300/)
}

test.describe('TRANSLATION block — per-key scroll-into-view + out-of-view hint', () => {
  test('↑/↓ auto-scrolls the active key back into view and toggles the green hint', async ({
    page,
  }) => {
    await page.goto('/pr/111?sel=' + encodeURIComponent('resources/lang/nl/big.php:1'))
    await enterDiffAndSettle(page)

    const rows = page.getByTestId('translation-row')
    await expect(rows).toHaveCount(20)

    const pane = page.locator('[data-testid="translation-overview"]')
    await expect(pane).toHaveAttribute('data-scrollsync', '')
    const container = page.locator('[data-testid="detail-card"] [data-testid="code-diff"]').first()
    const down = container.locator('[data-hint="down"]')
    const up = container.locator('[data-hint="up"]')

    // Confirm this fixture actually overflows (otherwise the rest of the test
    // would trivially pass without exercising anything).
    const overflowsInitially = await pane.evaluate((el) => el.scrollHeight > el.clientHeight)
    expect(overflowsInitially).toBe(true)

    // At the first key, scrollTop is 0 and — since there's more below — the
    // down hint shows, the up hint doesn't.
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0)
    await expect(down).toHaveCSS('opacity', '1')
    await expect(up).toHaveCSS('opacity', '0')

    // Walk all the way to the LAST key (19 ArrowDowns from the first).
    for (let i = 0; i < 19; i++) {
      await page.keyboard.press('ArrowDown')
    }
    await expect(rows.nth(19)).toHaveAttribute('data-active', '1')
    // scrollChangeIntoView animates the scroll (SCROLL_MS glide) and settles
    // it again 220ms after the last call (home.mjs) — give that time to
    // finish before measuring geometry, same convention as
    // tests/scroll-focus-vertical-only.spec.mjs.
    await page.waitForTimeout(500)

    // The core fix: the active row is actually back in the pane's own
    // visible box — not just "selected" while scrolled 4000px out of view.
    const paneBox = await pane.boundingBox()
    const rowBox = await rows.nth(19).boundingBox()
    expect(rowBox.y).toBeGreaterThanOrEqual(paneBox.y - 1)
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1)
    // And that only happened because translation-overview itself actually
    // scrolled (the fix reuses ITS OWN scrollTop, not <main>'s).
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

    // Nothing left below the last key → down hint off; the earlier keys are
    // now above the fold → up hint on.
    await expect(down).toHaveCSS('opacity', '0')
    await expect(up).toHaveCSS('opacity', '1')

    // Walking back up brings the first key back into view and flips the
    // hints back.
    for (let i = 0; i < 19; i++) {
      await page.keyboard.press('ArrowUp')
    }
    await expect(rows.nth(0)).toHaveAttribute('data-active', '1')
    await page.waitForTimeout(500)
    const firstRowBox = await rows.nth(0).boundingBox()
    const paneBoxAgain = await pane.boundingBox()
    expect(firstRowBox.y).toBeGreaterThanOrEqual(paneBoxAgain.y - 1)
    expect(firstRowBox.y + firstRowBox.height).toBeLessThanOrEqual(paneBoxAgain.y + paneBoxAgain.height + 1)
    await expect(down).toHaveCSS('opacity', '1')
    await expect(up).toHaveCSS('opacity', '0')
  })
})
