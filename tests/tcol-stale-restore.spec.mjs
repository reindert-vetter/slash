import { test, expect } from './_fixtures.mjs'

// Reported bug: a link carrying a stale `?tcol=1` next to a `?sel=` that
// resolves to an ORDINARY block (not a test_class row) hid the whole
// blokken-index (pr-index) with nothing to take its place — no
// methodes-kolom ever renders for a non-test_class selection, but
// applyBlockRefRestore's plain-block branch (and applyCommentRefRestore's own
// branch) assigned state.selected directly, bypassing selectRow's usual
// testColumnFocused/classMethodSel reset. BlockList.mjs's own collapse
// ternary reads state.testColumnFocused alone (no curTestClassRow() guard),
// so the stale flag alone was enough to permanently width-0 the index.
//
// Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json) — the same one
// testclass-column-visible.spec.mjs uses. tests/Feature/StoreHelper.php:7 is
// an OTHER-category block, never grouped into a test_class row.
const PR = 110
const BLOCK_REF = 'tests/Feature/StoreHelper.php:7'

test('a stray ?tcol=1 next to a plain block selection does not hide the pr-index', async ({ page }) => {
  await page.goto(`/pr/${PR}?sel=${encodeURIComponent(BLOCK_REF)}&tcol=1`)

  const index = page.getByTestId('pr-index')
  await expect(index).toBeVisible()
  await expect
    .poll(async () => (await index.boundingBox())?.width ?? 0, { message: 'pr-index width' })
    .toBeGreaterThan(200)
  await expect(page.getByTestId('block-row').first()).toBeVisible()

  // The URL itself must not keep echoing the stale flag either — it was
  // reset, not merely hidden behind a race.
  await expect(page).not.toHaveURL(/tcol=1/)
})
