import { test, expect, leaveSearchBox, seededPr } from './_fixtures.mjs'

// placeComment/sendReaction/sendPrCommentReply now hand the keyboard back
// (or close the reply field) IMMEDIATELY, before the save is confirmed —
// see the "optimistic exit" doc comments in RelatedPanel.mjs. A failed save
// must therefore surface somewhere the reviewer can still find it, since
// they may already be looking at something else by the time it fails:
// cs.sendFailed marks it, shown as a small text/glyph badge
// (data-testid=comment-send-failed, never colour-only) on whichever card
// the draft resurfaces on, and the typed text itself is kept recoverable
// via the existing draft maps (composeDrafts/replyDrafts/prReplyDrafts).

test.describe('A failed save surfaces a badge and keeps the typed text', () => {
  test('a failed reply on a block-scoped thread closes the thread immediately and keeps the draft', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body: 'origineel' },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.route('**/api/workflows/*/signals/reply', (route) => route.fulfill({ status: 500 }))

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.fill('dit gaat mislukken')
    await page.keyboard.press('Enter')

    // The thread already closed (optimistic exit) — well before the mocked
    // 500 response is even processed — and the failure surfaces right on the
    // still-visible compact card.
    await expect(item).toHaveAttribute('data-expanded', 'false')
    await expect(item.getByTestId('comment-send-failed')).toBeVisible()
    await expect(item.getByTestId('comment-send-failed')).toContainText('mislukt')

    // Reopening the thread restores the failed text so it can be retried.
    await item.click()
    await expect(page.getByTestId('reaction-compose')).toHaveValue('dit gaat mislukken')
  })

  test('a failed reply on a comment-index item closes back to the item and keeps the draft', async ({
    page,
  }, testInfo) => {
    const pr = seededPr(testInfo)
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: '.github/workflows/ci.yml', line: 1, author: 'octocat', body: 'overall comment', kind: 'issue' },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.route('**/api/workflows/*/signals/reply', (route) => route.fulfill({ status: 500 }))

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const card = page.getByTestId('comment-detail-card')
    await expect(card).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').filter({ hasText: 'Beantwoorden' }).click()
    const reply = page.getByTestId('comment-detail-reply')
    await expect(reply).toBeFocused()
    await reply.fill('dit gaat ook mislukken')
    await page.keyboard.press('Enter')

    // The reply field closes immediately (optimistic exit) — back to the
    // item's rest position, not a diff (a comment-index item has none).
    await expect(page.getByTestId('comment-detail-reply')).toHaveCount(0)
    await expect(card.getByTestId('comment-send-failed')).toBeVisible()

    // Reopening "Beantwoorden" restores the failed text.
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').filter({ hasText: 'Beantwoorden' }).click()
    await expect(page.getByTestId('comment-detail-reply')).toHaveValue('dit gaat ook mislukken')
  })

  test('a failed new-comment placement keeps the draft and shows the badge on reopening', async ({ page }) => {
    await page.route('**/api/workflows/task_code_comment', (route) => route.fulfill({ status: 500 }))

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // Block 0 has no local diff to step into on this fixture — pick block 1.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // list -> diff

    await page.keyboard.press('Enter')
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.fill('dit gaat niet lukken')

    await page.keyboard.press('Enter') // opens the compose-kind menu
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Enter') // "Plaats comment"
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // The composer already closed (optimistic exit) before the mocked 500
    // response is even processed.
    await expect(page.getByTestId('comment-compose')).toHaveCount(0)

    // Reopening it on the same unit restores the draft and shows the badge.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    await expect(page.getByTestId('comment-compose')).toHaveValue('dit gaat niet lukken')
    await expect(page.getByTestId('comment-send-failed')).toBeVisible()
  })
})
