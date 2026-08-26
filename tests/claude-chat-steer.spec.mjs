import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies the steer path: a message typed while a claude CLI call is really
// in flight is handed to THAT turn (a "steer" Signal on the conversation's own
// chat_steer Execution) instead of landing in the client-side queue. See
// "Doorpraten tijdens een lopende turn" in .claude/docs/claude-chat-panel.md.
//
// The running turn is simulated by HOLDING the first message Signal's POST
// (like claude-chat-queue.spec.mjs), and "a CLI call is in flight" by mocking
// GET /api/chat/steerable — the server can't be in that state here, since the
// held POST never reaches it. The Go side (delivery into the running call, and
// the fallback when nothing runs) is covered by chat_steer_test.go.
test('embedded Claude chat: a message typed mid-turn is steered into the running turn', async ({
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

  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const bodies = []
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
  await page.route('**/api/chat/steerable*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, steerable: true }),
    }),
  )
  await page.route('**/api/workflows/chat_steer', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runId: 'chatsteer-mock' }),
    }),
  )
  const steered = []
  await page.route('**/signals/steer', async (route) => {
    steered.push(route.request().postDataJSON().body)
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

  // Typed mid-turn: this must reach the running turn, not the queue.
  await composer.fill('kan je het mocken?')
  await composer.press('Enter')
  await expect.poll(() => steered).toEqual(['kan je het mocken?'])
  await expect(page.getByTestId('claude-queued')).toHaveCount(0)
  // And it is NOT sent as a second turn of its own.
  expect(bodies).toEqual(['eerste vraag'])

  release()
  await expect.poll(() => bodies.length, { timeout: 15000 }).toBe(1)
})
