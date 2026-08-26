import { test, expect, seededPr } from './_fixtures.mjs'

// While the cheap read-only first attempt of a two-step chat turn (task 3,
// see .claude/docs/claude-chat-panel.md) is still streaming its own answer,
// that answer can literally BE the internal {"type":"need_write"} escalation
// directive (chat_workflow.go's isNeedWriteDirective) — never reviewer-facing
// content. The live partial bubble (claudePartialBubble, src/ClaudeChat.mjs)
// must show a labelled icon instead of the raw JSON. Same mocked-SSE
// mechanism as claude-chat-progress.spec.mjs.
test('the live partial bubble shows a labelled icon, not raw JSON, for the need_write directive', async ({ page }, testInfo) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'verander dit',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
  const progress = (extra) => ({
    type: 'chat.progress',
    pr,
    key: conversationId,
    seq: 1,
    data: { running: true, startedAt: Date.now() - 1000, updatedAt: Date.now(), ...extra },
  })

  let connections = 0
  await page.route('**/api/events*', async (route) => {
    connections++
    const body =
      connections === 1
        ? 'retry: 300\n\n'
        : 'retry: 300\n\n' + frame(progress({ phase: 'writing', partial: '{"type":"need_write"}' }))
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    })
  })
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude, one step
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()

  // The icon pill, with a WORD label (never colour alone) and a matching
  // title, replaces the ordinary markdown partial body.
  const pill = page.getByTestId('claude-partial-need-write')
  await expect(pill).toBeVisible()
  await expect(pill).toContainText('Vraagt schrijftoegang')
  await expect(pill).toHaveAttribute('title', 'Vraagt schrijftoegang')
  await expect(page.getByTestId('claude-partial-body')).toHaveCount(0)

  // The raw directive text must never appear anywhere on screen.
  await expect(page.getByTestId('claude-partial')).not.toContainText('need_write')

  await expect(page.getByTestId('claude-message')).toHaveCount(0)

  expect(errors).toEqual([])
})
