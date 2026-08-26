import { test, expect } from './_fixtures.mjs'

// PR 107 (tests/fixtures/translation-blocks.json + translation-callresolve.json,
// worktrees in _setup.mjs). Covers the two translation render modes + the
// sibling-locale columns (see .claude/docs/blocks-and-ingest.md "Translation
// blocks" and .claude/docs/tembed-workflows.md "Translation keys"):
//   1. A standalone TRANSLATION block renders a CHANGES-ONLY key overview, not
//      raw code — each row also carrying a read-only column per sibling
//      locale (en), inline in the SAME card (no separate companion card).
//   2. A resolved trans()/__() child shows the current value per locale, with a
//      "missing in <locale>" marker where the key is absent.
test.describe('PR Review Tree — translation blocks & trans() children', () => {
  test('a standalone lang block shows a changes-only overview + an inline en column per row', async ({ page }) => {
    await page.goto('/pr/107?sel=' + encodeURIComponent('resources/lang/nl/checkout.php:1'))

    const overview = page.getByTestId('translation-overview')
    await expect(overview).toBeVisible()
    // Only changed keys, old → new; unchanged 'bar' must NOT appear.
    await expect(overview).toContainText('foo')
    await expect(overview).toContainText('nieuw') // changed value (new)
    await expect(overview).toContainText('extra') // added key
    await expect(overview).toContainText('weg') // removed key
    await expect(overview).not.toContainText('bar')

    // The sibling (en) locale's CURRENT value renders as an extra, read-only
    // column on the SAME row — no separate companion card anymore — with a
    // "missing" marker where the key doesn't exist in en (weg is absent).
    const row = (key) => page.getByTestId('translation-row').filter({ hasText: key })
    const siblingCol = (key) => row(key).getByTestId('translation-sibling-col')
    await expect(siblingCol('foo')).toHaveAttribute('data-locale', 'en')
    await expect(siblingCol('foo')).toContainText('new-en') // en's current value for foo
    await expect(siblingCol('weg')).toContainText('ontbreekt in en')
  })

  test('a resolved trans() key shows its current value per locale, missing marked', async ({ page }) => {
    // The caller (CheckoutRequest::messages) is block 0 → auto-selected, so its
    // resolved translation children show in the Onderliggende-code panel.
    await page.goto('/pr/107')

    const items = page.getByTestId('related-item')
    // Two keys × two locales = four translation children.
    await expect(items).toHaveCount(4)

    // The dot-path key now sits once, in a shared heading above each en/nl
    // pair (translationGroupRow, RelatedPanel.mjs) — not repeated per card.
    const keyHeadings = page.getByTestId('related-translation-key')
    await expect(keyHeadings).toHaveCount(2)
    await expect(keyHeadings.filter({ hasText: 'checkout.foo' })).toHaveCount(1)
    await expect(keyHeadings.filter({ hasText: 'checkout.only_nl' })).toHaveCount(1)

    // Each card's own title is now just the locale word. Located via
    // data-child-id (which carries the translation:<locale>:<key> callKey)
    // rather than hasText: every leaf card's "Alleen bekijken" eye-icon
    // <title> already contains the substring "en" (bekijk-EN), so a plain
    // hasText:'en' filter matches BOTH locale cards.
    const fooRow = keyHeadings.filter({ hasText: 'checkout.foo' }).locator('xpath=following-sibling::div[1]')
    const nlFoo = fooRow.locator('[data-child-id*="translation:nl:checkout.foo"]')
    await expect(nlFoo).toContainText('nieuw')
    await expect(nlFoo.getByText('vertaling', { exact: true })).toBeVisible()

    const enFoo = fooRow.locator('[data-child-id*="translation:en:checkout.foo"]')
    await expect(enFoo).toContainText('new-en')

    // only_nl exists in nl but not en → the en child renders the missing marker.
    const onlyNlRow = keyHeadings.filter({ hasText: 'checkout.only_nl' }).locator('xpath=following-sibling::div[1]')
    const enMissing = onlyNlRow.locator('[data-child-id*="translation:en:checkout.only_nl"]')
    await expect(enMissing.getByTestId('translation-missing')).toContainText('ontbreekt in en')

    // The en/nl pair sits side by side (same row), not stacked — each half
    // takes roughly the row's width, with a dotted vertical divider between.
    const fooBox = await fooRow.boundingBox()
    const nlBox = await nlFoo.boundingBox()
    const enBox = await enFoo.boundingBox()
    expect(Math.abs(nlBox.y - enBox.y)).toBeLessThan(5)
    expect(nlBox.width).toBeLessThan(fooBox.width * 0.6)
    expect(enBox.width).toBeLessThan(fooBox.width * 0.6)
  })
})
