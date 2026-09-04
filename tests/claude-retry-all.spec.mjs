import { test, expect, seededPr } from './_fixtures.mjs'

// Reviewer request: "ik wil alle gefaalde claude chats opnieuw kunnen runnen
// per pr" — next to the existing per-turn "Opnieuw proberen" (retryClaudeTurn,
// which only ever touches the ONE conversation on screen), a second button
// "Ook andere opnieuw proberen" retries EVERY failed Claude chat of the PR in
// one click, the displayed one included (retryAllFailedClaudeChats,
// RelatedPanel.mjs).
//
// A failed claude_chat turn does not fail the WORKFLOW itself
// (chat_workflow.go loops back to WaitSignal on a chat.KindError message), so
// this cannot be read off GET /api/problems the way an ordinary task failure
// can — it is a property of the transcript's own last message. Mocked here
// exactly like claude-other-tasks-hidden.spec.mjs: the per-conversation
// transcript fetch (GET /api/chat?commentId=...) is mocked directly rather
// than driving two real Claude turns through the offline stub, since this is
// purely about the bulk-retry ACTION, not about a turn actually running.
test('"Ook andere opnieuw proberen" retries both the open chat and every other failed chat of the PR', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const OTHER_ID = 'gh-other-failed'
  const OTHER_RUN = 'claudechat-other-failed'

  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'pas dit aan',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const commentId = (await start.json()).runId
  expect(commentId).toBeTruthy()

  const errorMessages = (userBody) => [
    { id: 'user-1', role: 'user', kind: '', body: userBody },
    {
      id: 'assistant-1',
      role: 'assistant',
      kind: 'error',
      body: "Claude (Opus) meldde zelf een fout: You've hit your session limit — probeer het straks handmatig opnieuw.",
    },
  ]

  await page.route('**/api/chat?pr=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, conversations: [commentId, OTHER_ID], seenAt: {} }),
    }),
  )
  await page.route('**/api/chat?commentId=' + commentId + '*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: errorMessages('pas dit aan') }),
    }),
  )
  await page.route('**/api/chat?commentId=' + OTHER_ID + '*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: errorMessages('doe maar') }),
    }),
  )
  // The foreign conversation's claude_chat Execution is ensured purely to
  // learn its runId; only THAT id is mocked, the displayed conversation's own
  // ensure still goes to the real backend.
  await page.route('**/api/workflows/claude_chat', async (route) => {
    const data = route.request().postDataJSON()
    if (data && String(data.commentId) === OTHER_ID) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: OTHER_RUN }) })
      return
    }
    await route.continue()
  })

  // Every retry Signal, WITH its target run id — real content for the
  // displayed conversation, mocked (never reaching a real Claude turn) for
  // the foreign one.
  const messageReqs = []
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().includes('/signals/message')) return
    messageReqs.push({ url: r.url(), body: r.postDataJSON() })
  })
  await page.route(`**/api/workflows/${OTHER_RUN}/signals/message`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' }),
  )

  await page.goto('/pr/' + pr)
  await page.getByTestId('comment-item').first().click()
  await page.keyboard.press('ArrowRight') // comment -> claude
  await expect(page.getByTestId('claude-message-body').last()).toContainText('session limit')
  await expect(page.getByTestId('claude-retry')).toBeVisible()
  await expect(page.getByTestId('claude-retry-all')).toBeVisible()

  await page.getByTestId('claude-retry-all').click()

  // Both conversations were retried: the displayed one (whatever its own,
  // real chat runId turns out to be), and the foreign one (OTHER_RUN, known
  // upfront since it's mocked).
  await expect.poll(() => messageReqs.length).toBe(2)
  const other = messageReqs.find((m) => m.url.includes(OTHER_RUN))
  expect(other).toBeTruthy()
  expect(other.body.action).toBe('retry')
  const own = messageReqs.find((m) => !m.url.includes(OTHER_RUN))
  expect(own).toBeTruthy()
  expect(own.body.action).toBe('retry')

  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
