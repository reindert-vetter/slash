import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A PR-comment index item that IS anchored to a real block (its own file+
// label matches one, see commentAnchorBlock/anchoredBlocks) shows that block
// "as if the code were already fully expanded" — home.mjs's
// openCommentAnchorDrill opens it as a drilled column automatically while
// merely walking ↑/↓ through the index (reviewer request: "als ik door
// blokken index langs ga, wil ik dat het al uitgeklapt is"), WITHOUT leaving
// list mode: the blokken-index stays visible while it is still being walked
// with ↑/↓ (it does slide away from the first → onward, see the dedicated test
// below), the sidebar highlight stays on the comment row itself, and the
// expanded view defaults to Unified — independent of the reviewer's own
// global diffViewMode preference. Its own comment+chat also render fully
// expanded (never the compact preview) and scoped to ONLY this row's own
// comment — see "Comments op regels shows only its own comment" in
// comments-panel.md. Deliberately does NOT move the keyboard/focus in — no
// comment card steals the keyboard — only an explicit ArrowRight hands the
// keyboard into the already-visible expanded comments; a second ArrowRight
// always lands on this exact comment, never skips to Underlying code. See
// comments-panel.md.

// `over` overrides the anchor's own fields — a test that needs an anchor block
// with real changed rows (the default one resolves to a file this PR doesn't
// touch) passes its own file/label/body. `extra` appends further comment rows
// (see the "shows only its own comment" test below, which needs a SECOND,
// unrelated comment on the same block to prove it stays hidden).
function mockAnchoredComment(page, over = {}, extra = []) {
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
        ...extra,
      ]),
    }),
  )
}

