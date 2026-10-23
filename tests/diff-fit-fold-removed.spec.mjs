import { test, expect, evaluateSettled, leaveSearchBox, appReady } from './_fixtures.mjs'

// In the single-pane right/new render (fit stand, narrow drilled column) a
// long pure-deletion run used to render as 150 blank filler rows. It now folds
// into one "removed lines" spacer (fillerPlan in Block.mjs); the cursor group
// and a click open it.
test('fit stand folds a long pure-deletion run into one spacer', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await appReady(page)
  await evaluateSettled(page, async () => {
    const { reactive } = await import('/src/vendor/arrow.js')
    const Block = (await import('/src/Block.mjs')).default
    const keep = ['function a() {', '  one();', '  two();', '}']
    const gone = Array.from({ length: 60 }, (_, i) => `  removed${i}();`)
    const b = reactive({
      category: 'OTHER', label: 'x.php', status: 'modified', file: 'x.php', line: 1, approved: false,
      code: {
        old: { start: 1, text: [...keep.slice(0, 3), ...gone, keep[3]].join('\n') },
        new: { start: 1, text: keep.join('\n') },
      },
    })
    window.__fold = reactive({ g: null })
    const host = document.createElement('div')
    host.id = 'fold-host'
    document.body.appendChild(host)
    Block(b, { viewMode: () => 'fit', activeGroup: () => window.__fold.g, diffActive: () => true })(host)
  })
  const host = page.locator('#fold-host')
  await expect(host.locator('[data-testid=collapsed-run]')).toHaveCount(1)
  await expect(host.locator('[data-testid=collapsed-run]')).toHaveText('⋯ 60 verwijderde regels')
  await expect(host.locator('[data-row]')).toHaveCount(4)
  await host.locator('[data-testid=collapsed-run]').dispatchEvent('click')
  await expect(host.locator('[data-testid=collapsed-run]')).toHaveCount(0)
  await expect(host.locator('[data-row]')).toHaveCount(64)
})
