import { test, expect, appReady } from './_fixtures.mjs'

// The look-ahead preview card (the "block below" the selected/active one, see
// DetailPanel's pair.forEach in home.mjs and drillPreviewColumns) always
// collapses to just its header + meta row (no description, no diff body) —
// Block()'s `collapsed` opt, unconditionally true for every preview card
// (reviewer request: "laat blokken onder de huidige actieve blok alleen de
// header zien"). Deliberately no longer conditioned on whether the active
// card fits the screen (the earlier previewTooTallForActive estimator is
// gone) — both a tall and a short active block leave the preview collapsed.
//
// PR 12903's own two blocks (CreatePaymentAction::execute at index 1,
// ::findOrCreateCustomer at index 2, same file — see step-preview-stability.
// spec.mjs) are both small by design (the main anchor fixture, see
// blocks-and-ingest.md), so their code is routed here to fabricate the two
// shapes this test actually needs: a genuinely tall active block (60 rows)
// and a short one, to confirm the preview collapses in both cases.
test.describe('look-ahead preview always collapses to just its header', () => {
  test('a tall active block leaves the preview collapsed to just its header', async ({ page }) => {
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
    // Select CreatePaymentAction::execute by label, not by raw index — see
    // "Sort order of the left list" in blocks-and-ingest.md.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()

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

  test('a short active block also leaves the preview collapsed', async ({ page }) => {
    // Both sides small — well within any screen — but the preview still
    // collapses: it is no longer conditional on the active card's own height.
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
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const cards = page.locator('[data-testid="block-column"] article')
    await expect(cards).toHaveCount(2)
    const active = cards.nth(0)
    const preview = cards.nth(1)

    await expect(active.locator('[data-testid="code-diff"]')).toHaveCount(1)
    await expect(preview.locator('[data-testid="code-diff"]')).toHaveCount(0)
  })
})
