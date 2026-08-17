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
// guarantee remains.
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

    // It renders as ONE unified column (data-pane="new" — the same meaning
    // that attribute already carries on the ordinary new/right codePane —
    // never a separate `[data-pane="old"]` wrapper), but that single column
    // DOES show the removed (-) line of its own real change: unified no
    // longer hides old content, it only restructures it — see the header
    // comment above.
    await expect(preview.locator('[data-pane="old"]')).toHaveCount(0)
    await expect(preview.locator('[data-pane="new"]')).toHaveCount(1)
    await expect(preview.locator('span.text-rose-500')).toHaveCount(1)
    await expect(preview.locator('span.text-emerald-500')).toHaveCount(1)

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
    // (This particular preview happens to collapse to just its header —
    // previewTooTallForActive, home.mjs, unrelated to width — so this only
    // asserts the width relationship, not the pane structure.)
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
})
