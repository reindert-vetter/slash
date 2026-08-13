import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies the fix for a reported bug: scrolling UP by hand inside a long
// comment thread used to get silently snapped back down to the newest
// message a few seconds later, whenever the comment poll (loadComments,
// every 5s) landed a new reply — because scrollCommentThreadToBottom only
// ever checked the KEYBOARD cursor (cs.threadPos === 0), never whether the
// reviewer's own mouse/wheel scroll had since moved away from the bottom
// (see cs.threadPinned/updateCommentThreadPinned in RelatedPanel.mjs).
//
// A manual scroll-up must instead surface a small "scroll to recent
// messages" button (data-testid=scroll-to-bottom-comments) and leave the
// scroll position alone until the reviewer explicitly presses it.
test('scrolling up in a comment thread stays put through a poll, with a button back down', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'octocat',
      body: 'root comment',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()

  // Enough replies that the capped comment-thread pane (max-h-[38vh]) has to
  // scroll internally at all.
  for (let i = 0; i < 12; i++) {
    await page.request.post('/api/workflows/' + runId + '/signals/reply', {
      data: { author: 'reviewer', body: 'reply nummer ' + i, done: false },
    })
  }

  await page.goto('/pr/' + pr)
  await page.keyboard.press('Escape')
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  const pane = page.getByTestId('comment-thread')
  await expect(pane).toBeVisible()
  const button = page.getByTestId('scroll-to-bottom-comments')

  // At rest the thread is scrolled to the bottom already, so the button is
  // hidden — it only ever appears once the reviewer scrolls away from it.
  await expect(button).toBeHidden()

  // Scroll the pane itself up by hand (not via ↑, which walks the keyboard
  // cursor through the thread — a different, unrelated mechanism).
  await pane.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(button).toBeVisible()
  const scrolledUpTop = await pane.evaluate((el) => el.scrollTop)
  expect(scrolledUpTop).toBe(0)

  // A new reply lands while the reviewer is reading an older message — the
  // comment poll (every 5s) must pick it up without yanking the scroll
  // position back down.
  await page.request.post('/api/workflows/' + runId + '/signals/reply', {
    data: { author: 'octocat', body: 'nog een reactie terwijl je terugleest', done: false },
  })
  await page.waitForTimeout(6000)
  await expect(page.getByTestId('reaction-bubble').last()).toContainText('nog een reactie terwijl je terugleest')
  await expect(pane.evaluate((el) => el.scrollTop)).resolves.toBe(0)
  await expect(button).toBeVisible()

  // Pressing the button is the explicit way back down.
  await button.click()
  await expect(button).toBeHidden()
  await expect
    .poll(() => pane.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 8))
    .toBe(true)
})

// Lighter check on the embedded Claude chat's own copy of the same button
// (ClaudeChat.mjs's claudeScrollToRecentButton) — the wiring (visibility on
// manual scroll-up, click scrolls back down), not the poll-driven race
// itself, which is already covered above for the structurally identical
// comment-thread mechanism.
test('scrolling up in the Claude chat thread shows the scroll-to-recent button', async ({ page }, testInfo) => {
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
  await page.keyboard.press('ArrowRight') // comment -> claude
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeFocused()

  // Send a handful of turns through the real (SLASH_CLAUDE=off, fake-client)
  // composer round-trip so the capped claude-chat-thread pane (max-h-[38vh])
  // has enough bubbles to scroll internally at all. The fake client cycles
  // through a few different canned replies, so this only waits for the
  // message COUNT to grow, not for any particular wording.
  for (let i = 0; i < 5; i++) {
    const before = await page.getByTestId('claude-message').count()
    await compose.fill('vraag nummer ' + i)
    await compose.press('Enter')
    await expect.poll(() => page.getByTestId('claude-message').count()).toBeGreaterThan(before)
  }

  const pane = page.getByTestId('claude-chat-thread')
  const button = page.getByTestId('scroll-to-bottom-claude')
  await expect(button).toBeHidden()

  await pane.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(button).toBeVisible()

  await button.click()
  await expect(button).toBeHidden()
  await expect
    .poll(() => pane.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 8))
    .toBe(true)
})
