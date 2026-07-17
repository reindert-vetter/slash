import { test, expect } from './_fixtures.mjs'

// The comments/taken sidebar is a fixed overlay toggled with `g` (see
// detail-layout.md), collapsed by default — open it before touching anything
// inside it.
async function placeVia(page, body) {
  // `g` already opens the sidebar on the empty, focused composer (enterComments
  // → toNew) — no extra click needed (clicking new-comment again would toggle
  // it back closed).
  await page.keyboard.press('g')
  await page.getByTestId('comment-compose').fill(body)
  await page.getByTestId('comment-send').click()
  await page.waitForTimeout(200)
  await page.getByTestId('command-input').fill('mijzelf')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
}
function item(page, body) {
  return page.getByTestId('comments-sidebar').getByTestId('comment-item').filter({ hasText: body })
}

test('call gran on billingAddress-like block, then re-navigate', async ({ page }) => {
  await page.goto('/pr/91')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight') // diff group
  await page.waitForTimeout(200)
  await page.keyboard.press('f') // line
  await page.waitForTimeout(120)
  await page.keyboard.press('f') // call
  await page.waitForTimeout(120)
  await placeVia(page, 'call comment 91')
  console.log('AFTER PLACE (call):', JSON.stringify(await page.getByTestId('comment-item').allInnerTexts()))
  await expect(item(page, 'call comment 91')).toHaveCount(1, { timeout: 4000 })

  // Move down/up to bump state.change and re-fire the scope watch, then back.
  await page.keyboard.press('s') // back to line
  await page.waitForTimeout(150)
  await page.keyboard.press('s') // back to group
  await page.waitForTimeout(150)
  console.log('AFTER WIDEN:', JSON.stringify(await page.getByTestId('comment-item').allInnerTexts()))
  await expect(item(page, 'call comment 91')).toHaveCount(1)
})

test('two blocks: comment on block A, switch to B and back', async ({ page }) => {
  await page.goto('/pr/91')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  await placeVia(page, 'block A comment')
  await expect(item(page, 'block A comment')).toHaveCount(1, { timeout: 4000 })
  await page.keyboard.press('ArrowLeft') // back to list
  await page.waitForTimeout(120)
  await page.keyboard.press('ArrowDown') // block B
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowUp') // back to block A
  await page.waitForTimeout(200)
  console.log('BACK ON A:', JSON.stringify(await page.getByTestId('comment-item').allInnerTexts()))
  await expect(item(page, 'block A comment')).toHaveCount(1)
})
