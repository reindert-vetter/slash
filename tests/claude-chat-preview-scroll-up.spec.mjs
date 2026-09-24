import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Regression for "als ik hier naar boven ga met mij keys, dan scrol je niet
// mee en is de chat niet zichtbaar". Walking DOWN into this unit's own
// code-preview card (cs.previewPos, see focusPreviewCard's alignToTopVertical
// call in RelatedPanel.mjs) correctly scrolls the outer `comments-and-related`
// column down to show it — but walking back UP used to leave that column
// scrolled exactly where it sat for the card for as long as the reviewer was
// still walking the "Andere chats in deze PR" rows (cs.claudeTasksPos) above
// it: `focusClaudeTaskRow` only ever kept ITS OWN row in view, never the
// composer/thread further up, so the chat stayed off-screen for the whole
// walk and only reappeared once the very last ↑ (reaching the composer
// itself) happened to trigger the browser's own "scroll a newly focused
// input into view" side effect. `nudgeClaudeCardIntoView` (called from both
// `focusClaudeTaskRow` and `focusClaudeComposer`'s rest branch) now brings
// the whole `claude-chat-card` back toward view on every ↑ step through that
// chain, not only the last one.
//
// Three OTHER unanswered conversations elsewhere in the PR force a real
// multi-row "Andere chats" walk between the code-preview card and the
// composer. Mocking `/api/chat*` directly (same trick as
// claude-other-tasks-hidden.spec.mjs) avoids driving real Claude turns just
// to get a fenced code block onto one transcript.
test.use({ viewport: { width: 1280, height: 700 } })

test('arrowing back up out of a code-preview card, through "Andere chats", scrolls the chat back into view', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: 'd.php', line: 0, author: 'AI check', body: 'vraag met een codeblok', kind: 'ai_warning', source: 'ai', local: true },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()

  const otherRunIds = []
  for (const [file, body] of [
    ['a.php', 'eerste andere vraag'],
    ['b.php', 'tweede andere vraag'],
    ['c.php', 'derde andere vraag'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    otherRunIds.push((await res.json()).runId)
  }

  // A long fence (many lines) so the expanded preview card is taller than
  // the viewport on its own, forcing `comments-and-related` to actually
  // overflow once it's opened.
  const fenceLines = Array.from({ length: 40 }, (_, i) => `    $line${i} = ${i};`).join('\n')
  await page.route('**/api/chat*', async (route) => {
    const url = new URL(route.request().url())
    const commentId = url.searchParams.get('commentId')
    if (commentId === runId) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'm1', role: 'user', body: 'vraag met een codeblok', createdAt: '2024-01-01T00:00:00Z' },
            {
              id: 'm2',
              role: 'assistant',
              body: 'Hier is het voorstel:\n```php\n' + fenceLines + '\n```\nNiet gecommit.',
              createdAt: '2024-01-01T00:01:00Z',
            },
          ],
          seenAt: '',
        }),
      })
    }
    if (otherRunIds.includes(commentId)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [{ id: commentId + '-1', role: 'user', body: 'nog geen antwoord', createdAt: '2024-01-01T00:00:00Z' }],
          seenAt: '',
        }),
      })
    }
    if (!commentId && url.searchParams.get('pr')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [runId, ...otherRunIds] }),
      })
    }
    return route.continue()
  })

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await page.getByTestId('block-row').filter({ hasText: 'vraag met een codeblok' }).first().click()
  const compose = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(compose).toBeFocused()

  await expect(page.getByTestId('claude-task-row')).toHaveCount(3)
  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toBeVisible()

  const column = page.getByTestId('comments-and-related')
  const isComposeReachable = async () => {
    const box = await compose.boundingBox()
    return !!box && box.y >= 0 && box.y < 700
  }

  // Down through the 3 task rows, then into the card: the column scrolls to
  // bring the card into view, pushing the composer off-screen.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  await expect(card).toHaveAttribute('data-active', 'true')
  await expect(async () => {
    const scrollTop = await column.evaluate((el) => el.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
  }).toPass()
  expect(await isComposeReachable()).toBe(false)

  // One ↑ leaves the card and lands on the LAST task row — not yet back at
  // the composer, but the chat must already be scrolling back into view
  // instead of staying frozen at the card's own scroll position.
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('claude-task-row').last()).toHaveAttribute('data-active', 'true')
  await expect(async () => {
    expect(await isComposeReachable()).toBe(true)
  }).toPass()

  // Walking the rest of the way up keeps it that way, ending back on the
  // composer itself.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
  await expect(compose).toBeFocused()
  expect(await isComposeReachable()).toBe(true)

  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
