import { test, expect, appReady } from './_fixtures.mjs'

// The block card header carries three labels, each optional: the MODULE, the
// LAYER, and the TYPE (the pre-existing category pill). Reindert: "ook wil ik
// een extra label erbij voor dat is in de app staat of dat (welke) module het
// staat", and later: three labels, "app is ook een module naam", all three
// optional.
//
// Module and layer are derived in the frontend from b.file (src/blockPath.mjs)
// rather than stored, so they need no migration and no re-ingest; this spec
// covers every shape of that split. PR 118 is the fixture
// (tests/fixtures/modulelabel-blocks.json).
async function selectRow(page, text) {
  await page.getByTestId('block-row').filter({ hasText: text }).click()
}

// Scoped to the card of THAT block: a look-ahead preview card for a different
// block renders alongside the selected one, and both carry these pills.
const card = (page, label) => page.locator('article').filter({ hasText: label }).first()

test('the card header shows the module and layer a block lives in, each optional', async ({
  page,
}) => {
  await page.goto('/pr/118')
  await appReady(page)

  // `app` is an ordinary module name, not a special case — it gets a pill like
  // any module. No layer: app/ has no Internal/Shared/Client grouping.
  await selectRow(page, 'PromotionCodesV2Feature')
  await expect(card(page, 'PromotionCodesV2Feature').getByTestId('block-module-pill')).toHaveText('app')
  await expect(card(page, 'PromotionCodesV2Feature').getByTestId('block-layer-pill')).toHaveCount(0)

  // Old, flat module style: module + type, no layer.
  await selectRow(page, 'RefundService')
  await expect(card(page, 'RefundService').getByTestId('block-module-pill')).toHaveText('Payments')
  await expect(card(page, 'RefundService').getByTestId('block-layer-pill')).toHaveCount(0)

  // New, three-part style: module + layer + type.
  await selectRow(page, 'CheckoutService')
  await expect(card(page, 'CheckoutService').getByTestId('block-module-pill')).toHaveText('Checkouts')
  await expect(card(page, 'CheckoutService').getByTestId('block-layer-pill')).toHaveText('Internal')

  // Plain Laravel structure: neither. The type pill still stands on its own.
  await selectRow(page, 'services.php')
  await expect(card(page, 'services.php').getByTestId('block-module-pill')).toHaveCount(0)
  await expect(card(page, 'services.php').getByTestId('block-layer-pill')).toHaveCount(0)
})
