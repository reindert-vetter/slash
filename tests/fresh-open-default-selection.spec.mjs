import { test, expect } from './_fixtures.mjs'

// A fresh open of /pr/<id> with NO `?sel=` at all (e.g. "Open review tree"
// from /pr-overview without a remembered position — see overviewExitUrl/
// treeUrl in home.mjs/overview.mjs) should land the reviewer on the first
// not-yet-fully-approved item of state.blocks, in plain list order —
// applyDefaultUnapprovedSelection (home.mjs) walks that one flat array with
// no special case for a top-level Start block vs. an underlying-code child
// (they already share the same array — see recomputeLeftList/
// BlockList.mjs's renderList and ↑/↓'s own stepVisibleSelected), so this
// generalises for free; two independent top-level blocks are enough to prove
// the "walk the whole list, land on the first open one" behaviour without
// also dragging in a relation child's own combined-subtree approval rollup
// (see materializeDefaultSelWorktrees in _setup.mjs for why a parent/child
// pair would make this fixture's approval math ambiguous). If EVERYTHING is
// already approved, land the keyboard on the toggle-approved row instead
// (state.toggleFocused), mirroring stepListSelection's own ↓-past-the-end
// stop.
//
// A RESTORED `?sel=` (a refresh, or the /pr-overview round trip with a
// remembered block) must be entirely unaffected — that keeps going through
// the existing applyBlockRefRestore/revealSelectedIfHidden path, proven
// separately (and in more depth) in tests/selected-reveal-hidden.spec.mjs.
// Test 3 below re-proves that on this fixture too, so a regression here
// can't slip past this spec.
//
// PR 108 (tests/fixtures/defaultsel-blocks.json, worktrees materialized in
// _setup.mjs via materializeDefaultSelWorktrees) has exactly two independent
// top-level blocks, each with one real changed line: DefaultSelBlockA::run
// (list index 0) and DefaultSelBlockB::run (list index 1). Its own PR
// number (not PR 95) so this spec's approval mutations never collide with
// postapprove-tree.spec.mjs, which leaves PR 95 fully approved without
// cleanup.
const PR = 108
const BLOCK_A_ID = '108:app/Actions/DefaultSelBlockA.php:DefaultSelBlockA::run'
const BLOCK_B_ID = '108:app/Actions/DefaultSelBlockB.php:DefaultSelBlockB::run'
const BLOCK_A_SEL = 'app/Actions/DefaultSelBlockA.php:7'

// blockApproveCount (home.mjs) counts the INTERSECTION of the approved-row set
// with the block's real, LCS-aligned changed-row indices once its code has
// loaded (the list-mode look-ahead preview eagerly fetches /api/code for
// every visible block, so that happens well before these tests assert
// anything) — approving a guessed index like `[0]` would silently miss if
// the block's one real changed row (the `$value = …;` line) sits at a
// different aligned-row index. A generous superset of row indices sidesteps
// having to duplicate alignRows/changedRows here: it's guaranteed to contain
// whatever the real index turns out to be for this tiny 5-line function body,
// so `done === total` regardless.
const APPROVE_ALL_ROWS = Array.from({ length: 12 }, (_, i) => i)

async function approveRunId(page) {
  const res = await page.request.post('/api/workflows/approve', { data: { pr: PR } })
  const { runId } = await res.json()
  return runId
}

async function setApproval(page, runId, blockId, rows) {
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId, rows, calls: [] },
  })
}

