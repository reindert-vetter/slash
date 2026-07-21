import { test, expect } from './_fixtures.mjs'

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

    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
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
    // top-level noun.
    await expect(page.getByTestId('command-row').first()).toContainText('Keur deze regels goed')
    await page.getByTestId('command-row').first().click()

    // This leaves nothing ahead for findNextUnapproved from the drilled
    // child's own position (its own subtree is done, and the parent has no
    // OTHER children to try next — see afterApproveAction/findNextUnapproved
    // in home.mjs), even though the PARENT's own line is still un-approved —
    // so the PR overall isn't fully approved yet: this opens the
    // 'reviewChoice' follow-up (Keur de PR goed / Wijs de PR af / Sluit
    // menu), not a plain close. Dismiss it before checking the approvals API.
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-row')).toHaveCount(3)
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()

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

    // The drilled card's own checkbox reflects the approval too.
    await expect(drill.locator('input[type=checkbox]')).toBeChecked()
  })
})
