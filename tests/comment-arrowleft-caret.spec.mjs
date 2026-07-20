import { test, expect } from './_fixtures.mjs'

// Regression test for: "option naar links, moet niet uit comment input gaan" —
// ArrowLeft (and Option/Alt+ArrowLeft, the Mac word-jump) inside a genuinely
// DOM-focused comment/reply textarea must move the caret, not pop the
// thread/sidebar focus or exit the panel. Before the fix, the
// isPrWideFocused()/relatedActive() branches in home.mjs's onKeydown always
// preventDefault'd + hijacked ArrowLeft, even while the reviewer was mid-edit
// in the composer or a reply field. See the isEditableFocused() guard added
// to both branches (keyboard-navigation.md, "Generieke input-focus-guard").
test.describe('ArrowLeft caret guard in comment inputs', () => {
  test('block-scoped composer: ArrowLeft/Alt+ArrowLeft move the caret, field stays open', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode (mirrors comment-composer-typing-guard.spec.mjs).
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

    // Caret sits at the end (position 11) — a plain ArrowLeft moves it one
    // character left, it must NOT exit the field/sidebar.
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
    await expect(page.getByTestId('comments-sidebar')).toBeVisible()

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
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('Meta+ArrowRight')
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

  test('PR-wide reply thread: ArrowLeft/Alt+ArrowLeft move the caret, thread stays open', async ({ page }) => {
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
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1: the description
    await page.keyboard.press('ArrowDown') // hand the keyboard to the PR-wide block
    await page.keyboard.press('Enter') // open its thread + focus the reply field

    const compose = page.getByTestId('pr-wide-compose')
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

    // Escape still steps out of the field (back to the row highlight).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('pr-wide-item').first()).toHaveAttribute('data-active', 'true')
  })

  test('ArrowLeft still navigates normally when the composer row is only highlighted (no field focus)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')

    await page.keyboard.press('Meta+ArrowRight')
    const sidebar = page.getByTestId('comments-sidebar')
    await expect(sidebar).toBeVisible()
    // A fresh Cmd+ArrowRight-open only highlights the "+ Comment op deze regel"
    // row (enterComments) — no textarea DOM focus yet.
    await expect(page.getByTestId('new-comment')).toHaveClass(/ring-indigo-300/)
    await expect(page.getByTestId('comment-compose')).toHaveCount(0)

    // ArrowLeft here must still exit back to the diff (unchanged behavior) —
    // the sidebar stays open, only the keyboard focus leaves it.
    await page.keyboard.press('ArrowLeft')
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)
  })
})
