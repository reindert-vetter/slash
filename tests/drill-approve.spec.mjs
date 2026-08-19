import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The command-palette "approve"-action (COMMANDS' 'approve' item, home.mjs)
// used to be hardcoded to the top-level curBlock()/state.gran/state.change,
// ignoring state.focusLevel/state.drill/state.drillCursor entirely. So while
// a drilled Onderliggende-code column owned the keyboard (Enter/click on a
// child, see detail-layout.md's "Drillen" section), approving via Enter →
// "Keur ... goed" silently mutated the TOP-LEVEL block instead of the drilled
// child the reviewer was actually looking at — the reported bug ("ik kan
// niks in onderliggende code blok goedkeuren"). approveContext() (home.mjs)
// now resolves { block, gran, change } from state.focusLevel/drillCursor,
// mirroring the already-correct findNextUnapproved/fKey/dKey/setDrillGran
// pattern; approveNoun/approveTargetRows/toggleApprove/toggleCallApprove and
// the COMMANDS label all take that context instead of reading curBlock()/
// state.gran/state.change directly.
//
// Same PR 95 tree fixture as postapprove-tree.spec.mjs: TreeParentAction::execute
// (top-level, one real changed line) → TreeChildAction::run (its event_listener
// child, shown in "Onderliggende code", also one real changed line).
test.describe('PR Review Tree — approving inside a drilled Onderliggende-code column', () => {
  test('the palette approve action targets the drilled child, not the top-level block', async ({
    page,
  }) => {
    await page.goto('/pr/95')

    // TreeChildAction.php now WINS the fresh-open default tie-break over
    // TreeParentAction.php (file order, see "Land a fresh PR open on the
    // first block of the first-changed file"), so select the parent
    // explicitly — this test is specifically about drilling INTO the child
    // from the parent, not about which one opens by default.
    await page.locator('[data-idx="0"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the parent's diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // → into the Onderliggende-code panel

    const child = page.getByTestId('related-item').first()
    await expect(child).toContainText('TreeChildAction::run')
    await child.click() // drill in — focus lands on the drilled column's diff

    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('TreeChildAction::run')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Approve via the command palette while the DRILLED column owns the
    // keyboard.
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // The label names the unit this action covers — "deze regels" (the
    // drilled child's own single-line group), never "dit block"/a stale
    // top-level noun. It's the default (2nd) item, right after the pinned
    // "Sluit menu".
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze regels goed')
    await page.getByTestId('command-row').nth(1).click()

    // The drilled card's own checkbox reflects the approval right away —
    // checked here, before the drilled column closes below.
    await expect(drill.locator('input[type=checkbox]')).toBeChecked()

    // The drilled child's own subtree is now done (it has no children of its
    // own), but the PARENT's own line is still un-approved — so
    // findNextUnapproved's step 3 (see drilling.md's "Finishing a drilled
    // column's subtree returns to an unapproved ancestor") returns straight
    // to the parent instead of descending to siblings or opening the PR-wide
    // review-submit menus. This still opens the postApprove confirm menu (it
    // lands on a different block than the one just approved), but the 2nd
    // item is labelled "Ga terug", not "Ga door".
    await expect(menu).toBeVisible()
    const postApproveRows = page.getByTestId('command-row')
    await expect(postApproveRows).toHaveCount(2)
    await expect(postApproveRows.nth(0)).toContainText('Sluit menu')
    await expect(postApproveRows.nth(1)).toContainText('Ga terug')
    await postApproveRows.filter({ hasText: 'Ga terug' }).click()
    await expect(menu).not.toBeVisible()

    // The drilled column closes and focus returns to the parent's own diff,
    // on the exact position it was left at before drilling in (its saved
    // cursor — here still the first/only group, since drilling in never
    // moved it).
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(page.getByTestId('block-column')).toContainText('TreeParentAction::execute')

    // The approval must land on the CHILD's block id — never the parent's.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/approvals?pr=95')
        const rows = await res.json()
        const row = Array.isArray(rows)
          ? rows.find((r) => r.blockId === '95:app/Actions/TreeChildAction.php:TreeChildAction::run')
          : null
        return row && Array.isArray(row.rows) ? row.rows.length : 0
      })
      .toBeGreaterThan(0)

    const approvals = await (await page.request.get('/api/approvals?pr=95')).json()
    const parentRow = approvals.find(
      (r) => r.blockId === '95:app/Actions/TreeParentAction.php:TreeParentAction::execute',
    )
    // The parent was never touched — either absent, or empty rows/calls.
    expect(!parentRow || ((parentRow.rows || []).length === 0 && (parentRow.calls || []).length === 0)).toBe(
      true,
    )
  })
})
