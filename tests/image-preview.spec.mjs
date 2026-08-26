import { test, expect } from './_fixtures.mjs'

// PR 130 (tests/fixtures/image-blocks.json, worktrees in _setup.mjs,
// materializeImageWorktrees). A changed raster image has no text to diff, so
// Block.mjs's imageSlot renders the PICTURE itself — fetched from
// GET /api/image (image_asset.go) — INSTEAD of the raw text diff (the
// svgSlot/translationSlot precedent: replace, not add alongside). Unlike
// svgSlot it honours the three `a` stands, each with its image-shaped
// meaning: split = side by side, unified = stacked at 50% opacity, fit =
// only the new one. See .claude/docs/diff-render.md.
//
// The block column also shows a look-ahead preview of the next block, so both
// cards can be on screen at once — every assertion is scoped to the specific
// <article> via a hasText filter on the file name.
function imageCard(page, fileName) {
  return page.locator('article').filter({ hasText: fileName })
}

// decoded waits until the browser really decoded the image (naturalWidth > 0),
// which is what proves /api/image served valid bytes with a usable
// Content-Type — an <img> tag alone would pass even for a 404.
async function expectDecoded(img) {
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0))
    .toBe(true)
}

test.describe('image block — rendered preview instead of a text diff', () => {
  test('shows old + new side by side, and never a text diff', async ({ page }) => {
    await page.goto('/pr/130?sel=' + encodeURIComponent('public/images/logo.png:1'))

    const card = imageCard(page, 'logo.png')
    const diff = card.getByTestId('image-diff')
    await expect(diff).toBeVisible()
    await expect(card.getByTestId('code-diff')).toHaveCount(0)

    const oldImg = diff.getByTestId('image-pane-oud').locator('img')
    const newImg = diff.getByTestId('image-pane-nieuw').locator('img')
    await expectDecoded(oldImg)
    await expectDecoded(newImg)
    // Each side is served from its own worktree, so the two URLs differ only
    // in `side` — and they are real endpoint URLs, not data URIs.
    expect(await oldImg.getAttribute('src')).toContain('/api/image?')
    expect(await oldImg.getAttribute('src')).toContain('side=old')
    expect(await newImg.getAttribute('src')).toContain('side=new')
  })

  test('an added image shows only its new side', async ({ page }) => {
    await page.goto('/pr/130?sel=' + encodeURIComponent('public/images/added.png:1'))

    const diff = imageCard(page, 'added.png').getByTestId('image-diff')
    await expect(diff).toBeVisible()
    await expect(diff.getByTestId('image-pane-nieuw')).toBeVisible()
    await expect(diff.getByTestId('image-pane-oud')).toHaveCount(0)
  })

  test('a cycles split → overlay at 50% → only the new image', async ({ page }) => {
    await page.goto('/pr/130?sel=' + encodeURIComponent('public/images/logo.png:1'))
    const card = imageCard(page, 'logo.png')
    await expect(card.getByTestId('image-diff')).toBeVisible()

    // Step into the diff so the card owns the keyboard, then cycle the stand.
    await page.keyboard.press('ArrowRight')
    const diff = card.getByTestId('image-diff')
    await expect(diff.getByTestId('image-pane-oud')).toBeVisible()

    // split → unified: one overlay pane, the new image on top at 50% opacity.
    await page.keyboard.press('a')
    const overlay = diff.getByTestId('image-pane-overlay')
    await expect(overlay).toBeVisible()
    await expect(diff.getByTestId('image-pane-oud')).toHaveCount(0)
    const top = diff.getByTestId('image-overlay-new')
    await expectDecoded(top)
    await expect.poll(() => top.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5')
    // Both versions are really stacked: the overlay pane holds two images.
    await expect(overlay.locator('img')).toHaveCount(2)

    // unified → fit: only the new image, no old side, no overlay.
    await page.keyboard.press('a')
    await expect(diff.getByTestId('image-pane-nieuw')).toBeVisible()
    await expect(diff.getByTestId('image-pane-overlay')).toHaveCount(0)
    await expect(diff.getByTestId('image-pane-oud')).toHaveCount(0)

    // fit → split again: back to two panes.
    await page.keyboard.press('a')
    await expect(diff.getByTestId('image-pane-oud')).toBeVisible()
    await expect(diff.getByTestId('image-pane-nieuw')).toBeVisible()
  })
})
