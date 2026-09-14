import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// `Space` on a blokken-index comment row (spaceKey, home.mjs). Reviewer
// request: "spatie in de comment op regel en ai warning index item, dan wil ik
// het verwijderen en naar de volgende gaan" — answered with Ignore (reversible,
// the row returns via "Toon N verborgen comments"), NOT resolve or delete:
// Space is one keypress with no confirm, and an earlier cut that let it resolve
// outright was reverted as too easy to trigger by accident.
//
// Scoped to the two sections named: "Comments op regels" (b.lineAnchored) and
// every AI risk finding. The comment_batch checkbox + its bottom action row —
// what Space used to toggle here — were removed with the same change, so the
// index no longer starts a batch run at all.
//
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

test.describe('Space on a comment-index row', () => {
  test('hides a "Comments op regels" row, lands on the next comment row, and the row comes back via the toggle', async ({
    page,
  }) => {
    await mockComments(page, [
      anchoredComment('sp1-a', 'graag nullsafe hier'),
      // A DIFFERENT line than the first — comments on the exact same line group into
      // one index row (commentGroupKeyOf), and this test wants two rows.
      anchoredComment('sp1-b', 'deze naam kan korter', { id: 'sp1-b', runId: 'run-sp1-b', line: 2 }),
    ])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const row1 = rowFor(page, 'graag nullsafe hier')
    const row2 = rowFor(page, 'deze naam kan korter')
    await row1.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')

    await page.keyboard.press('Space')
    // Gone from the index, and the cursor moved on to the next comment row.
    await expect(row1).toHaveCount(0)
    await expect(row2).toHaveClass(/bg-indigo-50/)

    // Reversible: "Toon 1 verborgen comment" brings it straight back.
    const toggle = page.getByTestId('toggle-ignored')
    await expect(toggle).toContainText('1 verborgen comment')
    await toggle.click()
    await expect(row1).toHaveCount(1)
  })

  test('hides an AI risk finding too, and never resolves anything', async ({ page }) => {
    const signalled = []
    await page.route('**/api/workflows/run-sp2-ai/signals/**', async (route) => {
      signalled.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    await mockComments(page, [aiFinding('sp2-ai'), anchoredComment('sp2-b', 'graag nullsafe hier')])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    const rowAi = rowFor(page, 'mogelijk risico')
    await rowAi.click()
    await page.keyboard.press('Space')
    await expect(rowAi).toHaveCount(0)
    // No reply/resolve/delete signal was sent for it — Ignore is the whole
    // action (its own durable write goes to the ignore_comment tracker, which
    // this PR has no run for in the harness, so it degrades to session-only).
    expect(signalled.filter((u) => u.includes('/reply') || u.includes('/delete'))).toEqual([])
  })

  test('the comment_batch checkbox and its bottom action row are gone', async ({ page }) => {
    await mockComments(page, [anchoredComment('sp3-a', 'graag nullsafe hier')])
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()

    await expect(page.getByTestId('batch-checkbox')).toHaveCount(0)
    await expect(page.getByTestId('batch-action-row')).toHaveCount(0)
  })

  test('resolving still only happens through the Enter menu, never bare Space', async ({ page }) => {
    // A comment placed in this app (no `source`), so the resolve signal reaches
    // its own task_code_comment run. The write is intercepted so this stays a
    // UI test.
    const resolved = []
    await page.route('**/api/workflows/run-sp4-a/signals/reply', async (route) => {
      resolved.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })
    const mock = mockComments(page, [anchoredComment('sp4-a', 'graag nullsafe hier', { source: '' })])
    await mock
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Sorts under "Comments op regels" (b.lineAnchored), so the default
    // selection lands elsewhere — select it directly. Anchored to a real block,
    // so it opens "as if fully expanded" (openCommentAnchorDrill, home.mjs).
    const row = rowFor(page, 'graag nullsafe hier')
    await row.click()
    await expect(page.getByTestId('drill-column')).toContainText('ContractController::index')

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
    mock.serve([anchoredComment('sp4-a', 'graag nullsafe hier', { source: '', status: 'resolved' })])
    await expect(row).toHaveCount(0)
  })
})
