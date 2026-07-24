import { test, expect } from './_fixtures.mjs'

// Shift+ArrowDown/ArrowUp multi-unit range selection (extendRange/
// drillExtendRange, state.rangeAnchor — home.mjs). Meaningful at
// gran==='line' and gran==='group' (isRangeGran): it merges the current unit
// with the unit the range started from into one { start, end } row range,
// which the highlight, the command-palette approve action, and (per
// commentTarget) a placed comment's anchor all then act on as if it were a
// single (wider) unit.
//
// Fixture PR 102 (RangeSelectAction::execute, four changed lines in two
// separate groups — $a/$b, then $c/$d, split by one unchanged $mid line;
// ::other, a same-file neighbour with one changed line) — see
// materializeRangeSelectWorktrees in tests/_setup.mjs.
test.describe('PR Review Tree — Shift+arrow line/group-range selection', () => {
  test('extends the highlight, approves the whole range, collapses on a plain arrow, and clamps at the block boundary', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('ArrowRight') // step into execute's diff (gran 'group')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('f') // zoom to gran 'line' — lands on the first changed line
    // Active (new-side) rows get the emerald-200-ish tint (#b9f5d9, see
    // Block.mjs paneHTML) — one row active right now.
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(1)

    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    // The range now spans 3 of the 4 changed lines.
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(3)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // The default item is the 2nd row, right after the pinned "Sluit menu".
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze 3 regels goed')
    await page.getByTestId('command-row').nth(1).click()
    await expect(menu).not.toBeVisible()

    await expect
      .poll(async () => {
        const rows = await (await page.request.get('/api/approvals?pr=102')).json()
        const row = Array.isArray(rows)
          ? rows.find(
              (r) => r.blockId === '102:app/Actions/RangeSelectAction.php:RangeSelectAction::execute',
            )
          : null
        return row && Array.isArray(row.rows) ? row.rows.length : 0
      })
      .toBe(3)

    // Approving a same-block range that leaves more unapproved further down
    // auto-navigates there (afterApproveAction/findNextUnapproved, see
    // keyboard-navigation.md) — no follow-up menu, since it stays within this
    // block. That auto-navigation is itself a plain (non-shift) step, so it
    // already collapsed the range: the reviewer lands on just the 4th (last,
    // still unapproved) line.
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(1)

    // Shift+ArrowDown from the LAST line clamps at the block boundary instead
    // of flowing into the same-file neighbour (`other`) like a plain
    // ArrowDown would — the highlight stays a single line and the sidebar
    // selection stays on `execute`.
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(1)
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="1"]')).not.toHaveClass(/bg-indigo-50/)
  })

  test('also extends across gran==="group" units, merging two separate groups', async ({ page }) => {
    await page.goto('/pr/102')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    await page.keyboard.press('ArrowRight') // step into execute's diff — starts at gran 'group', unit 0 ($a/$b)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(2)

    await page.keyboard.press('Shift+ArrowDown')
    // Merges in the second group ($c/$d) — the unchanged $mid line in
    // between stays untinted, so the count is exactly the 4 changed lines,
    // not 5.
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(4)

    // Only two groups exist, so a further Shift+ArrowDown clamps instead of
    // flowing into the same-file neighbour ('other').
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.locator('div[class*="#b9f5d9"]')).toHaveCount(4)
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="1"]')).not.toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').nth(1).click()
    await expect(menu).not.toBeVisible()

    await expect
      .poll(async () => {
        const rows = await (await page.request.get('/api/approvals?pr=102')).json()
        const row = Array.isArray(rows)
          ? rows.find(
              (r) => r.blockId === '102:app/Actions/RangeSelectAction.php:RangeSelectAction::execute',
            )
          : null
        return row && Array.isArray(row.rows) ? row.rows.length : 0
      })
      .toBe(4)

    // That approves every changed row of `execute` — the next unapproved unit
    // is in a different block ('other'), so the postApprove follow-up menu
    // opens (unlike the same-block case in the previous test); dismiss it via
    // the pinned "Sluit menu" item without navigating further.
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
  })
})
