import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Comment-index rows are grouped per source line (commentGroupKeyOf,
// home.mjs): several open comments anchored to the same file+label+line now
// collapse into ONE "Start" row instead of one row per comment — reviewer
// request. See "Comment-index rows are grouped per source line" in
// comments-panel.md.

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

test.describe('comment-index rows grouped per line', () => {
  test('two comments on the exact same line become one row, with a "· +1" suffix', async ({ page }) => {
    await mockComments(page, [
      anchoredComment('grp-1', 'graag nullsafe hier', 1),
      anchoredComment('grp-2', 'en hier ontbreekt een null-check', 1, { id: 'grp-2', runId: 'run-grp-2' }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    // Exactly ONE comment row for both comments — not two.
    const row = page.locator('[data-idx="0"]')
    await expect(row).toContainText('graag nullsafe hier')
    await expect(row).toContainText('· +1')
    await expect(page.locator('[data-idx="1"]')).not.toContainText('en hier ontbreekt')
    // Only a real block sits at index 1, never a second comment row.
    await expect(page.getByTestId('comment-heading')).toBeVisible()

    // blockApproveCount sums the whole group, not a fixed 0/1.
    await expect(row.getByTestId('block-approval')).toHaveText('0/2')
  })

  test('two comments on DIFFERENT lines stay two separate rows', async ({ page }) => {
    await mockComments(page, [
      anchoredComment('sep-1', 'graag nullsafe hier', 1),
      anchoredComment('sep-2', 'deze naam kan korter', 2, { id: 'sep-2', runId: 'run-sep-2' }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.locator('[data-idx="0"]')).toContainText('graag nullsafe hier')
    await expect(page.locator('[data-idx="0"]')).not.toContainText('· +1')
    await expect(page.locator('[data-idx="1"]')).toContainText('deze naam kan korter')
  })

  test("Space resolves a group's comments one at a time", async ({ page }) => {
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
    await expect(page.locator('[data-idx="0"]').getByTestId('block-approval')).toHaveText('0/2')

    // First Space resolves the group's first still-open comment (grp-1).
    await page.keyboard.press('Space')
    await expect.poll(() => resolved).toEqual(['grp-1'])

    // The read model now reports grp-1 resolved — a resolved, non-mentioning
    // comment drops out of indexComments() entirely (unchanged, pre-existing
    // behavior), so the group's own candidate set shrinks to just grp-2
    // rather than accumulating "1/2". Space must still progress onto grp-2
    // instead of silently no-op'ing (there is no longer a resolved grp-1 in
    // the group to get stuck on).
    mock.serve([
      anchoredComment('grp-1', 'graag nullsafe hier', 1, { source: '', status: 'resolved' }),
      anchoredComment('grp-2', 'en hier ontbreekt een null-check', 1, {
        id: 'grp-2',
        runId: 'run-grp-2',
        source: '',
      }),
    ])
    await expect(page.locator('[data-idx="0"]').getByTestId('block-approval')).toHaveText('0/1')
    await expect(page.locator('[data-idx="0"]')).toContainText('en hier ontbreekt een null-check')

    await page.keyboard.press('Space')
    await expect.poll(() => resolved).toEqual(['grp-1', 'grp-2'])
  })
})
