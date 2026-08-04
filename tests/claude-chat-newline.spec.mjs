import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies Shift+Enter in the Claude composer: it inserts a newline instead of
// sending (plain Enter still sends), and — the half that was actually broken —
// that newline SURVIVES into the rendered bubble instead of being collapsed
// into the previous line by Markdown. See "The composer is a <textarea>" and
// hardBreaks (src/markdown.mjs).
test('Claude chat: Shift+Enter adds a line and that line survives into the bubble', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // Shift+Enter does NOT send — it just adds a line to the still-open message.
  let sent = 0
  page.on('request', (req) => {
    if (req.url().includes('/signals/message')) sent++
  })
  await composer.type('eerste regel')
  await composer.press('Shift+Enter')
  await composer.type('tweede regel')
  expect(await composer.inputValue()).toBe('eerste regel\ntweede regel')
  expect(sent).toBe(0)

  // Space still types a space here, it does not trigger the global
  // approve-and-continue shortcut (onKeydown's Space branch sits behind the
  // relatedActive()/isEditableFocused() guards — see home.mjs).
  await composer.press('Space')
  expect(await composer.inputValue()).toBe('eerste regel\ntweede regel ')
  await composer.press('Backspace')

  // Plain Enter sends it, and the bubble keeps both lines: a hard break, not
  // one collapsed sentence (Markdown swallows a lone newline — hardBreaks is
  // what prevents that for the reviewer's own message).
  await composer.press('Enter')
  const body = page.getByTestId('claude-message-body').first()
  await expect(body).toBeVisible()
  await expect(body.locator('br')).toHaveCount(1)
  expect(await body.innerHTML()).toMatch(/eerste regel\s*<br\s*\/?>\s*tweede regel/)
})
