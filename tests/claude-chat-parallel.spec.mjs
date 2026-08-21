import { test, expect, seededPr } from './_fixtures.mjs'

// Two conversations at once: a reviewer sends a message, walks to other code
// and starts a SECOND conversation there while the first is still being
// answered. Reviewer report: "ik wil kunnen chatten en terwijl ik op antwoord
// wacht, een andere chat (op een andere selectie) kunnen starten, nu raak ik
// die chat weer kwijt."
//
// What used to go wrong was entirely client-side: `cc.busy`/`cc.progress` were
// a single slot for whichever conversation the panel happened to show, so the
// second conversation's very first message was QUEUED behind the first one's
// turn ("doorpraten", meant for one conversation) instead of being sent. The
// in-flight bookkeeping now lives per conversation in claudeTurns.mjs — see
// "Parallel conversations" in .claude/docs/claude-chat-panel.md.
//
// Same trick as claude-chat-queue.spec.mjs: the running turn is a HELD POST,
// so "a turn is in flight" is a steady state instead of a slow real turn. The
// backend is untouched by this spec (each conversation is its own Execution
// with its own run lock, so it was never the limiting side).
test('a second conversation can start while the first is still being answered', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, body, label] of [
    ['a', 'eerste vraag over total', 'Order::total'],
    ['b', 'tweede vraag over lines', 'Order::lines'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body, gran: 'call', label },
    })
    conv[key] = (await res.json()).runId
    expect(conv[key]).toBeTruthy()
  }

  // Conversation A's Signal POST hangs until release(); every other one goes
  // through at once. Routed on the URL, which carries the conversation's own
  // run id (chat-<commentId>), so the two are told apart by conversation, not
  // by arrival order.
  const sent = []
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/signals/message', async (route) => {
    const url = route.request().url()
    sent.push((url.includes('chat-' + conv.a) ? 'a:' : 'b:') + route.request().postDataJSON().body)
    if (url.includes('chat-' + conv.a)) await held
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'signalled' }),
    })
  })

  const enterChatOn = async (text) => {
    await page.getByTestId('comment-item').filter({ hasText: text }).first().click()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowRight')
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    return composer
  }

  {
    await page.goto('/pr/' + pr)
    await expect(page.getByTestId('comment-item').first()).toBeVisible()

    // Conversation A: its POST hangs, so A now has a turn running.
    const a = await enterChatOn('eerste vraag over total')
    await a.fill('leg dit uit')
    await a.press('Enter')
    await expect.poll(() => sent.length).toBe(1)

    // Walk to the OTHER comment and chat there. Its first message must go out
    // straight away — it used to sit in A's queue until A's turn returned.
    const b = await enterChatOn('tweede vraag over lines')
    await expect(page.getByTestId('claude-queued')).toHaveCount(0)
    await b.fill('en dit dan')
    await b.press('Enter')
    await expect.poll(() => sent.length).toBe(2)
    expect(sent).toEqual(['a:leg dit uit', 'b:en dit dan'])
    // Nothing queued anywhere: two turns, two conversations, in parallel.
    await expect(page.getByTestId('claude-queued')).toHaveCount(0)

    // A is still running, and B — which is what the panel shows now — is not
    // reported as busy on its behalf: the status line belongs to the
    // conversation on screen.
    await expect(page.getByTestId('claude-chat-compose')).toBeEnabled()

    release()
    // And conversation A is still reachable by walking back onto it — the
    // whole point of the report ("nu raak ik die chat weer kwijt"). Back out
    // of the Claude column, one comment up (an earlier item collapses behind
    // the "1 hierboven" button, so this walks rather than clicks), and in
    // again: A's own comment and its own composer.
    await page.getByTestId('comment-more-above').click() // an earlier comment is collapsed away
    await expect(page.getByTestId('comment-item').first()).toContainText('eerste vraag over total')
    const back = await enterChatOn('eerste vraag over total')
    await expect(back).toBeVisible()
    await expect(page.getByTestId('claude-chat-column')).toBeVisible()
  }
  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB
  // (see .claude/docs/testing-playwright.md), so the two threads are gone with
  // it — same as claude-chat-queue.spec.mjs.
})
