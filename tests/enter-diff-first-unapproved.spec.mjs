import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Stepping from the block index into a diff (enterDiff, home.mjs) lands on the
// first unit that still NEEDS approval instead of always on the block's first
// change — "als ik naar links ga (naar blokken index) en ik ga direct naar
// rechts, dan wil ik op de regel belanden die nog niet approved is, anders wel
// gewoon de eerste" (Reindert). Everything approved (or nothing known yet)
// still lands on the first unit.
//
// Fixture PR 102 (RangeSelectAction::execute — four changed lines in TWO
// separate group units, $a/$b and $c/$d, split by an unchanged $mid line; see
// materializeRangeSelectWorktrees in tests/_setup.mjs). Two groups is exactly
// what this needs: approving the first one must move the landing to the second.
const BLOCK_ID = '102:app/Actions/RangeSelectAction.php:RangeSelectAction::execute'

// clearBlockApproval resets the block's durable approval through the sanctioned
// write path (the approve workflow's `set` signal — an empty set removes the
// row), same helper shape as space-approve-continue.spec.mjs. Keeps every test
// here independent of run order on a shared worker DB.
async function clearBlockApproval(page) {
  const start = await page.request.post('/api/workflows/approve', { data: { pr: 102 } })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId: BLOCK_ID, rows: [], calls: [] },
  })
  await expect
    .poll(async () => {
      const rows = await (await page.request.get('/api/approvals?pr=102')).json()
      return Array.isArray(rows) && rows.every((r) => r.blockId !== BLOCK_ID)
    })
    .toBe(true)
}

// activeRow reads which row the diff cursor sits on — [data-change-active]
// marks the FIRST row of the active unit (Block.mjs, paneHTML) and carries the
// row index, so two different group units always read differently.
async function activeRow(page) {
  return await page.locator('[data-change-active]').first().getAttribute('data-row')
}

// approveCurrentUnit approves whatever the cursor covers through the command
// palette (Enter → the default 2nd row, "Keur deze regels goed").
async function approveCurrentUnit(page) {
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').nth(1).click()
  await expect(menu).not.toBeVisible()
}

test.describe('PR Review Tree — → lands on the first unapproved unit', () => {
  test('re-entering the diff skips an already approved first group', async ({ page }) => {
    await clearBlockApproval(page)
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into execute's diff, gran 'group'
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    const firstGroup = await activeRow(page)

    // Learn the second group's own row the same way the reviewer would.
    await page.keyboard.press('ArrowDown')
    const secondGroup = await activeRow(page)
    expect(secondGroup).not.toBe(firstGroup)

    // Nothing approved yet: ← then → still lands on the first group.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => activeRow(page)).toBe(firstGroup)

    // Approve the first group. That already auto-navigates to the second one
    // (same block, so no postApprove menu — see afterApproveAction), which is
    // exactly the position re-entering must reproduce.
    await approveCurrentUnit(page)
    await expect.poll(() => activeRow(page)).toBe(secondGroup)

    await page.keyboard.press('ArrowLeft') // back to the block index
    await page.keyboard.press('ArrowRight') // and straight back in
    await expect.poll(() => activeRow(page)).toBe(secondGroup)
  })

  test('a fully approved block still lands on its first unit', async ({ page }) => {
    await clearBlockApproval(page)
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    const firstGroup = await activeRow(page)

    // Space = approve + continue; twice covers both groups of this block.
    await page.keyboard.press('Space')
    await page.keyboard.press('Space')
    await expect
      .poll(async () => {
        const rows = await (await page.request.get('/api/approvals?pr=102')).json()
        const row = Array.isArray(rows) ? rows.find((r) => r.blockId === BLOCK_ID) : null
        return row && Array.isArray(row.rows) ? row.rows.length : 0
      })
      .toBe(4)

    // Reopen straight onto this (now fully approved, thus hidden) block — a
    // restored ?sel= pins it visible, see revealSelectedIfHidden.
    await page.goto('/pr/102?sel=app%2FActions%2FRangeSelectAction.php%3A7')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => activeRow(page)).toBe(firstGroup)
  })
})
