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

// `over` overrides the anchor's own fields — a test that needs an anchor block
// with real changed rows (the default one resolves to a file this PR doesn't
// touch) passes its own file/label/body.
function mockAnchoredComment(page, over = {}) {
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
          ...over,
        },
      ]),
    }),
  )
}

test.describe('a comment-index item anchored to a real block', () => {
  test('opens automatically on selection as the leading column, blokken-index still visible, but the keyboard stays out until ArrowRight', async ({
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

    // The anchor block opens as the focused drilled column ALREADY, without
    // any further keypress — and the comment item's own top-level column is
    // gone entirely (no narrow rail, no left-edge chevron), so the layout is
    // exactly what navigating to that same block through the code gives:
    // blokken-index, diff card, Onderliggende code, comments. Reviewer
    // request, see commentAnchorColumnHidden (home.mjs).
    await expect(page.getByTestId('block-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('block-column')).toBeHidden()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()
    await expect(drillColumn).toContainText('ContractController::index')
    await expect(drillColumn.getByTestId('drill-left-hint')).toHaveCount(0)

    // The comment already shows next to it, but only COMPACT — nothing
    // pre-expanded/pre-focused (no comment card auto-expanded, per "dan moet
    // de diff niet direct geselecteerd zijn").
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-expanded', 'false')

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
  // back then the collapsed, 56px-wide rail (`block-collapsed`), today the
  // hidden, zero-width block column — instead of the real, focused
  // `drill-column`. Fixed via `focusedColumnEl()` (home.mjs).
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
    // the narrow collapsed rail) — checked as an upper bound rather than an
    // exact match, since the drilled column's own width is content-driven
    // (contentWidthCls, Block.mjs) and can exceed the viewport, in which case
    // positionMenu clamps the menu into view and it ends up NARROWER than the
    // region. Either way it can never be the ~56px rail this test guards
    // against.
    expect(menuBox.width).toBeLessThanOrEqual(drillBox.width + 2)
  })

  // This view used to force its own Unified stand (state.commentAnchorViewMode,
  // a field independent of the global state.diffViewMode). Dropped on reviewer
  // request — "hetzelfde zien als dat je via de code hebt genavigeerd" — so the
  // anchored column now follows whatever stand the reviewer picked elsewhere.
  test('the anchored column keeps the shared diff stand instead of forcing Unified', async ({ page }) => {
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    // Pick a stand inside the anchored column itself — it writes the SHARED
    // state.diffViewMode now, not a private field of this one view.
    await drillColumn.getByTestId('diffview-fit').click()
    await expect(drillColumn.getByTestId('diffview-fit')).toHaveClass(/bg-indigo-100/)

    // Step away and back: the stand survives. It used to be reset to Unified
    // on every fresh open of this view (state.commentAnchorViewMode).
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await row.click()
    await expect(drillColumn).toBeVisible()
    await expect(drillColumn.getByTestId('diffview-fit')).toHaveClass(/bg-indigo-100/)
  })

  // Reviewer request: "als ik navigeer door comments op regels dan wil ik niet
  // dat er 2 dingen geselecteerd zijn, dus selecteer alleen items in blokken
  // index totdat ik naar rechts druk" — plus, once you DO step right, the
  // sidebar row must read as "selected, but the arrows moved on".
  test('nothing in the column reads as selected until ArrowRight, and then the sidebar row hands off', async ({
    page,
  }) => {
    // Its own mock: this test needs an anchor block that actually HAS changed
    // rows (the shared one resolves to an unchanged file, so it could never
    // show an active unit either way).
    await mockAnchoredComment(page, {
      id: 'anchor-changed',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'rename this argument',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'rename this argument' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()
    await expect(drillColumn.locator('code.language-php').first()).toBeVisible()
    // This anchor really does carry changed rows — otherwise the highlight
    // assertions below would pass for the wrong reason.
    await expect(drillColumn.locator('[data-changed]').first()).toBeVisible()

    // Only the sidebar row is selected — the code shows with no active unit.
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(row.locator('text=›')).toHaveClass(/text-indigo-500/)
    await expect(drillColumn.locator('[data-change-active]')).toHaveCount(0)

    // ArrowRight hands the keyboard in: now the column carries the selection
    // and the row steps back to the grey, arrow-less "handed off" look.
    await page.keyboard.press('ArrowRight')
    await expect(drillColumn.locator('[data-change-active]').first()).toBeVisible()
    await expect(row).not.toHaveClass(/bg-indigo-50/)
    await expect(row).toHaveClass(/bg-slate-100/)
    await expect(row.locator('text=›')).toHaveClass(/text-transparent/)
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
