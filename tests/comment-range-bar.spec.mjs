import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// While the keyboard sits IN a comment, the diff draws a vertical bar along
// its RIGHT edge over exactly the rows that comment was anchored to
// (commentRangeRowSet in RelatedPanel.mjs → Block's commentRangeBar), so the
// reviewer can see which lines/selection the open comment is about. Regression
// sensitive because the row set is threaded down through five functions
// (Block → codeDiff → codePane → paneHTML → rowCellHTML) and only the
// rightmost pane may draw it.
//
// The comment is placed straight through the task_code_comment workflow API
// (like comment-range-first-row.spec.mjs) with a range WIDER than the single
// change group the fixture offers — that is exactly the anchor a Shift+↑/↓
// range stores, and it makes the bar's extent observable at all.
test('the focused comment marks its own rows along the right edge of the diff', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff, lands on the first change group
  await expect(page).toHaveURL(/mode=diff/)

  const card = page.locator('[data-testid="block-column"] article').first()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  const row = await card.locator('[data-change-active]').first().getAttribute('data-row')
  expect(row).not.toBeNull()
  const rowStart = Number(row)
  const rowEnd = rowStart + 2 // deliberately wider than the one-row change group

  // The rows must really exist in the block, or there'd be nothing to draw on.
  const rowCount = await card.locator('[data-pane="new"] [data-row]').count()
  expect(rowCount).toBeGreaterThan(rowEnd)

  const body = 'bereik-balk ' + Math.random().toString(36).slice(2)
  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line: 1, author: 'reviewer', body, label, gran: 'group', rowStart, rowEnd },
  })
  expect(res.ok()).toBeTruthy()

  // Reload so the comment is present from the first render (avoids racing the
  // frontend's own poll cadence, same as comment-range-first-row).
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)

  const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
  await expect(item).toBeVisible()

  // Nothing yet: the comment is merely visible, the keyboard is still on the diff.
  const bars = page.getByTestId('comment-range-bar')
  await expect(bars).toHaveCount(0)

  // → steps into the comment itself (enterCommentsHead, cs.focus = 'comment').
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()

  await expect(bars).toHaveCount(rowEnd - rowStart + 1)
  const marked = await bars.evaluateAll((els) => els.map((el) => Number(el.dataset.commentRange)))
  expect(marked.sort((a, b) => a - b)).toEqual([rowStart, rowStart + 1, rowStart + 2])
  // Only the rightmost (new) pane draws it — never both halves of the split.
  await expect(card.locator('[data-pane="new"] [data-testid="comment-range-bar"]')).toHaveCount(
    rowEnd - rowStart + 1,
  )

  // ← hands the keyboard back to the diff; the bar goes with it.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toHaveCount(0)
  await expect(bars).toHaveCount(0)
})
