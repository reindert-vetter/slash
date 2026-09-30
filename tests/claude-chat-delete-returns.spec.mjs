import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Deleting a chat (Wis Claude-gesprek on a placeholder anchor) walks back to
// the place the reviewer stood right before jumping to it — here chat B, from
// which chat A was opened through "Andere chats in deze PR". See
// chatPlaceStack in src/home.mjs.
test.use({ viewport: { width: 2000, height: 1100 } })

async function startChat(page, idx, text) {
  await page.locator(`[data-idx="${idx}"]`).evaluate((e) => e.click())
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Chat over deze regel' }).click()
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  await composer.fill(text)
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/workflows/task_code_comment') && r.request().method() === 'POST'),
    composer.press('Enter'),
  ])
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
}

test('deleting a chat returns to the chat it was opened from', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await startChat(page, 1, 'eerste chat vraag')
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await startChat(page, 2, 'tweede chat vraag')
  await expect(page.getByTestId('claude-selected-line').first()).toContainText('tweede chat vraag')

  // Jump to the other chat (A) via "Andere chats in deze PR".
  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toContainText('eerste chat vraag')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('claude-selected-line').first()).toContainText('eerste chat vraag')

  // Delete A: the default first item of the empty-composer menu.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  await expect(page.getByTestId('claude-message-body').first()).toContainText('tweede chat vraag')
  await expect(page.getByTestId('comment-item')).toHaveCount(1)
})
