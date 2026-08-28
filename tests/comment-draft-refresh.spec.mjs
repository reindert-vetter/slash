import { test, expect, seededPr, leaveSearchBox, openNewComment, appReady } from './_fixtures.mjs'

// Regression tests for: "als ik iets type in de comment/chat input, en ik
// refresh, dan wil ik bij die ene comment/chat input dezelfde tekst zien. als
// ik een url open en/of een andere blok selecteer, dan wil ik die tekst niet
// zien." See draftStorage.mjs and "Drafts survive leaving mid-type" in
// .claude/docs/comments-panel.md.
test.use({ viewport: { width: 2000, height: 1100 } })

test.describe('a typed draft survives a real page refresh, scoped to its own anchor', () => {
  test('new-comment composer: same block after reload keeps the draft, a different block does not', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await composer.fill('refresh me please')
    await expect(composer).toHaveValue('refresh me please')

    // A real reload — the in-memory Map is gone, only localStorage remains.
    // The URL still carries the same ?sel=/?mode=/?rel.foc= (bindUrlState,
    // see CLAUDE.md), so the composer reopens on the SAME unit by itself —
    // no need to reopen it manually.
    await page.reload()
    await appReady(page)
    await expect(page.getByTestId('comment-compose')).toHaveValue('refresh me please')
    await page.keyboard.press('Escape') // panel -> diff

    // A DIFFERENT block's composer must not show it, even after the reload.
    await page.keyboard.press('ArrowLeft') // diff -> block index
    await page.keyboard.press('ArrowDown') // next block
    await page.keyboard.press('ArrowRight') // list -> diff
    await openNewComment(page)
    await expect(page.getByTestId('comment-compose')).toHaveValue('')
  })

  test('claude chat composer: same conversation after reload keeps the draft, a different one does not', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const start1 = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr,
        file: 'test.php',
        line: 1,
        author: 'reviewer',
        body: 'eerste comment',
        code: '$order->total();',
        gran: 'call',
        label: 'Order::total',
      },
    })
    expect((await start1.json()).runId).toBeTruthy()
    const start2 = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr,
        file: 'test.php',
        line: 1,
        author: 'reviewer',
        body: 'tweede comment',
        code: '$order->total();',
        gran: 'call',
        label: 'Order::total',
      },
    })
    expect((await start2.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const items = page.getByTestId('comment-item')
    await expect(items).toHaveCount(2)

    const first = items.filter({ hasText: 'eerste comment' })
    await first.click()
    await page.keyboard.press('ArrowRight') // comment -> claude
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await composer.fill('nog niet verstuurd concept')
    await expect(composer).toHaveValue('nog niet verstuurd concept')

    // Switching straight to the SECOND (unrelated) conversation without
    // sending must not leak the first conversation's unsent draft into it —
    // the composer's DOM node is reused across conversations, see
    // claudeDrafts' own doc comment.
    const second = items.filter({ hasText: 'tweede comment' })
    await second.click()
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('')

    // A real reload, back on the FIRST conversation, still has its draft.
    await page.reload()
    await appReady(page)
    await leaveSearchBox(page)
    const firstAfterReload = page.getByTestId('comment-item').filter({ hasText: 'eerste comment' })
    await firstAfterReload.click()
    await page.keyboard.press('ArrowRight') // comment -> claude
    await expect(page.getByTestId('claude-chat-compose')).toHaveValue('nog niet verstuurd concept')
  })
})
