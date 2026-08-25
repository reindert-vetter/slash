import { test, expect, appReady } from './_fixtures.mjs'

// Reindert: "ik wil hier ook kunnen zoeken op closed prs en prs van andere
// (wel in een lagere volgorde)" and, on the presentation: "als je zoekt, wil
// ik alle categorieen weg hebben". So while a query is active the search view
// is ONE flat list — no result heading, and none of the three drawers below it
// (Filters / Recent gegenereerd / Mislukte taken), which are siblings of the
// content region and therefore stayed in view before this. The inbox sections
// were already routed away by currentView().
//
// The ordering itself is a pure Go function and is covered by
// TestSortSearchRowsRanking (search_rank_test.go), not from here — the offline
// fixture carries no PR state at all, so a closed row has to be mocked.
test.describe('PR overview — searching drops every category', () => {
  test('a query hides the three drawers and shows no result heading; clearing it brings them back', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    // At rest all three blocks are there.
    await expect(page.locator('[data-testid="filter-drawer"]')).toBeVisible()
    await expect(page.locator('[data-testid="recent"]')).toBeVisible()
    await expect(page.locator('[data-testid="problems-drawer"]')).toBeVisible()

    const search = page.locator('[data-testid="search"]')
    await search.fill('scheduling')
    const results = page.locator('[data-testid="search-results"]')
    await expect(results.locator('[data-testid="pr-row"]')).toHaveCount(2)

    // Every category is gone: the drawers …
    await expect(page.locator('[data-testid="filter-drawer"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="recent"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="problems-drawer"]')).toHaveCount(0)
    // … and any heading inside the results region.
    await expect(results.locator('h2')).toHaveCount(0)

    // Clearing the box restores them.
    await search.fill('')
    await expect(page.locator('[data-testid="filter-drawer"]')).toBeVisible()
    await expect(page.locator('[data-testid="recent"]')).toBeVisible()
    await expect(page.locator('[data-testid="problems-drawer"]')).toBeVisible()
  })

  test('a closed and a merged result are marked by a WORD, an open one is not', async ({ page }) => {
    // With no headings left, this marker is the only thing telling a
    // no-longer-open hit apart from an open one — hence a word, not a tint
    // (the reviewer is colourblind).
    await page.route('**/api/prs/search**', (route) =>
      route.fulfill({
        json: {
          ok: true,
          prs: [
            { number: 700, title: 'Still open', author: 'alice', state: 'OPEN', url: 'https://example.test/700', updatedAt: new Date().toISOString(), isDraft: false, baseRefName: 'develop', headRefName: 'a' },
            { number: 701, title: 'Landed already', author: 'alice', state: 'MERGED', url: 'https://example.test/701', updatedAt: new Date().toISOString(), isDraft: false, baseRefName: 'develop', headRefName: 'b' },
            { number: 702, title: 'Abandoned', author: 'alice', state: 'CLOSED', url: 'https://example.test/702', updatedAt: new Date().toISOString(), isDraft: false, baseRefName: 'develop', headRefName: 'c' },
          ],
        },
      }),
    )

    await page.goto('/pr-overview')
    await appReady(page)
    await page.locator('[data-testid="search"]').fill('anything')

    const rows = page.locator('[data-testid="search-results"] [data-testid="pr-row"]')
    await expect(rows).toHaveCount(3)

    await expect(rows.nth(0).locator('[data-testid="row-state-mark"]')).toHaveCount(0)
    await expect(rows.nth(1).locator('[data-testid="row-state-mark"]')).toContainText('Samengevoegd')
    await expect(rows.nth(2).locator('[data-testid="row-state-mark"]')).toContainText('Gesloten')
  })
})
