import { test, expect } from './_fixtures.mjs'

// Regression: state.selected is a raw index into state.blocks, but BlockList's
// renderList doesn't render a row for a hidden (fully-approved, while
// state.showApproved is false) block. After approving + hiding a block, a page
// RELOAD restored the selection onto that hidden block via ?sel=file:line
// (applyBlockRefRestore), and a SEARCH recompute reset it to index 0 which can
// equally be hidden — either way the detail panel showed the hidden block while
// NO sidebar row highlighted, reading as a lost selection. stepVisibleSelected
// already covered ↑/↓ (see sidebar-skip-approved.spec.mjs); this covers the
// load/search recomputation paths, fixed by clampSelectedToVisible (home.mjs):
// after the blockRef restore has had its chance (and, on load, after the
// approvals + blockstats have landed and the approvalSummaries watch flushed),
// a selection landing on a hidden block is clamped to the first VISIBLE one.
// The live approve flow is deliberately untouched: approving the block you're
// looking at keeps it selected (asserted below, before the reload).
//
// Same fixture/shape as sidebar-skip-approved.spec.mjs: PR 12903,
// category-sorted so ContractController::index (CONTROLLER) is index 0 and
// CreatePaymentAction::execute is index 1 — the same block that spec already
// durably approves, so this adds no new cross-spec approval state.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK0_SEL = 'app/Http/Controllers/Api/ContractController.php:30' // ContractController::index
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlock1Approval resets block 1's durable approval through the sanctioned
// write path (the approve workflow's `set` signal — an empty set removes the
// row), so the test is idempotent per worker DB: on a retry/repeat the approval
// from a previous run would otherwise already hide row 1 at load and break the
// initial click. Polls the read-model until the row is really gone.
async function clearBlock1Approval(page) {
  const start = await page.request.post('/api/workflows/approve', {
    data: { pr: 12903 },
  })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId: BLOCK1_ID, rows: [], calls: [] },
  })
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/approvals?pr=12903')
      const rows = await res.json()
      return Array.isArray(rows) && rows.every((r) => r.blockId !== BLOCK1_ID)
    })
    .toBe(true)
}

test.describe('PR Review Tree — selection clamps to a visible block on load/search', () => {
  test('reload and search never leave the selection on a hidden approved block', async ({
    page,
  }) => {
    await clearBlock1Approval(page)
    await page.goto('/pr/12903')
    // Select + fully approve block 1 (CreatePaymentAction::execute) via the
    // palette, exactly like sidebar-skip-approved.spec.mjs.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused search box
    expect(selParam(page)).toBe(BLOCK1_SEL)

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()

    // Block 1 is now fully approved and hidden from the rendered list — but the
    // LIVE flow keeps it selected (the reviewer is still looking at it): the
    // clamp must not fire here.
    await expect(page.locator('[data-idx="1"]')).toHaveCount(0)
    expect(selParam(page)).toBe(BLOCK1_SEL)

    // Wait until the approval durably landed in the read-model — persistApproval
    // is fire-and-forget, so reloading before the approve workflow wrote the row
    // would race (the reload restores approvals from GET /api/approvals).
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/approvals?pr=12903')
        const rows = await res.json()
        return Array.isArray(rows) && rows.some((r) => r.blockId === BLOCK1_ID && (r.rows || []).length > 0)
      })
      .toBe(true)

    // ── Reload: ?sel= points at the hidden block ─────────────────────────────
    await page.reload()
    // The approvals land async after load; once they do, the restored selection
    // (hidden block 1) must be clamped to the first visible block (block 0) —
    // exactly one highlighted row, and it's block 0, not "no row at all".
    const highlighted = page.locator(
      '[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15',
    )
    await expect(page.locator('[data-idx="1"]')).toHaveCount(0)
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-idx', '0')
    // The blockRef mirror watch rewrote ?sel= to the clamped block, and the
    // detail card shows that block — not the hidden one.
    await expect.poll(() => selParam(page)).toBe(BLOCK0_SEL)
    await expect(page.getByTestId('block-column')).toContainText('ContractController::index')

    // ── Search: the top match is the hidden block ────────────────────────────
    // 'payment' matches both CreatePaymentAction blocks; after the filter the
    // hidden approved `execute` is index 0, so setSearch's `selected = 0` lands
    // on it — the clamp must move to the first visible match instead.
    await page.getByTestId('block-search').fill('payment')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toContainText('findOrCreateCustomer')
  })
})
