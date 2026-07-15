import { test, expect } from './_fixtures.mjs'

// `a` toggles the global diff-pane view (state.diffViewMode, see
// keyboard-navigation.md "`a` — diff-weergave toggelen") between the default
// side-by-side rendering and a new-only, full-width rendering — everywhere a
// Block() card is visible.
test.describe('PR Review Tree — diff view toggle (`a`)', () => {
  // Direct-mount unit test: Block()'s viewMode opt controls whether codeDiff
  // renders both panes or just the new one, for a genuinely two-sided
  // (modified) block.
  test('viewMode="new" collapses a modified block to just the new pane', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
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
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: { start: 26, end: 29, text: 'public function bar(): ?int {\n    return 2;\n}' },
        },
      })
      const host = document.createElement('div')
      host.id = 'view-mode-host'
      document.body.appendChild(host)
      // The viewMode opt must be backed by a reactive read (arrow.js only
      // tracks property reads on a reactive proxy) — a plain global wouldn't
      // trigger a re-render on mutation, unlike state.diffViewMode in home.mjs.
      window.__vm = reactive({ mode: 'split' })
      Block(b, { viewMode: () => window.__vm.mode })(host)
    })

    const panes = page.locator('#view-mode-host code.language-php')
    // Split (default): both panes render.
    await expect(panes).toHaveCount(2)

    // Flip to new-only: only the new/right pane remains, and it takes the full
    // width (same rendering path as an already one-sided added block).
    await page.evaluate(() => {
      window.__vm.mode = 'new'
    })
    await expect(panes).toHaveCount(1)
    const card = page.locator('#view-mode-host article')
    await expect(card).toHaveClass(/w-\[70rem\]/)

    // Flip back: side by side again.
    await page.evaluate(() => {
      window.__vm.mode = 'split'
    })
    await expect(panes).toHaveCount(2)
  })

  // An already one-sided (added) block has no old pane to hide, so the toggle
  // has no effect on it — it stays single-pane either way.
  test('viewMode has no effect on an already one-sided (added) block', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
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
      host.id = 'added-view-mode-host'
      document.body.appendChild(host)
      window.__addedVm = reactive({ mode: 'split' })
      Block(b, { viewMode: () => window.__addedVm.mode })(host)
    })

    const panes = page.locator('#added-view-mode-host code.language-php')
    await expect(panes).toHaveCount(1)

    await page.evaluate(() => {
      window.__addedVm.mode = 'new'
    })
    await expect(panes).toHaveCount(1)
  })

  // End-to-end: pressing `a` in the real app flips the visible block's diff
  // between side-by-side and new-only, and `a` again flips it back. Anchored
  // on block 0 of PR 12903, which reliably carries a real (two-sided) change
  // — see the data caveat in conventions.md.
  test('`a` toggles the live diff card between side-by-side and new-only', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('ArrowRight') // step into the diff
    const diff = page.getByTestId('code-diff').first()
    await expect(diff).toBeVisible()
    const panes = diff.locator('code.language-php')
    await expect(panes).toHaveCount(2)

    await page.keyboard.press('a')
    await expect(panes).toHaveCount(1)

    await page.keyboard.press('a')
    await expect(panes).toHaveCount(2)
  })
})
