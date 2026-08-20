import { test, expect } from './_fixtures.mjs'

// The methodes-kolom (stop 2b, see .claude/docs/test-class-grouping.md) after a
// RESTORE: it must actually be on screen, and `?tcol=1` must hand ↑/↓ straight
// back to it.
//
// Reported bug: on a restored `?sel=testclass:…` link the index showed "52/116"
// for a test class while the diff showed a single fully-approved method — the
// methodes-kolom holding the other 7 methods was rendered but scrolled out of
// view behind the pr-index, because scrollFocusIntoView() aligned <main> on the
// block-column (the column's RIGHT neighbour) on every code load. ↓ then also
// stepped the pr-index instead of the methods, since stop-2b focus was purely
// ephemeral and never restored.
//
// Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json) — TriggersIndexTest
// with two changed methods, SettingsStoreTest with one.
const PR = 110
const CLASS_REF = 'testclass:tests/Feature/TriggersIndexTest.php::TriggersIndexTest'
const METHOD_REF = 'tests/Feature/TriggersIndexTest.php:7'
const restoreUrl = (extra = '') =>
  `/pr/${PR}?sel=${encodeURIComponent(CLASS_REF)}&tmethod=${encodeURIComponent(METHOD_REF)}${extra}`

// Measured in ONE in-page shot and polled by the callers: <main> and the
// pr-index animate their width/offset for 200ms after a focus change (the
// pr-index slides away when stop 2b takes focus), so two separate
// boundingBox() calls can catch the two boxes at different moments of that
// transition and read as "outside" while nothing is actually clipped. Never
// assert a transient state — see .claude/docs/testing-playwright.md.
const columnInsideMain = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('[data-testid="detail-panel"]')
    const col = document.querySelector('[data-testid="test-methods-column"]')
    if (!main || !col) return null
    const m = main.getBoundingClientRect()
    const c = col.getBoundingClientRect()
    return c.left >= m.left - 1 && c.right <= m.right + 1
  })

test.describe('the methodes-kolom survives a restore', () => {
  // A narrow viewport is load-bearing: the bug is a horizontal scroll of
  // <main>, which only happens once its column flow is wider than the viewport.
  test.use({ viewport: { width: 760, height: 700 } })

  test('a restored test_class link leaves the methodes-kolom on screen', async ({ page }) => {
    await page.goto(restoreUrl())

    const column = page.getByTestId('test-methods-column')
    await expect(column).toBeVisible()
    await expect(page.getByTestId('test-method-row')).toHaveCount(2)

    // <main> is at its rest position and the column starts inside it — not
    // scrolled one column width to the left, hidden behind the pr-index.
    const main = page.getByTestId('detail-panel')
    await expect
      .poll(async () => main.evaluate((el) => el.scrollLeft), { message: '<main> scrollLeft' })
      .toBe(0)
    await expect
      .poll(() => columnInsideMain(page), { message: 'methodes-kolom inside <main>' })
      .toBe(true)
  })

  test('→ onto the column keeps it in view and records ?tcol=1', async ({ page }) => {
    await page.goto(restoreUrl())
    await page.keyboard.press('ArrowRight')

    const column = page.getByTestId('test-methods-column')
    await expect(column).toHaveClass(/border-indigo-300|dark:border-indigo-500/)
    await expect(page).toHaveURL(/tcol=1/)

    await expect
      .poll(() => columnInsideMain(page), { message: 'methodes-kolom inside <main>' })
      .toBe(true)
    await expect
      .poll(() => page.getByTestId('detail-panel').evaluate((el) => el.scrollLeft), {
        message: '<main> scrollLeft',
      })
      .toBe(0)
  })

  test('?tcol=1 gives ↑/↓ to the methods, without it the pr-index keeps them', async ({ page }) => {
    // With the param: the column owns the keyboard immediately, no → first.
    await page.goto(restoreUrl('&tcol=1'))
    await expect(page.getByTestId('test-methods-column')).toHaveClass(
      /border-indigo-300|dark:border-indigo-500/,
    )
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('test-method-row').nth(1)).toHaveClass(
      /bg-indigo-50|dark:bg-indigo-500\/15/,
    )
    // Still the same class row, one method further.
    await expect(page).toHaveURL(/TriggersIndexTest/)
    await expect(page).toHaveURL(/tmethod=[^&]*%3A12/)

    // Without it: an ordinary restored selection, so the pr-index keeps ↑/↓ and
    // steps to the neighbouring row — TriggersIndexTest is the LAST row of this
    // fixture (groupTestClasses appends the class rows), so ↑ is the step that
    // moves. The index must not lose ↑/↓ after every refresh on a test class.
    await page.goto(restoreUrl())
    await expect(page.getByTestId('test-methods-column')).not.toHaveClass(
      /border-indigo-300|dark:border-indigo-500/,
    )
    await page.keyboard.press('ArrowUp')
    await expect(page).toHaveURL(/SettingsStoreTest/)
  })
})
