import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies: compactConversation's meta line names who sent the LAST message
// of the thread (lastReplyNote in RelatedPanel.mjs) — not just the root
// author + reaction count, which never change once someone replies. See the
// "Inline comment blocks" section in detail-layout.md.
test('compact comment row shows who replied last, unless it was me', async ({ page }, testInfo) => {
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

  await page.goto('/pr/' + pr)
  await page.keyboard.press('Escape')

  const meta = page.getByTestId('comment-item').first().getByTestId('comment-meta')
  // No reply yet — nothing to name beyond the root author already shown above.
  await expect(meta).toHaveText('test.php:1 · 0 reacties · open')

  // A reply from someone else — the compact row now names them.
  await page.request.post('/api/workflows/' + runId + '/signals/reply', {
    data: { author: 'octocat', body: 'still me, not the reviewer', done: false },
  })
  await page.reload()
  await expect(page.getByTestId('comment-item').first().getByTestId('comment-meta')).toHaveText(
    'test.php:1 · 1 reacties · open · octocat reageerde',
  )

  // The reviewer's own reply is the last one now — the note disappears again.
  await page.request.post('/api/workflows/' + runId + '/signals/reply', {
    data: { author: 'reviewer', body: 'my own reply', done: false },
  })
  await page.reload()
  await expect(page.getByTestId('comment-item').first().getByTestId('comment-meta')).toHaveText(
    'test.php:1 · 2 reacties · open',
  )
})
