import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Reviewer report: a chat that hit a session/usage limit (or any other error
// its last automatic retry attempt could not recover from) showed the same
// green ✓ "Klaar" as a genuinely finished chat in "Andere chats in deze PR" —
// AND, once the reviewer had looked at it for the 5s dwell, disappeared from
// the list entirely, exactly like a `seen`+`answered` chat nobody needs to
// look at again. Both read as "nothing to do here", the opposite of true. See
// `otherTaskFailed` in .claude/docs/claude-chat-panel.md.
//
// Mocked the same way as claude-other-tasks-hidden.spec.mjs (the per-
// conversation transcript fetch, `/api/chat?commentId=...`, is mocked
// directly) — this is purely about the LIST row's own state/filter, not about
// a turn actually running. `seenAt` is set NEWER than the error message so
// the chat is already past the 5s "seen" dwell from the very first render —
// exactly the case that used to fall into the "seen and answered" filter and
// vanish.
test('a chat whose last message is an error shows "Mislukt" instead of "Klaar" and stays listed once seen', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, file, body] of [
    ['limit', 'a.php', 'gebruik property hier, niet method'],
    ['other', 'b.php', 'tweede selectie'],
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
    if (commentId === conv.limit) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            {
              id: 'u1',
              role: 'user',
              body: 'gebruik property hier, niet method',
              createdAt: '2024-01-01T00:00:00Z',
            },
            {
              id: 'a1',
              role: 'assistant',
              kind: 'error',
              body:
                "Claude (Opus) meldde zelf een fout: You've hit your session limit · resets 2pm (Europe/Amsterdam) " +
                'Dit lost een automatische nieuwe poging vermoedelijk niet op — probeer het straks handmatig opnieuw.',
              createdAt: '2024-01-01T00:01:00Z',
            },
          ],
          // Already "bekeken" from the very first render — the case that used
          // to make a failed-and-seen chat vanish from the list entirely.
          seenAt: '2024-01-01T00:02:00Z',
        }),
      })
    }
    if (!commentId && url.searchParams.get('pr')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [conv.limit, conv.other] }),
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
  await expect(page.getByTestId('block-row')).toHaveCount(2)

  await enterChatOn('tweede selectie')

  const row = page.getByTestId('claude-task-row').filter({ hasText: 'gebruik property hier' })
  // Still listed — a failed/limit-stranded chat must not disappear once
  // "bekeken", unlike an ordinary answered-and-seen chat.
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-state', 'failed')
  await expect(row).toContainText('Mislukt')
  await expect(row).not.toContainText('Klaar')
  await expect(row).toContainText('✕')

  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
