import { test, expect } from './_fixtures.mjs'

// The left→right navigation chain (see keyboard-navigation.md, "De links→rechts
// navigatieketen"): PR-description → block-index → diff → onderliggende code.
// → advances one stop, ← steps one stop back. Comments/taken are no longer a
// stop in this chain — they live in a separate, `g`-toggled fixed sidebar (see
// detail-layout.md): ↓/↑ cross between comments and taken, and ← from
// anywhere inside the sidebar exits straight back to the diff in one step
// (the sidebar stays open). This exercises the description toggle (stop 1)
// and that sidebar mechanism.
test.describe('PR Review Tree — left-right nav chain', () => {
  test('← on the block-index opens the PR-description column (stop 1), → closes it again', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    const info = page.getByTestId('pr-info-column')
    await expect(info).toHaveCount(0)

    await page.keyboard.press('ArrowLeft')
    await expect(info).toHaveCount(1)
    await expect(info).toBeVisible()

    // The description column must sit physically to the left of the pr-index
    // (it pushes the pr-index right, rather than appearing after it — see
    // detail-layout.md, "verplaats pr description naar links"). The pr-index
    // slides right over a 200ms CSS transition, so poll until it settles
    // instead of asserting on a single (possibly mid-transition) frame.
    const prIndex = page.getByTestId('pr-index')
    await expect
      .poll(async () => {
        const infoBox = await info.boundingBox()
        const prIndexBox = await prIndex.boundingBox()
        return infoBox.x + infoBox.width <= prIndexBox.x
      })
      .toBe(true)

    // ↑/↓ do nothing while the description owns the keyboard — the block
    // selection underneath must not move.
    const selectedIdx = await page.locator('[data-testid=block-row].bg-indigo-50').getAttribute('data-idx')
    await page.keyboard.press('ArrowDown')
    await expect(info).toHaveCount(1)

    await page.keyboard.press('ArrowRight')
    await expect(info).toHaveCount(0)
    await expect(page.locator('[data-testid=block-row].bg-indigo-50')).toHaveAttribute('data-idx', selectedIdx)
  })

  test('stop 1 and stop 2 get the same on/off indigo focus border as the diff card (stop 3)', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) carries no local diff; select block 1
    // (CreatePaymentAction::execute) so → into the diff (stop 3) actually
    // enters diff mode.
    await page.locator('[data-idx="1"]').click()

    // Stop 2 (the pr-index) owns the keyboard by default in list-mode: its
    // container should carry the same border-indigo-300/ring-indigo-200 pair
    // the block-diff card uses via diffActive (see Block.mjs / home.mjs).
    const prIndex = page.getByTestId('pr-index')
    await expect(prIndex).toHaveClass(/border-indigo-300/)
    await expect(prIndex).toHaveClass(/ring-indigo-200/)

    // ← moves the keyboard to stop 1 (the description column): stop 2 must
    // drop its indigo border and stop 1's card must pick it up.
    await page.keyboard.press('ArrowLeft')
    const infoCard = page.getByTestId('pr-info-card')
    await expect(infoCard).toBeVisible()
    await expect(infoCard).toHaveClass(/border-indigo-300/)
    await expect(infoCard).toHaveClass(/ring-indigo-200/)
    await expect(prIndex).not.toHaveClass(/border-indigo-300/)

    // → back to stop 2: the border swaps back.
    await page.keyboard.press('ArrowRight')
    await expect(prIndex).toHaveClass(/border-indigo-300/)

    // → into the diff (stop 3): stop 2 must drop its indigo border again,
    // while the diff card (already covered by drill-focus.spec.mjs) owns it.
    await page.keyboard.press('ArrowRight')
    await expect(prIndex).not.toHaveClass(/border-indigo-300/)
    await expect(page.locator('article').first()).toHaveClass(/border-indigo-300/)
  })

  test('← on stop 1 (the PR-description column) exits the chain to the PR overview', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('ArrowLeft') // block-index → stop 1 (description)
    await expect(page.getByTestId('pr-info-column')).toHaveCount(1)

    await page.keyboard.press('ArrowLeft') // stop 1 → nothing further left: the PR overview
    await expect(page).toHaveURL(/\/pr-overview/)
    await expect(page.getByTestId('inbox')).toBeVisible()
  })

  test('g opens the comments sidebar; ← exits straight to the diff (sidebar stays open); ↓ with nothing deeper reaches Taken; Enter opens the task', async ({
    page,
    request,
  }) => {
    // Block 1 of the left list (CreatePaymentAction::execute — block 0,
    // ContractController::index, sorts first as the sole CONTROLLER, see
    // categoryRank in home.mjs, but has no local diff) is the one fixture
    // block guaranteed to carry a real diff (see the data caveat in
    // conventions.md) — it has exactly one changed line, so there's no
    // "later, non-colliding" unit within it to place a comment on without
    // landing in the same scope other specs already use for their own
    // comments on it (comment-index.spec.mjs, related-nav.spec.mjs).
    // Comments are scoped per BLOCK, but Taken (the workflows list) is scoped
    // to the whole PR — so seed the comment on a *different* block
    // (findOrCreateCustomer — index 1 of the raw, unsorted /api/blocks
    // response, distinct from the UI's sorted list index used below) that
    // nothing else here touches; it still shows up as a Taken row for this
    // PR, with zero risk of also surfacing in this block's comment index.
    const blocks = await (await request.get('/api/blocks?pr=12903')).json()
    const other = blocks[1]
    const start = await request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file: other.file,
        line: 1,
        author: 'reviewer',
        body: 'nav-chain comment',
        label: other.class + '::' + other.name,
        rowStart: -1,
        rowEnd: -1,
      },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    await expect
      .poll(async () => {
        const runs = await (await request.get('/api/workflows?pr=12903')).json()
        return (runs.runs || []).some((r) => r.runId === runId)
      })
      .toBe(true)

    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute
    // The related-code card has no outer focus border anymore (removed so its
    // children read as loose blocks); the code stop owning the keyboard shows as
    // cs.focus === 'code', mirrored to the URL as rel.foc (this block has no
    // underlying-code children here, so there's no selected item to assert on).
    const relFoc = () => new URL(page.url()).searchParams.get('rel.foc')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // list → diff (this block's one change)
    await page.keyboard.press('ArrowRight') // diff → related panel (code)
    await expect.poll(relFoc).toBe('code')

    // `g` opens the comments/taken sidebar (independent of the code stop —
    // it's a separate, fixed overlay, not the next stop in the chain) and
    // highlights the "+ Comment op deze regel" row — but does NOT auto-focus
    // the composer (see enterComments in RelatedPanel.mjs: a fresh `g`-open
    // only highlights the row, so a 2nd `g` can toggle the sidebar shut right
    // away instead of typing a literal "g" into an already-focused textarea).
    const sidebar = page.getByTestId('comments-sidebar')
    await page.keyboard.press('g')
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('new-comment')).toHaveClass(/ring-indigo-300/)
    await expect(page.getByTestId('comment-compose')).toHaveCount(0)

    // Enter opens the composer and focuses it.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // ← from the composer exits straight back to the diff in one step — not
    // back to the Onderliggende-code stop — and the sidebar stays open (the
    // composer itself closes — exitRelated drops cs.composing — so the
    // "+ Comment op deze regel" button loses its focus ring instead).
    await page.keyboard.press('ArrowLeft')
    await expect.poll(relFoc).toBe(null)
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)

    // `g` again — the sidebar is open but the keyboard sits on the diff —
    // re-highlights the row without auto-focusing the composer. Nothing
    // deeper to go from there — ↓ advances straight to Taken. Exactly one row
    // should carry the keyboard highlight.
    await page.keyboard.press('g')
    await expect(page.getByTestId('new-comment')).toHaveClass(/ring-indigo-300/)
    await expect(page.getByTestId('comment-compose')).toHaveCount(0)
    await page.keyboard.press('ArrowDown')
    const active = page.locator('[data-testid=workflow-row][data-active="true"]')
    await expect(active).toHaveCount(1)

    // Walk ↓ until the highlighted row is the one for our seeded run (other
    // workflow types for this PR — pr_status, build_relations, … — sit in the
    // same list), then confirm the reachable count so the loop can't spin
    // forever if something regresses.
    const ourRow = page.locator(`[data-testid=workflow-row][data-run-id="${runId}"]`)
    await expect(ourRow).toHaveCount(1)
    const total = await page.locator('[data-testid=workflow-row]').count()
    for (let i = 0; i < total; i++) {
      if ((await ourRow.getAttribute('data-active')) === 'true') break
      await page.keyboard.press('ArrowDown')
    }
    await expect(ourRow).toHaveAttribute('data-active', 'true')

    // Enter opens the focused run the same way a click does: it jumps to the
    // comment's block/unit and selects its thread.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('comment-thread')).toContainText('nav-chain comment')
    await expect(page.getByTestId('reaction-compose')).toBeFocused()
  })

  test('← from a diff deep-link goes to the block-index first, then the description on a second ←', async ({
    page,
  }) => {
    // Regression test: loading straight into mode=diff (a deep link, as opposed
    // to navigating there via →) used to auto-focus the search box on load
    // regardless of the restored mode. That left state.searchActive true while
    // state.mode stayed 'diff', so a bare ArrowLeft was caught by onKeydown's
    // searchActive branch (which assumes list mode) before the diff-mode branch
    // ever ran — jumping straight to stop 1 (the description) instead of first
    // landing on stop 2 (the block-index), and leaving mode:'diff' +
    // showDescription:true simultaneously true, which the layout never expects
    // (see detail-layout.md) — the description card rendered behind the diff
    // card instead of beside it.
    // sel targets CreatePaymentAction::execute (app/Actions/CreatePaymentAction.php:26),
    // the block that reliably carries a real change (see conventions.md) — a
    // restored mode=diff on a block with zero change groups gets auto-corrected
    // back to 'list' on load (see the mode/groups.length guard in ensureCode,
    // home.mjs), which would make this deep link start in list mode already and
    // defeat the point of this regression test.
    await page.goto('/pr/12903?mode=diff&sel=app%2FActions%2FCreatePaymentAction.php%3A26')
    await expect(page.getByTestId('block-column')).toBeVisible()

    const info = page.getByTestId('pr-info-column')
    await expect(info).toHaveCount(0)

    // First ← must land on the block-index (stop 2), not the description.
    await page.keyboard.press('ArrowLeft')
    await expect(page).not.toHaveURL(/mode=diff/) // list is the default mode, omitted from the URL
    await expect(info).toHaveCount(0)
    await expect(page.getByTestId('pr-index')).toBeVisible()

    // Second ← steps one stop further left, onto the description (stop 1) —
    // and it must sit physically beside, not behind, the block-index/diff.
    await page.keyboard.press('ArrowLeft')
    await expect(info).toHaveCount(1)
    await expect(info).toBeVisible()
    const prIndex = page.getByTestId('pr-index')
    await expect
      .poll(async () => {
        const infoBox = await info.boundingBox()
        const prIndexBox = await prIndex.boundingBox()
        return infoBox.x + infoBox.width <= prIndexBox.x
      })
      .toBe(true)
  })

  test('stop 1 summary section is labelled "Doel" with a light-green background', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.keyboard.press('ArrowLeft') // block-index → stop 1 (description)

    const summary = page.getByTestId('pr-info-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('Doel')
    await expect(summary).not.toContainText('Samenvatting')
    await expect(summary).toHaveClass(/bg-emerald-50/)
  })
})
