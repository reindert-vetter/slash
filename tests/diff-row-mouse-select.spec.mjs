import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Mouse line selection (Block.mjs's onBlockMouseDown/onBlockMouseMove ->
// home.mjs's selectRowAt/extendRowRange/ensureTopLevelDiffFocus): a click
// jumps the diff cursor straight to the clicked row, a mousedown+mousemove
// drag extends it into a multi-row range exactly like Shift+ArrowUp/Down
// (reusing the same state.rangeAnchor mechanism, see range-select.spec.mjs),
// and a click on a non-focused card (the look-ahead preview) first focuses
// that card the same way the keyboard would (stepBlock/enterDiff) before
// landing on the clicked row. Reuses PR 102 (RangeSelectAction::execute, four
// changed lines in two groups; ::other, a same-file neighbour with one
// changed line) — see materializeRangeSelectWorktrees in tests/_setup.mjs.
test.describe('PR Review Tree — mouse line selection (click, hover, drag-range)', () => {
  test('a click jumps straight to the clicked line, independent of the current cursor', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // step into execute's diff (gran 'group')
    await page.keyboard.press('f') // zoom to gran 'line' — lands on the first changed line ($a)

    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$a')

    // The four changed ("new" side) lines in document order: $a, $b, $c, $d.
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await expect(changedRows).toHaveCount(4)
    await changedRows.nth(2).click() // $c — two positions away from the cursor

    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$c')
  })

  test('mousedown + drag selects a contiguous range, exactly like Shift+ArrowDown', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // gran 'line', cursor on $a

    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await expect(activeRows).toHaveCount(1)
    // Let the block-column's own entrance transition (BlockList's fixed
    // pr-index slide-in) settle before reading pixel coordinates — a raw
    // mouse drag, unlike .click(), needs stable coordinates up front.
    await page.waitForTimeout(400)

    const from = await changedRows.nth(0).boundingBox() // $a
    const to = await changedRows.nth(2).boundingBox() // $c
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2)
    await page.mouse.up()

    // The range now spans 3 of the 4 changed lines ($a, $b, $c) — the exact
    // same end state as range-select.spec.mjs's Shift+ArrowDown x2.
    await expect(activeRows).toHaveCount(3)

    // The anchor is a real Shift-range anchor: the command palette offers the
    // same bulk-approve action a keyboard range would.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze 3 regels goed')
    await page.keyboard.press('Escape')
  })

  test('clicking a row on the non-focused look-ahead preview focuses it like a key would', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // execute is selected + focused
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    // `other` renders to the right as the dimmed look-ahead preview (i===sel+1).
    const preview = page.getByTestId('detail-card').nth(1)
    const previewRow = preview.locator('[data-pane="new"] [data-changed="1"]').first()
    await expect(previewRow).toBeVisible()
    await previewRow.click()

    // Focusing `other` moves the sidebar selection (stepBlock, same-file
    // neighbour) and the click lands the diff cursor on its one changed line.
    await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-idx="0"]')).not.toHaveClass(/bg-indigo-50/)
    const nowFocused = page.getByTestId('detail-card').first()
    await expect(nowFocused.locator('div[class*="#b9f5d9"]')).toHaveCount(1)
    await expect(nowFocused.locator('div[class*="#b9f5d9"]')).toContainText('$x')
  })
})