// waitApproved polls the durable read-model until blockId's row-count matches
// what was just signalled — persistApproval-equivalent writes here are
// fire-and-forget, so a goto() right after signalling would otherwise race.
async function waitApproved(page, blockId, expectRows) {
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/approvals?pr=${PR}`)
      const rows = await res.json()
      const row = Array.isArray(rows) ? rows.find((r) => r.blockId === blockId) : null
      return row && Array.isArray(row.rows) ? row.rows.length : 0
    })
    .toBe(expectRows)
}

// resetApprovals clears both blocks back to unapproved — called before AND
// after every test so this spec is idempotent regardless of run order within
// the shared worker DB (the same defensive pattern
// selected-reveal-hidden.spec.mjs uses for its own single block).
async function resetApprovals(page) {
  const runId = await approveRunId(page)
  await setApproval(page, runId, BLOCK_A_ID, [])
  await setApproval(page, runId, BLOCK_B_ID, [])
  await waitApproved(page, BLOCK_A_ID, 0)
  await waitApproved(page, BLOCK_B_ID, 0)
  return runId
}

test.describe('PR Review Tree — fresh open with no ?sel lands on the first unapproved item', () => {
  test.afterEach(async ({ page }) => {
    await resetApprovals(page)
  })

  test('block A approved, block B not → lands on block B', async ({ page }) => {
    const runId = await resetApprovals(page)
    await setApproval(page, runId, BLOCK_A_ID, APPROVE_ALL_ROWS)
    await waitApproved(page, BLOCK_A_ID, APPROVE_ALL_ROWS.length)

    await page.goto(`/pr/${PR}`)

    // Block A is fully approved and hidden by default (state.showApproved
    // stays false — this path never unfolds the whole section, see
    // applyDefaultUnapprovedSelection's own doc comment); only block B
    // remains, and it's the one that's selected.
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    const highlighted = page.locator(
      '[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15',
    )
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-idx', '1')
    await expect(highlighted).toContainText('DefaultSelBlockB::run')
    await expect(page.getByTestId('toggle-approved')).toContainText('Toon 1 goedgekeurde block')
    // toggleFocused must NOT be set here — a real block got selected instead.
    await expect(page.getByTestId('toggle-approved')).not.toHaveClass(/bg-indigo-50/)
  })

  test('everything approved → the toggle-approved row gets the keyboard', async ({ page }) => {
    const runId = await resetApprovals(page)
    await setApproval(page, runId, BLOCK_A_ID, APPROVE_ALL_ROWS)
    await setApproval(page, runId, BLOCK_B_ID, APPROVE_ALL_ROWS)
    await waitApproved(page, BLOCK_A_ID, APPROVE_ALL_ROWS.length)
    await waitApproved(page, BLOCK_B_ID, APPROVE_ALL_ROWS.length)

    await page.goto(`/pr/${PR}`)

    // Both blocks are fully approved and hidden — nothing left to select.
    await expect(page.getByTestId('block-row')).toHaveCount(0)
    const toggle = page.getByTestId('toggle-approved')
    await expect(toggle).toBeVisible()
    await expect(toggle).toContainText('Toon 2 goedgekeurde blocks')
    // state.toggleFocused gives it the same indigo ring as a selected row.
    await expect(toggle).toHaveClass(/bg-indigo-50|dark:bg-indigo-500\/15/)
  })

  test('a restored ?sel= on an approved block is unaffected (existing pin/reveal path)', async ({
    page,
  }) => {
    const runId = await resetApprovals(page)
    await setApproval(page, runId, BLOCK_A_ID, APPROVE_ALL_ROWS)
    await waitApproved(page, BLOCK_A_ID, APPROVE_ALL_ROWS.length)

    // A restored ?sel= — not a fresh, sel-less open — must keep going through
    // applyBlockRefRestore/revealSelectedIfHidden: block A stays selected,
    // and stays visible (pinned) instead of being hidden as an ordinary
    // fully-approved block would be. Block B is unapproved and thus always
    // visible regardless, so both rows show — the pin only prevents A from
    // disappearing; it never forces B out of view or the selection onto it.
    await page.goto(`/pr/${PR}?sel=${encodeURIComponent(BLOCK_A_SEL)}`)

    await expect(page.getByTestId('block-row')).toHaveCount(2)
    const highlighted = page.locator(
      '[data-idx].bg-indigo-50, [data-idx].dark\\:bg-indigo-500\\/15',
    )
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-idx', '0')
    await expect(highlighted).toContainText('DefaultSelBlockA::run')
    // The section itself stays folded — the toggle still offers to reveal,
    // never "Verberg" (nothing was unfolded to hide A; it's just pinned).
    await expect(page.getByTestId('toggle-approved')).toContainText('Toon')
  })
})
