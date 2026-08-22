import { test, expect, leaveSearchBox, openNewComment, seededPr } from './_fixtures.mjs'

// Regression test for: "if I'm typing a comment ... and I navigate away
// from the comment (e.g. to the left), then I want that same message to be
// visible there again" — leaving the new-comment composer (or an
// existing thread's reply field) via ArrowLeft at caret position 0 used to
// unmount the field and discard whatever was typed, since both are otherwise
// uncontrolled DOM elements. See composeDrafts/replyDrafts in
// RelatedPanel.mjs and the matching paragraph in detail-layout.md.
test.describe('typed but not yet sent comment text survives leaving and returning', () => {
  test('new-comment composer: restores the draft on the same unit, stays empty on a different one', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode (mirrors comment-arrowleft-caret.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.type('this is my draft')
    await expect(composer).toHaveValue('this is my draft')

    // Caret at position 0 — ArrowLeft here leaves the field (see
    // editableCaretCanMoveLeft) instead of moving the caret.
    await composer.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect(composer).toHaveCount(0)

    // Re-opening the composer on the SAME unit restores the draft.
    await openNewComment(page)
    const restored = page.getByTestId('comment-compose')
    await expect(restored).toBeFocused()
    await expect(restored).toHaveValue('this is my draft')

    // Typing can simply continue from there.
    await restored.type(' — continued')
    await expect(restored).toHaveValue('this is my draft — continued')
    await page.keyboard.press('Escape') // leave the panel, back to the diff

    // A DIFFERENT block's composer must not carry the draft over — step to
    // the next block with the keyboard (staying in list mode briefly)
    // instead of clicking a distant row, which avoids an unrelated
    // scroll-into-view flake on the sidebar's own internal scroll container.
    await page.keyboard.press('ArrowLeft') // diff -> block index
    await page.keyboard.press('ArrowDown') // block 1 -> the next block
    await page.keyboard.press('ArrowRight') // list -> diff
    await openNewComment(page)
    await expect(page.getByTestId('comment-compose')).toHaveValue('')

    // There is no "Annuleer"/explicit-cancel button any more (see "No more
    // explicit Annuleer button" in comments-panel.md) — Escape is the only
    // way to leave a still-open composer, and it no longer discards the
    // draft: typing here and leaving via Escape must still restore this
    // (fresh) block's own draft later, same as any other exit.
    await page.getByTestId('comment-compose').fill('kept even after Escape')
    await expect(page.getByText('Annuleer')).toHaveCount(0)
    await page.keyboard.press('Escape') // panel -> diff

    // The FIRST block's composer still remembers its own, separate draft.
    await page.keyboard.press('ArrowLeft') // diff -> block index
    await page.keyboard.press('ArrowUp') // back to the original block
    await page.keyboard.press('ArrowRight') // list -> diff
    await openNewComment(page)
    await expect(page.getByTestId('comment-compose')).toHaveValue('this is my draft — continued')

    // And so does the SECOND block, once we return to it.
    await page.keyboard.press('Escape') // panel -> diff
    await page.keyboard.press('ArrowLeft') // diff -> block index
    await page.keyboard.press('ArrowDown') // back to the second block
    await page.keyboard.press('ArrowRight') // list -> diff
    await openNewComment(page)
    await expect(page.getByTestId('comment-compose')).toHaveValue('kept even after Escape')
  })

  test('existing thread reply field: restores the draft after leaving and coming back', async ({ page }, testInfo) => {
    const pr = seededPr(testInfo)
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr,
        file: 'test.php',
        line: 1,
        author: 'reviewer',
        body: 'origineel',
        code: '$order->total();',
        gran: 'call',
        label: 'Order::total',
      },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click()

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.type('my reply draft')
    await expect(reply).toHaveValue('my reply draft')

    await reply.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('reaction-compose')).toHaveCount(0)

    // Selecting the same comment again restores the field with the draft.
    await item.click()
    const restored = page.getByTestId('reaction-compose')
    await expect(restored).toBeFocused()
    await expect(restored).toHaveValue('my reply draft')
  })
})
