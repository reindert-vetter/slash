import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: clicking an "Andere chats in deze PR" row could open a
// DIFFERENT conversation than the one clicked. jumpToClaudeConversation first
// navigates to the chat's code (openTask), then enterClaudeChat resolved "the
// chat to open" from whatever the selection now was (chatAnchorComment). When
// that navigation could not land on the chat's own comment — its block is no
// longer in the PR, or the comment sits outside the landing unit (unpinned) —
// that resolved to the conversation already in view, or to another one on the
// same block. Reviewer report (PR 13933): "als ik druk op `is dit`… onder
// andere chats, dan zie ik die niet verschijnen". Now the jump passes its
// target to enterClaudeChat explicitly.

async function seedChat(page, { file = 'app/Actions/CreatePaymentAction.php', label, line, body, rowStart, question }) {
  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file,
      label,
      line,
      author: 'reviewer',
      body,
      kind: '',
      source: 'ui',
      local: true,
      rowStart,
      rowEnd: rowStart,
    },
  })
  const runId = (await res.json()).runId
  expect(runId).toBeTruthy()
  if (question) {
    const chat = await page.request.post('/api/workflows/claude_chat', { data: { pr: 12903, commentId: runId } })
    const chatRunId = (await chat.json()).runId
    expect(chatRunId).toBeTruthy()
    const sig = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
      data: { author: 'reviewer', body: question },
    })
    expect(sig.ok()).toBe(true)
  }
  return runId
}

test('an "Andere chats" row opens its own conversation even when its code is no longer in the PR', async ({
  page,
}) => {
  const ids = []
  try {
    // A conversation on a block this PR no longer contains (the real case: a
    // migration dropped from the PR after the chat started).
    ids.push(
      await seedChat(page, {
        file: 'database/migrations/2026_01_01_000000_gone.php',
        label: 'up',
        line: 25,
        body: 'weg comment',
        rowStart: 0,
        question: 'vraag over weg',
      }),
    )
    // The conversation in view while that one shows up as an "other" row.
    ids.push(
      await seedChat(page, {
        label: 'CreatePaymentAction::findOrCreateCustomer',
        line: 40,
        body: 'hier kijk ik',
        rowStart: -1,
        question: 'vraag hier',
      }),
    )

    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await leaveSearchBox(page)
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::findOrCreateCustomer' }).click()
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> comment
    await page.keyboard.press('ArrowRight') // comment -> claude
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
    const chat = page.getByTestId('claude-chat-column')
    await expect(chat).toContainText('vraag hier')

    const row = page.getByTestId('claude-task-row').filter({ hasText: 'vraag over weg' })
    await expect(row).toBeVisible()
    await row.click()

    await expect(chat).toContainText('vraag over weg')
    await expect(chat).not.toContainText('vraag hier')
  } finally {
    for (const id of ids) {
      await page.request.post('/api/workflows/' + id + '/signals/delete', { data: { author: 'reviewer' } })
    }
  }
})
