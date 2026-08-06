import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// "Chat met Claude" (prCommentCommandsFor, home.mjs) — the PR-wide sibling of
// the block-scoped embedded Claude conversation: a comment-index item (an
// AI-controle finding, or any other PR-wide comment) has no code context to
// reach Claude via → (see claude-chat-panel.md's "chain, key by key"), so this
// command opens the SAME claude_chat conversation directly under the item's
// own detail card (RelatedPanel.mjs's commentDetailCard / pcc / prCommentClaudeView).
// See ".claude/docs/claude-chat-panel.md" for the mechanism this reuses
// (chatAnchorComment's `s.prComment` branch, syncClaudeAnchorForSelection).
//
// The seeded comment must be a REAL backend record (not a mocked GET) —
// POST /api/workflows/claude_chat's own handler (handleClaudeChatStart,
// tasks_api.go) looks the commentId up in the real comments module and 400s
// with "unknown comment" otherwise, regardless of what /api/comments answers.

test('"Chat met Claude" opens the embedded column under a PR-wide comment-index item and round-trips a message', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  // A PR-wide (kind !== '') comment — "PR-wide" means it has no ROW anchor
  // within a block, not that it carries no file at all: a real code_warning
  // finding that can't be pinned to a block still keeps File "as a hint of
  // what the finding is about" (see anchoredWarning in code_warning.go); the
  // HTTP endpoint below (unlike an Activity calling the comments module
  // directly, e.g. from code_warning's own workflow) rejects an empty File
  // regardless of Kind (handleTaskCodeComment, tasks_api.go).
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'app/Http/Controllers/Api/ContractController.php',
      line: 0,
      author: 'AI check',
      body: 'Dit endpoint valideert de invoer niet.',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()

  // Not shown until explicitly opened.
  await expect(page.getByTestId('pr-comment-claude-section')).toHaveCount(0)

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await menu.getByTestId('command-row').getByText('Chat met Claude', { exact: true }).click()
  await expect(menu).toHaveCount(0)

  const section = page.getByTestId('pr-comment-claude-section')
  await expect(section).toBeVisible()
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeFocused()

  await compose.fill('Kan dit sneller?')
  await compose.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText(
    'Ik heb naar de code gekeken. Zal ik een aanpak voorstellen?',
  )

  // Closing hides the column again without touching the conversation itself
  // (a later reopen — not exercised here — would show the same transcript).
  await page.getByTestId('pr-comment-claude-close').click()
  await expect(page.getByTestId('pr-comment-claude-section')).toHaveCount(0)
})
