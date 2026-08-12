import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A PR-comment index item that IS anchored to a real block (its own file+
// label matches one, see commentAnchorBlock/anchoredBlocks) can show that
// block "as if the code were already fully expanded" — home.mjs's
// openCommentAnchorDrill opens it as a drilled column, WITHOUT leaving list
// mode: the blokken-index stays visible (unlike an ordinary → into a block's
// own diff, which hides it), the sidebar highlight stays on the comment row
// itself, and the expanded view defaults to Unified — independent of the
// reviewer's own global diffViewMode preference. This ONLY happens on an
// explicit ArrowRight now — merely selecting the row leaves it at rest — and
// a SECOND ArrowRight hands the keyboard into the expanded comments. See
// comments-panel.md.

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
  test('stays at rest on selection, expands on ArrowRight, in Unified, blokken-index still visible', async ({
    page,
  }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // A fresh open lands on the (only, unresolved) comment item by default.
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="0"]')).toContainText('please rename this variable')

    // Merely being selected does NOT open the drilled column anymore —
    // reviewer request: only an explicit ArrowRight does. At rest it reads
    // exactly like any other (unanchored) comment item: the plain read-only
    // commentDetailCard.
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('ArrowRight')

    // The blokken-index never left — unlike an ordinary block's own diff
    // (state.mode==='diff'), which slides it away.
    await expect(page.getByTestId('pr-index')).toBeVisible()

    // The comment item's own top-level card collapses to a narrow rail (the
    // same rail an ordinary block gets once one of ITS children is drilled
    // into) — its anchor block opens as the focused drilled column instead.
    await expect(page.getByTestId('block-collapsed')).toBeVisible()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()
    await expect(drillColumn).toContainText('ContractController::index')

    // Defaults to Unified for this view — the compact split/unified/fit
    // indicator only renders on the card that owns the diff keyboard.
    await expect(drillColumn.getByTestId('diffview-unified')).toHaveClass(/bg-indigo-100/)
    await expect(drillColumn.getByTestId('diffview-split')).not.toHaveClass(/bg-indigo-100/)

    // The sidebar selection itself never moved off the comment row.
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
  })

  test('a second ArrowRight hands the keyboard into the expanded comments', async ({ page }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // opens the drilled column, at rest
    await expect(page.getByTestId('drill-column')).toBeVisible()
    // The comment already shows, but only COMPACT — nothing pre-expanded/
    // pre-focused (reviewer request: no comment card auto-expanded).
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-expanded', 'false')

    await page.keyboard.press('ArrowRight') // hands the keyboard into it
    await expect(item).toHaveAttribute('data-expanded', 'true')
  })

  test('navigating away closes the expanded view again', async ({ page }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('drill-column')).toBeVisible()

    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('pr-index')).toBeVisible()
  })
})
