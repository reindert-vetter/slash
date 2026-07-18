import { test, expect } from './_fixtures.mjs'

// state.selected is a raw index into state.blocks, but BlockList's renderList
// doesn't render a row for a hidden (fully-approved, while state.showApproved
// is false) block. Two recomputation paths can land the selection on such a
// hidden index, and they resolve it differently (home.mjs):
//
// - LOAD (revealSelectedIfHidden): a page reload restores the selection via
//   ?sel=file:line (applyBlockRefRestore) — that is the reviewer's OWN
//   position, so instead of moving it away the approved section is unfolded
//   (state.showApproved = true): the hidden block becomes visible and stays
//   selected/highlighted. Runs only after the approvals + blockstats have
//   landed and the approvalSummaries watch flushed (isFullyApproved needs
//   them), and after applyBlockRefRestore (a visible restore is a no-op).
//
// - SEARCH (clampSelectedToVisible): setSearch's `selected = 0` reset is a
//   synthetic landing, not the reviewer's position — typing a query must never
//   suddenly unfold every approved block PR-wide, so the selection clamps to
//   the first VISIBLE match instead.
//
// stepVisibleSelected already covered ↑/↓ (see sidebar-skip-approved.spec.mjs).
// The live approve flow is deliberately untouched: approving the block you're
// looking at keeps it selected (asserted below, before the reload).
//
// Same fixture/shape as sidebar-skip-approved.spec.mjs: PR 12903,
// category-sorted so ContractController::index (CONTROLLER) is index 0 and
// CreatePaymentAction::execute is index 1 — the same block that spec already
// durably approves, so this adds no new cross-spec approval state.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
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

test.describe('PR Review Tree — hidden approved selection: reveal on load, clamp on search', () => {
  test('reload reveals the hidden approved block; search clamps to a visible match', async ({
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
    // LIVE flow keeps it selected (the reviewer is still looking at it): no
    // reveal and no clamp fires here.
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

    // ── Reload: ?sel= points at the hidden block → REVEAL, don't move ────────
    await page.reload()
    // The approvals land async after load; once they do, revealSelectedIfHidden
    // unfolds the approved section: block 1's row exists again, is the ONE
    // highlighted row, and the selection (and ?sel=) never moved off it.
    const highlighted = page.locator(
      '[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15',
    )
    await expect(page.locator('[data-idx="1"]')).toHaveCount(1)
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-idx', '1')
    expect(selParam(page)).toBe(BLOCK1_SEL)
    await expect(page.getByTestId('block-column')).toContainText('CreatePaymentAction::execute')
    // The reveal flipped state.showApproved — the toggle row now offers to hide.
    await expect(page.getByTestId('toggle-approved')).toContainText('Verberg')

    // ── Search: the top match is the hidden block → CLAMP, don't unfold ──────
    // Fold the approved section back first (the reveal above left it open).
    await page.getByTestId('toggle-approved').click()
    await expect(page.locator('[data-idx="1"]')).toHaveCount(0)
    // 'payment' matches both CreatePaymentAction blocks; after the filter the
    // hidden approved `execute` is index 0, so setSearch's `selected = 0` lands
    // on it — the clamp moves to the first visible match instead, and the
    // approved section stays folded.
    await page.getByTestId('block-search').fill('payment')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toContainText('findOrCreateCustomer')
    await expect(page.getByTestId('toggle-approved')).toContainText('Toon')
  })
})
