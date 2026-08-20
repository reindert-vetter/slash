import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: "als ik met mijn muis op een diff klik, en in de breedte
// past alles, dan moeten we niets verbergen. Past het niet, verberg dan eerst
// het PR-omschrijvingsblok en daarna de PR-index."
//
// So a MOUSE click into a diff is no longer a step through the left→right nav
// chain (which always hides both left columns): applyDiffColumnFit (home.mjs)
// keeps whichever of them still fits beside <main>'s own column flow, dropping
// the left-most one first. The KEYBOARD path is deliberately unchanged —
// stepping right past a column hides it, as it always did.

test.describe('a mouse click into a diff only hides a left column that no longer fits', () => {
  test('on a wide viewport the pr-index stays visible after clicking a diff row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2600, height: 900 })
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const index = page.getByTestId('pr-index')
    await expect(index).toHaveJSProperty('clientWidth', 414)

    // A click straight into the diff — the same row diff-row-mouse-select.spec
    // uses. There is plenty of width left over here, so nothing is given up.
    const changedRows = page.getByTestId('detail-card').first().locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.nth(0).click()
    await page.waitForTimeout(400) // the aside's own 200ms width transition

    await expect(page).toHaveURL(/mode=diff/)
    await expect(index).toBeVisible()
    await expect(index).toHaveJSProperty('clientWidth', 414)
  })

  test('on a narrow viewport the same click still collapses the pr-index', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const changedRows = page.getByTestId('detail-card').first().locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.nth(0).click()
    await page.waitForTimeout(400)

    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.getByTestId('pr-index')).toHaveJSProperty('clientWidth', 0)
  })

  test('the keyboard path keeps hiding the pr-index, however wide the window is', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 2600, height: 900 })
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // step INTO the diff, the nav-chain way
    await page.waitForTimeout(400)

    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.getByTestId('pr-index')).toHaveJSProperty('clientWidth', 0)
  })

  test('the PR-description column survives a click when it fits, and is dropped before the index when it does not', async ({
    page,
  }) => {
    // Wide enough for BOTH left columns next to this block's own two columns
    // (~2115px of <main> content): 624 + 416 + gaps.
    await page.setViewportSize({ width: 3400, height: 900 })
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowLeft') // stop 1 — the PR-description column
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    const changedRows = page.getByTestId('detail-card').first().locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.nth(0).click()
    await page.waitForTimeout(400)

    // Both left columns fit next to this one small block, so both stay.
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await expect(page.getByTestId('pr-index')).toBeVisible()
    // The keyboard did move into the diff (stop 1 no longer owns it): ↓ walks
    // the diff's own units instead of being swallowed by the description stop.
    await expect(page).toHaveURL(/mode=diff/)

    // Shrink until only one of the two can stay — the description (left-most)
    // goes first, the index survives longer. The threshold moved down with
    // the diff cards themselves: a card's width is now measured in the CODE
    // font's own character advance instead of the card's inherited
    // proportional `ch`, making every content-driven card ~1/3 narrower (see
    // "The chars → px conversion" in .claude/docs/diff-card.md), so at the
    // old 2600px both left columns still fit.
    await page.setViewportSize({ width: 2000, height: 900 })
    await page.waitForTimeout(400)
    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
    await expect(page.getByTestId('pr-index')).toBeVisible()
  })

  // Bug report: "een click op een test index laat blokken index nog wel
  // inklappen" — state.testColumnFocused (stop 2b of the left→right nav
  // chain, see test-class-grouping.md) SURVIVES the diff-mode transition, and
  // used to force the pr-index collapse unconditionally, regardless of
  // state.keepIndexInDiff — so a mouse click into a test class's active
  // method's diff always hid the pr-index even with plenty of width to
  // spare. Fixed: testColumnFocused only forces the collapse while still in
  // list mode; once in diff mode the same keepIndexInDiff fit check as an
  // ordinary block's diff decides.
  test('a click into a test class method diff also keeps the pr-index when it fits', async ({ page }) => {
    await page.setViewportSize({ width: 2600, height: 900 })
    await page.goto('/pr/110')
    await leaveSearchBox(page)

    const index = page.getByTestId('pr-index')
    await expect(index).toHaveJSProperty('clientWidth', 414)

    // Select the test class row, then its first method — this is what puts
    // state.testColumnFocused into the "true straight through a diff click"
    // state the bug report describes.
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    await page.getByTestId('test-method-row').first().click()
    await expect(page).not.toHaveURL(/mode=diff/)

    // A mouse click into the active method's own diff.
    const changedRows = page.getByTestId('detail-card').first().locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.nth(0).click()
    await page.waitForTimeout(400) // the aside's own 200ms width transition

    await expect(page).toHaveURL(/mode=diff/)
    await expect(index).toBeVisible()
    await expect(index).toHaveJSProperty('clientWidth', 414)
  })
})
