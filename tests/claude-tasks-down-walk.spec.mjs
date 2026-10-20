import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'
test.use({ viewport: { width: 2000, height: 900 } })

// ↓ in the Claude column: composer -> other-chat row -> card 1 -> card 2 ...
// A ↓ on a card must never step back up onto the "andere chats" row (the
// extra stop that made the view jump up between two cards).
test('↓ walks other chats once, then each card exactly once', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const mk = async (body) =>
    (
      await (
        await page.request.post('/api/workflows/task_code_comment', {
          data: { pr, file: 'test.php', line: 1, author: 'reviewer', body, code: '$order->total();', gran: 'call', label: 'Order::total' },
        })
      ).json()
    ).runId
  const id = await mk('wat is dit voor status?')
  const id2 = await mk('andere vraag')
  const json = (body) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/chat?commentId=' + id2, json({ messages: [{ id: 'x1', role: 'user', kind: 'text', body: 'hoi' }] }))
  await page.route('**/api/chat?pr=*', json({ conversations: [id, id2] }))
  await page.route(
    '**/api/chat?commentId=' + id,
    json({
      messages: [
        { id: 'm1', role: 'assistant', kind: 'text', body: 'Eerste:\n```php\n$a = 1;\n```' },
        { id: 'm2', role: 'assistant', kind: 'text', body: 'Tweede:\n```php\n$b = 2;\n```\nen\n```php\n$c = 3;\n```' },
      ],
    }),
  )
  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await page.getByTestId('comment-item').first().click()
  await page.keyboard.press('ArrowRight')
  const cards = page.getByTestId('code-preview-card')
  const row = page.getByTestId('claude-task-row')
  await expect(cards).toHaveCount(3)
  await expect(row).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(row).toHaveAttribute('data-active', 'true')
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowDown')
    await expect(cards.nth(i)).toHaveAttribute('data-active', 'true')
    await expect(row).toHaveAttribute('data-active', 'false')
  }
})
