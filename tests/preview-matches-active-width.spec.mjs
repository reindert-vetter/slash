import { test, expect, appReady, evaluateSettled } from './_fixtures.mjs'

// Task 29: a look-ahead preview card must never be WIDER than the ACTIVE
// (selected) card it's stacked next to. PR 105
// (materializePreviewWidthWorktrees, tests/_setup.mjs) seeds a one-sided
// `added` block (selected, index 0 — its own singleSide() already narrows it)
// immediately followed by a two-sided `modified` block (index 1, the
// look-ahead preview) that genuinely has real old+new text on disk. Without
// the activeSingleSided override in home.mjs, that preview would render at
// its own natural full width with both panes side by side — wider than the
// one-sided active card next to it.
//
// Since the `a`-cycle's 2nd stand was reworked from "hide the old pane" into
// "unified: stack old (-) above new (+) in one column", this override no
// longer guarantees the preview shows nothing the active card doesn't have —
// a genuinely two-sided preview forced into 'unified' still shows its own
// removed (-) line, only narrow and stacked instead of side by side. That
// guarantee was deliberately dropped (see detail-layout.md); only the WIDTH
// guarantee remains. (The pane-structure assertions this test once made are
// moot now too: every preview always collapses to just its header — see "The
// look-ahead preview always collapses to just its header" in diff-card.md —
// so there is no rendered pane at all to assert against; only the width
// class/bounding-box comparison still applies.)
test.describe('PR Review Tree — look-ahead preview matches a one-sided active block', () => {
  test('preview card narrows to unified when the active card is one-sided', async ({ page }) => {
    await page.goto('/pr/105')
    await appReady(page)

    // List mode already renders the selected card (0) + its look-ahead
    // preview (1) side by side in the block column (see
    // tests/step-preview-stability.spec.mjs for the same precedent).
    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)

    const active = cards.nth(0)
    const preview = cards.nth(1)

    // The active (added, one-sided) card is narrow on its own — this is the
    // pre-existing, unrelated singleSide() behaviour, asserted here only as a
    // sanity baseline for the width comparison below. Width is content-driven
    // now (contentWidthCls, Block.mjs), so for this short fixture it lands on
    // the flat 80-character floor.
    await expect(active).toHaveClass(/w-\[calc\(80ch_\+_2rem\)\]/)

    // The preview always collapses to just its header (see diff-card.md) —
    // no pane of any kind renders, since there's no diff body at all.
    await expect(preview.locator('[data-testid="code-diff"]')).toHaveCount(0)

    // Sanity: the active card's own bounding width and the preview's agree —
    // never wider, per the one-directional rule (see detail-layout.md).
    const activeBox = await active.boundingBox()
    const previewBox = await preview.boundingBox()
    expect(previewBox.width).toBeLessThanOrEqual(activeBox.width + 1)
  })

  test('preview card never renders wider than a two-sided active card', async ({ page }) => {
    // PR 12903's blocks 1+2 are both two-sided (modified) same-file
    // neighbours. Every stand's width is content-driven now (contentWidthCls,
    // Block.mjs) and the look-ahead preview's cap (fitCapCharsFor/
    // capFitChars) applies in every stand too — not just 'fit' as before —
    // so the preview can never render wider than the active card next to it.
    // (Every preview always collapses to just its header — Block()'s own
    // `collapsed` opt, unrelated to width — so this only asserts the width
    // relationship, not the pane structure.)
    await page.goto('/pr/12903')
    await appReady(page)
    await page.locator('[data-idx="1"]').click()

    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)
    const active = cards.nth(0)
    const preview = cards.nth(1)
    const activeBox = await active.boundingBox()
    const previewBox = await preview.boundingBox()
    expect(previewBox.width).toBeLessThanOrEqual(activeBox.width + 1)
  })

  // Regression: on the VERY FIRST render, before loadBlocks() has populated
  // state.blocks, activeSingleSided's `singleSide(state.blocks[sel])` /
  // `singleSide(focusedBlock())` calls used to read `.status` off `undefined`
  // (state.blocks[sel] is undefined until the fetch resolves) — a TypeError
  // that broke the reactive render entirely, on EVERY PR page, leaving the
  // sidebar permanently stuck on "No blocks ingested yet." even once blocks
  // did load. Both call sites now guard with `|| {}` (singleSide({}) is a
  // safe null). This asserts a fresh load never throws and blocks genuinely
  // render, so that crash can't silently come back.
  test('a fresh page load never throws and blocks render', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/pr/105')
    await appReady(page)

    await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(2)
    await expect(page.getByTestId('block-row')).toHaveCount(2)
    expect(errors).toEqual([])
  })

  // Regression: singleSide(b) used to be a denylist (`added`→'right',
  // `removed`→'left', everything else → null/two-sided), so a synthetic
  // 'unchanged' block (a drilled call-frame pointing at a file this PR
  // doesn't touch — resolveChildBlock in home.mjs, old === new) fell through
  // to the two-sided branch: it showed BOTH (identical) panes — reported
  // live: a drilled `added` method's own card stayed one-pane while an
  // 'unchanged' RuleData::__construct call target beneath it showed both.
  // singleSide is now an allowlist (only 'modified' keeps both panes), so
  // 'unchanged' still renders a single pane like 'added'/'removed'. (The
  // width side of this regression — 'unchanged' landing on the wide
  // two-sided tier — no longer applies: every stand is content-driven now,
  // with no tier distinction left to fall into; see contentWidthCls,
  // Block.mjs.)
  test('an unchanged block renders a single pane, never both', async ({ page }) => {
    await page.goto('/pr/105')
    await appReady(page)

    const widths = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const { default: Block } = await import('/src/Block.mjs')
      const longLine = 'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLonger($a, $b, $c);'
      const active = reactive({
        category: 'CONTROLLER',
        label: 'MoneybirdController::createRulesWhenPluginIsActive',
        status: 'added',
        file: 'app/Http/Controllers/MoneybirdController.php',
        line: 145,
        name: 'createRulesWhenPluginIsActive',
        class: 'MoneybirdController',
        approved: false,
        code: { new: { start: 145, end: 147, text: 'public function createRulesWhenPluginIsActive(): void {\n    x();\n}' } },
      })
      // Same source on both sides — a genuinely 'unchanged' drilled frame
      // (resolveChildBlock builds exactly this shape: old === new).
      const unchangedSrc = `public function __construct() {\n    ${longLine}\n}`
      const preview = reactive({
        category: 'OTHER',
        label: 'RuleData::__construct',
        status: 'unchanged',
        file: 'app/Data/RuleData.php',
        line: 12,
        name: '__construct',
        class: 'RuleData',
        approved: false,
        code: { old: { start: 12, end: 14, text: unchangedSrc }, new: { start: 12, end: 14, text: unchangedSrc } },
      })

      const activeHost = document.createElement('div')
      activeHost.id = 'unchanged-active-host'
      document.body.appendChild(activeHost)
      Block(active, { viewMode: () => 'split' })(activeHost)

      const previewHost = document.createElement('div')
      previewHost.id = 'unchanged-preview-host'
      document.body.appendChild(previewHost)
      Block(preview, { viewMode: () => 'split', preview: true })(previewHost)

      const previewCard = previewHost.querySelector('article')
      return {
        previewOldPanes: previewCard.querySelectorAll('[data-pane="old"]').length,
        previewNewPanes: previewCard.querySelectorAll('[data-pane="new"]').length,
      }
    })

    expect(widths.previewOldPanes).toBe(0)
    expect(widths.previewNewPanes).toBe(1)
  })

  // Regression: the "preview never wider than active" guarantee must also
  // hold when the ACTIVE card itself is two-sided (`modified`) — the
  // `activeSingleSided` override (home.mjs) only forces the preview's
  // viewMode to 'unified' for a one-sided active card, so a two-sided active
  // card relies entirely on both cards sharing the same fixed split/unified
  // width tier (widthCls, Block.mjs). Confirms that still holds across all
  // three `a` stands even when the preview's own code is genuinely much
  // longer than the active card's.
  test('a modified active card is never smaller than a wider modified preview, in every stand', async ({
    page,
  }) => {
    await page.goto('/pr/105')
    await appReady(page)

    for (const stand of ['split', 'unified', 'fit']) {
      const widths = await evaluateSettled(page, async (viewMode) => {
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
              new: { start: line, end: line + 2, text: `public function ${name}(): int {\n    ${newLine}\n}` },
            },
          })
        const active = makeBlock('map', 60, 'return $short;')
        const preview = makeBlock(
          'headings',
          70,
          'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLongerThanTheActiveOne($a, $b, $c, $d);',
        )

        document.querySelectorAll('#modified-active-host, #modified-preview-host').forEach((n) => n.remove())
        const activeHost = document.createElement('div')
        activeHost.id = 'modified-active-host'
        document.body.appendChild(activeHost)
        Block(active, { viewMode: () => viewMode })(activeHost)

        const previewHost = document.createElement('div')
        previewHost.id = 'modified-preview-host'
        document.body.appendChild(previewHost)
        Block(preview, {
          viewMode: () => viewMode,
          preview: true,
          capFitChars: () => fitCapCharsFor(active),
        })(previewHost)

        const activeCard = activeHost.querySelector('article')
        const previewCard = previewHost.querySelector('article')
        return {
          activeWidth: activeCard.getBoundingClientRect().width,
          previewWidth: previewCard.getBoundingClientRect().width,
        }
      }, stand)

      expect(widths.previewWidth, `stand=${stand}`).toBeLessThanOrEqual(widths.activeWidth + 1)
    }
  })

  // Direct-mount unit test: the top-level look-ahead preview's `narrowFixed`
  // opt (Block.mjs/home.mjs's DetailPanel `pair.forEach`) — reviewer
  // decision: this preview's width is now a FLAT MIN_CONTENT_WIDTH_CHARS
  // (80) floor, never content-driven, since it always collapses to just its
  // header anyway (no diff body ever renders). Scoped to ONLY that call
  // site — a drilled column's own look-ahead preview (drillPreviewColumns)
  // is untouched and keeps its existing content-driven-but-capped width.
  test('narrowFixed gives the main-column preview a flat width regardless of content, but leaves an ordinary card content-driven', async ({
    page,
  }) => {
    await page.goto('/pr/105')
    await appReady(page)

    const cls = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const wideLine =
        'return $this->fooBarValuesFromRequestPayloadDataThatIsGenuinelyMuchLongerThanEightyCharactersWide($a, $b, $c);'
      const makeBlock = (name, line) =>
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
            new: { start: line, end: line + 2, text: `public function ${name}(): int {\n    ${wideLine}\n}` },
          },
        })

      const fixedHost = document.createElement('div')
      fixedHost.id = 'narrow-fixed-preview-host'
      document.body.appendChild(fixedHost)
      Block(makeBlock('fixedPreview', 200), {
        viewMode: () => 'fit',
        preview: true,
        collapsed: () => true,
        narrowFixed: () => true,
      })(fixedHost)

      const contentDrivenHost = document.createElement('div')
      contentDrivenHost.id = 'narrow-fixed-not-set-host'
      document.body.appendChild(contentDrivenHost)
      // Same wide content, same 'fit' stand, but no narrowFixed opt at all —
      // mirrors an ordinary active card (and drillPreviewColumns' own
      // preview, which never passes narrowFixed either).
      Block(makeBlock('contentDriven', 210), { viewMode: () => 'fit' })(contentDrivenHost)

      return {
        fixed: document.querySelector('#narrow-fixed-preview-host article').className,
        contentDriven: document.querySelector('#narrow-fixed-not-set-host article').className,
      }
    })

    expect(cls.fixed).toMatch(/w-\[calc\(80ch_\+_2rem\)\]/)
    // The content-driven card, given the exact same wide line, grows well
    // past the flat 80-character floor — proof narrowFixed is what's
    // actually suppressing the growth above, not some property of the
    // fixture itself.
    const contentDrivenMatch = /w-\[calc\((\d+)ch_\+_2rem\)\]/.exec(cls.contentDriven)
    expect(Number(contentDrivenMatch[1])).toBeGreaterThan(80)
  })

  // Regression (2026-08-19, live PR 13392, FillStats::handle's drilled-in
  // <class-header> child): a block/side with ZERO changed rows (here:
  // status 'unchanged', old === new — the same shape resolveChildBlock/a
  // drilled context card builds) used to fall back to the block's TRUE
  // longest line, uncapped, via codeMaxLineChars — an exceptionally long
  // UNCHANGED context line (well past 100 chars) then stretched the card
  // far past the screen. NO_CHANGE_MAX_WIDTH_CHARS (100, Block.mjs) now
  // caps exactly that fallback path, so the card stays at the cap instead
  // of growing to the line's full length. Contrast with the "grows well
  // past 80" content-driven case just above, which DOES have a changed row
  // and must stay genuinely uncapped.
  test('a block with no changed rows caps its width instead of following its longest unchanged line', async ({
    page,
  }) => {
    await page.goto('/pr/105')
    await appReady(page)

    const cls = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      // Well past NO_CHANGE_MAX_WIDTH_CHARS (100) — a real (non-comment) code
      // line, mirroring the reported bug's `$signature` property line rather
      // than a doc-comment (nonCommentLineLengths deliberately excludes
      // comment lines, so a comment wouldn't exercise the cap at all).
      const veryLongLine =
        "protected \$signature = 'stats:fill {--model= : The model to process, an exceptionally long option description that keeps going}';"
      const noChangeSrc = `class FillStats extends Command {\n    ${veryLongLine}\n}`
      const noChangeBlock = reactive({
        category: 'OTHER',
        label: 'FillStats::<class-header>',
        status: 'unchanged',
        file: 'app/Console/Commands/Maintenance/FillStats.php',
        line: 1,
        name: '<class-header>',
        class: 'FillStats',
        approved: false,
        // old === new, exactly resolveChildBlock's shape for context with no
        // changed rows of its own.
        code: { old: { start: 1, end: 4, text: noChangeSrc }, new: { start: 1, end: 4, text: noChangeSrc } },
      })

      const host = document.createElement('div')
      host.id = 'no-change-cap-host'
      document.body.appendChild(host)
      // Also pass an activeGroup (a drilled-in card always has a cursor
      // unit) — since the block itself has zero changed rows,
      // selectionWindowLineChars still returns null (not just for the
      // "no unit at all" case), exercising the same fallback path a real
      // drilled context card hits.
      Block(noChangeBlock, { viewMode: () => 'fit', activeGroup: () => ({ start: 0, end: 3 }) })(host)

      return { className: host.querySelector('article').className }
    })

    // Capped at NO_CHANGE_MAX_WIDTH_CHARS (100), not the ~110+-char raw line.
    expect(cls.className).toMatch(/w-\[calc\(100ch_\+_2rem\)\]/)
  })
})
