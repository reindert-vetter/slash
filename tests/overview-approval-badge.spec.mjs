import { test, expect, appReady } from './_fixtures.mjs'

// The per-PR reviewer-approval badge on /pr-overview: a green "✓ done/total"
// pill once fully approved, a neutral grey "done/total" while in progress,
// nothing until total>0 — mirroring the /pr/<id> sidebar pill. Backend:
// GET /api/approvalsummary?prs=… rolls up done/total over the whole PR from the
// approvals read-model + the server-side blockstats count. Frontend:
// kickOffApprovals backfills state.approvals, approvalPill renders the chip.
test.describe('PR Review Tree — PR-overview approval badge', () => {
  // Backend smoke test, like blockstats.spec.mjs' /api/blockstats test: the
  // seeded PR 12903 has real base/head worktrees on disk, so the endpoint
  // returns a real (non-negative, done ≤ total) rollup with a positive total.
  test('GET /api/approvalsummary returns a per-PR done/total rollup', async ({ page }) => {
    const res = await page.request.get('/api/approvalsummary?prs=12903')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.ok).toBe(true)
    const s = body.summaries['12903']
    expect(typeof s).toBe('object')
    expect(Number.isInteger(s.total)).toBeTruthy()
    expect(s.total).toBeGreaterThan(0)
    expect(Number.isInteger(s.done)).toBeTruthy()
    expect(s.done).toBeGreaterThanOrEqual(0)
    expect(s.done).toBeLessThanOrEqual(s.total)
  })

  // Fully approved → green pill with the ✓ (check) icon. Route the summary so
  // the done/total is deterministic regardless of the worker's approvals DB.
  test('a fully approved PR shows a green ✓ done/total badge', async ({ page }) => {
    await page.route('**/api/approvalsummary*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, summaries: { 12903: { done: 10, total: 10 } } }) }),
    )
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.locator('[data-testid="pr-row"][data-pr="12903"] [data-testid="approval-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('10/10')
    // Green (emerald) + a check svg icon.
    await expect(badge).toHaveClass(/emerald/)
    await expect(badge.locator('svg')).toHaveCount(1)
  })

  // In progress → neutral grey pill, no check icon. Also proves a non-ingested
  // row (no hasGraph) never gets a badge even when the summary carries it.
  test('an in-progress PR shows a neutral done/total badge (no ✓)', async ({ page }) => {
    await page.route('**/api/approvalsummary*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, summaries: { 12903: { done: 4, total: 10 }, 12801: { done: 1, total: 2 } } }) }),
    )
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.locator('[data-testid="pr-row"][data-pr="12903"] [data-testid="approval-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('4/10')
    await expect(badge).not.toHaveClass(/emerald/)
    await expect(badge.locator('svg')).toHaveCount(0)

    // 12801 is not ingested (no seeded blocks), so its row shows no badge even
    // though the mocked summary supplied one.
    const badges = page.locator('[data-testid="approval-badge"]')
    await expect(badges).toHaveCount(1)
  })
})
