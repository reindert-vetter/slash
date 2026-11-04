import { test, expect, seededPr } from './_fixtures.mjs'

// A steered message (id `steer-…`) while the turn still runs shows a dashed
// border plus the word "doorgegeven"; Claude's earlier text sits BEFORE it.
// Once the turn is over it is an ordinary bubble. See "Steeren" in
// .claude/docs/claude-chat-panel.md.
test('embedded Claude chat: a steered message reads dashed + "doorgegeven" while the turn runs', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: 'test.php', line: 1, author: 'reviewer', body: 'kan dit sneller?', code: '$order->total();', gran: 'call', label: 'Order::total' },
  })
  const conversationId = (await start.json()).runId
  const t0 = Date.now()
  const iso = (ms) => new Date(t0 + ms).toISOString()
  const messages = [
    { id: 'm1', role: 'user', body: 'begin', createdAt: iso(-5000), conversationId },
    { id: 'steer-s1-before', role: 'assistant', body: 'Claude zei dit eerst', createdAt: iso(-1001), conversationId },
    { id: 'steer-s1', role: 'user', body: 'doe het anders', createdAt: iso(-1000), conversationId },
  ]
  await page.route('**/api/chat?commentId=*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, messages }) }),
  )
  const running = true
  const frame = (d) => `data: ${JSON.stringify(d)}\n\n`
  await page.route('**/api/events*', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + frame({ type: 'chat.progress', pr, key: conversationId, seq: Date.now(), data: { running, phase: 'tool', tool: 'Read', startedAt: t0 - 3000, updatedAt: Date.now() } }),
    }),
  )
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight')

  const ids = page.getByTestId('claude-message')
  await expect(ids).toHaveCount(3)
  expect(await ids.evaluateAll((els) => els.map((e) => e.dataset.messageId))).toEqual(['m1', 'steer-s1-before', 'steer-s1'])
  const steer = page.locator('[data-message-id="steer-s1"]')
  await expect(steer.getByTestId('claude-steered-badge')).toContainText('doorgegeven')
  await expect(steer.getByTestId('claude-message-body')).toHaveClass(/border-dashed/)
  // The earlier messages are ordinary, solid bubbles.
  await expect(page.locator('[data-message-id="m1"]').getByTestId('claude-steered-badge')).toHaveCount(0)
  await expect(page.locator('[data-message-id="m1"]').getByTestId('claude-message-body')).not.toHaveClass(/border-dashed/)
})
