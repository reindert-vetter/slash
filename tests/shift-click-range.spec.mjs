import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: "als ik iets heb geselecteerd, en ik druk op shift en ik
// selecteer iets daaronder, dan wil ik alles ertussen ook selecteren."
//
// A Shift+click therefore EXTENDS the current diff selection to the clicked
// row instead of replacing it — the click counterpart of Shift+ArrowDown/Up
// and of a mousedown+drag range. Even though the diff moved to native browser
// text selection for a plain click/drag/double-/triple-click (see "Line
// selection: click and browser text selection" in
// .claude/docs/diff-render.md), Shift+click is deliberately the ONE exception
// that stays resolved via app state (home.mjs's resolveShiftClickSelection,
// never the browser's own native selection-extend behaviour): every diff
// pane reassigns its entire `.innerHTML` on every state change, so a
// PRECEDING plain click's own re-render destroys the row DOM a native
// Shift+click would need to extend FROM, leaving the browser with no valid
// anchor (observed to silently reassign it to the wrong row rather than
// failing loudly). resolveShiftClickSelection mirrors the exact row-index
// math the old keyboard-driven extendRange already used, so it still
// inherits the "a mouse range is per LINE, never per group" rule. Reuses
// PR 102 (RangeSelectAction::execute, four changed lines in two groups) —
// see tests/diff-row-mouse-select.spec.mjs.

test('Shift+click extends the selection to the clicked row, exactly like Shift+ArrowDown', async ({
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

  await changedRows.nth(2).click({ modifiers: ['Shift'] }) // $c

  // $a..$c — the same end state as Shift+ArrowDown twice, and as dragging
  // from $a to $c.
  await expect(activeRows).toHaveCount(3)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-row').nth(1)).toContainText('Keur deze 3 regels goed')
  await page.keyboard.press('Escape')

  // A second Shift+click moves the far end of the range, keeping the anchor.
  await changedRows.nth(1).click({ modifiers: ['Shift'] }) // $b
  await expect(activeRows).toHaveCount(2)
})

test('Shift+click extends upward too, and a plain click still replaces the range', async ({
  page,
}) => {
  await page.goto('/pr/102')
  await leaveSearchBox(page)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('f')

  const card = page.getByTestId('detail-card').first()
  const activeRows = card.locator('div[class*="#b9f5d9"]')
  const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')

  await changedRows.nth(3).click() // plain click: cursor on $d, one line
  await expect(activeRows).toHaveCount(1)

  await changedRows.nth(1).click({ modifiers: ['Shift'] }) // extend UP to $b
  await expect(activeRows).toHaveCount(3)

  await changedRows.nth(0).click() // a plain click drops the range again
  await expect(activeRows).toHaveCount(1)
  await expect(activeRows).toContainText('$a')
})
