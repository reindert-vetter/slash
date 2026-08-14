import { test, expect, leaveSearchBox, evaluateSettled, appReady } from './_fixtures.mjs'

// Regression test for a reported bug: in the split diff, the old (left) and
// new (right) pane each render through their OWN independent `.innerHTML`
// binding (Block.mjs's codePane), and both used to read the SAME
// `activeGroup()` — two independent reactive consumers of the same value.
// arrow.js can drop a re-run for one of the two (see "co-subscribers can drop
// an update" in .claude/rules/arrowjs-pitfalls.md), which showed up live as
// the active-row indigo bar sitting on two DIFFERENT rows at once, one per
// pane, after an approve-driven auto-advance moved the cursor.
//
// Fix: only the new/right pane drives selection at all now (reviewer
// request: "ik wil dat we alleen nieuwe kunnen selecteren en navigeren") —
// the old/left pane is display-only in the split stand: no `data-row`, no
// active bar/checkmark, and a click there is a no-op. Hovering either side
// still lights up BOTH (data-row-pair + onRowPairHover), since only the
// CLICK/active-cursor is right-only, not the hover affordance. Reuses PR
// 102's RangeSelectAction::execute (four one-line changes, each with real
// old+new text — see materializeRangeSelectWorktrees in tests/_setup.mjs).
test.describe('PR Review Tree — the old/left pane of a split diff is display-only', () => {
  test('the old pane never carries data-row, never shows the active tint, and a click on it is a no-op', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // gran 'group', first group ($a/$b) active
    await page.keyboard.press('f') // gran 'line', cursor on $a

    const card = page.getByTestId('detail-card').first()
    const oldRows = card.locator('[data-pane="old"] [data-row]')
    const oldActiveTint = card.locator('[data-pane="old"] div[class*="#fed7dc"]')
    const newActiveTint = card.locator('[data-pane="new"] div[class*="#b9f5d9"]')

    // The old pane never carries a data-row at all, even though a real
    // cursor is active right now on the new pane.
    await expect(oldRows).toHaveCount(0)
    await expect(oldActiveTint).toHaveCount(0)
    await expect(newActiveTint).toHaveCount(1)
    await expect(newActiveTint).toContainText('$a')

    // Clicking a row in the old pane does nothing: no data-row to resolve, so
    // onBlockMouseDown's own [data-row] lookup finds nothing and bails.
    const oldRowB = card.locator('[data-pane="old"]').getByText('$b =', { exact: false })
    await oldRowB.click()
    await expect(newActiveTint).toHaveCount(1)
    await expect(newActiveTint).toContainText('$a') // unchanged — still on $a
    await expect(oldActiveTint).toHaveCount(0)

    // Approving the current line auto-advances the cursor (Space, see
    // space-approve-continue.spec.mjs) — the exact trigger the original bug
    // needed. The old pane must still show no active tint of its own
    // afterwards, and the new pane's bar must have actually moved.
    await page.keyboard.press('Space')
    await expect(newActiveTint).toHaveCount(1)
    await expect(newActiveTint).toContainText('$b')
    await expect(oldActiveTint).toHaveCount(0)
  })

  test('hovering either pane lights up BOTH — the old pane has no native hover of its own', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f')

    const card = page.getByTestId('detail-card').first()
    const oldRowC = card.locator('[data-pane="old"] [data-row-pair]').filter({ hasText: '$c = 0;' })
    const newRowC = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$c = 3;' })

    await expect(oldRowC).not.toHaveClass(/row-pair-hover/)
    await expect(newRowC).not.toHaveClass(/row-pair-hover/)

    // Hovering the OLD side lights up its own row AND its new/right
    // counterpart (bidirectional pairing, reviewer request).
    await oldRowC.hover()
    await expect(oldRowC).toHaveClass(/row-pair-hover/)
    await expect(newRowC).toHaveClass(/row-pair-hover/)

    // Moving away from that row clears both.
    await page.mouse.move(0, 0)
    await expect(newRowC).not.toHaveClass(/row-pair-hover/)
    await expect(oldRowC).not.toHaveClass(/row-pair-hover/)
  })
})

// A PURE DELETION inside an otherwise modified block (a removed line with no
// replacement — the new/right side is an empty filler row): reviewer answer
// "als het side by side is, moet rechts een lege regel zichtbaar zijn" — the
// active cursor bar and the approve checkmark move to the (empty) new/right
// row, not the old/left row that actually carries the text. Mounts Block()
// directly (same pattern as diff-trim-collapse.spec.mjs) so the exact aligned
// row index feeding `activeGroup`/`approvedRows` is known up front.
test('a pure-deletion row in split view shows its active bar and checkmark on the empty NEW/right filler, not the old/left text', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await appReady(page)

  const rowIndex = await evaluateSettled(page, async () => {
    const { reactive } = await import('/src/vendor/arrow.js')
    const Block = (await import('/src/Block.mjs')).default
    const { blockRows } = await import('/src/Block.mjs')
    const b = reactive({
      category: 'ACTION',
      label: 'Foo::bar',
      status: 'modified',
      file: 'app/Foo.php',
      line: 10,
      name: 'bar',
      class: 'Foo',
      approved: false,
      code: {
        old: {
          start: 10,
          text: 'public function bar()\n{\n    $a = 1;\n    $b = 2;\n    return $a;\n}',
        },
        new: {
          start: 10,
          text: 'public function bar()\n{\n    $a = 1;\n    return $a;\n}',
        },
      },
    })
    const rows = blockRows(b)
    const idx = rows.findIndex((r) => r.left && r.left.includes('$b = 2;') && r.right == null)
    const host = document.createElement('div')
    host.id = 'pure-del-host'
    document.body.appendChild(host)
    Block(b, {
      activeGroup: () => ({ start: idx, end: idx }),
      approvedRows: () => new Set([idx]),
    })(host)
    return idx
  })
  expect(rowIndex).toBeGreaterThanOrEqual(0)

  const host = page.locator('#pure-del-host')
  const oldRow = host.locator(`[data-pane="old"] [data-row-pair="${rowIndex}"]`)
  const newRow = host.locator(`[data-pane="new"] [data-row="${rowIndex}"]`)

  // The old/left pane shows the removed text, but no active tint, no
  // checkmark and no data-row of its own. The checkmark itself is a
  // `before:content-[...]` pseudo-element (see rowApproveMarkerHTML in
  // Block.mjs — real text here would leak into a plain-text/TreeWalker read
  // of the row, see call-approval-dots.spec.mjs), so its presence is checked
  // via the mouse approve-toggle element instead of a `text=✓` locator.
  await expect(oldRow).toContainText('$b = 2;')
  await expect(oldRow).not.toHaveClass(/#fed7dc/)
  await expect(oldRow.locator('[data-approve-toggle="line"]')).toHaveCount(0)

  // The new/right pane shows the empty filler row, but it's the one that
  // carries the active tint + checkmark.
  await expect(newRow).toHaveCount(1)
  await expect(newRow).toHaveClass(/#b9f5d9|indigo-50/)
  await expect(newRow.locator('[data-approve-toggle="line"]')).toHaveAttribute('title', 'Trek goedkeuring in')
})
