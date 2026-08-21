import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Comment op deze regel" silently takes over an EXISTING bare Claude-chat
// anchor (isChatAnchorPlaceholder, RelatedPanel.mjs) instead of creating a
// second, unrelated comment on the same line — see "Overname zonder extra
// menu-item" in comments-panel.md / claude-chat-panel.md. placeComment's own
// claudeAutoAnchor flag already covered this WITHIN the same composing
// session; this regression-tests the harder case: the reviewer left (closed
// the panel / reloaded) and only later types their first real comment on the
// exact same line, in a wholly fresh session with no claudeAutoAnchor set.
test('typing a first real comment on a line that only has a Claude conversation takes over the anchor, no second comment', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Chat over deze regel' }).click()

  const claudeComposer = page.getByTestId('claude-chat-compose')
  await expect(claudeComposer).toBeFocused()
  await claudeComposer.fill('Wat doet deze functie?')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    claudeComposer.press('Enter'),
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()
  await expect(page.getByTestId('comment-item')).toHaveCount(1)
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')

  // Leave and come back — a fresh page load means a fresh module context, so
  // any in-memory claudeAutoAnchor session flag from creating the anchor
  // above is gone. Only the anchor comment's own identity survives.
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await expect(page.getByTestId('comment-item')).toHaveCount(1)
  await expect(page.getByTestId('comment-item')).toContainText('Claude gesprek')

  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('Dit moet echt anders.')
  const [replyRes] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/reply') && req.method() === 'POST'),
    page.keyboard.press('Enter'), // posts directly — an ordinary composer, no comment-kind menu
  ])
  expect(replyRes.postDataJSON().body).toBe('Dit moet echt anders.')

  // Still exactly ONE comment card — the reply landed on the existing
  // anchor's thread, no second, unrelated comment was created next to it.
  await expect(page.getByTestId('comment-item')).toHaveCount(1)
  const item = page.getByTestId('comment-item')
  // The reviewer's own reply — the only reaction on this thread — now reads
  // as an ordinary comment instead of "Claude gesprek": this reply IS the
  // reviewer's real first comment, not a reply to the placeholder note (see
  // "A taken-over Claude-chat anchor reads as an ordinary comment" in
  // comments-panel.md). No stray "Claude gesprek" left anywhere.
  await expect(item).not.toContainText('Claude gesprek')
  await expect(item).toContainText('Dit moet echt anders.')
  await item.click()
  await expect(page.getByTestId('reaction-bubble').last()).toContainText('Dit moet echt anders.')
})
