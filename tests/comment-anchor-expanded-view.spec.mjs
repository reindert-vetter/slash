import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A PR-comment index item that IS anchored to a real block (its own file+
// label matches one, see commentAnchorBlock/anchoredBlocks) shows that block
// "as if the code were already fully expanded" — home.mjs's
// openCommentAnchorDrill opens it as a drilled column automatically while
// merely walking ↑/↓ through the index (reviewer request: "als ik door
// blokken index langs ga, wil ik dat het al uitgeklapt is"), WITHOUT leaving
// list mode: the blokken-index stays visible (unlike an ordinary → into a
// block's own diff, which hides it), the sidebar highlight stays on the
// comment row itself, and the expanded view defaults to Unified —
// independent of the reviewer's own global diffViewMode preference.
// Deliberately does NOT move the keyboard/focus in — no comment card is
// auto-expanded — only an explicit ArrowRight hands the keyboard into the
// already-visible expanded comments. See comments-panel.md.

function mockAnchoredComment(page) {
  const now = new Date().toISOString()
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'anchor-1',
          runId: 'run-anchor-1',
          pr: 12903,
          file: 'app/Http/Controllers/Api/ContractController.php',
          label: 'ContractController::index',
          line: 30,
          author: 'reviewer',
          body: 'please rename this variable',
          createdAt: now,
          reactionCount: 0,
          status: 'open',
          source: 'ui',
          kind: '',
          reactions: [],
          rowStart: -1,
          rowEnd: -1,
        },
      ]),
    }),
  )
}

test.describe('a comment-index item anchored to a real block', () => {
  test('opens automatically on selection, in Unified, blokken-index still visible, but the keyboard stays out until ArrowRight', async ({
    page,
  }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // This comment sorts under "Comments op regels" (b.lineAnchored) — UNDER
    // the changed-files categories — so a fresh open's default selection
    // (applyDefaultUnapprovedSelection, plain list order) now lands on an
    // ordinary unapproved block first, same as if there were no comment at
    // all; select the comment row directly instead.
    const row = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await row.click()
    await expect(row).toHaveClass(/bg-indigo-50/)

    // The blokken-index never left — unlike an ordinary block's own diff
    // (state.mode==='diff'), which slides it away.
    await expect(page.getByTestId('pr-index')).toBeVisible()

    // The comment item's own top-level card collapses to a narrow rail (the
    // same rail an ordinary block gets once one of ITS children is drilled
    // into) — its anchor block opens as the focused drilled column instead —
    // ALREADY, without any further keypress.
    await expect(page.getByTestId('block-collapsed')).toBeVisible()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()
    await expect(drillColumn).toContainText('ContractController::index')

    // The comment already shows next to it, but only COMPACT — nothing
    // pre-expanded/pre-focused (no comment card auto-expanded, per "dan moet
    // de diff niet direct geselecteerd zijn").
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-expanded', 'false')

    // Defaults to Unified for this view — the compact split/unified/fit
    // indicator only renders on the card that owns the diff keyboard.
    await expect(drillColumn.getByTestId('diffview-unified')).toHaveClass(/bg-indigo-100/)
    await expect(drillColumn.getByTestId('diffview-split')).not.toHaveClass(/bg-indigo-100/)

    // The sidebar selection itself never moved off the comment row.
    await expect(row).toHaveClass(/bg-indigo-50/)

    // ArrowRight hands the keyboard INTO the already-open, already-visible
    // expanded view.
    await page.keyboard.press('ArrowRight')
    await expect(item).toHaveAttribute('data-expanded', 'true')
  })

  // Bug report: "als ik een onderliggende code open doordat ik een comment
  // open dat het menu op de juiste blok zichtbaar is (niet in de parent)".
  // Enter on the comment-index row (still selected, not yet stepped in with
  // ArrowRight) opens its own 'prComment' menu (selectedComment()'s branch in
  // onKeydown) — menuAnchor/menuRegion used to fall back to the bare
  // `[data-testid="block-column"]` selector once `comment-detail-card` isn't
  // rendered (which it never is while the anchor is drilled open, see
  // DetailPanel's own !focusedHere branch), and that selector still matched —
  // just the collapsed, 56px-wide rail (`block-collapsed`) instead of the
  // real, focused `drill-column`. Fixed via `focusedColumnEl()` (home.mjs).
  test('the comment-index-item menu opens on the drilled anchor column, not the collapsed rail', async ({
    page,
  }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.locator('[data-idx]').filter({ hasText: 'please rename this variable' }).click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // A real menu, not the narrow rail's width (~56px).
    const menuBox = await menu.boundingBox()
    const drillBox = await drillColumn.boundingBox()
    expect(menuBox.width).toBeGreaterThan(200)
    // Sized to the drilled column's own width (menuRegion resolves to it, not
    // the narrow collapsed rail) — checked via WIDTH rather than the exact
    // left edge, since the drilled column's own width is content-driven now
    // (contentWidthCls, Block.mjs) and can exceed the viewport, in which case
    // positionMenu deliberately clamps the menu's left edge into view while
    // still matching its width to the region.
    expect(Math.abs(menuBox.width - drillBox.width)).toBeLessThan(2)
  })

  test('navigating away closes the expanded view again', async ({ page }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // See the test above: a fresh open no longer lands here by default (the
    // comment sorts under "Comments op regels", below the changed-files
    // categories) — select it directly first.
    await page.locator('[data-idx]').filter({ hasText: 'please rename this variable' }).click()
    await expect(page.getByTestId('drill-column')).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('pr-index')).toBeVisible()
  })
})
