import { test, expect } from './_fixtures.mjs'

// Line-aligned diff in the code panes. Block.mjs runs a pure LCS line diff
// (alignRows/diffLines — no AI) so the two sides line up row-for-row: unchanged
// lines share a row, a removed line leaves a blank filler on the right, an added
// line leaves a blank filler on the left, and changed lines are tinted red (old)
// / green (new). We mount a Block with an inline fixture and assert the DOM.
test.describe('PR Review Tree — code diff alignment', () => {
  test('aligns old/new line-by-line with red/green tints and fillers', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Let the app's initial module load + lazy fetches settle before the in-page
    // evaluate() runs — otherwise its dynamic import races the load and the
    // execution context can be destroyed mid-import ("context destroyed").
    await page.waitForLoadState('networkidle')

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
    // Row tints are hex (rose-100/emerald-100 mixed 20% toward white) — see
    // paneHTML in Block.mjs; #ffe9eb = del, #dafbea = ins.
    await expect(panes.nth(0).locator('div[class*="#ffe9eb"]')).toHaveCount(2)
    await expect(panes.nth(0).locator('.bg-slate-50')).toHaveCount(1)

    // New side: three added lines (green), no filler.
    await expect(panes.nth(1).locator('div[class*="#dafbea"]')).toHaveCount(3)
    await expect(panes.nth(1).locator('.bg-slate-50')).toHaveCount(0)

    // The shared closing brace is untinted on both sides (an equal row).
    await expect(panes.nth(0).locator('div:not([class*="bg-"])')).toHaveCount(1)
    await expect(panes.nth(1).locator('div:not([class*="bg-"])')).toHaveCount(1)
  })

  // An added block has no old source, so the card drops the OLD pane and renders
  // just the NEW pane at full width (and the card itself is narrower).
  test('an added block shows only the new pane', async ({ page }) => {
    await page.goto('/pr/12903')
    // Let the app's own load settle before injecting, so our evaluate's dynamic
    // import doesn't race a client re-render.
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Settle the app's own load before the in-page evaluate() so its dynamic
    // import doesn't race a client re-render / navigation ("context destroyed").
    await page.waitForLoadState('networkidle')

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

    // Its three added lines are green (hex #dafbea = emerald-100 +20% white), no
    // fillers (nothing was removed).
    await expect(panes.first().locator('div[class*="#dafbea"]')).toHaveCount(3)
    await expect(panes.first().locator('.bg-slate-50')).toHaveCount(0)

    // The card is the narrow single-pane width, not the wide two-pane width.
    const card = page.locator('#added-host article')
    await expect(card).toHaveClass(/w-\[38rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
  })

  // Re-indent regression: wrapping an array in array_merge([...]) pushes the
  // inner lines 4 spaces deeper. Those lines are identical in content, so the
  // whitespace-insensitive line diff must pair them and show them as a soft
  // whitespace-only re-alignment — the words ('amount'/'taxes') must never be
  // char-marked, and only the genuinely new structure stays tinted.
  test('re-indented lines are a soft ws hint, not a content change', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Settle the app's own load before the in-page evaluate() so its dynamic
    // import doesn't race a client re-render / navigation ("context destroyed").
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'RESOURCE',
        label: 'ShippingResource::dryRun',
        status: 'modified',
        file: 'app/Http/Resources/ShippingResource.php',
        line: 31,
        name: 'dryRun',
        class: 'ShippingResource',
        approved: false,
        code: {
          old: {
            start: 25,
            end: 32,
            text:
              'public static function dryRun(): array\n' +
              '{\n' +
              '    return [\n' +
              "        'amount'          => 100,\n" +
              "        'amount_with_tax' => 121,\n" +
              "        'taxes'           => [TaxResource::dryRun()],\n" +
              '    ];\n' +
              '}',
          },
          new: {
            start: 31,
            end: 41,
            text:
              'public static function dryRun(): array\n' +
              '{\n' +
              '    return array_merge(\n' +
              '        [\n' +
              "            'amount'          => 100,\n" +
              "            'amount_with_tax' => 121,\n" +
              "            'taxes'           => [TaxResource::dryRun()],\n" +
              '        ],\n' +
              '        AddressInfoResource::dryRun(),\n' +
              '    );\n' +
              '}',
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'reindent-host'
      document.body.appendChild(host)
      Block(b)(host)
    })

    const panes = page.locator('#reindent-host code.language-php')
    await expect(panes).toHaveCount(2)
    const markers = '[class*="bg-emerald-"], [class*="bg-rose-"]'

    // Regression: the unchanged words are never wrapped in a char-diff marker.
    for (const word of ['taxes', 'amount', 'amount_with_tax']) {
      await expect(panes.locator(`span${markers}`, { hasText: word })).toHaveCount(0)
    }

    // Content changes (e.g. the genuinely new `array_merge(...)` structure) get
    // no char-level background either — only the line-level red/green pane tint
    // marks a real change now (see highlightChanges in Block.mjs).
    await expect(
      panes.nth(1).locator('span[class*="bg-emerald-"]', { hasText: 'array_merge' }),
    ).toHaveCount(0)

    // The re-indented 'taxes' row is a whitespace-only re-alignment: no full-line
    // tint (#… hex classes) and not counted as a change for navigation. It still
    // gets its own soft whitespace marker (bg-emerald-200) so the shifted
    // indentation is visible even though the row itself is untinted.
    const taxesRow = panes.nth(1).locator(':scope > div', { hasText: 'taxes' })
    await expect(taxesRow).toHaveCount(1)
    await expect(taxesRow).not.toHaveClass(/bg-\[#/)
    await expect(taxesRow).not.toHaveAttribute('data-changed', '1')
    await expect(taxesRow.locator('span[class*="bg-emerald-200"]')).not.toHaveCount(0)
  })
})
