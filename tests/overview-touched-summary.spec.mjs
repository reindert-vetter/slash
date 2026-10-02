import { test, expect, appReady } from './_fixtures.mjs'

// The "Migrations & API changes" section is a summary list (see
// .claude/docs/pr-overview.md): its rows are compact — avatar + name, title +
// DB/API badges, a 1-2 line change summary (prStatus.touchSummary, built by
// inbox_touch_summary.go) and the chevron — and they never join a stack.
// The shared fixture has no such section, so the inbox and status responses
// are extended in-flight.
const TOUCHED = 'Migrations & API changes'

test.describe('PR overview — Migrations & API changes summary rows', () => {
  test('renders a compact row with the DB/API summary and keeps it out of stacks', async ({ page }) => {
    await page.route('**/api/inbox', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.sections = body.sections || []
      body.sections.push({
        title: TOUCHED,
        prs: [
          // 970901 is stacked on 970902's head branch: in any other section
          // computeStacks would lift both into a "Gestapelde PR's" group.
          { number: 970901, title: 'Add refund columns', author: 'alice', updatedAt: '2026-09-30T10:00:00Z', baseRefName: 'feat/base', headRefName: 'feat/refund' },
          { number: 970902, title: 'Base change', author: 'alice', updatedAt: '2026-09-30T10:00:00Z', baseRefName: 'main', headRefName: 'feat/base' },
        ],
      })
      await route.fulfill({ response: res, json: body })
    })
    await page.route('**/api/inbox/status**', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.statuses = body.statuses || {}
      body.statuses['970901'] = {
        migrationFiles: ['database/migrations/2026_09_01_000000_alter_orders.php'],
        apiFiles: ['routes/api.php'],
        touchSummary: {
          db: [{ kind: 'alter', name: 'orders', add: ['refund_id'], del: ['legacy'] }, { kind: 'create', name: 'refunds' }],
          api: [{ kind: 'routes', name: 'api', add: ['POST /orders/{id}/refund'] }],
        },
      }
      // No summary (e.g. the patch fetch failed): falls back to file names.
      body.statuses['970902'] = { apiFiles: ['app/Http/Resources/OrderResource.php'] }
      await route.fulfill({ response: res, json: body })
    })

    await page.goto('/pr-overview')
    await appReady(page)

    const section = page.locator(`[data-testid="section"][data-title="${TOUCHED}"]`)
    const row = section.locator('[data-testid="pr-row"][data-pr="970901"]')
    await expect(row).toHaveAttribute('data-compact', 'true')
    await expect(row.locator('[data-testid="row-author"]')).toBeVisible()
    await expect(row.locator('[data-testid="touch-migrations"]')).toBeVisible()
    await expect(row.locator('[data-testid="touch-api"]')).toBeVisible()
    await expect(row.locator('[data-testid="touch-summary-db"]')).toHaveText('DB orders: +refund_id, −legacy · Nieuwe tabel refunds')
    await expect(row.locator('[data-testid="touch-summary-api"]')).toHaveText('API routes/api: +POST /orders/{id}/refund')
    // The full row's tracks are absent.
    await expect(row.locator('[data-testid="reviewers"]')).toHaveCount(0)

    await expect(section.locator('[data-pr="970902"] [data-testid="touch-summary-api"]')).toHaveText('API OrderResource')
    // Not lifted into a stack.
    await expect(page.locator('[data-testid="stack"] [data-pr="970901"]')).toHaveCount(0)

    // Clicking still opens the ordinary popover.
    await row.click()
    await expect(row.locator('[data-testid="pr-popover"]')).toBeVisible()
  })
})
