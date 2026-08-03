import { test, expect, leaveSearchBox, openNewComment, seededPr } from './_fixtures.mjs'

// Regression test for: "in a comment I can't use the right arrow key
// (first left in the input with a sentence, and then right)" —
// the mirror image of comment-arrowleft-caret.spec.mjs. ArrowRight (and
// Option/Alt+ArrowRight, the Mac word-jump) inside a genuinely DOM-focused
// comment/reply textarea must move the caret, not jump into the comment's
// thread. Before the fix, the relatedActive() branch in home.mjs's onKeydown
// always preventDefault'd + hijacked ArrowRight, even while the reviewer was
// mid-edit and the caret still had somewhere to move right into. See
// editableCaretCanMoveRight() (keyboard-navigation.md, "Generic input-focus
// guard").
test.describe('ArrowRight caret guard in comment inputs', () => {
  test('block-scoped composer: ArrowRight/Alt+ArrowRight move the caret, field stays open', async ({ page }) => {
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

    await composer.type('hello world')
    await expect(composer).toHaveValue('hello world')

    // Move the caret away from the end first — the exact bug-report sequence:
    // left within the sentence, then right.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    let pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBe(9)

    // A plain ArrowRight moves the caret one character right — it must NOT be
    // hijacked as a nav shortcut.
    await page.keyboard.press('ArrowRight')
    await expect(composer).toBeFocused()
    pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBe(10)

    // Alt+ArrowRight (Option on macOS) word-jumps within the field.
    await page.keyboard.press('Alt+ArrowRight')
    await expect(composer).toBeFocused()
    pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBeGreaterThan(10)

    // Neither arrow-right press touched the composer's content or closed it.
    await expect(composer).toHaveValue('hello world')

    // Escape remains the explicit "get me out" gesture.
    await page.keyboard.press('Escape')
    await expect(composer).toHaveCount(0)
  })

  test('block-scoped reply thread: ArrowRight moves the caret, entering the thread only fires once the caret is at the end', async ({
    page,
  }, testInfo) => {
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
    await item.click() // lands on the comment card, reply field auto-focused (cs.focus === 'comment')

    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()
    await reply.type('quick reply')
    await expect(reply).toHaveValue('quick reply')
    const len = 'quick reply'.length

    // Move the caret away from the end first (the bug report's exact sequence).
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    let pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len - 2)

    // A plain ArrowRight moves the caret — it must NOT jump into the thread
    // while there's still text to the right of the caret.
    await page.keyboard.press('ArrowRight')
    await expect(reply).toBeFocused()
    pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len - 1)
    await expect(reply).toHaveValue('quick reply')
    await expect(page.getByTestId('reaction-bubble').first()).not.toHaveClass(/ring-indigo-400/)

    // Alt+ArrowRight word-jumps further right, still inside the field.
    await page.keyboard.press('Alt+ArrowRight')
    await expect(reply).toBeFocused()
    pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBeGreaterThan(len - 1)
    await expect(page.getByTestId('reaction-bubble').first()).not.toHaveClass(/ring-indigo-400/)

    // Only once the caret is genuinely at the end does ArrowRight keep its
    // existing nav meaning: it steps straight into the embedded Claude chat
    // (enterClaudeChat() — 'thread' is a vertical cursor reached via ArrowUp,
    // not a horizontal ArrowRight stop any more, see TODO 2 in
    // todo-claude-chat-blok.md), focusing its own composer instead of the
    // reply field.
    pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  })

  test('comment-index item reply field: ArrowRight/Alt+ArrowRight move the caret, field stays open', async ({
    page,
  }) => {
    const now = new Date().toISOString()
    const comments = [
      {
        id: 'pw-arrow-right-1',
        runId: 'run-pw-arrow-right-1',
        pr: 12903,
        file: '',
        line: 0,
        author: 'octocat',
        body: 'a pr-wide comment',
        createdAt: now,
        reactionCount: 0,
        status: 'open',
        source: 'github',
        kind: 'issue',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ]
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
    )

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // A fresh, no-?sel= open lands on the first not-yet-resolved item, which
    // is this comment (see recomputeLeftList/applyDefaultUnapprovedSelection).
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    // Enter opens the small action menu, default-selected on "Beantwoorden" —
    // a second Enter runs it, revealing the reply field.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Enter')

    const compose = page.getByTestId('comment-detail-reply')
    await expect(compose).toBeFocused()
    await compose.type('quick reply')
    await expect(compose).toHaveValue('quick reply')
    const len = 'quick reply'.length

    // Move the caret away from the end first.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    let pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len - 2)

    // A plain ArrowRight moves the caret, doesn't pop any focus.
    await page.keyboard.press('ArrowRight')
    await expect(compose).toBeFocused()
    pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len - 1)

    // Alt+ArrowRight word-jumps within the field.
    await page.keyboard.press('Alt+ArrowRight')
    await expect(compose).toBeFocused()
    pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBeGreaterThan(len - 1)

    await expect(compose).toHaveValue('quick reply')

    // Escape hides the reply field again; the thread/detail card stays.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('comment-detail-reply')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()
  })
})
