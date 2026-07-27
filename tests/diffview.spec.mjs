import { test, expect } from './_fixtures.mjs'

// `a` cycles the global diff-pane view (state.diffViewMode, see
// keyboard-navigation.md "`a` — diff-weergave toggelen") through THREE stands
// — split → new → fit → split — everywhere a Block() card is visible. A
// genuinely two-sided (modified) block drops its old pane only in 'new'
// (forcedNewOnly in Block.mjs); an already one-sided (added/removed) block
// keeps its single pane in every stand. The card WIDTH: 'new' shrinks every
// visible card to a fixed 60% regardless of singleSide (`narrowed` in
// Block.mjs) — modified, added and removed alike; 'fit' instead sizes the
// card off its own code (`fitWidthCls`), floored at that same 60% width but
// deliberately UNCAPPED upward (a CSS `max(...)`, not `clamp(...)`) — on
// explicit reviewer request, 'fit' must never cut off a genuinely long code
// line behind an invisible horizontal scroll, even if that means growing
// past the full split width. `codeMaxLineChars` (the TRUE longest
// non-comment line) drives this, not `codeGrowthChars`'s 75th-percentile
// (which `relatedColumnWidthCls` still uses, unaffected by this change).
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

    // Flip to 'fit': BOTH panes come back (unlike 'new', 'fit' never forces a
    // single pane — see forcedNewOnly in Block.mjs), but the width class is no
    // longer the fixed 70rem/82rem — it's a CSS max() driven by the code's own
    // (short) content, so it should still sit at (or near) the 60% floor for
    // this tiny fixture.
    await page.evaluate(() => {
      window.__vm.mode = 'fit'
    })
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/max\(42rem/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
    await expect(card).not.toHaveClass(/w-\[42rem\]/) // no longer the fixed 'new' width either

    // Flip back: side by side again, full width restored.
    await page.evaluate(() => {
      window.__vm.mode = 'split'
    })
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/w-\[70rem\]/)
  })

  // Direct-mount unit test: in 'fit', a card with genuinely wide code lines
  // grows past the 60% floor (but never past the full split ceiling) — proof
  // that fitWidthCls actually reacts to the block's own content, not just a
  // fixed clamp() that always resolves to its floor.
  test('viewMode="fit" grows a card with wide code lines past the 60% floor', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // 35 chars total on the line (incl. the 4-space indent) — probed to sit
      // comfortably between the 60% floor and the full split ceiling (see the
      // width assertions below), proving fitWidthCls actually scales with the
      // content instead of just resolving to one of the two extremes.
      const wideLine = 'return $this->fooBarValues($a);'
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::wide',
        status: 'modified',
        file: 'app/Foo.php',
        line: 60,
        name: 'wide',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 60, end: 62, text: 'public function wide(): int {\n    return 1;\n}' },
          new: { start: 60, end: 62, text: `public function wide(): int {\n    ${wideLine}\n}` },
        },
      })
      const host = document.createElement('div')
      host.id = 'fit-wide-host'
      document.body.appendChild(host)
      Block(b, { viewMode: () => 'fit' })(host)
    })

    const card = page.locator('#fit-wide-host article')
    await expect(card).toHaveClass(/max\(42rem/)
    const width = await card.evaluate((el) => el.getBoundingClientRect().width)
    // Comfortably past the 60% floor (42rem = 672px at the default 16px root)
    // for this deliberately widened line, and comfortably under the full
    // split ceiling (70rem = 1120px) — proves fitWidthCls is actually
    // proportional to the content, not just resolving to the floor.
    expect(width).toBeGreaterThan(700)
    expect(width).toBeLessThan(1000)
  })

  // Direct-mount unit test: the OTHER end of the spectrum — a genuinely very
  // wide line now GROWS the card past the full split width instead of being
  // capped there. This is a deliberate reversal (was: "caps ... at the full
  // split width") — on explicit reviewer request, 'fit' must guarantee the
  // single widest real code line is always fully visible (no wrap, no hidden
  // horizontal scroll), even past what 'split' itself would show. See
  // fitWidthCls's doc comment in Block.mjs.
  test('viewMode="fit" grows a card past the full split width for an extremely wide line', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const veryWideLine =
        'return $this->veryLongMethodNameThatDescribesSomethingComplicated($argumentOne, $argumentTwo, $argumentThree);'
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::verywide',
        status: 'modified',
        file: 'app/Foo.php',
        line: 70,
        name: 'verywide',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 70, end: 72, text: 'public function verywide(): int {\n    return 1;\n}' },
          new: { start: 70, end: 72, text: `public function verywide(): int {\n    ${veryWideLine}\n}` },
        },
      })
      const host = document.createElement('div')
      host.id = 'fit-verywide-host'
      document.body.appendChild(host)
      Block(b, { viewMode: () => 'fit' })(host)
    })

    const card = page.locator('#fit-verywide-host article')
    const width = await card.evaluate((el) => el.getBoundingClientRect().width)
    // Genuinely wider than the full split width (70rem = 1120px) — 'fit' no
    // longer caps at 'split's width; the whole point is that the widest real
    // line must never be cut off, even if that means 'fit' > 'split'.
    expect(width).toBeGreaterThan(1120)
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
      window.__addedVm.mode = 'fit'
    })
    // `fit`: still one pane (singleSide wins over the two-pane fit formula —
    // see fitWidthCls), and this fixture's short code lands the max() on
    // (or near) the same 60% floor.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/max\(42rem/)
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

    await page.evaluate(() => {
      window.__removedVm.mode = 'fit'
    })
    // Same single-pane fit formula as the added-block case above (based on the
    // OLD side's text here, since that's the only side a removed block has).
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/max\(42rem/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
  })

  // End-to-end: pressing `a` in the real app cycles the visible block's diff
  // through all three stands — split → new → fit → split. Anchored on block 1
  // of PR 12903 (CreatePaymentAction::execute), which reliably carries a real
  // (two-sided) change — see the data caveat in conventions.md. Block 0
  // (ContractController::index) sorts first as the sole CONTROLLER
  // (categoryRank in home.mjs) but has no local diff.
  test('`a` cycles the live diff card through split → new → fit → split', async ({
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

    await page.keyboard.press('a') // split → new
    await expect(panes).toHaveCount(1)
    // The card really shrinks on screen (not just a class string) — 60% of the
    // split width, well under a loose 80% sanity bound to absorb rounding/
    // sub-pixel layout without pinning an exact px value.
    let newWidth
    await expect
      .poll(async () => {
        const box = await card.boundingBox()
        newWidth = box.width
        return box.width
      })
      .toBeLessThan(splitBox.width * 0.8)

    await page.keyboard.press('a') // new → fit
    // 'fit' brings BOTH panes back (unlike 'new'), sized off the block's own
    // (real, non-trivial) code — at least the 60% floor, but deliberately
    // UNCAPPED upward (no more full-split-width ceiling, see fitWidthCls):
    // this real block (CreatePaymentAction::execute) happens to carry a line
    // wide enough that 'fit' genuinely grows past 'split' itself here, which
    // is exactly the intended behavior (a long line must never be hidden
    // behind an invisible horizontal scroll).
    await expect(panes).toHaveCount(2)
    await expect
      .poll(async () => {
        const box = await card.boundingBox()
        return box.width
      })
      .toBeGreaterThanOrEqual(newWidth - 1)

    await page.keyboard.press('a') // fit → split
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

  // The compact split/new/fit status indicator (Block.mjs's viewModeIndicator)
  // is only rendered on the card that currently owns the diff keyboard
  // (diffActive() — see the "a — cycling the diff view" section in
  // keyboard-navigation.md), shows the active stand highlighted, and a click
  // jumps state.diffViewMode straight to that stand via the setViewMode opt.
  test('the split/new/fit indicator only shows on the focused card, highlights the active stand, and a click jumps to it', async ({
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
      window.__vm = reactive({ mode: 'split', focused: false })
      window.__setViewModeCalls = []
      const host = document.createElement('div')
      host.id = 'view-mode-indicator-host'
      // Sit above the rest of the page (position:fixed z-index), like the
      // app's own overlays — otherwise a fixed-position app element (the
      // sidebar/pr-index) can sit on top of this host in normal flow and
      // intercept the click below.
      host.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:white;'
      document.body.appendChild(host)
      Block(b, {
        viewMode: () => window.__vm.mode,
        diffActive: () => window.__vm.focused,
        setViewMode: (mode) => window.__setViewModeCalls.push(mode),
      })(host)
    })

    const host = page.locator('#view-mode-indicator-host')
    const indicator = host.locator('[data-testid="diffview-indicator"]')

    // Not focused (diffActive() === false, e.g. a preview/look-ahead card):
    // no indicator at all — no empty space reserved either.
    await expect(indicator).toHaveCount(0)

    // Focus this card: the indicator appears, with the current stand ('split')
    // highlighted and the other two not.
    await page.evaluate(() => {
      window.__vm.focused = true
    })
    await expect(indicator).toHaveCount(1)
    const split = host.locator('[data-testid="diffview-split"]')
    const newBtn = host.locator('[data-testid="diffview-new"]')
    const fit = host.locator('[data-testid="diffview-fit"]')
    await expect(split).toHaveClass(/ring-indigo-300/)
    await expect(newBtn).not.toHaveClass(/ring-indigo-300/)
    await expect(fit).not.toHaveClass(/ring-indigo-300/)

    // A click on 'fit' calls setViewMode('fit') — home.mjs's setDiffViewMode
    // then jumps state.diffViewMode straight there (unit-tested here via the
    // opt itself, not the global state).
    await fit.click()
    await expect
      .poll(() => page.evaluate(() => window.__setViewModeCalls))
      .toEqual(['fit'])

    // Once the underlying viewMode actually flips to 'fit' (mirroring what
    // home.mjs's setDiffViewMode would do), the highlight follows it.
    await page.evaluate(() => {
      window.__vm.mode = 'fit'
    })
    await expect(fit).toHaveClass(/ring-indigo-300/)
    await expect(split).not.toHaveClass(/ring-indigo-300/)

    // Losing focus (diffActive() false again, e.g. stepping into a drilled
    // column) hides the indicator again.
    await page.evaluate(() => {
      window.__vm.focused = false
    })
    await expect(indicator).toHaveCount(0)
  })
})
