import { test, expect } from './_fixtures.mjs'

// Task 29: a look-ahead preview card must never be wider or show more (e.g. an
// old pane) than the ACTIVE (selected) card it's stacked next to. PR 105
// (materializePreviewWidthWorktrees, tests/_setup.mjs) seeds a one-sided
// `added` block (selected, index 0 — its own singleSide() already narrows it)
// immediately followed by a two-sided `modified` block (index 1, the
// look-ahead preview) that genuinely has real old+new text on disk. Without
// the activeSingleSided override in home.mjs, that preview would render at
// its own natural full width with both panes (including the old/removed
// side) — wider and richer than the one-sided active card next to it.
test.describe('PR Review Tree — look-ahead preview matches a one-sided active block', () => {
  test('preview card narrows to new-only when the active card is one-sided', async ({ page }) => {
    await page.goto('/pr/105')
    await page.waitForLoadState('networkidle')

    // List mode already renders the selected card (0) + its look-ahead
    // preview (1) side by side in the block column (see
    // tests/step-preview-stability.spec.mjs for the same precedent).
    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)

    const active = cards.nth(0)
    const preview = cards.nth(1)

    // The active (added, one-sided) card is narrow on its own — this is the
    // pre-existing, unrelated singleSide() behaviour, asserted here only as a
    // sanity baseline for the width comparison below.
    await expect(active).toHaveClass(/w-\[42rem\]/)

    // The preview card (modified, genuinely two-sided) must match — narrow,
    // not its own natural full width.
    await expect(preview).toHaveClass(/w-\[42rem\]/)
    await expect(preview).not.toHaveClass(/w-\[70rem\]/)

    // And it must not carry an old/removed pane — only the new side, exactly
    // like the active card next to it.
    await expect(preview.locator('[data-pane="old"]')).toHaveCount(0)
    await expect(preview.locator('[data-pane="new"]')).toHaveCount(1)

    // Sanity: the active card's own bounding width and the preview's agree —
    // never wider, per the one-directional rule (see detail-layout.md).
    const activeBox = await active.boundingBox()
    const previewBox = await preview.boundingBox()
    expect(previewBox.width).toBeLessThanOrEqual(activeBox.width + 1)
  })

  test('preview card keeps its own two-sided width when the active card is two-sided', async ({ page }) => {
    // PR 12903's blocks 1+2 are both two-sided (modified) same-file
    // neighbours — the pre-existing, unaffected case: no override should
    // apply, so the preview keeps its own full width and both panes.
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-idx="1"]').click()

    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)
    const preview = cards.nth(1)
    await expect(preview).toHaveClass(/w-\[70rem\]/)
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
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="block-column"] article')).toHaveCount(2)
    await expect(page.getByTestId('block-row')).toHaveCount(2)
    expect(errors).toEqual([])
  })
})
