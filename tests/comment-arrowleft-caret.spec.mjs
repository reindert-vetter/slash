import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Regression test for: "option naar links, moet niet uit comment input gaan" —
// ArrowLeft (and Option/Alt+ArrowLeft, the Mac word-jump) inside a genuinely
// DOM-focused comment/reply textarea must move the caret, not pop the
// thread/sidebar focus or exit the panel. Before the fix, the relatedActive()
// branch in home.mjs's onKeydown always preventDefault'd + hijacked ArrowLeft,
// even while the reviewer was mid-edit in the composer or a reply field. See
// the isEditableFocused() guard added to that branch (keyboard-navigation.md,
// "Generieke input-focus-guard"). The comment-index item's own reply field
// (RelatedPanel.mjs's commentDetailCard) needs no such guard at all — it isn't
// wired into any cs.focus-based branch, so a plain ArrowLeft there simply
// falls through to the browser untouched; the third test below covers that.
test.describe('ArrowLeft caret guard in comment inputs', () => {
  test('block-scoped composer: ArrowLeft/Alt+ArrowLeft move the caret, field stays open', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode (mirrors comment-composer-typing-guard.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()

    await composer.type('hello world')
    await expect(composer).toHaveValue('hello world')

    // Caret sits at the end (position 11) — a plain ArrowLeft moves it one
    // character left, it must NOT exit the field.
    await page.keyboard.press('ArrowLeft')
    await expect(composer).toBeFocused()
    let pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBe(10)

    // Alt+ArrowLeft (Option on macOS) word-jumps within the field.
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(composer).toBeFocused()
    pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBeLessThan(10)

    // Neither arrow-left press touched the composer's content or closed it.
    await expect(composer).toHaveValue('hello world')

    // Escape remains the explicit "get me out" gesture.
    await page.keyboard.press('Escape')
    await expect(composer).toHaveCount(0)
  })

  test('block-scoped reply thread: ArrowLeft/Alt+ArrowLeft move the caret, thread stays open', async ({ page }) => {
    const pr = 970002
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
    await reply.type('quick reply')
    await expect(reply).toHaveValue('quick reply')

    await page.keyboard.press('ArrowLeft')
    await expect(reply).toBeFocused()
    let pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBe('quick reply'.length - 1)

    await page.keyboard.press('Alt+ArrowLeft')
    await expect(reply).toBeFocused()
    pos = await reply.evaluate((el) => el.selectionStart)
    expect(pos).toBeLessThan('quick reply'.length - 1)

    await expect(reply).toHaveValue('quick reply')
    await expect(page.getByTestId('comment-thread')).toBeVisible()
  })

  test('comment-index item reply field: ArrowLeft/Alt+ArrowLeft move the caret, field stays open', async ({
    page,
  }) => {
    const now = new Date().toISOString()
    const comments = [
      {
        id: 'pw-arrow-1',
        runId: 'run-pw-arrow-1',
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
    // is this comment (see recomputeLeftList/applyDefaultUnapprovedSelection)
    // — its detail card already shows to the right of the index.
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

    await page.keyboard.press('ArrowLeft')
    await expect(compose).toBeFocused()
    let pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBe('quick reply'.length - 1)

    await page.keyboard.press('Alt+ArrowLeft')
    await expect(compose).toBeFocused()
    pos = await compose.evaluate((el) => el.selectionStart)
    expect(pos).toBeLessThan('quick reply'.length - 1)

    await expect(compose).toHaveValue('quick reply')

    // Escape hides the reply field again; the thread/detail card stays.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('comment-detail-reply')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()
  })

  test('ArrowLeft still navigates normally when a comment conversation is highlighted (caret at the start)', async ({
    page,
  }) => {
    // Reaching a comment conversation always focuses its reply field
    // immediately (toComment, RelatedPanel.mjs) — there is no longer a
    // "highlighted but unfocused" composer state reachable via arrow keys
    // (the composer only opens via an explicit click/Enter/the command
    // palette, never via ↓/→ browsing — see hasVisibleComments in
    // RelatedPanel.mjs). This covers the empty-field boundary instead: an
    // empty reply field's caret is already at position 0, so ArrowLeft must
    // still peel back to the diff rather than being swallowed as a caret
    // move (see editableCaretCanMoveLeft in home.mjs).
    const pr = 970003
    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body: 'origineel', rowStart: -1, rowEnd: -1 },
    })
    expect((await start.json()).runId).toBeTruthy()

    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    const item = page.getByTestId('comment-item').first()
    await expect(item).toBeVisible()
    await item.click()
    const reply = page.getByTestId('reaction-compose')
    await expect(reply).toBeFocused()

    // Nothing typed — the caret sits at position 0, nowhere left to move —
    // so ArrowLeft peels back one stop instead.
    await page.keyboard.press('ArrowLeft')
    await expect(reply).toHaveCount(0)
  })
})
