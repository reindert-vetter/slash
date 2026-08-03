import { test, expect, seededPr, evaluateSettled } from './_fixtures.mjs'

// Verifies the embedded Claude conversation column (claude_chat workflow,
// see .claude/docs/comments-panel.md's "Embedded Claude chat" section):
// it renders as its own column next to the comment thread, → deepens one
// level further from an existing thread into it, a plain message round-trips
// through the fake claude backend (SLASH_CLAUDE_CHAT_TURNS, see
// _fixtures.mjs), a "question with choices" turn renders its option buttons,
// choosing one both records the answer and continues the conversation, and
// the two agentic action buttons ("Bewerk code"/"Commit wijziging", see
// .claude/docs/claude-chat-panel.md) are wired to a real send resp. a
// confirm-before-push menu.
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

  // ↑ from the comment card walks into its own thread bubble first ('thread'
  // is a vertical cursor now, reached via ↑, not a horizontal → stop — see
  // TODO 2 in todo-claude-chat-blok.md); → from that bubble reaches the
  // Claude block in the same single step as → from the comment card itself.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  // ← goes straight back to the comment card (not to 'thread' in between).
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()

  // → deepens comment -> claude directly, one step (the reply field is empty,
  // so the caret guard lets ArrowRight through as a nav key — see
  // editableCaretCanMoveRight in keyboard-navigation.md).
  await page.keyboard.press('ArrowRight') // comment -> claude
  const connector = page.getByTestId('comment-claude-connector')
  await expect(connector).toBeVisible()

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

  // "Bewerk code" sends the SAME typed text as "Stuur", but with an
  // action:'edit' turn (see chat_workflow.go's ChatMessageSignal.Action). An
  // edit turn first needs a per-conversation shadow worktree
  // (ensureChatShadowWorktree, chat_shadow.go), which requires a REAL PR head
  // branch from gh — something this synthetic seededPr number doesn't have
  // even under the offline Fake, so it deterministically reports the "no
  // worktree" KindError turn instead of consuming the next programmed reply.
  // That is still exactly what this test needs to verify: the button really
  // sends a real action:'edit' Signal end-to-end (real success/failure git
  // plumbing is covered offline at the Go level, see chat_shadow_test.go).
  await composer.fill('Pas de foutafhandeling aan.')
  await page.getByTestId('claude-chat-send-edit').click()
  await expect(page.getByTestId('claude-message-body').last()).toContainText(
    'Kon geen werkkopie voor Claude klaarzetten om in te bewerken.',
  )

  // "Commit wijziging" needs no typed text and genuinely fast-forward-pushes
  // onto the PR's real head branch, so it never acts on a single click: it
  // only opens a confirm menu (mirrors "Approve the whole PR"). Verifying the
  // confirm step opens/closes is enough here — actually confirming would push
  // to a real remote, out of scope for this offline suite (see
  // claude-chat-panel.md).
  await page.getByTestId('claude-chat-commit').click()
  const confirmMenu = page.getByTestId('command-menu')
  await expect(confirmMenu).toBeVisible()
  await expect(confirmMenu).toContainText('Ja, commit en push naar de PR-branch')
  await page.keyboard.press('Escape')
  await expect(confirmMenu).toBeHidden()

  // ← steps back out of the chat straight onto the comment card it hangs on
  // (no more 'thread' stop in between).
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
})

// A message with `kind: 'action'` (chat.KindAction — Claude placed/resolved a
// comment on the left thread on the reviewer's request, Phase 4, see
// chat_workflow.go's applyChatCommentAction) and `kind: 'error'` (that same
// attempt failing, chat.KindError) each need their own word+glyph marking —
// per the colourblind rule, never colour alone (see chatKindBadge in
// ClaudeChat.mjs). Driving this through a real comment_action directive would
// require a commentId known ahead of the fixture file being loaded (the
// comment's run id is only assigned once the server starts, see the fake's
// SetChatTurns doc comment); the KindAction/KindError decision itself is
// already covered end-to-end on the backend (chat_workflow_test.go). This is
// therefore a direct-mount unit test of the render, mirroring diffview.spec.mjs.
test('Claude chat: an action turn and an error turn each get their own badge, not just a colour', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  // Settle the app's own load before mounting a second component into the
  // live page (the cold-start mount race in conventions.md) — waiting for the
  // sidebar to render is enough here; evaluateSettled itself retries on the
  // "Execution context was destroyed" race the load-time history.replaceState
  // burst can still cause.
  await expect(page.getByTestId('pr-index')).toBeVisible()

  await evaluateSettled(page, async () => {
    const { claudeChatColumn } = await import('/src/ClaudeChat.mjs')
    const messages = [
      { id: 'm1', role: 'assistant', kind: 'action', body: '✓ Comment-thread opgelost.' },
      { id: 'm2', role: 'assistant', kind: 'error', body: 'Kon de comment-thread niet bijwerken.' },
    ]
    const view = {
      messages: () => messages,
      status: () => 'ready',
      busy: () => false,
      progress: () => null,
      elapsed: () => 0,
      claudePos: () => 0,
    }
    const host = document.createElement('div')
    host.id = 'claude-chat-badge-host'
    document.body.appendChild(host)
    claudeChatColumn(view, { onSend: () => {} })(host)
  })

  const host = page.locator('#claude-chat-badge-host')
  const actionBadge = host.getByTestId('claude-message-action')
  await expect(actionBadge).toBeVisible()
  await expect(actionBadge).toContainText('actie in commentthread')
  const errorBadge = host.getByTestId('claude-message-error')
  await expect(errorBadge).toBeVisible()
  await expect(errorBadge).toContainText('foutmelding')

  // Neither badge is present on a plain assistant turn.
  await evaluateSettled(page, async () => {
    const { claudeChatColumn } = await import('/src/ClaudeChat.mjs')
    const messages = [{ id: 'm3', role: 'assistant', body: 'Gewoon een antwoord.' }]
    const view = {
      messages: () => messages,
      status: () => 'ready',
      busy: () => false,
      progress: () => null,
      elapsed: () => 0,
      claudePos: () => 0,
    }
    const host = document.createElement('div')
    host.id = 'claude-chat-plain-host'
    document.body.appendChild(host)
    claudeChatColumn(view, { onSend: () => {} })(host)
  })
  const plainHost = page.locator('#claude-chat-plain-host')
  await expect(plainHost.getByTestId('claude-message-action')).toHaveCount(0)
  await expect(plainHost.getByTestId('claude-message-error')).toHaveCount(0)
})
