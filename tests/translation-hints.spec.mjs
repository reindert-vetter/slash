import { test, expect } from './_fixtures.mjs'

// A TRANSLATION block's per-key overview reuses the EXACT SAME green
// out-of-view scroll hint (scrollHint/updateHints, Block.mjs) as an ordinary
// code diff — see the "Translation blocks" section in
// .claude/rules/blocks-and-ingest.md for the data-scrollsync/data-changed/
// data-change-active wiring that makes this work with zero new logic.
// Mirrors tests/hints.spec.mjs's own mount pattern: no fixture PR needed,
// just a synthetic TRANSLATION block mounted directly in a short host div so
// its own key overview actually overflows.
test.describe('PR Review Tree — TRANSLATION block out-of-view scroll hints', () => {
  test('shows a down hint for many changed keys, then an up hint once scrolled to the bottom', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // 30 changed keys — far more than fit in a 160px-tall host.
      const oldLines = []
      const newLines = []
      for (let i = 0; i < 30; i++) {
        oldLines.push(`    'k${i}' => 'old${i}',`)
        newLines.push(`    'k${i}' => 'new${i}',`)
      }
      const old = `<?php\n\nreturn [\n${oldLines.join('\n')}\n];\n`
      const neu = `<?php\n\nreturn [\n${newLines.join('\n')}\n];\n`
      const b = reactive({
        category: 'TRANSLATION',
        label: 'big.php',
        status: 'modified',
        file: 'resources/lang/nl/big.php',
        line: 1,
        name: 'big.php',
        class: '',
        approved: false,
        code: {
          old: { start: 1, end: 32, text: old },
          new: { start: 1, end: 32, text: neu },
        },
      })
      const host = document.createElement('div')
      host.id = 'translation-hint-host'
      host.style.display = 'flex'
      host.style.height = '160px'
      document.body.appendChild(host)
      // Selected + in diff mode (hintsEnabled true) and navigated onto the
      // FIRST key (idx 0) — mirrors home.mjs's activeGroup() shape for a
      // TRANSLATION block (see translationNavUnits/translationSlot).
      Block(b, { hintsEnabled: () => true, activeGroup: () => ({ idx: 0 }) })(host)
    })

    const container = page.locator('#translation-hint-host [data-testid="code-diff"]')
    const overview = container.locator('[data-testid="translation-overview"]')
    const up = container.locator('[data-hint="up"]')
    const down = container.locator('[data-hint="down"]')
    await expect(container).toBeVisible()
    await expect(overview).toHaveAttribute('data-scrollsync', '')
    await expect(overview.locator('[data-testid="translation-row"]')).toHaveCount(30)

    // Reused verbatim: the same green pill, distinguished by chevron SHAPE
    // (not color) — see the colorblind note in keyboard-navigation.md.
    await expect(down.locator('span')).toHaveClass(/bg-emerald-500/)
    await expect(up.locator('span')).toHaveClass(/bg-emerald-500/)

    await page.evaluate(async () => {
      const { updateHints } = await import('/src/Block.mjs')
      updateHints(document.querySelector('#translation-hint-host [data-testid="code-diff"]'))
    })
    // Scrolled to the top (the first key, k0, is active/in view): the last
    // keys are below the fold → down hint on, up hint off.
    await expect(down).toHaveCSS('opacity', '1')
    await expect(up).toHaveCSS('opacity', '0')

    // Scroll the actual scroll container (translation-overview, NOT <main>)
    // to the bottom — a plain manual scroll (trackpad), not a keyboard step.
    await page.evaluate(() => {
      const p = document.querySelector('#translation-hint-host [data-scrollsync]')
      p.scrollTop = p.scrollHeight
      p.dispatchEvent(new Event('scroll'))
    })
    await expect(up).toHaveCSS('opacity', '1')
    await expect(down).toHaveCSS('opacity', '0')
  })

  test('shows no hints when every changed key fits in view', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const old = `<?php\n\nreturn [\n    'foo' => 'oud',\n];\n`
      const neu = `<?php\n\nreturn [\n    'foo' => 'nieuw',\n];\n`
      const b = reactive({
        category: 'TRANSLATION',
        label: 'small.php',
        status: 'modified',
        file: 'resources/lang/nl/small.php',
        line: 1,
        name: 'small.php',
        class: '',
        approved: false,
        code: {
          old: { start: 1, end: 4, text: old },
          new: { start: 1, end: 4, text: neu },
        },
      })
      const host = document.createElement('div')
      host.id = 'translation-hint-host'
      host.style.display = 'flex'
      host.style.height = '400px'
      document.body.appendChild(host)
      Block(b, { hintsEnabled: () => true, activeGroup: () => ({ idx: 0 }) })(host)
      const { updateHints } = await import('/src/Block.mjs')
      updateHints(document.querySelector('#translation-hint-host [data-testid="code-diff"]'))
    })

    const container = page.locator('#translation-hint-host [data-testid="code-diff"]')
    await expect(container).toBeVisible()
    await expect(container.locator('[data-hint="up"]')).toHaveCSS('opacity', '0')
    await expect(container.locator('[data-hint="down"]')).toHaveCSS('opacity', '0')
  })
})
