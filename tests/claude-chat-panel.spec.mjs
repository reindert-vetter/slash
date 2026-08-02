import { test, expect, seededPr } from './_fixtures.mjs'

// Verifies the embedded Claude conversation column (claude_chat workflow,
// see .claude/rules/comments-panel.md's "Embedded Claude chat" section):
// it renders as its own column next to the comment thread, → deepens one
// level further from an existing thread into it, a plain message round-trips
// through the fake claude backend (SLASH_CLAUDE_CHAT_TURNS, see
// _fixtures.mjs), a "question with choices" turn renders its option buttons,
// and choosing one both records the answer and continues the conversation.
test('embedded Claude chat: enter via →, send a message, answer a question', async ({ page }, testInfo) => {
  // Its own synthetic PR (and its own again on a retry) — comments have no
  // reset hook shared across specs, see "A spec that SEEDS data" in
  // testing-playwright.md.
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

  // → deepens comment -> thread -> claude, exactly like → already deepens
  // comment -> thread (the reply field is empty both times, so the caret
  // guard lets ArrowRight through as a nav key — see
  // editableCaretCanMoveRight in keyboard-navigation.md).
  await page.keyboard.press('ArrowRight') // comment -> thread
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
  await page.keyboard.press('ArrowRight') // thread -> claude

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeVisible()
  await expect(composer).toBeFocused()

  // First turn: a plain text reply (see tests/fixtures/claude-chat-turns.json).
  // .first() is the reviewer's own just-sent message; the assistant's reply
  // is the second bubble (threadMessages ordering: user turn, then reply).
  await composer.fill('Kun je hier iets over zeggen?')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')

  // Second turn: a strict "question with choices" directive — renders as up
  // to 3 option buttons (chat_workflow.go's maxChatQuestionOptions), free
  // text remains the implicit 4th option via the same composer.
  await composer.fill('Stel een aanpak voor.')
  await composer.press('Enter')
  const options = page.getByTestId('claude-question-option')
  await expect(options).toHaveCount(3)
  await expect(options.nth(1)).toHaveText('Optie B')

  // Choosing an option sends its text as the next reviewer turn (same Signal
  // as free text) — the question bubble records the chosen answer, and the
  // conversation continues with the next programmed turn.
  await options.nth(1).click()
  await expect(page.getByTestId('claude-question-answer')).toContainText('Optie B')
  await expect(page.getByTestId('claude-message-body').last()).toContainText(
    'Bedankt, ik ga verder met Optie B.',
  )

  // ← steps back out of the chat into the thread it hangs on — one level at
  // a time, mirroring 'thread' -> 'comment'.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
})
