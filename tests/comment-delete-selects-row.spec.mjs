import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: deleting a comment must hand the keyboard back to the diff row
// it was anchored to, instead of leaving cs.focus stuck on the now-gone
// comment/thread (which silently swallowed every further arrow key — see
// deleteCommentAndSelectRow in home.mjs). Uses PR 12903's blocks 1+2
// (CreatePaymentAction::execute / ::findOrCreateCustomer, same file, see
// step-preview-stability.spec.mjs): block 1 has exactly ONE change group, so
// ArrowDown past it flows into block 2 — a reliable, black-box signal that
// the keyboard is genuinely back on the diff (relatedActive() === false)
// rather than swallowed by a dangling comment-panel focus.
test('deleting a comment returns the keyboard to its own diff row', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)

  const card = page.locator('[data-testid="block-column"] article').first()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  // The one changed row's own aligned-diff index (data-row on the active row).
  const row = await card.locator('[data-change-active]').first().getAttribute('data-row')
  expect(row).not.toBeNull()
  const rowIdx = Number(row)

  const body = 'verwijder-en-selecteer ' + Math.random().toString(36).slice(2)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file,
      line: 1,
      author: 'reviewer',
      body,
      label,
      gran: 'group',
      rowStart: rowIdx,
      rowEnd: rowIdx,
    },
  })
  expect(start.ok()).toBeTruthy()

  // Reload onto the same block/diff so the freshly placed comment shows up
  // inline for the (only) group unit it's anchored on.
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await expect(page).toHaveURL(/mode=diff/)

  const sel = async () => page.evaluate(() => new URLSearchParams(location.search).get('sel'))
  const startSel = await sel()

  const item = page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body })
  await expect(item).toBeVisible()

  // → enters the comment's own thread (enterCommentsHead), focusing its
  // reply field — the precondition for Enter to open the comment menu.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
  await expect(page.getByTestId('reaction-compose')).toHaveValue('')

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('command-row').nth(2)).toContainText('Verwijder comment')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu).not.toBeVisible()
  await expect(item).toHaveCount(0)

  // The keyboard must be back on the diff by now: block 1's one and only
  // group unit is exhausted, so ArrowDown flows into the same-file
  // neighbour (block 2, ::findOrCreateCustomer) — exactly like an ordinary
  // ArrowDown would, with no comment/thread left to swallow it.
  await expect
    .poll(async () => {
      await page.keyboard.press('ArrowDown')
      return sel()
    })
    .not.toBe(startSel)
})
