import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Mouse line selection (Block.mjs's onBlockMouseDown/onBlockMouseMove ->
// home.mjs's selectRowAt/extendRowRange/ensureTopLevelDiffFocus): a click
// jumps the diff cursor straight to the clicked row, a mousedown+mousemove
// drag extends it into a multi-row range exactly like Shift+ArrowUp/Down
// (reusing the same state.rangeAnchor mechanism, see range-select.spec.mjs),
// and a click on a non-focused card (the look-ahead preview) first focuses
// that card the same way the keyboard would (stepBlock/enterDiff) before
// landing on the clicked row.
//
// A click ALWAYS forces gran to 'line' (single), 'group' (double) or the
// whole open block (triple) — clickGranFor/selectRowAt in home.mjs, driven by
// the browser's own `e.detail` consecutive-click counter — overriding
// whatever finer/coarser gran the keyboard had left active. A drag always
// ranges per LINE too, never per group, regardless of how it was started.
// EXCEPT: a single click landing inside an actual call-segment (a hoverable
// span, Block.mjs's `data-call-seg`/CALL_HOVER_CLS) selects that exact
// segment at 'call' granularity instead of 'line' — see the dedicated
// call-segment test below (PR 12903, a real multi-segment call chain).
// Reuses PR 102 (RangeSelectAction::execute, four changed lines in two
// groups; ::other, a same-file neighbour with one changed line) — see
// materializeRangeSelectWorktrees in tests/_setup.mjs.
test.describe('PR Review Tree — mouse line selection (click, hover, drag-range)', () => {
  test('a single click always selects one LINE, even from group or call granularity', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // gran 'group' — the first group ($a/$b) is active
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    await expect(activeRows).toHaveCount(2)

    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await expect(changedRows).toHaveCount(4)
    await changedRows.nth(2).click() // $c — a plain click while gran was still 'group'

    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$c')
    await expect(page).toHaveURL(/gran=line/) // state.gran really became 'line'

    // Zoom to 'call' and click again — a plain click overrides that too.
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/gran=call/)
    await changedRows.nth(0).click() // $a
    await expect(page).toHaveURL(/gran=line/)
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$a')
  })

  test('a double-click selects the whole group the line sits in', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // move off the default group first, to prove the click re-selects it
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await expect(activeRows).toHaveCount(1)

    await changedRows.nth(2).dblclick() // $c — in the SECOND group ($c/$d)
    await expect(activeRows).toHaveCount(2)
    await expect(activeRows.nth(0)).toContainText('$c')
    await expect(activeRows.nth(1)).toContainText('$d')
    // 'group' is the URL's default granularity, so it's omitted entirely.
    await expect(page).not.toHaveURL(/gran=/)
  })

  test('a triple-click selects every line of the currently open block, never a same-file neighbour', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')

    await changedRows.nth(1).click({ clickCount: 3 }) // $b, triple-click
    // All four changed lines of `execute` — never flowing into `other`.
    await expect(activeRows).toHaveCount(4)
    await expect(page.locator('[data-idx="0"]')).toHaveClass(/bg-indigo-50/)

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze 4 regels goed')
    await page.keyboard.press('Escape')
  })

  test('mousedown + drag selects a contiguous LINE range, exactly like Shift+ArrowDown', async ({ page }) => {
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

// A single click landing INSIDE a real call-segment selects that exact
// segment at 'call' granularity instead of 'line' — the on-character
// refinement of the click-depth scheme above, top-level only (see the
// drilled-column test below). PR 12903's CreatePaymentAction::execute (block
// index 1), whose first change group is a single modified row with a real
// multi-segment call chain: `$order` / `->billingAddress` / `->update(` / `[`
// — see navigate.spec.mjs's "f on a single-line group jumps straight to
// call" for the same fixture line. Prism tokenizes `->billingAddress` itself
// into two adjacent spans ("->" and "billingAddress") that share ONE
// `data-call-seg` value — exactly the case onCallSegHover exists for.
test('a single click on a call-segment selects exactly that segment, with a whole-segment hover affordance', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click() // CreatePaymentAction::execute
  await page.keyboard.press('ArrowRight') // into the diff, default gran 'group'
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  const card = page.getByTestId('detail-card').first()
  // Scope to the ONE row with the call chain — the block has other changed
  // rows too, each of which may carry its own (single, unsplit) segment.
  const row = card.locator('[data-pane="new"] [data-row]').filter({ hasText: 'billingAddress' })
  const addrSpan = row.locator('[data-call-seg]', { hasText: 'billingAddress' }).first()
  await expect(addrSpan).toHaveClass(/call-seg\b/)
  const segId = await addrSpan.getAttribute('data-call-seg')

  // The "->" right before it is a SEPARATE Prism token but the SAME logical
  // segment (same data-call-seg value) — hovering the identifier must also
  // grey out that sibling span, not just the exact element under the cursor.
  const wholeSeg = row.locator(`[data-call-seg="${segId}"]`)
  await expect(wholeSeg.first()).not.toHaveClass(/call-seg-hover/)
  await addrSpan.hover()
  const segCount = await wholeSeg.count()
  expect(segCount).toBeGreaterThan(1) // really split across ≥2 Prism tokens
  for (let i = 0; i < segCount; i++) await expect(wholeSeg.nth(i)).toHaveClass(/call-seg-hover/)

  await addrSpan.click()
  await expect(page).toHaveURL(/gran=call/)
  // The underline spans BOTH Prism tokens of the selected segment ("->" and
  // "billingAddress"), so look for the one containing the identifier rather
  // than assuming DOM order.
  const underline = card.locator('span[class*="decoration-[#6366f1]"]').filter({ hasText: 'billingAddress' })
  await expect(underline).toHaveCount(1)

  // A click BESIDE the characters (the row's own blank tail, past all
  // segments) falls back to 'line' — same row, same block, no special casing.
  // Click near the row's own right edge, well past the short call chain's
  // rendered text.
  const rowBox = await row.boundingBox()
  await row.click({ position: { x: rowBox.width - 10, y: rowBox.height / 2 } })
  await expect(page).toHaveURL(/gran=line/)
})

// A drilled Onderliggende-code column deliberately keeps ONLY the single-line
// click — no double/triple-click depth there at all (reviewer: "alleen
// top-level"). PR 106's TreeChildAction2::run (two adjacent changed lines,
// ONE 'group' unit) — see drill-approve-line-skip.spec.mjs for the same
// fixture's own doc comment.
test('a double-click inside a drilled column still selects only the ONE clicked line', async ({ page }) => {
  await page.goto('/pr/106')
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // parent's diff
  await page.keyboard.press('ArrowRight') // into the Onderliggende-code panel

  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('TreeChildAction2::run')
  await child.click() // drill in

  const drill = page.getByTestId('drill-column')
  await expect(drill).toHaveCount(1)
  await expect(page.locator('[data-change-active]').first()).toBeVisible()

  const activeRows = drill.locator('div[class*="#b9f5d9"]')
  await expect(activeRows).toHaveCount(2) // the whole (only) group, the default landing

  const changedRows = drill.locator('[data-pane="new"] [data-changed="1"]')
  await changedRows.first().dblclick()
  // Still just the ONE line — a drilled column never widens to the group on
  // a double-click, unlike the top-level diff.
  await expect(activeRows).toHaveCount(1)
})
