import { test, expect, appReady } from './_fixtures.mjs'

// The look-ahead preview card (the "block below" the selected/active one, see
// DetailPanel's pair.forEach in home.mjs and drillPreviewColumns) collapses to
// just its header + meta row (no description, no diff body) once the ACTIVE
// card next to it doesn't fully fit the available screen height on its own —
// previewTooTallForActive (home.mjs) + Block()'s `collapsed` opt (Block.mjs).
// This frees the space the preview would otherwise take for the active card's
// own (longer) diff, per the "give the block below less room" request.
//
// PR 12903's own two blocks (CreatePaymentAction::execute at index 1,
// ::findOrCreateCustomer at index 2, same file — see step-preview-stability.
// spec.mjs) are both small by design (the main anchor fixture, see
// blocks-and-ingest.md), so their code is routed here to fabricate the two
// shapes this test actually needs: a genuinely tall active block (60 rows,
// comfortably over PREVIEW_COLLAPSE-worthy at the default 1280×720 viewport,
// see previewTooTallForActive's own constants) and a short sibling.
test.describe('look-ahead preview collapses when the active card does not fit', () => {
  test('a tall active block collapses the preview to just its header', async ({ page }) => {
    await page.route('**/api/code**', async (route) => {
      const url = new URL(route.request().url())
      const name = url.searchParams.get('name')
      if (name === 'execute') {
        const oldLines = Array.from({ length: 60 }, (_, i) => `    $x${i} = ${i};`)
        const newLines = [...oldLines]
        newLines[30] = '    $x30 = 999; // changed'
        await route.fulfill({
          json: {
            file: 'app/Actions/CreatePaymentAction.php',
            old: { start: 1, end: 60, text: oldLines.join('\n') },
            new: { start: 1, end: 60, text: newLines.join('\n') },
          },
        })
        return
      }
      if (name === 'findOrCreateCustomer') {
        await route.fulfill({
          json: {
            file: 'app/Actions/CreatePaymentAction.php',
            old: { start: 1, end: 3, text: '    $y = 1;\n    $y = 2;\n    $y = 3;' },
            new: { start: 1, end: 3, text: '    $y = 1;\n    $y = 20;\n    $y = 3;' },
          },
        })
        return
      }
      await route.fallback()
    })

    await page.goto('/pr/12903')
    await appReady(page)
    // Select block 1 (CreatePaymentAction::execute) — see step-preview-
    // stability.spec.mjs for why block 0 (ContractController::index) isn't
    // the one to pick here (no local diff of its own).
    await page.locator('[data-idx="1"]').click()

    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)
    const active = cards.nth(0)
    const preview = cards.nth(1)

    // The active card keeps its full diff — nothing about it collapses.
    await expect(active.locator('[data-testid="code-diff"]')).toHaveCount(1)
    await expect(active).toContainText('$x30 = 999')

    // The preview card shows its header (title/status) and meta (file:line +
    // approve pill) — but neither a description paragraph nor a diff body.
    await expect(preview).toContainText('findOrCreateCustomer')
    await expect(preview.locator('[data-testid="code-diff"]')).toHaveCount(0)
    await expect(preview).not.toContainText('nog geen omschrijving')
    await expect(preview).not.toContainText('$y = 20')
  })

  test('a short active block leaves the preview fully expanded', async ({ page }) => {
    // Both sides small — well under the collapse threshold — so the preview
    // keeps showing its usual description + diff body, unaffected.
    await page.route('**/api/code**', async (route) => {
      const url = new URL(route.request().url())
      const name = url.searchParams.get('name')
      if (name === 'execute') {
        await route.fulfill({
          json: {
            file: 'app/Actions/CreatePaymentAction.php',
            old: { start: 1, end: 2, text: '    $a = 1;\n    $a = 2;' },
            new: { start: 1, end: 2, text: '    $a = 10;\n    $a = 2;' },
          },
        })
        return
      }
      await route.fallback()
    })

    await page.goto('/pr/12903')
    await appReady(page)
    await page.locator('[data-idx="1"]').click()

    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)
    const preview = cards.nth(1)
    await expect(preview.locator('[data-testid="code-diff"]')).toHaveCount(1)
  })
})
