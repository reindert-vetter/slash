import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Laat Claude alle openstaande comments verwerken" (comment_batch.go) plus the
// index changes it rides on:
//
//  1. EVERY unresolved comment gets its own blokken-index row (indexComments,
//     RelatedPanel.mjs) — not just PR-wide/mentioned ones.
//  2. Every batch-eligible row (isBatchEligible, commentBatch.mjs) gets its own
//     checkbox, checked by default; a bottom action row runs the batch over
//     whatever is currently checked. There is deliberately no palette entry
//     point anymore — see .claude/docs/comments-panel.md's "The comment_batch
//     checkboxes and the bottom action row".
//  3. `Space` on such a row TOGGLES that checkbox (or advances to the next row
//     when there is none) — it deliberately does NOT resolve the comment.
//     Resolving only happens through the row's own `Enter` menu. An earlier
//     cut had Space resolve directly, reverted as "too easy to trigger by
//     accident" (see .claude/docs/approval.md).
//
// The batch run itself is server-side and needs a real claude CLI, so this spec
// stops at the POST it sends. See .claude/docs/workflows-comments.md.

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

function aiFinding(id) {
  return {
    id,
    runId: 'run-' + id,
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
  }
}

function rowFor(page, text) {
  return page.locator('[data-idx]').filter({ hasText: text })
}

test.describe('Comment batch', () => {
  test('eligible rows get a checked checkbox, an AI finding gets none, and the bottom action row counts + starts the run', async ({
    page,
  }) => {
    const started = []
    await page.route('**/api/workflows/comment_batch', async (route) => {
      started.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"runId":"batch-run"}' })
    })
    await mockComments(page, [
      anchoredComment('cb-1', 'graag nullsafe hier'),
      // A DIFFERENT line than cb-1 — comments on the exact same line now
      // group into one index row (commentGroupKeyOf, see
      // comments-panel.md), and this test wants two SEPARATE rows.
      anchoredComment('cb-2', 'deze naam kan korter', { id: 'cb-2', runId: 'run-cb-2', line: 2 }),
      // An AI risk finding: it still gets its own index row (unchanged), but it
      // must never be offered a checkbox — "van GitHub + eigen, geen AI".
      aiFinding('cb-ai'),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const row1 = rowFor(page, 'graag nullsafe hier')
    const row2 = rowFor(page, 'deze naam kan korter')
    const rowAi = rowFor(page, 'mogelijk risico')

    // Checked by default on both eligible rows, no checkbox at all on the AI row.
    await expect(row1.getByTestId('batch-checkbox')).toBeChecked()
    await expect(row2.getByTestId('batch-checkbox')).toBeChecked()
    await expect(rowAi.getByTestId('batch-checkbox')).toHaveCount(0)

    const actionRow = page.getByTestId('batch-action-row')
    await expect(actionRow).toContainText('Verwerk 2 comments met Claude (Opus 5)')

    // Unchecking one row (mouse) lowers the count and excludes it from the run.
    await row2.getByTestId('batch-checkbox').click()
    await expect(row2.getByTestId('batch-checkbox')).not.toBeChecked()
    await expect(actionRow).toContainText('Verwerk 1 comment met Claude (Opus 5)')

    // Clicking a REGULAR row never toggles its checkbox (only the checkbox's
    // own click does) — selecting cb-1 first, both anchored to the same block,
    // opens it "as if fully expanded" (see openCommentAnchorDrill, home.mjs).
    await row1.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')
    await expect(row1.getByTestId('batch-checkbox')).toBeChecked()

    // The action row starts the run over exactly the checked comment(s) and
    // jumps to the first one.
    await actionRow.click()
    await expect.poll(() => started.length).toBe(1)
    expect(started[0].commentIds).toEqual(['cb-1'])
    await expect(page.locator('[data-idx].bg-indigo-50')).toContainText('graag nullsafe hier')
  })

  test('Space toggles the selected row\'s own checkbox; a row with none advances instead', async ({ page }) => {
    await mockComments(page, [
      anchoredComment('cb-1', 'graag nullsafe hier'),
      anchoredComment('cb-2', 'deze naam kan korter', { id: 'cb-2', runId: 'run-cb-2', line: 2 }),
      // No checkbox at all — Space here must advance, never resolve/toggle
      // anything (see aiFinding's own doc comment above).
      aiFinding('cb-ai'),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const row2 = rowFor(page, 'deze naam kan korter')
    await row2.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')
    await expect(row2.getByTestId('batch-checkbox')).toBeChecked()

    await page.keyboard.press('Space')
    await expect(row2.getByTestId('batch-checkbox')).not.toBeChecked()
    await expect(page.getByTestId('batch-action-row')).toContainText('Verwerk 1 comment met Claude (Opus 5)')

    // Pressing it again re-checks — a plain toggle, not a one-way exclude.
    await page.keyboard.press('Space')
    await expect(row2.getByTestId('batch-checkbox')).toBeChecked()
    await expect(page.getByTestId('batch-action-row')).toContainText('Verwerk 2 comments met Claude (Opus 5)')

    // The AI finding has no checkbox — Space there just advances the selection
    // (mirrors the ordinary "↓ falls through" convention) instead of resolving
    // it or doing nothing.
    const rowAi = rowFor(page, 'mogelijk risico')
    await rowAi.click()
    await expect(rowAi.getByTestId('batch-checkbox')).toHaveCount(0)
    await page.keyboard.press('Space')
    await expect(rowAi).not.toHaveClass(/bg-indigo-50/)
  })

  test('clicking the checkbox does not steal keyboard focus: Enter still opens the row\'s full menu afterward', async ({
    page,
  }) => {
    // The actual reported bug: a mouse click on the checkbox left it holding
    // real DOM focus, and isEditableFocused() (home.mjs) then swallowed every
    // later Enter/Space app-wide — see "Generic input-focus guard" in
    // keyboard-navigation.md.
    await mockComments(page, [anchoredComment('cb-1', 'graag nullsafe hier')])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const row = rowFor(page, 'graag nullsafe hier')
    await row.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')

    await row.getByTestId('batch-checkbox').click()
    await expect(row.getByTestId('batch-checkbox')).not.toBeChecked()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('command-row').filter({ hasText: 'Resolve comment' })).toHaveCount(1)
    await expect(menu.getByTestId('command-row').filter({ hasText: 'Beantwoorden' })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Space still works too, right after the click.
    await page.keyboard.press('Space')
    await expect(row.getByTestId('batch-checkbox')).toBeChecked()
  })

  test('resolving a comment now only happens through the Enter menu, never bare Space', async ({ page }) => {
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
    // Sorts under "Comments op regels" (b.lineAnchored), so the default
    // selection lands elsewhere — select it directly. Anchored to a real
    // block — opens "as if fully expanded" instead of showing
    // commentDetailCard (see openCommentAnchorDrill, home.mjs).
    const row = rowFor(page, 'graag nullsafe hier')
    await row.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')

    // Space toggles the checkbox, never resolves.
    await page.keyboard.press('Space')
    expect(resolved.length).toBe(0)
    await expect(row.getByTestId('batch-checkbox')).not.toBeChecked()

    // Enter → default "Resolve comment" (own comment) → Enter actually resolves.
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('command-row').nth(1)).toContainText('Resolve comment')
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect.poll(() => resolved.length).toBe(1)
    expect(resolved[0].done).toBe(true)

    // Once the read model reports it resolved, the row leaves the index again.
    mock.serve([anchoredComment('cb-1', 'graag nullsafe hier', { source: '', status: 'resolved' })])
    await expect(row).toHaveCount(0)
  })
})
