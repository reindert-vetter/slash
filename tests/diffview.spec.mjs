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
  // A one-sided (added/removed) block only ever shows one pane, so it renders
  // at the narrow (60%) width by default — the same width the `a` toggle gives
  // every card — and stays narrow regardless of viewMode.
  test('a one-sided (added) block is narrow by default and stays narrow regardless of viewMode', async ({
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
    // Narrow by default — one pane, so the 60% width applies without `a`.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).toHaveClass(/2xl:w-\[49\.2rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'new'
    })
    // `a` on: still one pane, still narrow — no change for a one-sided block.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'split'
    })
    // Flipped back to split: a one-sided block stays narrow regardless.
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
  })

  // Same as above but for a removed block — the other one-sided status, to
  // make sure the narrow-by-default width follows singleSide and not some
  // added-specific path.
  test('a one-sided (removed) block is narrow by default too', async ({
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
    // Narrow by default — one pane.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)

    await page.evaluate(() => {
      window.__removedVm.mode = 'new'
    })
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
  })

  // End-to-end: pressing `a` in the real app flips the visible block's diff
  // between side-by-side and new-only, and `a` again flips it back. Anchored
  // on block 1 of PR 12903 (CreatePaymentAction::execute), which reliably
  // carries a real (two-sided) change — see the data caveat in
  // conventions.md. Block 0 (ContractController::index) sorts first as the
  // sole CONTROLLER (categoryRank in home.mjs) but has no local diff.
  test('`a` toggles the live diff card between side-by-side and new-only', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)

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

  // Regression: toggleDiffView rebuilds every visible pane's HTML (Block.mjs's
  // codeDiff, via .innerHTML), which resets each pane's scrollTop to 0. Without
  // re-centring after the toggle, a change deep inside a long function jumped to
  // the top of the function instead of staying in view. CreatePaymentAction::execute
  // (block 1) is ~60 lines with its one real change on line 67 (well below the
  // fold), so scrollChangeIntoView must have actually scrolled the pane down to
  // reach it — a reliable, non-trivial scrollTop to assert against.
  test('`a` keeps the active change in view instead of jumping to the top', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // step into the diff, lands on the only change

    const anchor = page.locator('[data-change-active]').first()
    await expect(anchor).toBeVisible()

    // scrollChangeIntoView already centred the anchor on entry — confirm the
    // pane actually had to scroll for this fixture (a non-zero baseline), else
    // this test wouldn't tell the top-jump apart from "there was nothing to
    // scroll".
    const scrollTopBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-change-active]')
      return el.closest('[data-scrollsync]').scrollTop
    })
    expect(scrollTopBefore).toBeGreaterThan(0)

    await page.keyboard.press('a')
    // The pane's HTML gets rebuilt (fewer/no old-pane) — re-query after the toggle.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const el = document.querySelector('[data-change-active]')
          return el ? el.closest('[data-scrollsync]').scrollTop : -1
        })
      })
      .toBeGreaterThan(0)

    // Toggling back should also keep it in view, not just the one-shot new-only case.
    await page.keyboard.press('a')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const el = document.querySelector('[data-change-active]')
          return el ? el.closest('[data-scrollsync]').scrollTop : -1
        })
      })
      .toBeGreaterThan(0)
  })
})
