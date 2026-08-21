import { test, expect, appReady } from './_fixtures.mjs'

// The selected/active diff card grows to fill whatever height its column has
// left, up to the footer (Block.mjs's <article> gets `flex-1` once the block
// is big enough — the same DIFF_FLOOR_MIN_ROWS gate diffFloorCls's own
// min-h-[45vh] floor already used) — reviewer request, screenshot of a
// drilled SessionEnricher::utmValues card whose diff pane only ever got the
// fixed 45vh floor even though its column had plenty of room left below it.
// See "The floor has no ceiling" in .claude/docs/diff-card.md.
//
// Reuses the same fabricated-code fixture shape as
// preview-collapse-when-active-tall.spec.mjs (PR 12903, block index 1).
test.describe('the active diff card grows to fill its column, not just a fixed floor', () => {
  test('a big-enough block (>=20 rows) gets flex-1 on its card', async ({ page }) => {
    await page.route('**/api/code**', async (route) => {
      const url = new URL(route.request().url())
      const name = url.searchParams.get('name')
      if (name === 'execute') {
        const oldLines = Array.from({ length: 60 }, (_, i) => `    $x${i} = ${i};`)
        const newLines = [...oldLines]
        newLines[30] = '    $x30 = 999; // changed'
        await route.fulfill({
          json: {
            file: 'app/Actions/CreatePaymentAction.php',
            old: { start: 1, end: 60, text: oldLines.join('\n') },
            new: { start: 1, end: 60, text: newLines.join('\n') },
          },
        })
        return
      }
      await route.fallback()
    })

    await page.goto('/pr/12903')
    await appReady(page)
    await page.locator('[data-idx="1"]').click()

    const active = page.locator('[data-testid="block-column"] article').nth(0)
    await expect(active.locator('[data-testid="code-diff"]')).toHaveCount(1)

    await expect(active).toHaveClass(/flex-1/)
    expect(await active.evaluate((el) => getComputedStyle(el).flexGrow)).toBe('1')

    // Grows well past the old fixed 45vh floor (≈324px at the default 720px
    // test viewport) — it now claims whatever the column has left.
    const height = await active.evaluate((el) => el.getBoundingClientRect().height)
    expect(height).toBeGreaterThan(450)
  })

  test('a short block (<20 rows) stays compact — no flex-1', async ({ page }) => {
    await page.route('**/api/code**', async (route) => {
      const url = new URL(route.request().url())
      const name = url.searchParams.get('name')
      if (name === 'execute') {
        await route.fulfill({
          json: {
            file: 'app/Actions/CreatePaymentAction.php',
            old: { start: 1, end: 2, text: '    $a = 1;\n    $a = 2;' },
            new: { start: 1, end: 2, text: '    $a = 10;\n    $a = 2;' },
          },
        })
        return
      }
      await route.fallback()
    })

    await page.goto('/pr/12903')
    await appReady(page)
    await page.locator('[data-idx="1"]').click()

    const active = page.locator('[data-testid="block-column"] article').nth(0)
    await expect(active.locator('[data-testid="code-diff"]')).toHaveCount(1)

    await expect(active).not.toHaveClass(/flex-1/)
    expect(await active.evaluate((el) => getComputedStyle(el).flexGrow)).toBe('0')
  })
})
