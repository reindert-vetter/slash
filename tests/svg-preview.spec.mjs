import { test, expect } from './_fixtures.mjs'

// PR 109 (tests/fixtures/svg-blocks.json, worktrees in _setup.mjs,
// materializeSvgWorktrees). A changed `.svg` file has no PHP function to
// scan — it's a whole-file OTHER block (ScanBlocks' wholeFileBlock
// fallback, phpscan.go) — and Block.mjs's svgSlot renders it as rendered
// old/new <img> previews INSTEAD OF the raw text diff (the translationSlot
// precedent: replace, not add alongside — see .claude/docs/blocks-and-ingest.md
// "Translation blocks" for the sibling precedent, and Block.mjs's own
// svgSlot doc comment for why there's deliberately no raw-text fallback).
//
// The block column also shows a look-ahead PREVIEW of the next block, so
// selecting one of these two .svg blocks can put BOTH their cards on
// screen at once — every assertion below is therefore scoped to the
// specific `<article>` card via a `hasText` filter on the file name,
// rather than a bare `getByTestId('svg-diff')` (which would hit Playwright
// strict-mode ambiguity as soon as both cards are present).
function svgCard(page, fileName) {
  return page.locator('article').filter({ hasText: fileName })
}

test.describe('SVG block — rendered old/new preview', () => {
  test('shows rendered old + new <img> previews instead of a text diff', async ({ page }) => {
    await page.goto('/pr/109?sel=' + encodeURIComponent('public/icons/logo.svg:1'))

    const card = svgCard(page, 'logo.svg')
    const diff = card.getByTestId('svg-diff')
    await expect(diff).toBeVisible()

    // The raw text diff (codeDiff's own root) never renders for this card.
    await expect(card.getByTestId('code-diff')).toHaveCount(0)

    const oldImg = diff.getByTestId('svg-pane-oud').locator('img')
    const newImg = diff.getByTestId('svg-pane-nieuw').locator('img')
    await expect(oldImg).toBeVisible()
    await expect(newImg).toBeVisible()

    // Both images are plain data URIs, never an inline <svg> element in the
    // DOM (see svgDataUri's own doc comment on why that matters for XSS).
    await expect(diff.locator('svg')).toHaveCount(0)
    const oldSrc = await oldImg.getAttribute('src')
    const newSrc = await newImg.getAttribute('src')
    expect(oldSrc).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(newSrc).toMatch(/^data:image\/svg\+xml;base64,/)
    // Old (#f00) and new (#0f0) are genuinely different images.
    expect(oldSrc).not.toEqual(newSrc)
  })

  test('never executes a hostile <script>/onload= payload inside the SVG', async ({ page }) => {
    await page.goto('/pr/109?sel=' + encodeURIComponent('public/icons/evil.svg:1'))

    const card = svgCard(page, 'evil.svg')
    const diff = card.getByTestId('svg-diff')
    await expect(diff).toBeVisible()
    await expect(diff.locator('img')).toHaveCount(2)
    // No inline <svg> anywhere in the card — only <img>.
    await expect(diff.locator('svg')).toHaveCount(0)

    // Give a hostile onload/<script> every chance to have fired by now.
    await page.waitForTimeout(300)
    const fired = await page.evaluate(() => window.__svgXssFired)
    expect(fired).toBeUndefined()
  })
})