test.describe('a comment-index item anchored to a real block', () => {
  test('opens automatically on selection as the leading column, already fully expanded, blokken-index still visible, but the keyboard stays out until ArrowRight', async ({
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

    // The comment already shows FULLY EXPANDED (the real thread, not just a
    // compact preview) the moment the row is selected — reviewer request:
    // "comment en chat moet ook volledig opengevouwen zijn" — even though
    // nothing is pre-FOCUSED yet (no comment card steals the keyboard, per
    // "dan moet de diff niet direct geselecteerd zijn").
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await expect(item).toHaveAttribute('data-expanded', 'true')

    // The sidebar selection itself never moved off the comment row.
    await expect(row).toHaveClass(/bg-indigo-50/)

    // A FIRST ArrowRight only reveals the diff as "entered" (see the
    // dedicated highlight test below) — the keyboard stays on the sidebar,
    // the comment item stays expanded exactly as before. Only a SECOND
    // ArrowRight hands the keyboard INTO the already-open, already-visible
    // expanded view.
    await page.keyboard.press('ArrowRight')
    await expect(item).toHaveAttribute('data-expanded', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(item).toHaveAttribute('data-expanded', 'true')
  })

  // Reviewer request: "als ik navigeer door comments op regels wil ik aan de
  // rechterkant alleen die comment en chat zien" — a SECOND, unrelated open
  // comment on the exact same block must not also render next to this row's
  // own drilled anchor, even though it would ordinarily fall under the same
  // containment check (commentUnder) since both have an unknown rowStart
  // (-1, matches every unit of the block). Only cs.scope.onlyIds (set by
  // home.mjs's commentScope while isCommentAnchorDrillActive) narrows it back
  // down to exactly this row's own comment.
  test('shows only its own comment, not another unrelated one on the same block', async ({ page }) => {
    await mockAnchoredComment(page, {}, [
      {
        id: 'anchor-2',
        runId: 'run-anchor-2',
        pr: 12903,
        file: 'app/Http/Controllers/Api/ContractController.php',
        label: 'ContractController::index',
        line: 42,
        author: 'reviewer',
        body: 'a completely different remark',
        createdAt: new Date().toISOString(),
        reactionCount: 0,
        status: 'open',
        source: 'ui',
        kind: '',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.locator('[data-idx]').filter({ hasText: 'please rename this variable' }).click()

    const items = page.getByTestId('comment-item')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('please rename this variable')
    // The second comment is a "Comments op regels" row of its own too (it
    // sorts into the sidebar independently), so this asserts its absence
    // scoped to the actual comment-item cards, not the whole page (which
    // still legitimately shows its snippet in the sidebar list).
    await expect(items.first()).not.toContainText('a completely different remark')
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

    // The stand toggle only shows once the diff is "entered" (diffActive,
    // gated on commentAnchorAwaitingEntry — see the border test above): a
    // first ArrowRight reveals it, still without handing the keyboard in.
    await page.keyboard.press('ArrowRight')

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
    await page.keyboard.press('ArrowRight')
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

    // A FIRST ArrowRight only "selects the code": the active row lights up,
    // but the sidebar keeps the keyboard (still the indigo selected look,
    // not yet handed off) — reviewer request: "als ik 1 keer naar rechts ga,
    // selecteer code, als ik 2 keer naar rechts ga selecteer dan eerste
    // openstaande comment".
    await page.keyboard.press('ArrowRight')
    await expect(drillColumn.locator('[data-change-active]').first()).toBeVisible()
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(row.locator('text=›')).toHaveClass(/text-indigo-500/)

    // A SECOND ArrowRight hands the keyboard in: now the column carries the
    // selection and the row steps back to the grey, arrow-less "handed off"
    // look.
    await page.keyboard.press('ArrowRight')
    await expect(row).not.toHaveClass(/bg-indigo-50/)
    await expect(row).toHaveClass(/bg-slate-100/)
    await expect(row.locator('text=›')).toHaveClass(/text-transparent/)
  })

  // Reviewer request: "als ik een comment selecteer in de index, wil ik dat er
  // maar in kolom/blok geselecteerd is (en blauw border heeft) ... als ik 2
  // keer naar rechts ga, wil ik ook 2x naar links moeten om op dezelfde plek
  // te komen". Two bugs: (1) the drilled anchor column's blue border
  // (diffActive) used to show even before a FIRST ArrowRight — while only the
  // sidebar row should read as selected — because it wasn't gated on
  // commentAnchorAwaitingEntry like the active-row highlight already was; (2)
  // walking back with ← used to skip a step (2x→ in, only 1x← needed to fully
  // exit) because the plain list-mode ← branch unconditionally called
  // enterDescriptionFromList() instead of first undoing commentAnchorEntered.
  test('only one blue border at a time, and 2x ArrowLeft mirrors 2x ArrowRight', async ({ page }) => {
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

    // Before any ArrowRight: only the sidebar row reads as selected, the
    // drilled card must NOT show the blue diffActive border yet.
    await expect(row).toHaveClass(/bg-indigo-50/)
    const card = drillColumn.locator('[data-diff-col-key]').first()
    await expect(card).not.toHaveClass(/border-indigo-300/)

    // First ArrowRight: reveals the active-row highlight (existing test
    // above) and now the card's own border too.
    await page.keyboard.press('ArrowRight')
    await expect(card).toHaveClass(/border-indigo-300/)
    await expect(row).toHaveClass(/bg-indigo-50/)

    // Second ArrowRight: hands the keyboard into the related panel.
    await page.keyboard.press('ArrowRight')
    await expect(row).toHaveClass(/bg-slate-100/)

    // First ArrowLeft undoes the second step only (back to the "diff
    // entered" stop: sidebar still selected, card border still blue).
    await page.keyboard.press('ArrowLeft')
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(card).toHaveClass(/border-indigo-300/)

    // Second ArrowLeft undoes the first step: back to plain comment-index
    // selection, no card border, drilled column still open.
    await page.keyboard.press('ArrowLeft')
    await expect(card).not.toHaveClass(/border-indigo-300/)
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(drillColumn).toBeVisible()
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

  // Reviewer request: "als ik naar rechts ga uit een comment op regel blokken
  // index lijst, dan mag je eerste blok wegschuiven net zoals je doet als je
  // een code blok selecteert uit de blokken index" — this view stays in list
  // mode on purpose (openCommentAnchorDrill), so BlockList's own diff-mode
  // collapse never fired for it and the pr-index stayed put where ordinary
  // code navigation slides it away. state.commentAnchorEntered is now a
  // fourth collapse case (BlockList.mjs), so the FIRST → hides it and ←
  // (which undoes exactly that one step) brings it back.
  test('the first ArrowRight slides the blokken-index away, ArrowLeft brings it back', async ({ page }) => {
    await mockAnchoredComment(page, {
      id: 'anchor-changed',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'rename this argument',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const index = page.getByTestId('pr-index')
    await page.locator('[data-idx]').filter({ hasText: 'rename this argument' }).click()
    await expect(page.getByTestId('drill-column')).toBeVisible()
    // Still fully there while merely walking the index with ↑/↓.
    await expect(index).toBeVisible()

    // First → ("selecteer code"): collapsed to a real zero width, giving its
    // space back to <main> — not merely translated out of view.
    await page.keyboard.press('ArrowRight')
    await expect(index).toHaveJSProperty('clientWidth', 0)

    // Second → only hands the keyboard on; the index stays gone.
    await page.keyboard.press('ArrowRight')
    await expect(index).toHaveJSProperty('clientWidth', 0)

    // Two ← mirror the two → (see the border test above), and the index is
    // back at the stop where only the sidebar row reads as selected.
    await page.keyboard.press('ArrowLeft')
    await expect(index).toHaveJSProperty('clientWidth', 0)
    await page.keyboard.press('ArrowLeft')
    await expect(index).toBeVisible()
    await expect(index).not.toHaveJSProperty('clientWidth', 0)
  })

  // A MOUSE click into the comment column skips onKeydown's ArrowRight branch
  // entirely, so it used to leave commentAnchorEntered false: no highlight, no
  // blue border, and an index still standing. The state.indexHandedOff watch
  // (home.mjs) catches up, per "a click runs the same function a key runs"
  // (mouse-navigation.md).
  test('clicking straight into the comment column collapses the index too', async ({ page }) => {
    await mockAnchoredComment(page, {
      id: 'anchor-changed',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'rename this argument',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const index = page.getByTestId('pr-index')
    await page.locator('[data-idx]').filter({ hasText: 'rename this argument' }).click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()
    await expect(index).toBeVisible()

    await page.getByTestId('comment-item').first().click()
    await expect(index).toHaveJSProperty('clientWidth', 0)
    // The same flag also reveals the diff's own "entered" look.
    await expect(drillColumn.locator('[data-change-active]').first()).toBeVisible()
  })
})
