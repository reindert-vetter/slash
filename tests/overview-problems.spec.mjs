import { test, expect, appReady } from './_fixtures.mjs'

// The "Mislukte taken" block at the bottom of /pr-overview surfaces work that
// went wrong out of sight: a workflow run that ended in status `failed`
// (durable, from the tembed store) and a poller/startup error that only ever
// reached the log (mirrored into an in-memory ring buffer). Both come from the
// read-only GET /api/problems — see run_errors.go.
//
// The populated case is driven through page.route rather than by provoking a
// real failure: every reachable failure path here is either best-effort (it
// logs and carries on, so nothing lands in the store) or depends on a live
// gh/network hiccup, neither of which is deterministic in a worker. What the
// backend actually reports is covered by run_errors_test.go; this spec is about
// the rendering — the words, and that these rows stay out of the keyboard nav.
const PROBLEMS = {
  ok: true,
  failedRuns: [
    {
      runId: 'run-boom-1',
      workflow: 'build_relations',
      pr: 12903,
      updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      error: 'tembed: workflow failed: resolveCalls: no such worktree',
    },
    {
      runId: 'run-boom-2',
      workflow: 'task_code_comment',
      pr: 12903,
      updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      error: 'tembed: workflow failed: save reaction: database is locked (5)',
      comment: { file: 'src/Billing/Invoice.php', line: 42, snippet: 'Kun je hier een guard clause van maken?' },
    },
  ],
  logErrors: [
    {
      at: new Date(Date.now() - 90_000).toISOString(),
      scope: 'import comments',
      pr: 970099,
      message: 'import comments: fetch review comments pr=970099: gh api ...: exit status 1',
    },
  ],
  // A row names the PR, not just its number — see problemPrChip.
  prTitles: { 12903: 'Refactor de facturatie-export' },
}

function stubProblems(page, body) {
  return page.route('**/api/problems', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  )
}

test.describe('PR overview — "Mislukte taken" block', () => {
  test('is always present and collapsed, and reports the count in words', async ({ page }) => {
    await stubProblems(page, PROBLEMS)
    await page.goto('/pr-overview')
    await appReady(page)

    const toggle = page.locator('[data-testid="problems-drawer"]')
    await expect(toggle).toBeVisible()
    // Collapsed: the count is readable without expanding (3 = 2 failed runs +
    // 1 mirrored log line).
    await expect(page.locator('[data-testid="problems-count"]')).toHaveText('Mislukte taken · 3')
    await expect(page.locator('[data-testid="problem-run"]')).toHaveCount(0)

    await toggle.click()

    const run = page.locator('[data-testid="problem-run"]').first()
    await expect(page.locator('[data-testid="problem-run"]')).toHaveCount(2)
    // The failure is carried by a word (+ a ⚠ glyph), never colour alone.
    await expect(run).toContainText('mislukt')
    await expect(run).toContainText('Relaties') // the workflow's Dutch label
    await expect(run).toContainText('#12903')
    await expect(run).toContainText('Refactor de facturatie-export') // the PR title
    await expect(run).toContainText('no such worktree')

    // A failed comment thread says WHICH comment: file:line + a body snippet.
    const commentLine = page.locator('[data-testid="problem-run-comment"]')
    await expect(commentLine).toHaveCount(1)
    await expect(commentLine).toContainText('Invoice.php:42')
    await expect(commentLine).toContainText('guard clause')

    const logRow = page.locator('[data-testid="problem-log"]')
    await expect(logRow).toHaveCount(1)
    await expect(logRow).toContainText('overgeslagen')
    await expect(logRow).toContainText('import comments')
    await expect(logRow).toContainText('#970099')
  })

  test('shows an explicit empty state when nothing went wrong', async ({ page }) => {
    await stubProblems(page, { ok: true, failedRuns: [], logErrors: [] })
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator('[data-testid="problems-count"]')).toHaveText('Mislukte taken · geen')
    await page.locator('[data-testid="problems-drawer"]').click()
    // The empty branch really renders (the single↔array slot pitfall would
    // leave the slot stuck instead).
    await expect(page.locator('[data-testid="problems-empty"]')).toBeVisible()
    await expect(page.locator('[data-testid="problem-run"]')).toHaveCount(0)
  })

  test('its rows never join the keyboard navigation', async ({ page }) => {
    await stubProblems(page, PROBLEMS)
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="problems-drawer"]').click()
    await expect(page.locator('[data-testid="problem-run"]')).toHaveCount(2)

    // paintSelection() iterates every [data-nav-row]; a failure line must not
    // be one, or the selection ring could land on it.
    const inProblems = await page
      .locator('[data-testid="problem-run"][data-nav-row], [data-testid="problem-log"][data-nav-row]')
      .count()
    expect(inProblems).toBe(0)

    // With the drawer open, ArrowDown still selects a real PR row — the ring
    // (ring-indigo-500/50, see paintSelection) lands there, never on a
    // failure line.
    await expect(page.locator('[data-testid="pr-row"]').first()).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-nav-row].ring-indigo-500\\/50')).toHaveCount(1)
    await expect(page.locator('[data-testid="pr-row"].ring-indigo-500\\/50')).toHaveCount(1)
  })
})
