import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Two different call keys of ONE caller can resolve to the very same definition:
// `app(Foo::class)->find()` produces both rule 6c-bis's `class_method:Foo` entry
// point (badged "eerste method") and a `find` row for the call itself. The
// Onderliggende-code panel used to render that as two identical cards (reported
// on PR 13392: `CreateAndBackfillSubscriptionViewsActivity::run` twice, once as
// "eerste method" and once as "bron: haiku"). preferredCallRows (home.mjs) now
// keeps exactly one row per target, ranked: a real Go-resolved call beats a
// Go-resolved entry point, and any Go resolution beats an LLM-found row.
//
// PR 124 (materializeDupTargetWorktrees, tests/_setup.mjs, seeded via
// duptarget-blocks.json/duptarget-callresolve.json) seeds both branches at once:
// SomeRepo::find is covered by an entry point + an LLM row, OtherRepo::handle by
// an entry point + a Go-resolved call.
const BLOCK = 'DupTargetAction::run'

test.describe('one card per resolved call target', () => {
  test('an entry point and the real call to the same method collapse to one card', async ({ page }) => {
    await page.goto('/pr/124')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    const items = page.getByTestId('related-item')
    // 5 seeded rows → 3 cards: SomeRepo::__construct, SomeRepo::find, OtherRepo::handle.
    await expect(items).toHaveCount(3)
    await expect(items.filter({ hasText: 'SomeRepo::find' })).toHaveCount(1)
    await expect(items.filter({ hasText: 'OtherRepo::handle' })).toHaveCount(1)
  })

  test('the Go-resolved row wins from the LLM row for the same target', async ({ page }) => {
    await page.goto('/pr/124')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    // SomeRepo::find is seeded as a Go entry point + an LLM (haiku) row: the Go
    // one survives, so no "bron: haiku" badge is left anywhere in the panel.
    await expect(page.getByTestId('related-item').filter({ hasText: 'SomeRepo::find' })).toContainText('eerste method')
    await expect(page.getByTestId('related-code')).not.toContainText('bron: haiku')
  })

  test('the real call wins from the entry point pointing at the same method', async ({ page }) => {
    await page.goto('/pr/124')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    // OtherRepo::handle is seeded as a Go entry point + a Go-resolved real call:
    // the real call survives, so the card carries no "eerste method" badge.
    const handle = page.getByTestId('related-item').filter({ hasText: 'OtherRepo::handle' })
    await expect(handle).toHaveCount(1)
    await expect(handle).not.toContainText('eerste method')
  })
})
