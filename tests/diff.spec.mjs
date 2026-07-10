import { test, expect } from '@playwright/test'

// Line-aligned diff in the code panes. Block.mjs runs a pure LCS line diff
// (alignRows/diffLines — no AI) so the two sides line up row-for-row: unchanged
// lines share a row, a removed line leaves a blank filler on the right, an added
// line leaves a blank filler on the left, and changed lines are tinted red (old)
// / green (new). We mount a Block with an inline fixture and assert the DOM.
test.describe('PR Review Tree — code diff alignment', () => {
  test('aligns old/new line-by-line with red/green tints and fillers', async ({
    page,
  }) => {
    await page.goto('/')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        name: 'bar',
        class: 'Foo',
        approved: false,
        code: {
          // old: 3 lines, new: 4 lines. Only "}" is shared, so the first lines
          // pair up as change rows and the extra new line becomes a left filler.
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 29,
            text: "public function bar(): ?int {\n    $x = 'hi';\n    return $x;\n}",
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'diff-host'
      document.body.appendChild(host)
      Block(b)(host)
    })

    const panes = page.locator('#diff-host code.language-php')
    await expect(panes).toHaveCount(2)

    // Both sides render the same number of aligned rows so they line up.
    const left = panes.nth(0).locator(':scope > div')
    const right = panes.nth(1).locator(':scope > div')
    await expect(left).toHaveCount(4)
    await expect(right).toHaveCount(4)

    // Old side: two removed lines (red) + one blank filler for the extra new line.
    await expect(panes.nth(0).locator('.bg-rose-100')).toHaveCount(2)
    await expect(panes.nth(0).locator('.bg-slate-50')).toHaveCount(1)

    // New side: three added lines (green), no filler.
    await expect(panes.nth(1).locator('.bg-emerald-100')).toHaveCount(3)
    await expect(panes.nth(1).locator('.bg-slate-50')).toHaveCount(0)

    // The shared closing brace is untinted on both sides (an equal row).
    await expect(panes.nth(0).locator('div:not([class*="bg-"])')).toHaveCount(1)
    await expect(panes.nth(1).locator('div:not([class*="bg-"])')).toHaveCount(1)
  })

  // An added block has no old source, so the card drops the OLD pane and renders
  // just the NEW pane at full width (and the card itself is narrower).
  test('an added block shows only the new pane', async ({ page }) => {
    await page.goto('/')
    // Let the app's own load settle before injecting, so our evaluate's dynamic
    // import doesn't race a client re-render.
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::baz',
        status: 'added',
        file: 'app/Foo.php',
        line: 40,
        name: 'baz',
        class: 'Foo',
        approved: false,
        code: {
          old: null,
          new: { start: 40, end: 42, text: 'public function baz(): int {\n    return 2;\n}' },
        },
      })
      const host = document.createElement('div')
      host.id = 'added-host'
      document.body.appendChild(host)
      Block(b)(host)
    })

    // Only one code pane — the new side.
    const panes = page.locator('#added-host code.language-php')
    await expect(panes).toHaveCount(1)
    await expect(panes.first()).toHaveClass(/language-php/)

    // Its three added lines are green, no fillers (nothing was removed).
    await expect(panes.first().locator('.bg-emerald-100')).toHaveCount(3)
    await expect(panes.first().locator('.bg-slate-50')).toHaveCount(0)

    // The card is the narrow width, not the wide two-pane width.
    const card = page.locator('#added-host article')
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[76rem\]/)
  })
})
