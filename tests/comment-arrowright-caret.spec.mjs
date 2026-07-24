import { test, expect } from './_fixtures.mjs'

// Regression test for: "in een comment kan ik niet met pijltjestoets naar
// rechts (eerst naar links in de input met een zin, en dan naar rechts)" —
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
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // list -> diff

    await page.keyboard.press('Meta+ArrowRight') // open the comments/taken sidebar
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()
    await page.getByTestId('new-comment').click()
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
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()

    // Escape remains the explicit "get me out" gesture.
    await page.keyboard.press('Escape')
    await expect(composer).toHaveCount(0)
  })

  test('block-scoped reply thread: ArrowRight moves the caret, entering the thread only fires once the caret is at the end', async ({
    page,
  }) => {
    const pr = 970004
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
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('Meta+ArrowRight')
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click() // lands on the comment row, reply field auto-focused (cs.focus === 'comment')

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
    // existing nav meaning: it steps into the thread (enterThread(), which
    // resets cs.threadPos to 0 — the reply field itself, no bubble
    // highlighted yet). ArrowUp then walks up into the message history —
    // that only does anything in 'thread' focus (in 'comment' focus, ArrowUp
    // instead walks the flat comment-row list), so the bubble lighting up
    // proves ArrowRight really flipped cs.focus to 'thread'.
    pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('reaction-bubble').first()).toHaveClass(/ring-indigo-400/)
  })

  test('PR-wide reply thread: ArrowRight/Alt+ArrowRight move the caret, thread stays open', async ({ page }) => {
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
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1: the description
    await page.keyboard.press('ArrowDown') // hand the keyboard to the PR-wide block
    await page.keyboard.press('Enter') // open its thread + focus the reply field

    const compose = page.getByTestId('pr-wide-compose')
    await expect(compose).toBeFocused()
    await compose.type('quick reply')
    await expect(compose).toHaveValue('quick reply')
    const len = 'quick reply'.length

    // Move the caret away from the end first.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    let pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBe(len - 2)

    // A plain ArrowRight moves the caret, doesn't pop the row/thread focus.
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

    // Escape still steps out of the field (back to the row highlight).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pr-wide-item').first()).toHaveAttribute('data-active', 'true')
  })
})
