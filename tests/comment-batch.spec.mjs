import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Laat Claude alle openstaande comments verwerken" (comment_batch.go) plus the
// two index changes it rides on:
//
//  1. EVERY unresolved comment gets its own blokken-index row (indexComments,
//     RelatedPanel.mjs) — not just PR-wide/mentioned ones.
//  2. Space on such a row RESOLVES the comment (spaceKey, home.mjs), which is
//     that row's equivalent of approving and what makes the ↑/↓ walk over the
//     open comments finishable.
//
// The batch run itself is server-side and needs a real claude CLI, so this spec
// stops at the palette: the entry item, the list of comments under each other,
// and the jump a row performs. See .claude/docs/workflows-comments.md.

// Same mutable-state route shape as comment-index-items.spec.mjs (never
// unroute+route: the 5s comment poll can land in the gap and reach the real,
// empty endpoint).
function mockComments(page, comments) {
  const state = { comments }
  const ready = page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.comments),
    }),
  )
  return Object.assign(ready, { serve: (next) => (state.comments = next) })
}

const NOW = new Date().toISOString()

function anchoredComment(id, body, extra = {}) {
  return {
    id,
    runId: 'run-' + id,
    pr: 12903,
    file: 'app/Http/Controllers/Api/ContractController.php',
    label: 'ContractController::index',
    line: 1,
    author: 'octocat',
    body,
    createdAt: NOW,
    reactionCount: 0,
    status: 'open',
    source: 'github',
    kind: '',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
    ...extra,
  }
}

test.describe('Comment batch', () => {
  test('an unresolved block-anchored comment gets its own index row; an AI finding is not offered to the batch', async ({
    page,
  }) => {
    await mockComments(page, [
      anchoredComment('cb-1', 'graag nullsafe hier'),
      anchoredComment('cb-2', 'deze naam kan korter', { id: 'cb-2', runId: 'run-cb-2' }),
      // An AI risk finding: it still gets its own index row (unchanged), but it
      // must never be handed to the batch — "van GitHub + eigen, geen AI".
      {
        id: 'cb-ai',
        runId: 'run-cb-ai',
        pr: 12903,
        file: '',
        line: 0,
        author: 'AI-controle',
        body: 'mogelijk risico in deze functie',
        createdAt: NOW,
        reactionCount: 0,
        status: 'open',
        source: 'ai',
        kind: 'ai_warning',
        reactions: [],
        rowStart: -1,
        rowEnd: -1,
      },
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    // Both open comments are index rows of their own.
    await expect(page.locator('[data-idx]').filter({ hasText: 'graag nullsafe hier' })).toHaveCount(1)
    await expect(page.locator('[data-idx]').filter({ hasText: 'deze naam kan korter' })).toHaveCount(1)

    // The PR menu's "PR keuren" submenu carries the batch entry, counting only
    // the two eligible comments (the AI finding is excluded). `/` only opens the
    // PR-wide menu from stop 1 — with a comment row selected it opens that row's
    // own menu instead (contextMenuMode, home.mjs).
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').filter({ hasText: 'GitHub' }).first().click()
    await expect(menu).toContainText('PR keuren')
    await menu.getByTestId('command-row').filter({ hasText: 'PR keuren' }).click()
    const entry = menu.getByTestId('command-row').filter({ hasText: 'Laat Claude alle openstaande comments verwerken' })
    await expect(entry).toContainText('(2)')

    // Opening it lists the comments under each other, with a start row on top.
    await entry.click()
    await expect(menu.getByTestId('command-row').filter({ hasText: 'Verwerk 2 comments met Claude' })).toBeVisible()
    await expect(menu.getByTestId('command-row').filter({ hasText: 'graag nullsafe hier' })).toHaveCount(1)
    await expect(menu.getByTestId('command-row').filter({ hasText: 'mogelijk risico' })).toHaveCount(0)

    // Enter on a comment row jumps to that comment (and closes the palette).
    await menu.getByTestId('command-row').filter({ hasText: 'deze naam kan korter' }).click()
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card').first()).toContainText('deze naam kan korter')
  })

  test('Space on a comment index row resolves it', async ({ page }) => {
    // A comment placed in this app (no `source`), so the resolve signal reaches
    // its own task_code_comment run — which the harness has, since the comment
    // itself is mocked. The write is intercepted so this stays a UI test.
    const resolved = []
    await page.route('**/api/workflows/run-cb-1/signals/reply', async (route) => {
      resolved.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    const mock = mockComments(page, [anchoredComment('cb-1', 'graag nullsafe hier', { source: '' })])
    await mock
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

    await page.keyboard.press('Space')
    await expect.poll(() => resolved.length).toBe(1)
    expect(resolved[0].done).toBe(true)

    // Once the read model reports it resolved, the row leaves the index again.
    mock.serve([anchoredComment('cb-1', 'graag nullsafe hier', { source: '', status: 'resolved' })])
    await expect(page.locator('[data-idx]').filter({ hasText: 'graag nullsafe hier' })).toHaveCount(0)
  })
})
