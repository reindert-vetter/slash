import { test, expect } from './_fixtures.mjs'

// Combined approval indicators. The seeded fixture DB has no worktrees, so
// /api/code (and thus a real diff with changed rows) is unavailable — like the
// diff/highlight tests, we mount the components directly with inline data and
// assert the DOM. Two surfaces:
//  • the sidebar row: the block + all its nested blocks' approval, rolled up by
//    home.mjs into state.approvalSummaries (here supplied directly).
//  • the "Onderliggende code" panel: each child's own approval badge plus a
//    header roll-up of the children shown.
test.describe('PR Review Tree — combined approval', () => {
  test('the sidebar row shows the combined done/total, green + ✓ when complete', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const BlockList = (await import('/src/BlockList.mjs')).default
      const state = reactive({
        mode: 'list',
        selected: 0,
        blocks: [
          { id: 'b1', category: 'ACTION', label: 'Foo::a', status: 'modified', file: 'app/Foo.php', side: 'new' },
          { id: 'b2', category: 'ACTION', label: 'Foo::b', status: 'modified', file: 'app/Foo.php', side: 'new' },
        ],
        // Partial for b1, fully approved for b2.
        approvalSummaries: { b1: { done: 1, total: 3 }, b2: { done: 2, total: 2 } },
      })
      const host = document.createElement('div')
      host.id = 'bl-host'
      document.body.appendChild(host)
      BlockList(state)(host)
      window.__st = state
    })

    const host = page.locator('#bl-host')
    const pills = host.getByTestId('block-approval')
    await expect(pills).toHaveCount(2)
    // Partial: neutral, no checkmark.
    await expect(pills.nth(0)).toHaveText('1/3')
    await expect(pills.nth(0)).not.toHaveClass(/emerald/)
    // Complete: green with a ✓.
    await expect(pills.nth(1)).toContainText('✓ 2/2')
    await expect(pills.nth(1)).toHaveClass(/emerald/)

    // Reactive: bumping b1 to complete flips its pill to the done state.
    await page.evaluate(() => {
      window.__st.approvalSummaries = { b1: { done: 3, total: 3 }, b2: { done: 2, total: 2 } }
    })
    await expect(pills.nth(0)).toContainText('✓ 3/3')
    await expect(pills.nth(0)).toHaveClass(/emerald/)
  })

  test('the underlying-code panel shows a per-child badge and a header roll-up', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const mod = await import('/src/RelatedPanel.mjs')
      const state = reactive({ pr: 12903, blocks: [], allBlocks: [], selected: 0 })
      const host = document.createElement('div')
      host.id = 'rp-host'
      document.body.appendChild(host)
      mod.default(state, () => null, { startCallSearch: () => {} })(host)
      mod.setRelated(
        [
          { id: 'c0', label: 'Foo::m0', file: 'app/Foo.php', line: 10, kind: 'method_call', code: 'a', approve: { done: 1, total: 3 } },
          { id: 'c1', label: 'Foo::m1', file: 'app/Foo.php', line: 11, kind: 'method_call', code: 'b', approve: { done: 2, total: 2 } },
          // A call into an unchanged file — no approval concept, no badge.
          { id: 'c2', label: 'Vendor::x', file: 'vendor/x.php', line: 5, kind: 'method_call', code: 'c', approve: null },
        ],
        [],
      )
    })

    const host = page.locator('#rp-host')
    const badges = host.getByTestId('related-approval')
    // Only the two PR-block children carry a badge; the vendor call has none.
    await expect(badges).toHaveCount(2)
    await expect(badges.nth(0)).toHaveText('1/3')
    await expect(badges.nth(1)).toContainText('✓ 2/2')

    // Header roll-up sums the children with a count: 1+2 / 3+2 = 3/5.
    await expect(host.getByTestId('related-approval-total')).toContainText('3/5 goedgekeurd')
  })
})
