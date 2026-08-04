import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A genuinely fresh /pr/<id> open — no `?sel=` at all: a bare link, "Open
// review tree"/"Generate" from the PR overview without a remembered
// position, a just-generated PR — must land the reviewer on stop 1 (the
// PR-description/summary column, state.showDescription) instead of the
// block-index, so the very first thing they see is the PR summary, not a
// block (see loadBlocks' `!hadSelParam` branch in home.mjs). A restored
// `?sel=` (a refresh, shared link, or the /pr-overview round trip) must be
// entirely unaffected and keep landing straight on the block-index.
//
// `page.goto` is wrapped by the test harness (see `_fixtures.mjs`) to
// auto-skip past stop 1 for every OTHER spec, which predates this behaviour
// and drives the keyboard assuming the block-index already owns it — this
// spec passes `{ keepDescription: true }` to opt out of that and observe the
// real, unwrapped behaviour.
test.describe('PR Review Tree — fresh open lands on the PR-description column', () => {
  test('a bare /pr/<id> open with no ?sel= shows the PR-info column, and → steps into the block-index', async ({
    page,
  }) => {
    await page.goto('/pr/12903', { keepDescription: true })

    const info = page.getByTestId('pr-info-column')
    await expect(info).toBeVisible()
    await expect(page.getByTestId('pr-info-summary')).toBeVisible()

    // The block-search box grabs the keyboard ambiently on load (see
    // leaveSearchBox's own comment) — leave it so the keys below actually
    // reach onKeydown's showDescription branch, not the search-box branch.
    await leaveSearchBox(page)

    // ↓/↑/Enter do nothing while stop 1 owns the keyboard — only →/← move.
    await page.keyboard.press('ArrowDown')
    await expect(info).toBeVisible()

    // → steps into the block-index (stop 2), which already has its own
    // default-unapproved selection ready (applyDefaultUnapprovedSelection) —
    // see fresh-open-default-selection.spec.mjs for that pick's own rules.
    await page.keyboard.press('ArrowRight')
    await expect(info).toHaveCount(0)
    await expect(page.locator('[data-testid=block-row].bg-indigo-50, [data-testid=block-row].dark\\:bg-indigo-500\\/15')).toHaveCount(1)
  })

  test('a restored ?sel= is unaffected — lands straight on the block-index, not stop 1', async ({ page }) => {
    await page.goto(
      '/pr/12903?sel=' + encodeURIComponent('app/Actions/CreatePaymentAction.php:20'),
      { keepDescription: true },
    )

    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
    await expect(page.getByTestId('pr-index')).toBeVisible()
  })
})
