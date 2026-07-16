import { test, expect } from './_fixtures.mjs'

// `a` toggles the global diff-pane view (state.diffViewMode, see
// keyboard-navigation.md "`a` — diff-weergave toggelen") between the default
// side-by-side rendering and a new-only rendering — everywhere a Block() card
// is visible. A genuinely two-sided (modified) block also drops its old pane
// (forcedNewOnly in Block.mjs); an already one-sided (added/removed) block
// keeps its single pane either way. The card WIDTH, however, shrinks to 60%
// for every visible card regardless of singleSide (`narrowed` in Block.mjs) —
// modified, added and removed alike.
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
    const card = page.locator('#view-mode-host article')
    // Split (default): both panes render, full card width.
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/w-\[70rem\]/)
    await expect(card).toHaveClass(/2xl:w-\[82rem\]/)

    // Flip to new-only: only the new/right pane remains, and the card itself
    // shrinks to 60% of its normal width (42rem/49.2rem of 70rem/82rem) —
    // deliberately narrower, not full-width, since a reviewer who hid the old
    // side wants the more compact view.
    await page.evaluate(() => {
      window.__vm.mode = 'new'
    })
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).toHaveClass(/2xl:w-\[49\.2rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)

    // Flip back: side by side again, full width restored.
    await page.evaluate(() => {
      window.__vm.mode = 'split'
    })
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/w-\[70rem\]/)
  })

  // An already one-sided (added) block has no old pane to hide, so the toggle
  // has no effect on its pane count — but the card still shrinks to 60% width
  // like every other visible card, so the layout stays consistent across
  // block types while `a` is on.
  test('viewMode narrows an already one-sided (added) block too, but keeps its single pane', async ({
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
    const card = page.locator('#added-view-mode-host article')
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'new'
    })
    // Still one pane (nothing to drop) — but the card narrows anyway.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).toHaveClass(/2xl:w-\[49\.2rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'split'
    })
    await expect(card).toHaveClass(/w-\[70rem\]/)
  })

  // Same as above but for a removed block — the other one-sided status, to
  // make sure the width follows `narrowed(viewMode)` and not some
  // added-specific path.
  test('viewMode narrows an already one-sided (removed) block too', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::qux',
        status: 'removed',
        file: 'app/Foo.php',
        line: 50,
        name: 'qux',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 50, end: 52, text: 'public function qux(): int {\n    return 3;\n}' },
          new: null,
        },
      })
      const host = document.createElement('div')
      host.id = 'removed-view-mode-host'
      document.body.appendChild(host)
      window.__removedVm = reactive({ mode: 'split' })
      Block(b, { viewMode: () => window.__removedVm.mode })(host)
    })

    const panes = page.locator('#removed-view-mode-host code.language-php')
    const card = page.locator('#removed-view-mode-host article')
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__removedVm.mode = 'new'
    })
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
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

    // The selected card carries the diffActive indigo border while it owns the
    // keyboard (see Block.mjs) — a reliable, unique way to pick it out from the
    // dimmed look-ahead preview card.
    const card = page.locator('article.border-indigo-300')
    const splitBox = await card.boundingBox()

    await page.keyboard.press('a')
    await expect(panes).toHaveCount(1)
    // The card really shrinks on screen (not just a class string) — 60% of the
    // split width, well under a loose 80% sanity bound to absorb rounding/
    // sub-pixel layout without pinning an exact px value.
    await expect
      .poll(async () => {
        const box = await card.boundingBox()
        return box.width
      })
      .toBeLessThan(splitBox.width * 0.8)

    await page.keyboard.press('a')
    await expect(panes).toHaveCount(2)
    await expect
      .poll(async () => {
        const box = await card.boundingBox()
        return box.width
      })
      .toBeCloseTo(splitBox.width, 0)
  })
})
