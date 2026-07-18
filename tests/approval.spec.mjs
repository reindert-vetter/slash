import { test, expect } from './_fixtures.mjs'

// evaluateSettled runs an in-page evaluate that's resilient to the documented
// cold-start mount-race (see .claude/rules/conventions.md): home.mjs's
// bindUrlState watches keep firing history.replaceState right after
// 'networkidle', and that burst can tear down the very execution context our
// evaluate() just started running in ("Execution context was destroyed").
// waitForLoadState('networkidle') alone doesn't guarantee the burst is over, so
// on that specific error we just wait for the page to go idle again and retry
// the whole evaluate — a few attempts, not a broad retries: N sledgehammer, and
// scoped to this one flaky race rather than every test.
async function evaluateSettled(page, fn, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.evaluate(fn)
    } catch (err) {
      if (!/context was destroyed/i.test(err.message) || i === attempts - 1) throw err
      lastErr = err
      await page.waitForLoadState('networkidle')
    }
  }
  throw lastErr
}

// Combined approval indicators. The seeded fixture DB has no worktrees, so
// /api/code (and thus a real diff with changed rows) is unavailable — like the
// diff/highlight tests, we mount the components directly with inline data and
// assert the DOM. Two surfaces:
//  • the sidebar row: the block + all its nested blocks' approval, rolled up by
//    home.mjs into state.approvalSummaries (here supplied directly).
//  • the "Onderliggende code" panel: each child's own approval badge.
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
        // Show approved blocks too — this test asserts the pill rendering of a
        // fully-approved row, which is otherwise hidden by default (see
        // blockstats.spec.mjs for the hide/toggle behaviour itself).
        showApproved: true,
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

  test('the underlying-code panel shows a per-child badge', async ({ page }) => {
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
  })

  // Regression: the emerald checkmark span in paneHTML (Block.mjs) is absolutely
  // positioned so it should take no flow width, but its HTML used to be preceded
  // by a plain leading space character — a real text node in the row's
  // white-space:pre content — which shifted the whole line one monospace column
  // to the right on an approved row. Mount the same changed line twice (one
  // approved, one not) and assert the code itself starts at the exact same
  // horizontal offset in both, while the checkmark stays visible.
  test('an approved row does not shift its code to the right', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')

    const offsets = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const blockMod = await import('/src/Block.mjs')
      const Block = blockMod.default
      const makeBlock = (approvedRows) =>
        reactive({
          category: 'ACTION',
          label: 'Foo::bar',
          status: 'modified',
          file: 'app/Foo.php',
          line: 26,
          name: 'bar',
          class: 'Foo',
          approvedRows,
          code: {
            old: { start: 26, end: 27, text: 'public function bar(): int {\n}' },
            new: { start: 26, end: 27, text: 'public function bar(): ?int {\n}' },
          },
        })

      const mount = (id, approvedRows) => {
        const host = document.createElement('div')
        host.id = id
        document.body.appendChild(host)
        const b = makeBlock(approvedRows)
        // Mirror how home.mjs wires the approval accessor: a function reading
        // b.approvedRows as a Set, so the pane's checkmark/tint logic sees it.
        Block(b, { approvedRows: () => blockMod.approvedRowSet(b) })(host)
        return host
      }

      const approvedHost = mount('approved-host', [0])
      const plainHost = mount('plain-host', [])

      // relX = the x offset of the first Prism token inside the changed row,
      // relative to that row's own <div> — decoupled from where the host sits
      // on the page, so both mounts are directly comparable. Skip the
      // absolutely-positioned checkmark overlay itself (present only on the
      // approved row): it sits at its own left-1.5 offset and isn't part of the
      // row's normal flow, so including it would compare the wrong element.
      const relX = (host) => {
        const row = host.querySelectorAll('code.language-php')[1].querySelector(':scope > div')
        const token =
          [...row.children].find((el) => !el.className.includes('absolute')) || row
        const rowRect = row.getBoundingClientRect()
        const tokenRect = token.getBoundingClientRect()
        return tokenRect.left - rowRect.left
      }

      const hasCheck = (host) =>
        !!host.querySelector('span[title="Goedgekeurd"]')

      return {
        approvedX: relX(approvedHost),
        plainX: relX(plainHost),
        approvedHasCheck: hasCheck(approvedHost),
        plainHasCheck: hasCheck(plainHost),
      }
    })

    // The checkmark stays visible on the approved row (memory: never hide the
    // done state) but isn't drawn on the unapproved one.
    expect(offsets.approvedHasCheck).toBe(true)
    expect(offsets.plainHasCheck).toBe(false)

    // The code itself starts at the same column either way — no layout shift.
    expect(offsets.approvedX).toBeCloseTo(offsets.plainX, 1)
  })
})
