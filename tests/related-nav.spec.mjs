import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Keyboard navigation into the inline comment block and the Onderliggende-code
// card. From the diff, → lands on the first comment conversation of the
// selected unit if there is one (stop between the diff and Onderliggende
// code, only reachable when the unit actually has comments — see
// hasVisibleComments/enterCommentsHead in RelatedPanel.mjs), else straight on
// Onderliggende code. ↓ within a conversation advances to the next one,
// falling through to Onderliggende code once there is no next one; ↑ on a
// conversation first walks its own thread (old messages, newest first) before
// moving to the previous conversation; ← peels back one stop at a time
// (thread → conversation → diff). See home.mjs (onKeydown → relatedActive/
// enterRelated/handleRelatedKey) and RelatedPanel.mjs (the cs.focus/threadPos
// state machine).
test.describe('PR Review Tree — related-panel navigation', () => {
  test('↓ into the comment conversation, ↑ walks the thread (reply loses focus), ← peels back one stop at a time', async ({
    page,
  }) => {
    // The comment index is scoped to the selected block, so seed the comment on
    // the same block this test will select (CreatePaymentAction::execute,
    // selected by label, not by raw index — see "Sort order of the left
    // list" in blocks-and-ingest.md) — read its file/label from the card. An
    // unknown row anchor (rowStart -1) means "block-level", so it shows for
    // that block whatever unit is selected. Writes still go through the
    // workflow endpoints (start + reply signal), so the write-boundary holds.
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    const card = page.getByTestId('block-column').locator('article').first()
    await expect(card).toBeVisible()
    const label = (await card.locator('h2').first().innerText()).trim()
    const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'eerste comment', label, rowStart: -1, rowEnd: -1 },
    })
    const runId = (await start.json()).runId
    expect(runId).toBeTruthy()
    // Add an old message (reaction) to the thread.
    await page.request.post('/api/workflows/' + encodeURIComponent(runId) + '/signals/reply', {
      data: { author: 'claude', body: 'oud bericht', done: false },
    })
    // Wait until the read-model shows *this* comment (by runId — other specs seed
    // on 12903 in parallel, so it isn't necessarily list[0]) with its reaction.
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        const c = list.find((x) => x.runId === runId)
        return c ? (c.reactions || []).length : 0
      })
      .toBeGreaterThan(0)

    // Reload so the comment list loads fresh with the just-seeded comment
    // already present (the frontend's own 5s poll cadence would otherwise
    // race the next steps).
    await page.goto('/pr/12903')
    // BY LABEL, not by raw index: the comment seeded above now has its own
    // index row (every unresolved comment does, see indexComments in
    // RelatedPanel.mjs), so every block below it shifted one slot.
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()

    // → into the diff, → onto the (only) comment conversation of this unit —
    // reachable because it exists (see hasVisibleComments). Landing on it
    // shows its history and focuses the reply field, so the reviewer can type
    // a reply straight away.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → the comment conversation
    const inlineComments = page.getByTestId('inline-comments')
    await expect(inlineComments.getByTestId('comment-item').first()).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId('reaction-compose')).toBeFocused()

    // ↑ steps into the thread directly (it's a vertical cursor now, not a
    // horizontal → stop — see TODO 2 in todo-claude-chat-blok.md); it
    // highlights the newest message (the reaction, last bubble — the
    // comment's own body is the first bubble above it) and drops the
    // reply-field focus.
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').last()).toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('reaction-compose')).not.toBeFocused()
    // ↑ again reaches the opening message (the comment body itself).
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').first()).toHaveClass(/ring-indigo-400/)
    await expect(page.getByTestId('reaction-bubble').first()).toContainText('eerste comment')

    // ← from inside the thread steps back one stop — to the conversation
    // level, still expanded, reply field no longer focused — not all the way
    // to the diff in one jump.
    await page.keyboard.press('ArrowLeft')
    await expect(inlineComments.getByTestId('comment-item').first()).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId('reaction-compose')).not.toBeFocused()

    // A further ← exits to the diff.
    const relFoc = () => new URL(page.url()).searchParams.get('rel.foc')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(relFoc).toBe(null)
  })

  test('→ from the diff goes straight to Onderliggende code when the selected unit has no comments', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
    // real changed row.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → related-code (no comments here)

    const relFoc = () => new URL(page.url()).searchParams.get('rel.foc')
    await expect.poll(relFoc).toBe('code')

    // No comment and no earlier Claude conversation on this unit ⇒ no chat
    // column at all, and nothing created one on the way past (the placeholder
    // comment is gone for good — see claude-chat-panel.md). No column ⇒ no
    // dashed connector either (it's gated on the same claudeChatVisible()).
    await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)
    await expect(page.getByTestId('comment-claude-connector')).toHaveCount(0)
    await expect(page.getByTestId('comment-item')).toHaveCount(0)
  })
})
