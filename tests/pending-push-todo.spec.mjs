import { test, expect, appReady, leaveSearchBox } from './_fixtures.mjs'

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
  // A path the block fixture really has, so the per-block marking below has
  // something to mark (tests/fixtures/blocks.json).
  files: ['app/Actions/CreatePaymentAction.php'],
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

  // Regression: rowIsCursor/rowInListRange (BlockList.mjs) used to only
  // exclude toggleFocused/ignoreToggleFocused/staleRowFocused, so stepping
  // onto this trailing row left the PREVIOUSLY selected block-row highlighted
  // too — two rows reading as "selected" at once.
  test('highlighting the push-todo row drops the previous block row highlight', async ({
    page,
  }) => {
    await mockPendingPush(page, ready)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const row = page.getByTestId('push-todo')
    const focused = /bg-indigo-50/
    for (let i = 0; i < 40; i++) {
      const cls = (await row.getAttribute('class')) || ''
      if (focused.test(cls)) break
      await page.keyboard.press('ArrowDown')
    }
    await expect(row).toHaveClass(focused)

    // Exactly one row in the whole index reads as selected while the
    // keyboard sits on the push-todo row — not the block row it came from.
    const index = page.getByTestId('pr-index')
    await expect(index.locator('[data-testid=block-row].bg-indigo-50')).toHaveCount(0)
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

  test('marks the blocks that came from the unpushed commits', async ({ page }) => {
    await mockPendingPush(page, ready)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // Two of the fixture's blocks live in that one file; every other row is
    // untouched, so the marking is not a blanket "this PR has something".
    const index = page.getByTestId('pr-index')
    await expect(index.getByTestId('row-unpushed')).toHaveCount(2)
    // The index row is icon-only (too little room next to the other pills);
    // the word still reaches an accessibility tree / hover via the title.
    await expect(index.getByTestId('row-unpushed').first()).toHaveAttribute('title', /ongepusht/i)

    // And the card of such a block says it too, so it also reads in diff mode
    // where the index has slid away.
    await index.getByTestId('block-row').nth(1).click()
    await expect(page.getByTestId('block-unpushed').first()).toContainText('ongepusht')
  })

  // Regression: isIndexMenu() (home.mjs) never listed ms.mode === 'pushTodo',
  // so menuAnchor()/menuRegion() fell through to the generic diff-pane
  // default instead of the sidebar — the menu still rendered somewhere
  // on-screen (positionMenu() clamps into the viewport, so a bare
  // toBeVisible() kept passing), just over the right-hand diff column
  // instead of the index/push-todo row the reviewer was actually looking
  // at. Reported: "menu is niet zichtbaar als ik wil pushen vanuit blokken
  // index". See "pushTodo was missing from isIndexMenu() entirely" in
  // .claude/docs/command-palette.md.
  test('opens its confirm menu positioned over the index, not the diff pane', async ({ page }) => {
    await mockPendingPush(page, ready)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // Select a real block first, same as any ordinary review session, so
    // state.selected points at a genuine diff/block row (not the push-todo
    // row itself) by the time the push-todo menu opens.
    await page.getByTestId('block-row').first().click()

    const row = page.getByTestId('push-todo')
    const focused = /bg-indigo-50/
    for (let i = 0; i < 40; i++) {
      const cls = (await row.getAttribute('class')) || ''
      if (focused.test(cls)) break
      await page.keyboard.press('ArrowDown')
    }
    await expect(row).toHaveClass(focused)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Push naar GitHub')
    // Let positionMenu()'s own reposition-after-render settle.
    await page.waitForTimeout(300)

    const menuBox = await menu.boundingBox()
    const indexBox = await page.getByTestId('pr-index').boundingBox()
    // The menu sits over the sidebar/its own row (menuRegion's pr-index),
    // not off in the diff pane on the right — a few px of slack for the
    // viewport clamp in positionMenu().
    expect(menuBox.x).toBeGreaterThanOrEqual(indexBox.x - 5)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(indexBox.x + indexBox.width + 5)
  })

  test('no row at all when there is nothing to push', async ({ page }) => {
    await mockPendingPush(page, null)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await expect(page.getByTestId('pr-index')).toBeVisible()
    await expect(page.getByTestId('push-todo')).toHaveCount(0)
    await expect(page.getByTestId('push-todo-heading')).toHaveCount(0)
    await expect(page.getByTestId('row-unpushed')).toHaveCount(0)
  })
})

// The same read model also marks the PR-overview row, so "this one still has
// something of mine waiting" is visible before opening the review tree at all
// (unpushedPill/kickOffPendingPush in overview.mjs). 12903 is the fixture's own
// ingested PR (hasGraph) — the badge is scoped to those rows.
test.describe('Ongepusht badge on the PR overview', () => {
  test('shows the badge on an ingested row with unpushed work', async ({ page }) => {
    await mockPendingPush(page, ready)
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.getByTestId('unpushed-badge')
    await expect(badge).toHaveCount(1)
    await expect(badge).toContainText('Ongepusht 2')
  })

  test('no badge when nothing is waiting', async ({ page }) => {
    await mockPendingPush(page, null)
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.getByTestId('pr-row').first()).toBeVisible()
    await expect(page.getByTestId('unpushed-badge')).toHaveCount(0)
  })
})
