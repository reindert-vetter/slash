import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The comment-arrow overlay (src/callArrows.mjs's setCommentArrows, computed
// in RelatedPanel.mjs's recomputeView): one flowing arrow per comment card
// currently rendered in InlineComments, from its own row in the diff to the
// card itself — the comment-card counterpart of the existing call-arrow
// overlay (tests/call-arrows.spec.mjs). See "Linking a comment card to its
// diff row" in comments-panel.md.
test('a comment card gets an arrow pointing at its own diff row', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  // By label, not by raw index — see "Sort order of the left list" in
  // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
  // real changed row.
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await page.keyboard.press('ArrowRight') // list -> diff, lands on the first change group
  await expect(page).toHaveURL(/mode=diff/)
  await expect(page.getByTestId('code-diff').first().locator('code.language-php').first()).toBeVisible()
  await page.getByTestId('diffview-split').click()

  const card = page.locator('[data-testid="block-column"] article').first()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  // No comment yet → no arrow at all.
  await expect(page.locator('[data-testid="comment-arrow"]')).toHaveCount(0)

  const row = await card.locator('[data-change-active]').first().getAttribute('data-row')
  expect(row).not.toBeNull()
  const rowStart = Number(row)

  const body = 'regel-pijl ' + Math.random().toString(36).slice(2)
  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line: 1, author: 'reviewer', body, label, gran: 'group', rowStart, rowEnd: rowStart },
  })
  expect(res.ok()).toBeTruthy()

  // Reload so the comment is present from the first render, same as
  // comment-range-bar.spec.mjs — avoids racing the poll cadence.
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx]').filter({ hasText: label }).first().click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)
  await expect(page.getByTestId('code-diff').first().locator('code.language-php').first()).toBeVisible()
  await page.getByTestId('diffview-split').click()

  const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
  await expect(item).toBeVisible()

  // The card carries the anchor the arrow overlay matches against — no
  // keyboard step needed, unlike the range bar (which only shows for the
  // comment the keyboard has actually entered): the arrow shows for every
  // visible card at once.
  await expect(item).toHaveAttribute('data-comment-id', /.+/)
  await expect(page.locator('[data-testid="comment-arrow"]')).toHaveCount(1)

  // Deleting the comment removes its card, and its arrow with it.
  await item.click()
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Verwijder comment' }).click()
  await expect(item).toHaveCount(0)
  await expect(page.locator('[data-testid="comment-arrow"]')).toHaveCount(0)
})
