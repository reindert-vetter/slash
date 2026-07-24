import { test, expect } from './_fixtures.mjs'

// PR 107 (tests/fixtures/translation-blocks.json + translation-callresolve.json,
// worktrees in _setup.mjs). Covers the two translation render modes + the
// companion card (see .claude/rules/blocks-and-ingest.md "Translation blocks"
// and .claude/rules/tembed-workflows.md "Translation keys"):
//   1. A standalone TRANSLATION block renders a CHANGES-ONLY key overview, not
//      raw code, plus a read-only companion card for the sibling (en) locale.
//   2. A resolved trans()/__() child shows the current value per locale, with a
//      "missing in <locale>" marker where the key is absent.
test.describe('PR Review Tree — translation blocks & trans() children', () => {
  test('a standalone lang block shows a changes-only overview + en companion', async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))

    const overview = page.getByTestId('translation-overview')
    await expect(overview).toBeVisible()
    // Only changed keys, old → new; unchanged 'bar' must NOT appear.
    await expect(overview).toContainText('foo')
    await expect(overview).toContainText('nieuw') // changed value (new)
    await expect(overview).toContainText('extra') // added key
    await expect(overview).toContainText('weg') // removed key
    await expect(overview).not.toContainText('bar')

    // The read-only companion card for the sibling en locale: en's CURRENT
    // values for exactly the keys changed in nl, and a "missing" marker where
    // the key doesn't exist in en (weg / only_nl are absent from en).
    const companion = page.getByTestId('translation-companion')
    await expect(companion).toBeVisible()
    await expect(companion).toHaveAttribute('data-locale', 'en')
    await expect(companion).toContainText('new-en') // en's current value for foo
    await expect(companion).toContainText('ontbreekt in en')
  })

  test('a resolved trans() key shows its current value per locale, missing marked', async ({ page }) => {
    // The caller (CheckoutRequest::messages) is block 0 → auto-selected, so its
    // resolved translation children show in the Onderliggende-code panel.
    await page.goto('/pr/107')

    const items = page.getByTestId('related-item')
    // Two keys × two locales = four translation children.
    await expect(items).toHaveCount(4)

    const nlFoo = items.filter({ hasText: 'nl · checkout.foo' })
    await expect(nlFoo).toContainText('nieuw')
    await expect(nlFoo.getByText('vertaling', { exact: true })).toBeVisible()

    const enFoo = items.filter({ hasText: 'en · checkout.foo' })
    await expect(enFoo).toContainText('new-en')

    // only_nl exists in nl but not en → the en child renders the missing marker.
    const enMissing = items.filter({ hasText: 'en · checkout.only_nl' })
    await expect(enMissing.getByTestId('translation-missing')).toContainText('ontbreekt in en')
  })
})
