import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies the live half of the embedded Claude conversation: while a turn is
// running the panel says WHAT Claude is doing and shows the answer as it is
// still being written (see .claude/docs/server-events.md and the
// "Live progress" section of .claude/docs/claude-chat-panel.md).
//
// Both are driven entirely through mocked network: the SSE stream
// (GET /api/events) is fulfilled with hand-written frames, so nothing here
// depends on a real Claude turn, on timing, or on a transient state — the
// injected progress simply stays "running" for the whole spec, which is a
// steady state an assertion can poll. The real streaming/publishing path is
// covered offline in Go (modules/claude's stream_test.go, chat_progress_test.go,
// chat_workflow_test.go).
test('embedded Claude chat: live status line and streaming partial answer', async ({ page }, testInfo) => {
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

  // The panel's EventSource opens at page load, well before the chat column is
  // entered — and an event for a conversation that isn't open yet is dropped by
  // design. So the first connection carries nothing but a short retry hint, and
  // every reconnect after that replays the frames; by the time the reviewer has
  // stepped into the chat, one of those reconnects delivers them.
  let connections = 0
  await page.route('**/api/events*', async (route) => {
    connections++
    const body =
      connections === 1
        ? 'retry: 300\n\n'
        : 'retry: 300\n\n' +
          frame(progress({ phase: 'writing', partial: 'Ik kijk naar `total()` en zie' })) +
          // The snapshot keeps the text produced so far when Claude moves on to
          // a tool (chat_progress.go), so a tool frame carries BOTH a tool
          // label and the answer so far.
          frame(progress({ phase: 'tool', tool: 'Read', detail: 'src/Order.php', partial: 'Ik kijk naar `total()` en zie' })) +
          // The LAST frame is the steady state the assertions below poll for.
          frame(
            progress({
              phase: 'tool',
              tool: 'Bash',
              // Deliberately LONG: the status line may wrap over up to three
              // lines (line-clamp-3) instead of being truncated to one — see
              // "Live progress" in .claude/docs/claude-chat-panel.md.
              detail:
                'git log --oneline --stat --follow -- src/Order.php src/OrderLine.php src/Invoice.php ' +
                'src/InvoiceLine.php src/Payment.php src/PaymentMethod.php src/Subscription.php ' +
                'src/SubscriptionLine.php src/Refund.php src/RefundLine.php src/Coupon.php',
              partial: 'Ik kijk naar `total()` en zie',
            }),
          )
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    })
  })
  // The resync read reports NO running turn, so anything the panel shows can
  // only have come from the pushed events — which is exactly what this spec is
  // about (and it also exercises the "a newer event wins over a resync that was
  // already in flight" guard in loadChatProgress).
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude, one step
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()

  // The status line names the tool and its target in words (never a
  // colour-only cue), and carries the elapsed seconds.
  const status = page.getByTestId('claude-chat-status')
  await expect(status).toContainText('src/Order.php')
  await expect(status).toContainText(/\d+s/)

  // The status line may run over MULTIPLE lines (max 3) rather than being cut
  // off at one — a long Bash/Read detail is exactly what used to disappear.
  const lines = await status.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      clamp: cs.webkitLineClamp,
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
    }
  })
  expect(lines.clamp).toBe('3')
  expect(lines.lines).toBeGreaterThan(1)
  expect(lines.lines).toBeLessThanOrEqual(3)

  // The answer-so-far renders as its own provisional bubble, markdown and all,
  // separate from the stored transcript.
  const partial = page.getByTestId('claude-partial-body')
  await expect(partial).toContainText('Ik kijk naar')
  await expect(partial.locator('code')).toHaveText('total()')
  // It is NOT a stored message: the transcript itself is still empty.
  await expect(page.getByTestId('claude-message')).toHaveCount(0)
})
