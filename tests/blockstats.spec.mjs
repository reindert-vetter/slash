import { test, expect } from './_fixtures.mjs'

// Hiding fully-approved starting points + the PR-wide header counter. Like the
// combined-approval tests, we mount BlockList directly with inline state (the
// component owns the hide/toggle + header logic); home.mjs's server-backed
// state.blockTotals only feeds the { done, total } numbers we supply here. A
// separate smoke test covers that GET /api/blockstats is wired and computes the
// totals server-side from the worktrees.
test.describe('PR Review Tree — hide approved blocks + header counter', () => {
  test('fully-approved top-level blocks are hidden and a toggle reveals them', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const BlockList = (await import('/src/BlockList.mjs')).default
      const mk = (id, label) => ({
        id,
        category: 'ACTION',
        label,
        status: 'modified',
        file: 'app/Foo.php',
        side: 'new',
      })
      const state = reactive({
        mode: 'list',
        selected: 0,
        showApproved: false,
        blocks: [mk('b1', 'Foo::a'), mk('b2', 'Foo::b'), mk('b3', 'Foo::c')],
        // b1 partial, b2 fully approved (hidden), b3 untouched.
        approvalSummaries: {
          b1: { done: 1, total: 3 },
          b2: { done: 2, total: 2 },
          b3: { done: 0, total: 2 },
        },
        approvalTotal: { done: 3, total: 7 },
      })
      const host = document.createElement('div')
      host.id = 'bl-host'
      document.body.appendChild(host)
      BlockList(state)(host)
      window.__st = state
    })

    const host = page.locator('#bl-host')
    const rows = host.getByTestId('block-row')

    // b2 is fully approved → hidden by default: only b1 and b3 show.
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Foo::a')
    await expect(rows.nth(1)).toContainText('Foo::c')

    // The header shows the PR-wide, server-backed combined count.
    const summary = host.getByTestId('approval-summary')
    await expect(summary).toContainText('3/7 goedgekeurd')
    await expect(summary).toContainText('4 nog te reviewen')

    // The toggle names how many are hidden; clicking reveals them.
    const toggle = host.getByTestId('toggle-approved')
    await expect(toggle).toHaveText(/Toon 1 goedgekeurde block/)
    await toggle.click()
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('Foo::b')
    await expect(toggle).toHaveText(/Verberg 1 goedgekeurde block/)
  })

  test('the header counter is hidden when there is nothing to approve', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const BlockList = (await import('/src/BlockList.mjs')).default
      const state = reactive({
        mode: 'list',
        selected: 0,
        showApproved: false,
        blocks: [
          { id: 'b1', category: 'ACTION', label: 'Foo::a', status: 'modified', file: 'app/Foo.php', side: 'new' },
        ],
        approvalSummaries: { b1: { done: 0, total: 0 } },
        approvalTotal: { done: 0, total: 0 },
      })
      const host = document.createElement('div')
      host.id = 'bl-host2'
      document.body.appendChild(host)
      BlockList(state)(host)
    })
    const host = page.locator('#bl-host2')
    await expect(host.getByTestId('block-row')).toHaveCount(1)
    await expect(host.getByTestId('approval-summary')).toHaveCount(0)
    // Nothing fully approved → no toggle button.
    await expect(host.getByTestId('toggle-approved')).toHaveCount(0)
  })

  // Wiring smoke test: the read-only endpoint computes a per-block total map
  // server-side from the base/head worktrees. Asserts the shape + that it keys the
  // PR's blocks (the exact JS/Go count parity is guarded by TestChangedRowCount).
  test('GET /api/blockstats returns a server-computed per-block total map', async ({
    page,
  }) => {
    const res = await page.request.get('/api/blockstats?pr=12903')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.pr).toBe(12903)
    expect(typeof body.totals).toBe('object')
    // Every stored block has an entry; totals are non-negative integers.
    const ids = Object.keys(body.totals)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('12903:app/Models/Order.php:Order::address')
    for (const v of Object.values(body.totals)) {
      expect(Number.isInteger(v)).toBeTruthy()
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})
