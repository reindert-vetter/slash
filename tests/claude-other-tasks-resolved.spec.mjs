import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// "als een comment is resolved, wil ik dat de chat ook klaar is en niet meer
// zichtbaar is in de lijst met lopende chats" — isResolvedChatDone
// (RelatedPanel.mjs): a resolved comment's chat drops out of "Andere chats in
// deze PR" AND the "Openstaande chats" sidebar section, unless its last turn
// failed (or is still running). See the "Two hard exclusions" section in
// .claude/docs/claude-chat-panel.md. Resolution is mocked on /api/comments and
// transcripts on /api/chat — this is purely about the list filters.
test('a resolved comment chat is hidden from both chat lists, unless its turn failed', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, file, body] of [
    ['r', 'r.php', 'opgeloste vraag'],
    ['f', 'f.php', 'opgeloste mislukte vraag'],
    ['s', 's.php', 'vierde selectie'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    conv[key] = (await res.json()).runId
    expect(conv[key]).toBeTruthy()
  }

  await page.route('**/api/comments?*', async (route) => {
    const res = await route.fetch()
    const list = await res.json()
    for (const c of list) if (c.id === conv.r || c.id === conv.f) c.status = 'resolved'
    return route.fulfill({ response: res, body: JSON.stringify(list) })
  })
  await page.route('**/api/chat*', async (route) => {
    const url = new URL(route.request().url())
    const commentId = url.searchParams.get('commentId')
    const json = (messages) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages, seenAt: '' }) })
    if (commentId === conv.r) {
      return json([{ id: 'r1', role: 'user', body: 'opgeloste vraag', createdAt: '2024-01-01T00:00:00Z' }])
    }
    if (commentId === conv.f) {
      return json([
        { id: 'f1', role: 'user', body: 'opgeloste mislukte vraag', createdAt: '2024-01-01T00:00:00Z' },
        { id: 'f2', role: 'assistant', kind: 'error', body: 'limit', createdAt: '2024-01-01T00:01:00Z' },
      ])
    }
    if (!commentId && url.searchParams.get('pr')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [conv.r, conv.f] }),
      })
    }
    return route.continue()
  })

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await page.getByTestId('block-row').filter({ hasText: 'vierde selectie' }).first().click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

  // The failed turn keeps its row; the settled resolved chat is gone.
  await expect(page.getByTestId('claude-task-row').filter({ hasText: 'mislukte' })).toBeVisible()
  await expect(page.getByTestId('claude-task-row')).toHaveCount(1)
  // No sidebar ("Openstaande chats") row for the settled resolved chat either.
  await expect(page.getByTestId('block-row').filter({ hasText: 'opgeloste vraag' })).toHaveCount(0)
})
