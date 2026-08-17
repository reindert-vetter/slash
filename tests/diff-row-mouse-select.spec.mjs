import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Mouse line selection (Block.mjs's onBlockMouseDown -> home.mjs's
// beginMouseSelection/resolveClickSelection/resolveRangeSelection/
// ensureTopLevelDiffFocus): the diff is now ordinary, browser-selectable text
// (reviewer request: "ik wil de browser selectie manier gebruiken") — a
// mousedown only seeds which row/call-segment/card a gesture started on, and
// the actual selection is resolved exactly once, on the next `mouseup`, by
// reading `window.getSelection()`. See "Line selection: click and browser
// text selection" in .claude/docs/diff-render.md.
//
// A genuine click (no drag, a COLLAPSED selection) ALWAYS resolves to 'line'
// granularity — overriding whatever finer/coarser gran the keyboard had left
// active, even 'call' — EXCEPT a single click landing inside an actual
// call-segment, which selects that exact segment at 'call' granularity
// instead (see the dedicated call-segment test below). A click that lands on
// neither a call-segment nor an actual changed/landable line does NOTHING at
// all (reviewer: "als er geen line is aangepast, dan wil ik daar geen
// interactie van zien").
//
// A REAL (non-collapsed) browser selection — a mousedown+drag, a native
// double-click (word select), a native triple-click (paragraph select,
// confined to the row's own <div>), or a native Shift+click (the browser's
// own selection-extend behaviour) — always rounds up to a per-LINE range
// (reviewer: "afronden op hele regels"), reusing the exact same
// state.rangeAnchor mechanism Shift+ArrowUp/Down built (see range-select.spec.mjs).
//
// Reuses PR 102 (RangeSelectAction::execute, four changed lines in two
// groups, split by one unchanged `$mid` line; ::other, a same-file neighbour
// with one changed line) — see materializeRangeSelectWorktrees in
// tests/_setup.mjs.
test.describe('PR Review Tree — mouse line selection (click, native selection)', () => {
  test('a genuine click always selects one LINE, even from group or call granularity', async ({ page }) => {
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

  test('a click on an unchanged line does nothing at all', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // gran 'line', cursor on $a
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.nth(0).click() // $a
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$a')
    // Dismiss the passive command-palette preview the click above triggered
    // (schedulePassiveMenu) — it floats right under the selected row and
    // would otherwise intercept the next click below.
    await page.keyboard.press('Escape')

    // `$mid = 5;` is the one unchanged line sitting between the two groups —
    // never touched by the PR, so it carries no data-changed at all.
    const midRow = card.locator('[data-pane="new"] [data-row]').filter({ hasText: '$mid' })
    await expect(midRow).toHaveCount(1)
    await midRow.click()

    // Nothing moved: the cursor is still exactly where it was before the click.
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$a')
  })

  test('a native double-click still selects only the ONE line it lands on', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // move off the default group first, to prove the click re-selects
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await expect(activeRows).toHaveCount(1)

    // A row div spans the full card width, but its text ("        $c = 3;")
    // is short and left-aligned — clicking the LOCATOR's default (center)
    // position lands on blank space past the visible text, where a native
    // double-click has no word to select and instead picks up the row's own
    // trailing whitespace/newline, which can bleed into the next row. Click
    // near the actual glyphs instead, same as a reviewer actually would.
    const cRow = changedRows.nth(2) // $c
    const cBox = await cRow.boundingBox()
    await cRow.dblclick({ position: { x: 24, y: cBox.height / 2 } }) // native word-select, confined to its own row
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$c')
    // 'line' is the gran that was already active — the point of this test is
    // that a native double-click does NOT widen the selection to the group.
    await expect(page).toHaveURL(/gran=line/)
  })

  test('a native triple-click still selects only the ONE line it lands on, never the whole block', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    const card = page.getByTestId('detail-card').first()
    const activeRows = card.locator('div[class*="#b9f5d9"]')
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')

    const bRow = changedRows.nth(1) // $b
    const bBox = await bRow.boundingBox()
    await bRow.click({ clickCount: 3, position: { x: 24, y: bBox.height / 2 } }) // native triple-click (paragraph select)
    // Never flows into every changed line of the block — a native
    // triple-click stops at the row's own block-level <div>.
    await expect(activeRows).toHaveCount(1)
    await expect(activeRows).toContainText('$b')
    await expect(page).toHaveURL(/gran=line/)
  })

  test('mousedown + drag (a real browser text selection) rounds up to a contiguous LINE range, exactly like Shift+ArrowDown', async ({
    page,
  }) => {
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

  // Bug report: "ik kan niet normaal met een muis een selectie doen ... want
  // na een fractie van een seconde is het niet meer geselecteerd (in de
  // diff)". resolveRangeSelection's own state write (above) re-renders the
  // pane's whole innerHTML, which used to collapse the reviewer's own native
  // selection within the same tick — restoreExactSelection now re-applies it.
  // Deliberately captures the EXACT selection text mid-drag (before mouseup
  // triggers the app's own state write) and asserts the FINAL, post-restore
  // selection matches it character for character — proving the restore is
  // exact, never rounded up to the whole-line `state.rangeAnchor`/`change`
  // range the test above asserts on the SAME kind of gesture (reviewer:
  // "ik wil alles kunnen selecteren als normaal [...] en kopiëren" — a
  // half-selected word must copy as a half-selected word, not three whole
  // lines).
  test('a native drag selection survives the resulting re-render EXACTLY, never rounded to whole lines', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('f') // gran 'line', cursor on $a

    const card = page.getByTestId('detail-card').first()
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await page.waitForTimeout(400)

    // Land mid-text on both ends (not the row's default center, which can sit
    // in blank space past the short code — see the double-click test above)
    // so the drag genuinely starts/ends PARTWAY through a line, never at a
    // line boundary.
    const from = await changedRows.nth(0).boundingBox() // $a
    const to = await changedRows.nth(2).boundingBox() // $c
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 40, to.y + to.height / 2)

    // Capture what the browser itself thinks is selected WHILE still
    // mid-drag, before mouseup ever reaches resolveRangeSelection.
    const expected = await page.evaluate(() => window.getSelection().toString())
    expect(expected.length).toBeGreaterThan(0)

    await page.mouse.up()
    // Give the re-render (and its own restoreExactSelection) time to run —
    // long enough to catch the old "collapses within a fraction of a second"
    // bug, which failed well inside 100ms.
    await page.waitForTimeout(300)

    const after = await page.evaluate(() => ({
      collapsed: window.getSelection().isCollapsed,
      text: window.getSelection().toString(),
    }))
    expect(after.collapsed).toBe(false)
    expect(after.text).toBe(expected)
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
// refinement of the click scheme above, top-level only (see the
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
// click — no call-segment precision there at all (reviewer: "alleen
// top-level"). PR 106's TreeChildAction2::run (two adjacent changed lines,
// ONE 'group' unit) — see drill-approve-line-skip.spec.mjs for the same
// fixture's own doc comment.
test('a native double-click inside a drilled column still selects only the ONE clicked line', async ({ page }) => {
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
  const firstRow = changedRows.first()
  const firstBox = await firstRow.boundingBox()
  // Click near the actual text, not the row's default (blank) center — see
  // the top-level double-click test's own comment for why.
  await firstRow.dblclick({ position: { x: 24, y: firstBox.height / 2 } })
  // Still just the ONE line — a native double-click never widens to the
  // group in a drilled column, same as at the top level.
  await expect(activeRows).toHaveCount(1)
})
