import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: a MOUSE click into a chat/comment column must not collapse
// the pr-index (or the PR-description column) when everything fits; when it
// does not, the description goes first and the index after it. Same fit logic
// as a diff click (diff-click-column-fit.spec.mjs), see applyDiffColumnFit.
test.use({ viewport: { width: 2600, height: 1100 } })

// Selecting the chat's index row only selects it; the click into its column
// (here the composer) is what hands the keyboard over and used to collapse the index.
async function clickChatColumn(page) {
  await page.locator('[data-idx="9"]').click()
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
  await page.getByTestId('claude-chat-compose').click({ force: true })
  await page.waitForTimeout(600) // the aside's own 200ms width transition
}

async function seedChatAndReload(page) {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Chat over deze regel' }).click()
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  await composer.fill('Wat doet deze functie?')
  await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    composer.press('Enter'),
  ])
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
}

test('clicking into a chat keeps the pr-index when everything fits', async ({ page }) => {
  await seedChatAndReload(page)
  await clickChatColumn(page)
  await expect(page.getByTestId('pr-index')).toHaveJSProperty('clientWidth', 414)
})

test('clicking into a chat in a narrow window still collapses the pr-index', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await seedChatAndReload(page)
  await clickChatColumn(page)
  await expect(page.getByTestId('pr-index')).toHaveJSProperty('clientWidth', 0)
})
