import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Comment-index rows used to be grouped per source line (commentGroupKeyOf,
// home.mjs): several open comments anchored to the same file+label+line
// collapsed into ONE "Start" row. That grouping was DELIBERATELY REVERTED
// (2026-08-27): a reviewer selecting the one grouped row for a mixed human
// review comment + an anchored AI-controle finding on the same line saw BOTH
// cards on the right for a single left-hand selection, breaking the harder
// invariant "what I select on the left is exactly what I see on the right,
// nothing else from the same block/selection" — even two purely human
// comments on the same line no longer group. See "Comment-index rows:
// grouping per source line was reverted" in comments-panel.md.

const NOW = new Date().toISOString()

function anchoredComment(id, body, line, extra = {}) {
  return {
    id,
    runId: 'run-' + id,
    pr: 12903,
    file: 'app/Http/Controllers/Api/ContractController.php',
    label: 'ContractController::index',
    line,
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

function mockComments(page, comments) {
  const state = { comments }
  const ready = page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.comments) }),
  )
  return Object.assign(ready, { serve: (next) => (state.comments = next) })
}

test.describe('comment-index rows are no longer grouped per line', () => {
  test('two human comments on the exact same line stay two separate rows', async ({ page }) => {
    await mockComments(page, [
      anchoredComment('grp-1', 'graag nullsafe hier', 1),
      anchoredComment('grp-2', 'en hier ontbreekt een null-check', 1, { id: 'grp-2', runId: 'run-grp-2' }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    // Each comment gets its OWN row — not merged into one "· +1" row.
    const rowA = page.locator('[data-idx]').filter({ hasText: 'graag nullsafe hier' })
    const rowB = page.locator('[data-idx]').filter({ hasText: 'en hier ontbreekt' })
    await expect(rowA).toHaveCount(1)
    await expect(rowB).toHaveCount(1)
    await expect(rowA).not.toContainText('· +1')
    await expect(rowB).not.toContainText('· +1')
    await expect(rowA.getByTestId('block-approval')).toHaveText('0/1')
    await expect(rowB.getByTestId('block-approval')).toHaveText('0/1')
    await expect(page.getByTestId('line-comment-heading')).toBeVisible()
  })

  test('a human comment and an anchored AI-controle finding on the same line never share a row or a right-hand card', async ({
    page,
  }) => {
    // Mirrors the reported bug: an AI-controle finding drops to kind === ''
    // once it resolves to a real line (anchoredWarning, code_warning.go), so
    // before the revert it grouped with an ordinary human comment on the
    // same line and both cards showed for one left-hand selection.
    await mockComments(page, [
      anchoredComment('human-1', 'Deze check doet volgens mij nooit iets', 1, { source: 'github' }),
      anchoredComment('ai-1', 'Een bot flow sluit direct af', 1, {
        id: 'ai-1',
        runId: 'run-ai-1',
        author: 'AI-controle',
        source: 'ai',
      }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const humanRow = page.locator('[data-idx]').filter({ hasText: 'Deze check doet volgens mij nooit iets' })
    const aiRow = page.locator('[data-idx]').filter({ hasText: 'Een bot flow sluit direct af' })
    await expect(humanRow).toHaveCount(1)
    await expect(aiRow).toHaveCount(1)

    // Selecting the human row shows exactly ONE comment card on the right,
    // its own — never the AI finding's card alongside it.
    await humanRow.click()
    const cards = page.getByTestId('comment-item')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('Deze check doet volgens mij nooit iets')

    // Selecting the AI row shows exactly its own finding, never the human
    // comment's card.
    await aiRow.click()
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('Een bot flow sluit direct af')
  })

  test('two comments on DIFFERENT lines stay two separate rows', async ({ page }) => {
    await mockComments(page, [
      anchoredComment('sep-1', 'graag nullsafe hier', 1),
      anchoredComment('sep-2', 'deze naam kan korter', 2, { id: 'sep-2', runId: 'run-sep-2' }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const rowA = page.locator('[data-idx]').filter({ hasText: 'graag nullsafe hier' })
    const rowB = page.locator('[data-idx]').filter({ hasText: 'deze naam kan korter' })
    await expect(rowA).toHaveCount(1)
    await expect(rowB).toHaveCount(1)
  })

  test('Space hides only this row; "Resolve comment" resolves only that row\'s comment', async ({
    page,
  }) => {
    const resolved = []
    await page.route('**/api/workflows/run-grp-1/signals/reply', async (route) => {
      resolved.push('grp-1')
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    await page.route('**/api/workflows/run-grp-2/signals/reply', async (route) => {
      resolved.push('grp-2')
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    const mock = mockComments(page, [
      anchoredComment('grp-1', 'graag nullsafe hier', 1, { source: '' }),
      anchoredComment('grp-2', 'en hier ontbreekt een null-check', 1, { id: 'grp-2', runId: 'run-grp-2', source: '' }),
    ])
    await mock
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const row = page.locator('[data-idx]').filter({ hasText: 'graag nullsafe hier' })
    await row.click()
    await expect(row.getByTestId('block-approval')).toHaveText('0/1')

    // Space hides the row (Ignore, see spaceKey in home.mjs) and never
    // resolves anything; revealing it again puts the cursor back on it.
    await page.keyboard.press('Space')
    await expect(row).toHaveCount(0)
    await expect(resolved).toEqual([])
    await page.getByTestId('toggle-ignored').click()
    await expect(row).toHaveCount(1)
    await row.click()

    // "Resolve comment" resolves only THIS row's own comment (grp-1) — the
    // other line comment (grp-2) is untouched, unlike the old group behavior.
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').filter({ hasText: 'Resolve comment' }).click()
    await expect.poll(() => resolved).toEqual(['grp-1'])
  })
})
