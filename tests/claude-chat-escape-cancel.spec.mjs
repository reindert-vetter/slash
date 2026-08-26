import { test, expect, seededPr } from './_fixtures.mjs'

// Reviewer request: cancel a running Claude turn by pressing Escape while the
// keyboard sits in the composer itself — without losing the field, so a
// second Escape (once the turn is gone) still leaves it as before. See
// "The Stop control: mouse + keyboard" in .claude/docs/claude-chat-panel.md.
//
// Driven the same way as claude-chat-progress.spec.mjs: the SSE stream
// (GET /api/events) is fulfilled with a hand-written `chat.progress` frame so
// the panel reaches a steady "a turn is running" state without depending on a
// real Claude turn or on timing.
test('Escape in the composer cancels a running turn and keeps the field', async ({ page }, testInfo) => {
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
  // A comment's Run ID IS its comment id, which is also the chat conversation
  // id the events are keyed on (see chatConversationRunID).
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
  const progress = (extra) => ({
    type: 'chat.progress',
    pr,
    key: conversationId,
    seq: 1,
    data: { running: true, startedAt: Date.now() - 3000, updatedAt: Date.now(), ...extra },
  })

  let connections = 0
  await page.route('**/api/events*', async (route) => {
    connections++
    const body =
      connections === 1
        ? 'retry: 300\n\n'
        : 'retry: 300\n\n' + frame(progress({ phase: 'writing', partial: 'Ik kijk naar `total()` en zie' }))
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    })
  })
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  const cancelRequests = []
  await page.route('**/api/chat/cancel', async (route) => {
    cancelRequests.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude, one step
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeVisible()

  // Wait for the same steady state the visible "Stop" button gates on
  // (claudeActive/hasActiveClaudeTurn) — this is the exact condition the
  // composer's own Escape branch reads (view.active()).
  await expect(page.getByTestId('claude-chat-cancel')).toBeVisible()

  await compose.click()
  await compose.fill('nog een vraag terwijl Claude bezig is')
  await compose.press('Escape')

  // The cancel fired, for the right conversation...
  await expect.poll(() => cancelRequests.length).toBe(1)
  expect(cancelRequests[0].commentId).toBe(conversationId)

  // ...but the composer itself was neither blurred nor cleared: the reviewer
  // can keep typing right away, per the reviewer's own explicit choice.
  await expect(compose).toBeFocused()
  await expect(compose).toHaveValue('nog een vraag terwijl Claude bezig is')
})

// Regression check: with no turn running, Escape in the composer must keep
// doing exactly what it did before this feature — leave the field (the
// existing isEditableFocused() fallback in home.mjs's onKeydown).
test('Escape in the composer still leaves the field when nothing is running', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'even een vraag',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.route('**/api/events*', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n',
    }),
  )
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  const cancelRequests = []
  await page.route('**/api/chat/cancel', async (route) => {
    cancelRequests.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude, one step
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeVisible()
  // No running turn: the Stop button never appears.
  await expect(page.getByTestId('claude-chat-cancel')).toHaveCount(0)

  await compose.click()
  await expect(compose).toBeFocused()
  await compose.press('Escape')

  await expect(compose).not.toBeFocused()
  expect(cancelRequests.length).toBe(0)
})
