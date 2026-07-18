import { test, expect } from './_fixtures.mjs'

// Regression coverage for "arrow-down selects the wrong PR": src/overview.mjs
// used to track the keyboard selection as a bare array position (`selIndex`)
// with no link back to *which* PR that was. Any change to the underlying row
// set that the reviewer didn't cause themselves — typing/clearing a search
// query (which swaps the entire row set for an unrelated one), a background
// snapshot reload, or opening/closing the "Recent gegenereerd" drawer — kept
// re-highlighting "whatever row now sits at that same numeric position",
// which is very often a completely different PR than the one actually
// selected.
//
// The fix tracks the selection by a stable identity (`data-nav-key`, mirrored
// from the row's arrow.js `.key(...)`) and re-derives the array position from
// that identity on every repaint (reanchorSelection in overview.mjs): if the
// selected row is still present, the ring follows it to its new position; if
// it's genuinely gone, the selection is released (no ring) — it must never
// drift onto an unrelated row.
test.describe('PR overview — keyboard selection tracks identity, not position', () => {
  test('typing a search query that leaves a shorter, differently-ordered row set never relocates the ring onto an unrelated PR', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(4)

    const isSelected = (loc) => loc.evaluate((el) => el.classList.contains('ring-emerald-500/50'))

    // Select the very first row in DOM order — the fixture's stack root,
    // PR 12903 (see tests/fixtures/inbox.json: the 12903→12904 stack renders
    // before the flat sections).
    await page.keyboard.press('Home')
    const first = page.locator('[data-testid="pr-row"][data-pr="12903"]')
    await expect.poll(() => isSelected(first)).toBe(true)

    // Search for a query that resolves to a *single*, unrelated PR (12801),
    // so the buggy positional code would keep selIndex at 0 — now in-bounds
    // of a 1-row list — and wrongly paint the ring on 12801.
    await page.locator('[data-testid="search"]').fill('12801')
    const results = page.locator('[data-testid="search-results"] [data-testid="pr-row"]')
    await expect(results).toHaveCount(1)
    await expect(results.first()).toHaveAttribute('data-pr', '12801')

    // The old PR (12903) is gone from the row set — the ring must NOT have
    // jumped onto the only remaining row (12801). Identity-based reanchoring
    // releases the selection instead of mis-selecting.
    expect(await isSelected(results.first())).toBe(false)

    // Clearing the search restores the original row set; the selection
    // reanchors back onto 12903 by identity — it was never actually lost,
    // just released while its row was out of scope.
    await page.locator('[data-testid="search"]').fill('')
    await expect(rows).toHaveCount(4)
    await expect.poll(() => isSelected(first)).toBe(true)
  })

  test('Escape in the search box blurs it so ArrowDown immediately drives the row list again', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const search = page.locator('[data-testid="search"]')
    await search.click()
    await search.fill('scheduling')
    await expect(page.locator('[data-testid="search-results"] [data-testid="pr-row"]')).toHaveCount(2)

    await search.press('Escape')
    await expect(search).toHaveValue('')
    // The fix: Escape blurs the field, not just clears its value.
    await expect(search).not.toBeFocused()

    // Back on the main row list; ArrowDown must move the keyboard selection
    // immediately — no extra click/Tab needed to "escape" the input first.
    const rows = page.locator('[data-nav-row]')
    await expect(rows).toHaveCount(4)
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => rows.first().evaluate((el) => el.classList.contains('ring-emerald-500/50')))
      .toBe(true)
  })

  test('the "Recent gegenereerd" drawer participates in ArrowDown once open, and closing it releases a selection inside it', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    await page.locator('[data-testid="recent"]').click()
    const recentItems = page.locator('[data-testid="recent-item"]')
    await expect(recentItems.first()).toBeVisible()

    const totalRows = await page.locator('[data-nav-row]').count()
    const prRowCount = await page.locator('[data-testid="pr-row"]').count()
    const recentCount = await recentItems.count()
    expect(totalRows).toBe(prRowCount + recentCount)

    // Walk all the way to the end — past every pr-row into the recent list.
    await page.keyboard.press('Home')
    for (let i = 0; i < totalRows - 1; i++) await page.keyboard.press('ArrowDown')
    const lastRow = page.locator('[data-nav-row]').last()
    await expect(lastRow).toHaveAttribute('data-testid', 'recent-item')
    await expect.poll(() => lastRow.evaluate((el) => el.classList.contains('ring-emerald-500/50'))).toBe(true)

    // Closing the drawer removes that row from the DOM entirely — identity
    // reanchoring must release the selection (no ring anywhere), never
    // silently relocate it onto an unrelated pr-row that happens to now sit
    // at the same numeric position.
    await page.locator('[data-testid="recent"]').click()
    await expect(page.locator('[data-testid="recent-item"]')).toHaveCount(0)
    const anySelected = await page
      .locator('[data-nav-row]')
      .evaluateAll((els) => els.some((el) => el.classList.contains('ring-emerald-500/50')))
    expect(anySelected).toBe(false)
  })
})
