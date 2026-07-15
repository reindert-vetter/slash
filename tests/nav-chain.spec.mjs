import { test, expect } from './_fixtures.mjs'

// The left→right navigation chain (see keyboard-navigation.md, "De links→rechts
// navigatieketen"): PR-description → block-index → diff → onderliggende code →
// comments → taken. → advances one stop, ← steps one stop back. This exercises
// the new stop 1 (description toggle) and stop 7 (taken), plus the comments→
// onderliggende-code ← fix (it used to skip straight to the diff).
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

  test('← from the composer returns to onderliggende code (not the diff); → with nothing deeper reaches Taken; Enter opens the task', async ({
    page,
    request,
  }) => {
    // Block 0 of PR 12903 is the one fixture block guaranteed to carry a real
    // diff (see the data caveat in conventions.md) — it has exactly one changed
    // line, so there's no "later, non-colliding" unit within it to place a
    // comment on without landing in the same scope other specs already use for
    // their own block-0 comments (comment-index.spec.mjs, related-nav.spec.mjs).
    // Comments are scoped per BLOCK, but Taken (the workflows list) is scoped to
    // the whole PR — so seed the comment on a *different* block (index 1) that
    // nothing else here touches; it still shows up as a Taken row for this PR,
    // with zero risk of also surfacing in block 0's comment index.
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
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    // The related-code card has no outer focus border anymore (removed so its
    // children read as loose blocks); the code stop owning the keyboard shows as
    // cs.focus === 'code', mirrored to the URL as rel.foc (block 0 has no
    // underlying-code children here, so there's no selected item to assert on).
    const relFoc = () => new URL(page.url()).searchParams.get('rel.foc')
    await page.keyboard.press('ArrowRight') // list → diff (block 0's one change)
    await page.keyboard.press('ArrowRight') // diff → related panel (code)
    await expect.poll(relFoc).toBe('code')
    await page.keyboard.press('ArrowRight') // code → new-comment composer (empty)
    await expect(page.getByTestId('comment-compose')).toBeFocused()

    // Bugfix under test: ← from the composer must land back on the
    // Onderliggende-code stop, not skip past it straight to the diff (it used
    // to call exitRelated() unconditionally here).
    await page.keyboard.press('ArrowLeft')
    await expect.poll(relFoc).toBe('code')

    // → again into the (still empty) composer. Nothing deeper to go from there
    // — → advances straight to Taken (stop 7). Exactly one row should carry the
    // keyboard highlight.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
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
})
