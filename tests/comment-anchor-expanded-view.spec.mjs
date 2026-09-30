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
// expanded view writes/reads the SHARED global diffViewMode (no private
// stand), defaulting to 'fit' on every fresh open — see "the anchored column
// defaults to fit on every fresh open" below. Its own comment+chat also render fully
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

  // Reviewer report: "ook als ik in de blokken index zit, toch schiet het soms
  // naar rechts". The auto-drill sets focusLevel=1 while the keyboard stays in
  // the index, and scrollFocusIntoView used to align that drilled column
  // flush-left — which, since AppColumns is one scroll space for the whole
  // row, pushed the index itself off the left edge (re-run on every code
  // load). Until the first → the row must stay at its rest position.
  test('keeps the row at rest (index visible) while the keyboard is still in the index', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 })
    await mockAnchoredComment(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'please rename this variable' })
    await row.click()
    await expect(page.getByTestId('drill-column')).toBeVisible()
    // Give the smooth scroll and any code-load re-run time to land.
    await page.waitForTimeout(800)
    const scrollLeft = await page.getByTestId('app-columns').evaluate((el) => el.scrollLeft)
    expect(scrollLeft).toBe(0)
    await expect(page.getByTestId('pr-index')).toBeInViewport()
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

  // Bug report: "ik zie rechts alleen de eerste warning van de 3 [...] als ik
  // in de blokken index naar de 2e ga, wil ik rechts ook alleen de 2e zien".
  // Two separate "Comments op regels" rows that resolve to the SAME anchor
  // block (two AI-controle findings on different lines of one function) used
  // to keep showing the FIRST one's thread after stepping to the second row:
  // commentAnchorBlock resolves purely by file+label, so
  // openCommentAnchorDrill's own "already open on this anchor, leave the
  // cursor alone" guard fired on the SHARED block instead of on "this exact
  // row was already selected", and state.drillCursor (which
  // commentTarget()/commentUnder scope the visible comment down to) never
  // moved to the second row's own line/unit.
  //
  // The anchor's own diff is mocked here (route on /api/code) so the two
  // pinned rows land on two unambiguous, well-separated 'line' units,
  // independent of whatever this fixture PR's real diff happens to contain.
  test('switching between two rows anchored to the SAME block shows the newly selected one, not the first', async ({
    page,
  }) => {
    const file = 'app/Http/Controllers/Api/ContractController.php'
    const label = 'ContractController::index'
    const oldText = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    const newLines = Array.from({ length: 10 }, (_, i) => `line${i}`)
    newLines[1] = 'changedLineOne'
    newLines[8] = 'changedLineTwo'
    await page.route('**/api/code**', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('name') !== 'index') {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          file,
          old: { start: 1, end: 10, text: oldText },
          new: { start: 1, end: 10, text: newLines.join('\n') },
        }),
      })
    })

    const bodyOne = 'eerste AI-risicowaarschuwing op regel een'
    const bodyTwo = 'tweede AI-risicowaarschuwing op regel acht'
    await mockAnchoredComment(
      page,
      { id: 'anchor-1', file, label, line: 2, body: bodyOne, source: 'ai', kind: '', gran: 'line', rowStart: 1, rowEnd: 1 },
      [
        {
          id: 'anchor-2',
          runId: 'run-anchor-2',
          pr: 12903,
          file,
          label,
          line: 9,
          author: 'AI check',
          body: bodyTwo,
          createdAt: new Date().toISOString(),
          reactionCount: 0,
          status: 'open',
          source: 'ai',
          kind: '',
          reactions: [],
          gran: 'line',
          rowStart: 8,
          rowEnd: 8,
        },
      ],
    )
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const rowOne = page.locator('[data-idx]').filter({ hasText: bodyOne })
    const rowTwo = page.locator('[data-idx]').filter({ hasText: bodyTwo })
    await rowOne.click()
    await expect(page.getByTestId('comment-item').first()).toContainText(bodyOne)

    await rowTwo.click()
    const items = page.getByTestId('comment-item')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText(bodyTwo)
    await expect(items.first()).not.toContainText(bodyOne)

    // And back the other way, so this isn't just "the last one wins".
    await rowOne.click()
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText(bodyOne)
    await expect(items.first()).not.toContainText(bodyTwo)
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
  // anchored column writes/reads the SHARED state.diffViewMode, not a private
  // field. A later, separate reviewer request ("wil ik mode 'Alleen nieuwe
  // code, breedte volgt de code' zien, ook als ik naar rechts druk")
  // reintroduced a default — but as an INITIAL stand only, mirroring the
  // allChangesAreSingleLine/allChangesAreAdditionsOnly auto-jump-to-'unified'
  // in diff-card.md: every FRESH open of a comment/chat-op-regel anchor jumps
  // to 'fit', but a manual pick made while that exact row stays selected
  // survives (↑/↓/→ never re-trigger it, only a genuinely new selection).
  test('the anchored column defaults to fit on every fresh open, but a manual pick survives while the row stays selected', async ({
    page,
  }) => {
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

    // Fresh open, nothing picked yet: defaults to 'fit' (the global
    // state.diffViewMode's own default is 'split', so this proves the
    // anchor's own auto-jump fired, not just an unrelated default).
    await expect(drillColumn.getByTestId('diffview-fit')).toHaveClass(/bg-indigo-100/)

    // Pick a different stand inside the anchored column itself — it writes
    // the SHARED state.diffViewMode, not a private field of this one view —
    // and it survives a re-render while this exact row stays selected (the
    // indicator itself only renders while diffActive() is true — i.e. before
    // the SECOND ArrowRight hands the keyboard into the comments/Claude
    // column, an orthogonal, pre-existing gate — so this checks the pick
    // sticks across an ordinary reactive re-render, not across handing the
    // keyboard further in).
    await drillColumn.getByTestId('diffview-split').click()
    await expect(drillColumn.getByTestId('diffview-split')).toHaveClass(/bg-indigo-100/)
    await expect(drillColumn.getByTestId('diffview-fit')).not.toHaveClass(/bg-indigo-100/)

    // Step away and back: a genuinely NEW open of this same row re-applies
    // the 'fit' default — it is an initial stand, not a permanent override.
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

  // Reported bug: "als ik resolve en ik naar een andere comment, dan zie ik
  // nu bovenin de chat ipv onderin". This auto-expanded
  // thread (isAnchorOnlyComment) never gets the keyboard (see the doc comment
  // above), so it never went through toComment()'s own scroll-to-bottom — the
  // freshly mounted [data-testid=comment-thread] kept its DOM-default
  // scrollTop (the TOP) instead of showing the newest reply. Fixed via
  // primeAnchorThreadScroll (RelatedPanel.mjs), called from
  // openCommentAnchorDrill (home.mjs). A long run of replies is needed to
  // actually overflow the thread's own max-h-[38vh] scroller.
  test('the auto-expanded thread lands scrolled to its newest reply, not the top', async ({ page }) => {
    const reactions = Array.from({ length: 20 }, (_, i) => ({
      id: 'r-' + i,
      author: 'reviewer',
      source: 'ui',
      body: 'reply number ' + i + ' — '.repeat(20),
    }))
    await mockAnchoredComment(page, { body: 'please rename this variable', reactions })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.locator('[data-idx]').filter({ hasText: 'please rename this variable' }).click()
    const thread = page.getByTestId('comment-thread')
    await expect(thread).toBeVisible()
    await expect(thread.locator('[data-testid=reaction-bubble]').last()).toBeVisible()
    // Give the deferred (requestAnimationFrame) scroll-to-bottom a moment —
    // but bounded well UNDER the 5s comment-poll interval (loadComments'
    // refreshTimer, RelatedPanel.mjs), which also happens to call
    // scrollCommentThreadToBottom() on every tick and would otherwise mask a
    // regression here a few seconds late instead of failing.
    await expect
      .poll(
        () =>
          thread.evaluate((el) => (el.scrollHeight > el.clientHeight ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2 : null)),
        { timeout: 1500 },
      )
      .toBe(true)
  })

  // Reported bug: "als ik een onderliggende kaart open van een comment, kan
  // ik daarna niet meer naar beneden drukken want dan selecteert het de
  // blokken index". Reproduces the exact sequence from the reviewer's own
  // debug-log recording: select the anchored comment row → ArrowRight (enter,
  // still on the sidebar) → ArrowRight (into the comment thread) → ArrowDown
  // (advances to the anchor's own Underlying-code panel) → open a resolved
  // child from there (drillIntoChild, a SECOND state.drill entry,
  // state.focusLevel=2) → Shift+ArrowDown. That last key used to fall
  // through to the generic list-mode branch and jump the SIDEBAR selection
  // to a different row, discarding the child's own drilled diff — see "A
  // child drilled from inside the anchor's own panel must own ↑/↓ too" in
  // .claude/docs/comments-panel.md.
  test('a child drilled from inside the anchor panel keeps ↓/Shift+↓ on its own diff, not the sidebar', async ({
    page,
  }) => {
    // A RESOLVED-CALL target, deliberately NOT a relation child: Psp is never
    // one of this PR's own changed files (see tests/_setup.mjs), so
    // Psp::createPayment resolves to a synthetic frame with no row of its
    // own in state.blocks — it stays nested under the anchor exactly like
    // before handleRelatedDrill's jump-vs-nest split (see
    // comments-panel.md's "A child with its own place in the blokken-index
    // jumps there instead of nesting" — a relation child WITH its own
    // state.blocks row, findOrCreateCustomer, now jumps away instead of
    // nesting, which is exactly what this test must NOT trigger, so it
    // switched fixtures rather than assert stale behavior).
    await page.route('**/api/callresolve?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            callerId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            callKey: 'createPayment',
            status: 'resolved',
            kind: 'method_call',
            childFile: 'app/Support/Psp.php',
            childClass: 'Psp',
            childMethod: 'createPayment',
            childLine: 12,
            childCode: 'function createPayment($input) {}',
            model: '',
            confidence: '',
            updatedAt: new Date().toISOString(),
          },
        ],
      })
    })
    await mockAnchoredComment(page, {
      id: 'anchor-deep',
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

    // First → enters (still on the sidebar), second → steps into the
    // comment thread, ↓ from there advances into the Underlying-code panel
    // (advanceFromComment → enterRelated, no other comment/task to land on
    // first).
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')

    const child = page.getByTestId('related-item').filter({ hasText: 'Psp::createPayment' })
    await expect(child).toBeVisible()
    await child.click()

    // The anchor collapsed to a rail, the child is now the sole focused
    // drilled column.
    await expect(page.getByTestId('drill-collapsed')).toBeVisible()
    await expect(drillColumn).toContainText('Psp::createPayment')

    await expect(row).toHaveClass(/bg-indigo-50/)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')

    // The sidebar selection (and thus the drilled child) must not have moved.
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(drillColumn).toContainText('Psp::createPayment')
    await expect(page.getByTestId('drill-collapsed')).toBeVisible()

    // A plain ↓ (no Shift) must walk the child's own change groups too.
    await page.keyboard.press('ArrowDown')
    await expect(row).toHaveClass(/bg-indigo-50/)
    await expect(drillColumn).toContainText('Psp::createPayment')
  })

  // Follow-up reported bug, same debug-log session: "ik kan vervolgens niet
  // meer op enter drukken op wat ik dan heb geselecteerd" — Enter on the same
  // deep-drilled child (focusLevel > 1) used to reopen the comment ROW's own
  // menu ("Beantwoorden"/"Resolve comment", via selectedComment() staying
  // truthy — openCommentAnchorDrill never touches state.selected) instead of
  // the ordinary block palette that already targets the drilled child + its
  // active line-range. See "A child drilled from inside the anchor's own
  // panel must own ↑/↓ too" (Enter/`/` addendum) in
  // .claude/docs/comments-panel.md.
  test('Enter on a child drilled from inside the anchor panel opens the block palette, not the comment menu', async ({
    page,
  }) => {
    // A RESOLVED-CALL target, deliberately NOT a relation child: Psp is never
    // one of this PR's own changed files (see tests/_setup.mjs), so
    // Psp::createPayment resolves to a synthetic frame with no row of its
    // own in state.blocks — it stays nested under the anchor exactly like
    // before handleRelatedDrill's jump-vs-nest split (see
    // comments-panel.md's "A child with its own place in the blokken-index
    // jumps there instead of nesting" — a relation child WITH its own
    // state.blocks row, findOrCreateCustomer, now jumps away instead of
    // nesting, which is exactly what this test must NOT trigger, so it
    // switched fixtures rather than assert stale behavior).
    await page.route('**/api/callresolve?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            callerId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            callKey: 'createPayment',
            status: 'resolved',
            kind: 'method_call',
            childFile: 'app/Support/Psp.php',
            childClass: 'Psp',
            childMethod: 'createPayment',
            childLine: 12,
            childCode: 'function createPayment($input) {}',
            model: '',
            confidence: '',
            updatedAt: new Date().toISOString(),
          },
        ],
      })
    })
    await mockAnchoredComment(page, {
      id: 'anchor-deep-2',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'rename this argument too',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'rename this argument too' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')

    const child = page.getByTestId('related-item').filter({ hasText: 'Psp::createPayment' })
    await expect(child).toBeVisible()
    await child.click()
    await expect(drillColumn).toContainText('Psp::createPayment')

    // Extend the child's own line range one step, exactly like the debug-log
    // reproduction, then Enter.
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')
    await page.keyboard.press('Enter')

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // The ordinary block palette's default (2nd, right after "Sluit menu")
    // item is an approve action on the selected line(s) — never the comment
    // row's own "Beantwoorden"/"Resolve comment".
    await expect(menu).not.toContainText('Beantwoorden')
    await expect(menu).not.toContainText('Resolve comment')
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur')

    // Bug found AFTER the above landed: menuAnchor()/menuRegion() still
    // anchored/sized the menu against pr-index (isIndexMenu(), unaware of
    // state.focusLevel) — collapsed to width 0 at this depth
    // (state.commentAnchorEntered), so the menu rendered as an unusable ~2px
    // sliver despite passing every text-only assertion above. Assert a real
    // width so this class of regression fails loudly instead of silently.
    const box = await menu.boundingBox()
    expect(box.width).toBeGreaterThan(100)
  })

  // Reviewer request: "als ik klik om een onderliggende kaart van een blok
  // van een comment op regel (of chat op regel ofzo), dan moet ik naar de
  // plek toe waar die ook onderliggende code is, maar dan naar de normale
  // plek met die aangepaste code waar alle comments enzo bij staan." A child
  // clicked from inside the anchor's OWN Underlying-code panel that ALSO has
  // its own ordinary row in state.blocks (a relation child, per
  // recomputeLeftList's own doc comment — unlike a resolved-call target's
  // definition, which stays excluded even when it's a real, changed PR
  // block) jumps to that ordinary place instead of nesting as yet another
  // drilled column under the special comment-anchor sub-view. See
  // "A child with its own place in the blokken-index jumps there instead of
  // nesting" in comments-panel.md.
  test('a child with its own place in the blokken-index jumps there instead of nesting, on click', async ({
    page,
  }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            kind: 'event_listener',
          },
        ],
      })
    })
    await mockAnchoredComment(page, {
      id: 'anchor-jump',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'jump to the real place',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'jump to the real place' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')

    // findOrCreateCustomer IS a real, changed PR block in this fixture — it
    // keeps its own row in the blokken-index (a relation child stays in
    // state.blocks, unlike a resolved-call target's definition).
    const child = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(child).toBeVisible()
    await child.click()

    // The whole comment-anchor sub-view is gone — no drilled column at all —
    // and the ordinary top-level block-column is back, showing the CHILD,
    // not the anchor.
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.getByTestId('drill-collapsed')).toHaveCount(0)
    const blockColumn = page.getByTestId('block-column')
    await expect(blockColumn).toBeVisible()
    await expect(blockColumn).toContainText('findOrCreateCustomer')

    // The sidebar itself now highlights findOrCreateCustomer's own row, not
    // the comment row that was selected before.
    const targetRow = page.locator('[data-idx]').filter({ hasText: 'CreatePaymentAction::findOrCreateCustomer' })
    await expect(targetRow).toHaveClass(/bg-indigo-50/)
  })

  // Same scenario, via Enter instead of a click — mouse-navigation.md's rule
  // 1: a click never becomes a second, diverging implementation of what a
  // key already does, so handleRelatedDrill is the SAME function for both.
  test('a child with its own place in the blokken-index jumps there instead of nesting, on Enter', async ({
    page,
  }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            kind: 'event_listener',
          },
        ],
      })
    })
    await mockAnchoredComment(page, {
      id: 'anchor-jump-enter',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'jump to the real place via enter',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'jump to the real place via enter' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')

    const child = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(child).toBeVisible()
    await expect(child).toHaveAttribute('data-active', 'true')
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.getByTestId('drill-collapsed')).toHaveCount(0)
    const blockColumn = page.getByTestId('block-column')
    await expect(blockColumn).toBeVisible()
    await expect(blockColumn).toContainText('findOrCreateCustomer')
  })

  // Reviewer request: "als ik een comment in de blokken index selecteer, wil
  // ik die altijd rechts zien, niet ingeklapt". A comment-index row whose own
  // comment is stale (anchorState 'unpinned', see comment-stale-anchor-fold.
  // spec.mjs) used to still fold behind the "N hierboven" hint even here,
  // because hiddenAboveCount()'s leading-stale-run fallback ran regardless of
  // cs.scope.onlyIds — even though isAnchorOnlyComment (commentCard,
  // RelatedPanel.mjs) exists specifically to force this exact row's own
  // comment fully open. The render loop starts at `i = hidden`, so a
  // fully-folded scoped list never even built the card for that override to
  // apply to.
  test('a stale (unpinned) comment selected via the blokken index shows fully expanded, not folded behind the hint', async ({
    page,
  }) => {
    await mockAnchoredComment(page, { anchorState: 'unpinned', body: 'please rename this variable' })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await page.locator('[data-idx]').filter({ hasText: 'please rename this variable' }).click()

    await expect(page.getByTestId('comment-more-above')).toHaveCount(0)
    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1)
    await expect(item).toHaveAttribute('data-expanded', 'true')
    await expect(item).toContainText('please rename this variable')
  })

  // The jump is scoped to EXACTLY the anchor's own first-level panel
  // (state.focusLevel === 1) — a child clicked from a column already
  // drilled a SECOND level deep from the anchor still nests, even when that
  // child also has its own state.blocks row. Without the focusLevel guard,
  // isCommentAnchorDrillActive(1) alone stays true at any depth (curBlock()
  // never leaves the comment row throughout this whole flow — see
  // openCommentAnchorDrill's own doc comment), so this would have
  // incorrectly jumped too.
  test('a child two levels deep from the anchor still nests, never jumps', async ({ page }) => {
    await page.route('**/api/callresolve?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            callerId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            callKey: 'createPayment',
            status: 'resolved',
            kind: 'method_call',
            childFile: 'app/Support/Psp.php',
            childClass: 'Psp',
            childMethod: 'createPayment',
            childLine: 12,
            childCode: 'function createPayment($input) {}',
            model: '',
            confidence: '',
            updatedAt: new Date().toISOString(),
          },
        ],
      })
    })
    // The level-2 edge: Psp::createPayment (the synthetic frame drilled from
    // the anchor) "calls" findOrCreateCustomer — a real PR block WITH its
    // own state.blocks row, so this is exactly the shape that jumps when
    // clicked at focusLevel===1, and must NOT when clicked at focusLevel===2.
    // A synthetic frame's own id is caller-scoped (b.id + '::' + callKey,
    // see resolveChildBlock's own doc comment) — computed here to match.
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute::createPayment',
            childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            kind: 'event_listener',
          },
        ],
      })
    })
    await mockAnchoredComment(page, {
      id: 'anchor-two-deep',
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::execute',
      body: 'stays nested two levels deep',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.locator('[data-idx]').filter({ hasText: 'stays nested two levels deep' })
    await row.click()
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')

    // Level 1: drill into the synthetic Psp::createPayment child (no
    // state.blocks row of its own — nests exactly as before this change).
    const level1Child = page.getByTestId('related-item').filter({ hasText: 'Psp::createPayment' })
    await expect(level1Child).toBeVisible()
    await level1Child.click()
    await expect(drillColumn).toContainText('Psp::createPayment')
    await expect(page.getByTestId('drill-collapsed')).toHaveCount(1)

    // Open ITS OWN Underlying-code panel and click findOrCreateCustomer —
    // even though IT has its own state.blocks row, focusLevel is now 2, so
    // this must nest as a THIRD column, not jump away.
    await page.keyboard.press('ArrowRight')
    const level2Child = page.getByTestId('related-item').filter({ hasText: 'findOrCreateCustomer' })
    await expect(level2Child).toBeVisible()
    await level2Child.click()

    await expect(drillColumn).toContainText('findOrCreateCustomer')
    // Two collapsed rails now: the anchor (level 1) and Psp::createPayment
    // (level 2), with findOrCreateCustomer the sole focused column at level 3.
    await expect(page.getByTestId('drill-collapsed')).toHaveCount(2)
  })
})
