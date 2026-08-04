import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies "doorpraten": the Claude composer stays usable while a turn is
// still running, and a message typed meanwhile is QUEUED (visibly, with a
// word — see claudeQueuedBubbles in ClaudeChat.mjs) and sent as its own turn
// once the running one returns. See "Doorpraten tijdens een lopende turn" in
// .claude/docs/claude-chat-panel.md.
//
// The running turn is simulated by HOLDING the first message Signal's POST
// (page.route) instead of relying on a slow real turn — so "a turn is in
// flight" is a steady state the assertions can poll, exactly like the mocked
// SSE frames in claude-chat-progress.spec.mjs.
test('embedded Claude chat: keep typing while a turn runs, queued turns drain in order', async ({
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

  // Hold the FIRST message Signal until release() is called; every later one
  // goes through immediately. bodies records what was sent, in order.
  const bodies = []
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  let seen = 0
  await page.route('**/signals/message', async (route) => {
    bodies.push(route.request().postDataJSON().body)
    seen++
    if (seen === 1) await held
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'signalled' }),
    })
  })

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // First turn — its POST hangs, so from here on a turn is "running".
  await composer.fill('eerste vraag')
  await composer.press('Enter')
  await expect.poll(() => bodies.length).toBe(1)

  // The composer is NOT disabled while that turn runs (it used to be) and two
  // further messages queue up, oldest first, each shown as its own bubble with
  // the waiting word — not merged, not dropped, and nothing sent yet.
  await expect(composer).toBeEnabled()
  await expect(page.getByTestId('claude-chat-send')).toBeEnabled()
  await composer.fill('tweede vraag')
  await composer.press('Enter')
  await composer.fill('derde vraag')
  await composer.press('Enter')
  const queued = page.getByTestId('claude-queued')
  await expect(queued).toHaveCount(2)
  await expect(queued.nth(0).getByTestId('claude-queued-body')).toContainText('tweede vraag')
  await expect(queued.nth(1).getByTestId('claude-queued-body')).toContainText('derde vraag')
  await expect(queued.nth(0).getByTestId('claude-queued-badge')).toContainText('wachtrij')
  // Still only the first turn on the wire.
  expect(bodies).toEqual(['eerste vraag'])
  // The shared footer says how many are waiting, in words.
  await expect(page.getByTestId('claude-chat-status')).toContainText('2 berichten in de wachtrij')

  // Releasing the running turn drains the queue one turn at a time, in order.
  release()
  await expect.poll(() => bodies.length, { timeout: 15000 }).toBe(3)
  expect(bodies).toEqual(['eerste vraag', 'tweede vraag', 'derde vraag'])
  await expect(page.getByTestId('claude-queued')).toHaveCount(0)
})
