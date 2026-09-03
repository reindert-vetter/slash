import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Two reviewer requests narrowing "Andere chats in deze PR" (RelatedPanel.mjs's
// otherClaudeChatsAll): an automatically started chat (kilo's own auto-check
// turn, chat.KindAutoCheck) must never show up there, and a chat that already
// has an answer AND was already viewed ('seen' + otherTaskAnswered) must not
// show up either — but a chat with NO answer yet stays visible even though it
// also falls into chatStateOf's 'seen' fallback. See "Two hard exclusions" in
// .claude/docs/claude-chat-panel.md.
//
// The per-conversation transcript fetch (ensureOtherTaskTitle's
// `/api/chat?commentId=...` GET) is mocked directly, same trick as the
// "auto_check turn" bubble test in claude-chat-panel.spec.mjs, rather than
// driving three real Claude turns through the offline stub — this is purely
// about the LIST's own filter, not about a turn actually running.
test('Andere chats in deze PR hides an auto-started chat and a seen-and-answered one, but keeps an unanswered one', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, file, body] of [
    ['a', 'a.php', 'eerste vraag automatisch gestart'],
    ['b', 'b.php', 'tweede vraag beantwoord en bekeken'],
    ['c', 'c.php', 'derde vraag nog geen antwoord'],
    ['d', 'd.php', 'vierde selectie'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    conv[key] = (await res.json()).runId
    expect(conv[key]).toBeTruthy()
  }

  await page.route('**/api/chat*', async (route) => {
    const url = new URL(route.request().url())
    const commentId = url.searchParams.get('commentId')
    if (commentId === conv.a) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            {
              id: 'a1',
              role: 'user',
              kind: 'auto_check',
              body: 'Kilo (de geautomatiseerde code-review bot) heeft hier een opmerking geplaatst',
            },
          ],
          seenAt: '',
        }),
      })
    }
    if (commentId === conv.b) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'b1', role: 'user', body: 'tweede vraag beantwoord en bekeken', createdAt: '2024-01-01T00:00:00Z' },
            { id: 'b2', role: 'assistant', body: 'hier is het antwoord', createdAt: '2024-01-01T00:01:00Z' },
          ],
          seenAt: '2024-01-01T00:02:00Z',
        }),
      })
    }
    if (commentId === conv.c) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [{ id: 'c1', role: 'user', body: 'derde vraag nog geen antwoord', createdAt: '2024-01-01T00:00:00Z' }],
          seenAt: '',
        }),
      })
    }
    if (!commentId && url.searchParams.get('pr')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [conv.a, conv.b, conv.c] }),
      })
    }
    return route.continue()
  })

  const enterChatOn = async (text) => {
    await page.getByTestId('block-row').filter({ hasText: text }).first().click()
    const compose = page.getByTestId('claude-chat-compose')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(compose).toBeFocused()
    return compose
  }

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(4)

  await enterChatOn('vierde selectie')

  // The unanswered chat (c) stays.
  await expect(page.getByTestId('claude-task-row').filter({ hasText: 'derde vraag' })).toBeVisible()
  // The auto-started chat (a) and the seen-and-answered one (b) are gone.
  await expect(page.getByTestId('claude-task-row').filter({ hasText: 'eerste vraag' })).toHaveCount(0)
  await expect(page.getByTestId('claude-task-row').filter({ hasText: 'tweede vraag' })).toHaveCount(0)
  await expect(page.getByTestId('claude-task-row')).toHaveCount(1)

  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
