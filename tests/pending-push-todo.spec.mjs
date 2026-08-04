import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The push todo at the very bottom of the block index: Claude's commits land on
// the PR's branch locally (so the code is reviewable right away) and the push to
// GitHub is the reviewer's own last step. See pushTodoRow (BlockList.mjs),
// pushTodoCommandsFor/stepListSelection (home.mjs) and pending_push.go.
//
// GET /api/pending-push is mocked: the real one reads git refs, which a test
// worktree fixture has none of.

function mockPendingPush(page, view) {
  return page.route('**/api/pending-push?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pending: view ? { '12903': view } : {} }),
    }),
  )
}

const ready = {
  pr: 12903,
  headRef: 'feature/x',
  sha: 'abc1234',
  ahead: 2,
  files: ['app/Services/OrderService.php'],
  state: 'ready',
  pushRunId: 'chatmerge-12903',
}

test.describe('Push todo at the bottom of the index', () => {
  test('shows what is unpushed and pushes only after a confirm step', async ({ page }) => {
    await mockPendingPush(page, ready)
    const signals = []
    await page.route('**/api/workflows/chatmerge-12903/signals/merge', async (route) => {
      signals.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.getByTestId('push-todo')
    await expect(page.getByTestId('push-todo-heading')).toBeVisible()
    await expect(row.getByTestId('push-todo-title')).toContainText('2 commits nog niet gepusht')
    await expect(row.getByTestId('push-todo-title')).toContainText('feature/x')
    // The state reads as a WORD, never colour alone (the reviewer is colour-blind).
    await expect(row.getByTestId('push-todo-status')).toContainText('klaar om te pushen')

    // A click opens the same confirm menu Enter opens — it never pushes directly.
    await row.click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Push naar GitHub')
    expect(signals).toHaveLength(0)

    await page.keyboard.press('Enter') // into the confirm submenu
    await expect(menu).toContainText('Ja, push 2 commits naar feature/x')
    expect(signals).toHaveLength(0)

    await page.keyboard.press('Enter') // confirm
    await expect(menu).toHaveCount(0)
    await expect.poll(() => signals.length).toBe(1)
    expect(signals[0]).toEqual({ action: 'push' })
  })

  test('is the bottom-most keyboard stop of the index, below the search box loop', async ({
    page,
  }) => {
    await mockPendingPush(page, ready)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.getByTestId('push-todo')
    const focused = /bg-indigo-50/

    // ↓ from the last block walks onto this row (no toggle rows exist here).
    for (let i = 0; i < 40; i++) {
      const cls = (await row.getAttribute('class')) || ''
      if (focused.test(cls)) break
      await page.keyboard.press('ArrowDown')
    }
    await expect(row).toHaveClass(focused)

    // One more ↓ continues into the search box, and ↑ comes straight back.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(row).toHaveClass(focused)
  })

  test('a failed push keeps the row, with a retry wording', async ({ page }) => {
    await mockPendingPush(page, {
      ...ready,
      state: 'failed',
      error: 'De branch op GitHub is verder gelopen.',
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await expect(page.getByTestId('push-todo-status')).toContainText('push mislukt')
    await page.getByTestId('push-todo').click()
    await expect(page.getByTestId('command-menu')).toContainText('Push opnieuw naar GitHub')
  })

  test('no row at all when there is nothing to push', async ({ page }) => {
    await mockPendingPush(page, null)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await expect(page.getByTestId('pr-index')).toBeVisible()
    await expect(page.getByTestId('push-todo')).toHaveCount(0)
    await expect(page.getByTestId('push-todo-heading')).toHaveCount(0)
  })
})
