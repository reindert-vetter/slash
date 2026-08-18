import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// `a` cycles the global diff-pane view (state.diffViewMode, see
// keyboard-navigation.md "`a` — diff-weergave toggelen") through THREE stands
// — split → unified → fit → split — everywhere a Block() card is visible. A
// genuinely two-sided (modified) block collapses to a single "old (-) above
// new (+)" column only in 'unified' (unifiedCodeDiff in Block.mjs); 'fit'
// instead HIDES the old pane entirely — on explicit reviewer request, a
// two-sided block shows only its new/right pane in 'fit', exactly like an
// already one-sided ADDED block (`fitOnly` in Block.mjs). The one deliberate
// exception: a REMOVED block has no new side to prefer, so it keeps showing
// its old/left pane in 'fit' too (there is nothing else to show). This keeps
// the three stands functionally distinct: `'unified'` is the only stand that
// still shows old code (stacked instead of side-by-side); `'fit'` is the only
// stand with a content-driven width. The card WIDTH: 'unified' shrinks every
// visible card to a fixed 60% regardless of singleSide (`narrowed` in
// Block.mjs) — modified, added and removed alike; 'fit' instead sizes the
// card off the one pane it actually shows (`fitWidthCls`), floored at that
// same 60% width but deliberately UNCAPPED upward (a CSS `max(...)`, not
// `clamp(...)`) — on explicit reviewer request, 'fit' must never cut off a
// genuinely long code line behind an invisible horizontal scroll, even if
// that means growing past the full split width. `codeMaxLineChars` (the TRUE
// longest non-comment line) drives this, not `codeGrowthChars`'s
// 75th-percentile (which `relatedColumnWidthCls` still uses, unaffected by
// this change).
test.describe('PR Review Tree — diff view toggle (`a`)', () => {
  // Direct-mount unit test: Block()'s viewMode opt controls whether codeDiff
  // renders a side-by-side split, or collapses a genuinely two-sided
  // (modified) block into ONE column with the old (-) line directly above
  // the new (+) line (unifiedCodeDiff).
  test('viewMode="unified" collapses a modified block to one old-above-new column', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
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
    // Split (default): both panes render. The card width is content-driven
    // (not a fixed tier) — for this tiny fixture (canonical 29 chars, well
    // under the 80-char floor) the combined 'split' total (min(80,29)+29=58)
    // still floors to the flat 80-character minimum, same as before.
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    // Flip to unified: a single column remains — both the old (-) and the
    // new (+) line of the changed row, stacked instead of side by side. The
    // width class is unaffected by the switch (still content-driven, same
    // floor for this fixture) — only the pane STRUCTURE changed.
    await page.evaluate(() => {
      window.__vm.mode = 'unified'
    })
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)
    // The unified column really shows BOTH a "-" (old, rose) and a "+" (new,
    // emerald) gutter line for each of the two changed rows (the return
    // type and the return value) — proof it's a stacked old-above-new
    // rendering, not the old new-only pane that hid the old side entirely.
    await expect(panes.first().locator('span.text-rose-500')).toHaveCount(2)
    await expect(panes.first().locator('span.text-emerald-500')).toHaveCount(2)

    // Flip to 'fit': old code disappears entirely — only the new/right pane
    // remains (unlike 'unified', which still shows old, just stacked). The
    // width class stays the same content-driven floor for this tiny fixture.
    await page.evaluate(() => {
      window.__vm.mode = 'fit'
    })
    await expect(panes).toHaveCount(1)
    await expect(card.locator('[data-pane="old"]')).toHaveCount(0)
    await expect(card.locator('[data-pane="new"]')).toHaveCount(1)
    // The old code text is genuinely gone, not just visually hidden — the
    // whole point of the request ("the 3rd option must not show old code").
    await expect(panes.first()).not.toContainText('return 1;')
    await expect(panes.first()).toContainText('return 2;')
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    // Flip back: side by side again, same content-driven width.
    await page.evaluate(() => {
      window.__vm.mode = 'split'
    })
    await expect(panes).toHaveCount(2)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)
  })

  // Direct-mount unit test: in 'fit', a card with a genuinely wide NEW-side
  // code line grows past the 80-character floor — proof that contentWidthCls
  // actually reacts to the (single, new) pane's own content, not just a
  // fixed value that always resolves to its floor. This block is genuinely
  // two-sided (modified) — the OLD side stays short on purpose, so this also
  // proves the width is no longer based on Math.max(old, new) doubled: only
  // the visible new pane's content counts.
  test('viewMode="fit" grows a card with a wide new-side code line past the 80-char floor', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // A short-line fixture to measure the actual floor width against
      // (font-metric independent), and a wide-line one, well past 80
      // characters, to measure the content-driven growth.
      const shortB = reactive({
        category: 'ACTION',
        label: 'Foo::short',
        status: 'modified',
        file: 'app/Foo.php',
        line: 50,
        name: 'short',
        class: 'Foo',
        approved: false,
        code: {
          old: { start: 50, end: 52, text: 'public function short(): int {\n    return 1;\n}' },
          new: { start: 50, end: 52, text: 'public function short(): int {\n    return 2;\n}' },
        },
      })
      // Deliberately past 80 characters (the flat floor) once the 4-space
      // indent is added, so this genuinely exercises the growth path.
      const wideLine =
        'return $this->fooBarValuesFromRequestPayloadDataForTheWideLineFixture($a, $b, $c, $d, $e, $f);'
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
      const floorHost = document.createElement('div')
      floorHost.id = 'fit-floor-host'
      document.body.appendChild(floorHost)
      Block(shortB, { viewMode: () => 'fit' })(floorHost)

      const host = document.createElement('div')
      host.id = 'fit-wide-host'
      document.body.appendChild(host)
      Block(b, { viewMode: () => 'fit' })(host)
    })

    const card = page.locator('#fit-wide-host article')
    await expect(card).toHaveClass(/w-\[calc\(\d+ch_\+_2rem\)\]/)
    const floorWidth = await page
      .locator('#fit-floor-host article')
      .evaluate((el) => el.getBoundingClientRect().width)
    const width = await card.evaluate((el) => el.getBoundingClientRect().width)
    // Comfortably past the 80-character floor for this deliberately widened
    // line, and comfortably under the extreme-length test's own threshold
    // (>1120px, see the next test) — proves contentWidthCls is actually
    // proportional to the content, not just resolving to the floor.
    expect(width).toBeGreaterThan(floorWidth + 10)
    expect(width).toBeLessThan(1120)
  })

  // Direct-mount unit test: the OTHER end of the spectrum — a genuinely very
  // wide NEW-side line now GROWS the card past the full split width instead
  // of being capped there. This is a deliberate reversal (was: "caps ... at
  // the full split width") — on explicit reviewer request, 'fit' must
  // guarantee the single widest real code line is always fully visible (no
  // wrap, no hidden horizontal scroll), even past what 'split' itself would
  // show. See fitWidthCls's doc comment in Block.mjs. Same single-pane
  // basis as the previous test — this line only needs to be longer here
  // because a single (not doubled) pane needs more characters to reach the
  // same pixel width.
  test('viewMode="fit" grows a card past the full split width for an extremely wide line', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const veryWideLine =
        'return $this->veryLongMethodNameThatDescribesSomethingComplicated' +
        '($argumentOne, $argumentTwo, $argumentThree, $argumentFour, $argumentFive);'
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

  // Direct-mount unit test: the card now sizes off a WINDOW around the
  // currently selected unit — the up to 2 changed rows directly above it,
  // the unit itself, and the up to 2 changed rows directly below
  // (selectionWindowLineChars, Block.mjs) — not the block's true longest
  // line wherever it happens to sit. Fixture: 5 short changed lines and one
  // genuinely long one, with the long line MORE than 2 changed rows away
  // from the selected line, so the window excludes it.
  test('a selection only follows the 2 neighboring changed rows on each side, not the whole block', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    // Mounted via evaluateSettled (like every other test here); the width is
    // measured in a SEPARATE step below (locator.evaluate, not inside this
    // same evaluate) so Tailwind Play CDN's async JIT has actually injected
    // CSS for these freshly-computed arbitrary-value classes before we read
    // getBoundingClientRect() — measuring synchronously in the same evaluate
    // call races that injection and reads the pre-Tailwind (unstyled, full
    // width) box.
    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const short = (n) => `$a${n} = ${n};`
      const longLine =
        'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLongerThanTheSelectedLine' +
        '($a, $b, $c, $d, $e, $f, $g, $h);'
      const makeBlock = () =>
        reactive({
          category: 'ACTION',
          label: 'Cart::applyPromotion',
          status: 'modified',
          file: 'app/Cart.php',
          line: 338,
          name: 'applyPromotion',
          class: 'Cart',
          approved: false,
          code: {
            old: { start: 338, end: 346, text: 'public function applyPromotion(): void {\n    return;\n}' },
            new: {
              start: 338,
              end: 346,
              // Row 0: signature (context, unchanged). Rows 1-2: two short
              // changed neighbors before the selection. Row 3: the SELECTED
              // short line. Rows 4-5: two short changed neighbors after.
              // Row 6: the long line — 3 changed rows after the selection,
              // outside the ±2 window.
              text:
                `public function applyPromotion(): void {\n` +
                `    ${short(1)}\n    ${short(2)}\n    ${short(3)}\n` +
                `    ${short(4)}\n    ${short(5)}\n    ${longLine}\n}`,
            },
          },
        })

      const wholeBlockHost = document.createElement('div')
      wholeBlockHost.id = 'fit-selected-line-whole-host'
      document.body.appendChild(wholeBlockHost)
      Block(makeBlock(), { viewMode: () => 'fit' })(wholeBlockHost)

      const selectedLineHost = document.createElement('div')
      selectedLineHost.id = 'fit-selected-line-narrow-host'
      document.body.appendChild(selectedLineHost)
      // Row 3 is the selected short line (see the row layout above).
      Block(makeBlock(), { viewMode: () => 'fit', activeGroup: () => ({ start: 3, end: 3 }) })(selectedLineHost)
    })

    const wholeBlockWidth = await page
      .locator('#fit-selected-line-whole-host article')
      .evaluate((el) => el.getBoundingClientRect().width)
    const selectedLineWidth = await page
      .locator('#fit-selected-line-narrow-host article')
      .evaluate((el) => el.getBoundingClientRect().width)

    // Without an active unit the card still follows the block's true longest
    // line (unchanged existing behavior) — comfortably past the 80-char floor.
    expect(wholeBlockWidth).toBeGreaterThan(1000)
    // With the short line selected, the long line sits outside the ±2
    // changed-row window, so the card shrinks back down near the flat
    // 80-character floor — nowhere near the long line's own width.
    expect(selectedLineWidth).toBeLessThan(wholeBlockWidth - 200)
  })

  // Direct-mount unit test: a cursor row deep inside a multi-row old-side-only
  // deletion run (see "de rij zelf niet meetbaar, en de directe buur ook
  // niet" in diff-card.md) must floor to MIN_CONTENT_WIDTH_CHARS, never to
  // the block's true global longest line. Two earlier, rejected behaviors
  // both failed this: (1) "reach for the nearest measurable changed row,
  // however far away" grabbed a long unrelated line and ballooned a single
  // step's width; (2) fixing that with strict adjacency but still falling
  // back to the whole-block max on "nothing measurable" turned that single
  // spike into a multi-row spike (every row inside the deletion run has no
  // measurable adjacent neighbor either).
  test('a cursor deep inside an old-side-only deletion run floors, never balloons to the block max', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const longLine =
        'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLongerThanTheSelectedLine' +
        '($a, $b, $c, $d, $e, $f, $g, $h);'
      const makeBlock = () =>
        reactive({
          category: 'ACTION',
          label: 'Cart::applyPromotion',
          status: 'modified',
          file: 'app/Cart.php',
          line: 338,
          name: 'applyPromotion',
          class: 'Cart',
          approved: false,
          code: {
            // Row 0: signature (context). Row 1: a short changed line,
            // measurable on the new/right side. Rows 2-4: a 3-row-deep
            // old-side-only deletion run (present in old, absent from new) —
            // row 3 is the SELECTED middle row, with no measurable neighbor
            // directly adjacent on either side (rows 2 and 4 are themselves
            // unmeasurable deletion rows). Row 5: the block's true longest
            // line, UNCHANGED (identical old/new) so it drives the
            // no-active-unit fallback but is never itself a "neighbor".
            old: {
              start: 338,
              end: 348,
              text:
                `public function applyPromotion(): void {
` +
                `    $a1 = 1;
    $old1 = 1;
    $old2 = 2;
    $old3 = 3;
` +
                `    ${longLine}
}`,
            },
            new: {
              start: 338,
              end: 348,
              text: `public function applyPromotion(): void {
    $b1 = 1;
    ${longLine}
}`,
            },
          },
        })

      const noUnitHost = document.createElement('div')
      noUnitHost.id = 'fit-deletion-run-no-unit-host'
      document.body.appendChild(noUnitHost)
      Block(makeBlock(), { viewMode: () => 'fit' })(noUnitHost)

      const midDeletionHost = document.createElement('div')
      midDeletionHost.id = 'fit-deletion-run-mid-host'
      document.body.appendChild(midDeletionHost)
      // Row 3 is the middle deletion row (old1/old2/old3 sit at rows 2/3/4).
      Block(makeBlock(), { viewMode: () => 'fit', activeGroup: () => ({ start: 3, end: 3 }) })(midDeletionHost)
    })

    const noUnitWidth = await page
      .locator('#fit-deletion-run-no-unit-host article')
      .evaluate((el) => el.getBoundingClientRect().width)
    const midDeletionWidth = await page
      .locator('#fit-deletion-run-mid-host article')
      .evaluate((el) => el.getBoundingClientRect().width)

    // Without an active unit the card still follows the block's true longest
    // (unchanged) line — comfortably past the 80-char floor.
    expect(noUnitWidth).toBeGreaterThan(1000)
    // With the middle deletion row selected, nothing measurable is directly
    // adjacent, so the card floors down near MIN_CONTENT_WIDTH_CHARS — far
    // below the global max, not equal to it.
    expect(midDeletionWidth).toBeLessThan(noUnitWidth - 400)
  })

  // Direct-mount unit test: the look-ahead preview's 'fit'-stand cap
  // (fitCapCharsFor/capFitChars, Block.mjs — see "The look-ahead preview must
  // never be wider than the active card" in diff-card.md). Two genuinely
  // two-sided (modified) PHP blocks, mounted side by side: the "preview" has
  // a much longer new-side line than the "active" one — without a cap it
  // would render wider than the active card, exactly the reported bug
  // (a `modified` ContractsExport::headings preview wider than the
  // `modified` ContractsExport::map active card in 'fit'). Passing
  // `capFitChars: () => fitCapCharsFor(active)` must clamp the preview back
  // down to the active card's own width.
  test('viewMode="fit" caps a look-ahead preview at the active card\'s own width', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    const widths = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const { default: Block, fitCapCharsFor } = await import('/src/Block.mjs')
      const makeBlock = (name, line, newLine) =>
        reactive({
          category: 'ACTION',
          label: 'Foo::' + name,
          status: 'modified',
          file: 'app/Foo.php',
          line,
          name,
          class: 'Foo',
          approved: false,
          code: {
            old: { start: line, end: line + 2, text: `public function ${name}(): int {\n    return 1;\n}` },
            new: {
              start: line,
              end: line + 2,
              text: `public function ${name}(): int {\n    ${newLine}\n}`,
            },
          },
        })
      const active = makeBlock('map', 60, 'return $short;')
      const preview = makeBlock(
        'headings',
        70,
        'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLonger($a, $b, $c, $d, $e, $f, $g, $h);',
      )

      const activeHost = document.createElement('div')
      activeHost.id = 'fit-cap-active-host'
      document.body.appendChild(activeHost)
      Block(active, { viewMode: () => 'fit' })(activeHost)

      const previewHost = document.createElement('div')
      previewHost.id = 'fit-cap-preview-host'
      document.body.appendChild(previewHost)
      Block(preview, {
        viewMode: () => 'fit',
        preview: true,
        capFitChars: () => fitCapCharsFor(active),
      })(previewHost)

      const activeCard = activeHost.querySelector('article')
      const previewCard = previewHost.querySelector('article')
      return {
        activeWidth: activeCard.getBoundingClientRect().width,
        previewWidth: previewCard.getBoundingClientRect().width,
      }
    })

    // The capped preview must never be wider than the active card next to it.
    expect(widths.previewWidth).toBeLessThanOrEqual(widths.activeWidth + 1)
  })

  // Direct-mount unit test: a NON-PHP file (e.g. a markdown/config file) does
  // NOT get the uncapped, max-line-based 'fit' width above — it stays at the
  // same narrow 60% width a one-sided block already uses in every other
  // stand (boundedWrapWidthCls in Block.mjs) and instead wraps the long line
  // within that width, so an isolated long prose/config line can never
  // balloon the card the way it can for PHP. Like every other block in
  // 'fit', this genuinely two-sided (modified) block also shows only its
  // new/right pane — old code is gone, not just visually hidden — so there's
  // only ONE (wrapping) pane to size/align, not the old two-pane
  // row-alignment mechanism. See isPhpFile/fitWidthCls's doc comment.
  test('viewMode="fit" bounds a non-PHP file at the narrow width, hides old code, and wraps its long line', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // A single, deliberately very long prose line (well past the narrow
      // 60% width) — the markdown-bullet case reported in practice.
      const longLine =
        '- Structure every test body as `// Given` / `// When` / `// Then`. Separate the phases with a **blank line above each `// When` and `// Then` marker** whenever a previous phase precedes it. This keeps the three phases visually separated and readable at a glance.'
      const b = reactive({
        category: 'OTHER',
        label: 'notes.md',
        status: 'modified',
        file: 'docs/notes.md',
        line: 1,
        name: 'notes.md',
        class: '',
        approved: false,
        code: {
          old: { start: 1, end: 3, text: '# Notes\nOld short line.\n' },
          new: { start: 1, end: 4, text: `# Notes\nNew short line.\n${longLine}\n` },
        },
      })
      const host = document.createElement('div')
      host.id = 'fit-nonphp-host'
      document.body.appendChild(host)
      Block(b, { viewMode: () => 'fit' })(host)
    })

    const card = page.locator('#fit-nonphp-host article')
    // Bounded at the narrow (60%) width — NOT a content-based max()/clamp()
    // formula (unlike the PHP case above).
    await expect(card).toHaveClass(/w-\[42rem\]/)
    await expect(card).toHaveClass(/2xl:w-\[49\.2rem\]/)
    await expect(card).not.toHaveClass(/w-\[70rem\]/)
    await expect(card).not.toHaveClass(/max\(/)
    await expect(card).not.toHaveClass(/clamp\(/)
    const width = await card.evaluate((el) => el.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(672 + 1)

    // Only the single new pane renders — old code is gone entirely.
    const panes = card.locator('code.language-php')
    await expect(panes).toHaveCount(1)
    await expect(card.locator('[data-pane="old"]')).toHaveCount(0)
    await expect(card.locator('[data-pane="new"]')).toHaveCount(1)
    await expect(panes.first()).not.toContainText('Old short line')
    await expect(panes.first()).toContainText('New short line')

    // The long line's row wraps (whitespace-pre-wrap) instead of overflowing
    // horizontally — no hidden content behind an invisible scroll.
    const pane = card.locator('[data-scrollsync]').first()
    const overflow = await pane.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

    // The wrapped row is genuinely taller than a normal single line (~20px
    // at this font/line-height) — proves it actually wrapped onto multiple
    // visual lines instead of staying on one, clipped line.
    const rowHeights = await card.evaluate((el) =>
      Array.from(el.querySelectorAll('[data-row]')).map(
        (row) => row.getBoundingClientRect().height,
      ),
    )
    expect(Math.max(...rowHeights)).toBeGreaterThan(30)
  })

  // An already one-sided (added) block has no old pane to hide, so the toggle
  // A one-sided (added/removed) block only ever shows one pane, so it renders
  // at the narrow (60%) width by default — the same width the `a` toggle gives
  // every card — and stays narrow regardless of viewMode.
  test('a one-sided (added) block is narrow by default and stays narrow regardless of viewMode', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
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
    // Narrow by default — one pane, content-driven width lands on the flat
    // 80-character floor for this short fixture, in every stand.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'unified'
    })
    // `a` on: still one pane, still narrow — no change for a one-sided block.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'fit'
    })
    // `fit`: still one pane (singleSide wins over the two-pane fit formula —
    // see contentWidthCls), and this fixture's short code lands on the same
    // flat 80-character floor.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    await page.evaluate(() => {
      window.__addedVm.mode = 'split'
    })
    // Flipped back to split: a one-sided block stays narrow regardless.
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)
  })

  // Same as above but for a removed block — the other one-sided status, to
  // make sure the narrow-by-default width follows singleSide and not some
  // added-specific path.
  test('a one-sided (removed) block is narrow by default too', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
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
    // Narrow by default — one pane, content-driven width lands on the flat
    // 80-character floor for this short fixture.
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    await page.evaluate(() => {
      window.__removedVm.mode = 'unified'
    })
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    await page.evaluate(() => {
      window.__removedVm.mode = 'fit'
    })
    // Same single-pane formula as the added-block case above (based on the
    // OLD side's text here, since that's the only side a removed block has).
    // This is the deliberate scope EXCEPTION to "'fit' hides old code": a
    // removed block has no new side to prefer, so its old/left pane keeps
    // showing here too — hiding it would leave nothing to review (fitOnly in
    // Block.mjs falls back to singleSide(b) first).
    await expect(panes).toHaveCount(1)
    await expect(card).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)
  })

  // End-to-end: pressing `a` in the real app cycles the visible block's diff
  // through all three stands — split → unified → fit → split — and the pane
  // STRUCTURE changes each time, but the card WIDTH no longer does: every
  // stand is content-driven off the same selection window
  // (selectionWindowLineChars, Block.mjs) regardless of viewMode, on
  // explicit reviewer request (the old fixed 60%/full-split tiers are gone).
  // Anchored on block 1 of PR 12903 (CreatePaymentAction::execute), which
  // reliably carries a real (two-sided) change — see the data caveat in
  // conventions.md. Block 0 (ContractController::index) sorts first as the
  // sole CONTROLLER (categoryRank in home.mjs) but has no local diff.
  test('`a` cycles the live diff card through split → unified → fit → split', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('ArrowRight') // step into the diff
    const diff = page.getByTestId('code-diff').first()
    await expect(diff).toBeVisible()
    // Block 1's own single (one-row) change group auto-jumps the initial
    // stand to 'unified' once its code arrives (home.mjs's
    // allChangesAreSingleLine watch) — wait for the code to actually render
    // (so the auto-jump has already fired) before forcing 'split' back, or
    // the click races the async code fetch and gets silently overridden the
    // moment it resolves. This is what makes the cycle below genuinely start
    // at 'split', as its own name says.
    await expect(diff.locator('code.language-php').first()).toBeVisible()
    await page.getByTestId('diffview-split').click()
    const panes = diff.locator('code.language-php')
    await expect(panes).toHaveCount(2)

    // The selected card carries the diffActive indigo border while it owns the
    // keyboard (see Block.mjs) — a reliable, unique way to pick it out from the
    // dimmed look-ahead preview card.
    const card = page.locator('article.border-indigo-300')
    const splitBox = await card.boundingBox()

    await page.keyboard.press('a') // split → unified
    await expect(panes).toHaveCount(1)
    // The pane structure changed (one stacked column instead of two). Since
    // 2026-08-18, 'split' no longer shares one width formula with
    // 'unified'/'fit': the non-canonical (old/left) pane in 'split' stays
    // fixed at the floor instead of following its own content, so 'split'
    // is generally WIDER than 'unified'/'fit' for a two-sided block whose
    // canonical side has any real content (see contentWidthCls's own doc
    // comment) — capture 'unified's own width instead of comparing it to
    // the 'split' baseline.
    const unifiedBox = await card.boundingBox()

    await page.keyboard.press('a') // unified → fit
    // 'fit' shows only the NEW pane (old code is hidden, unlike 'unified'
    // which still shows it stacked) — 'fit' and 'unified' still share the
    // same canonical-side-only formula (unaffected by the 'split' change
    // above), so their widths stay equal to each other.
    await expect(panes).toHaveCount(1)
    await expect(diff.locator('[data-pane="old"]')).toHaveCount(0)
    await expect
      .poll(async () => {
        const box = await card.boundingBox()
        return box.width
      })
      .toBeCloseTo(unifiedBox.width, 0)

    await page.keyboard.press('a') // fit → split
    await expect(panes).toHaveCount(2)
    // Round-tripping back to 'split' reproduces the SAME width it started
    // at — deterministic given the same block/selection, even though it no
    // longer matches 'unified'/'fit's width.
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
    // The pane's HTML gets rebuilt (restructured into one unified column) —
    // re-query after the toggle.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const el = document.querySelector('[data-change-active]')
          return el ? el.closest('[data-scrollsync]').scrollTop : -1
        })
      })
      .toBeGreaterThan(0)

    // Toggling back should also keep it in view, not just the one-shot unified case.
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

  // The compact split/unified/fit status indicator (Block.mjs's
  // viewModeIndicator) is only rendered on the card that currently owns the
  // diff keyboard (diffActive() — see the "a — cycling the diff view"
  // section in keyboard-navigation.md), shows the active stand highlighted,
  // and a click jumps state.diffViewMode straight to that stand via the
  // setViewMode opt.
  test('the split/unified/fit indicator only shows on the focused card, highlights the active stand, and a click jumps to it', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
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
    const unifiedBtn = host.locator('[data-testid="diffview-unified"]')
    const fit = host.locator('[data-testid="diffview-fit"]')
    await expect(split).toHaveClass(/ring-indigo-300/)
    await expect(unifiedBtn).not.toHaveClass(/ring-indigo-300/)
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

  // Direct-mount unit test: a genuinely two-sided (modified) block's
  // 'unified' stand stacks old (-) above new (+) in ONE column — the width
  // must therefore account for BOTH sides, not just the canonical new/right
  // one. Reported bug: a selected group whose OLD side carries a much
  // longer line than its NEW side ran off the right edge of a 'unified'
  // card, because only the (short) new/right side drove the width.
  test('viewMode="unified" sizes the card off whichever side is wider, not just the new/right one', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const longOld =
        "$oldLongLine = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';"
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::oldwide',
        status: 'modified',
        file: 'app/Foo.php',
        line: 80,
        name: 'oldwide',
        class: 'Foo',
        approved: false,
        code: {
          // Row 0: signature (context). Row 1: the OLD-only long line (no
          // new counterpart). Row 2: a short changed line on both sides.
          // The two changed rows form one contiguous group.
          old: {
            start: 80,
            end: 84,
            text: 'public function oldwide(): void {\n    ' + longOld + '\n    return 1;\n}',
          },
          new: {
            start: 80,
            end: 82,
            text: 'public function oldwide(): void {\n    return 2;\n}',
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'unified-old-wide-host'
      document.body.appendChild(host)
      Block(b, { viewMode: () => 'unified', activeGroup: () => ({ start: 1, end: 2 }) })(host)
    })

    const card = page.locator('#unified-old-wide-host article')
    const cls = await card.getAttribute('class')
    const match = /w-\[calc\((\d+)ch_\+_2rem\)\]/.exec(cls)
    // The old-only line is ~100 characters — comfortably past the short
    // new/right side's own content and past the 80-char floor, proving the
    // old side was actually measured for 'unified'.
    expect(Number(match[1])).toBeGreaterThan(90)
  })

  // Direct-mount unit test: since 2026-08-18, 'split' no longer measures the
  // non-canonical (old/left) pane's own content at all — it stays fixed at
  // the floor (MIN_CONTENT_WIDTH_CHARS) regardless — and the neighbor
  // extension PAST the selection's own boundary is gone entirely, on EITHER
  // side, not just the non-canonical one (reviewer decision: "kijk niet naar
  // omliggende rijen, maar alleen naar de huidige geselecteerde regel/groep/
  // call"). So a long line directly adjacent to (but not part of) the
  // selected unit must not inflate the card's width, even on the CANONICAL
  // (new/right) side, which used to keep the neighbor reach.
  test('viewMode="split" fixes the non-canonical pane at the floor and never reaches a neighbor past the selection', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // Row 1's own new-side text is a deliberate 81 characters — just past
      // MIN_CONTENT_WIDTH_CHARS (80) so its OWN measurement is distinguishable
      // from the floor, unlike a short line which the floor would mask either
      // way. The neighbor is deliberately much longer (126) so picking it up
      // would be unmistakable.
      const selectedNewLine =
        '    $b1 = 1234567890123456789012345678901234567890123456789012345678901234567890;'
      const longNewNeighbor =
        "    $newNeighborLongLine = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';"
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::baz',
        status: 'modified',
        file: 'app/Foo.php',
        line: 90,
        name: 'baz',
        class: 'Foo',
        approved: false,
        code: {
          // Row 0: signature (context). Row 1: the SELECTED changed line
          // (its own new-side text is 81 chars). Row 2: a new-only (added)
          // 126-char line — a directly-adjacent NEIGHBOR of row 1, on the
          // CANONICAL side, not part of the selection.
          old: {
            start: 90,
            end: 92,
            text: 'public function baz(): void {\n    $a1 = 1;\n}',
          },
          new: {
            start: 90,
            end: 93,
            text: 'public function baz(): void {\n' + selectedNewLine + '\n' + longNewNeighbor + '\n}',
          },
        },
      })
      const host = document.createElement('div')
      host.id = 'split-neighbor-canonical-side-host'
      document.body.appendChild(host)
      // Row 1 is the selected line (a gran=line-equivalent single-row unit).
      Block(b, { viewMode: () => 'split', activeGroup: () => ({ start: 1, end: 1 }) })(host)
    })

    const card = page.locator('#split-neighbor-canonical-side-host article')
    const cls = await card.getAttribute('class')
    const match = /w-\[calc\((\d+)ch_\+_2rem\)\]/.exec(cls)
    // 81 (the selected row's own canonical chars) + 80 (the non-canonical
    // pane's fixed floor) = 161 — proof the 126-character neighbor (canonical
    // side, directly adjacent, NOT part of the selection) never entered the
    // window at all; picking it up would have produced 126+80=206 instead.
    expect(Number(match[1])).toBe(161)
  })

  // Direct-mount unit test: reviewer decision (option 2 of 3 offered) — a
  // `gran=group` unit that balloons past GROUP_INTERIOR_FULL_SCAN_ROWS (a
  // wholly-added/removed block's single group can legitimately BE the
  // entire function, since there's no unchanged context row to end the run
  // early) only has its EDGES measured, same as a too-far neighbor. Without
  // this, a long line buried in the middle of a big added function —
  // nowhere near either edge, out of the visible viewport — drove the whole
  // card's width.
  test('a huge single group (a wholly-added function) floors instead of following a line buried deep in its middle', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await appReady(page)

    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const longMiddleLine =
        "$deepLine = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';"
      // 25 short lines with one long one buried in the middle (index 12) —
      // comfortably past GROUP_INTERIOR_FULL_SCAN_ROWS (20) so the interior
      // cap kicks in, and the long line sits far from both edges.
      const lines = []
      for (let i = 0; i < 25; i++) lines.push(i === 12 ? '    ' + longMiddleLine : '    $v' + i + ' = ' + i + ';')
      const text = 'public function wholeadded(): void {\n' + lines.join('\n') + '\n}'
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::wholeadded',
        status: 'added',
        file: 'app/Foo.php',
        line: 100,
        name: 'wholeadded',
        class: 'Foo',
        approved: false,
        code: { new: { start: 100, end: 100 + lines.length + 1, text } },
      })
      const host = document.createElement('div')
      host.id = 'group-interior-cap-host'
      document.body.appendChild(host)
      // The whole function is one contiguous changed run (added-only) —
      // select it entirely, exactly like changeGroups would for 'group'.
      Block(b, { viewMode: () => 'split', activeGroup: () => ({ start: 0, end: lines.length + 1 }) })(host)
    })

    const card = page.locator('#group-interior-cap-host article')
    const cls = await card.getAttribute('class')
    const match = /w-\[calc\((\d+)ch_\+_2rem\)\]/.exec(cls)
    // The buried line is ~100 characters — if it were still measured, the
    // card would be comfortably past 90ch. Instead it floors, since it's
    // nowhere near either edge of the (now edge-restricted) group.
    expect(Number(match[1])).toBe(80)
  })
})
