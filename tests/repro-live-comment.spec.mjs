import { test, expect } from './_fixtures.mjs'

async function place(page, body) {
  await page.getByTestId('new-comment').click()
  await page.getByTestId('comment-compose').fill(body)
  await page.getByTestId('comment-send').click()
  await page.getByText('Alleen voor mijzelf').click()
}
function item(page, body) {
  return page.getByTestId('related-panel').getByTestId('comment-item').filter({ hasText: body })
}

test('place on a later unit (2nd/3rd change) shows in list', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight') // enter diff (group 0)
  await page.waitForTimeout(150)
  await page.keyboard.press('ArrowDown') // group 1
  await page.waitForTimeout(120)
  await page.keyboard.press('ArrowDown') // group 2 (if exists)
  await page.waitForTimeout(120)
  await place(page, 'later unit comment')
  await expect(item(page, 'later unit comment')).toHaveCount(1, { timeout: 4000 })
})

test('placing a 2nd comment keeps both in the list', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  await place(page, 'first one')
  await expect(item(page, 'first one')).toHaveCount(1, { timeout: 4000 })
  await place(page, 'second one')
  await expect(item(page, 'second one')).toHaveCount(1, { timeout: 4000 })
  await expect(item(page, 'first one')).toHaveCount(1)
})

test('place at line, then move selection to group — comment stays visible', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight') // diff, group
  await page.waitForTimeout(150)
  await page.keyboard.press('f') // -> line
  await page.waitForTimeout(120)
  await place(page, 'line then group')
  await expect(item(page, 'line then group')).toHaveCount(1, { timeout: 4000 })
  await page.keyboard.press('s') // line -> group (widen scope, still contains it)
  await page.waitForTimeout(150)
  await expect(item(page, 'line then group')).toHaveCount(1)
})
