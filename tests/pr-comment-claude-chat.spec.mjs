import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// See the "stale block-scoped cs.focus" test's own finally block for why this
// races the request against a plain client-side timeout instead of a bare
// `await`.
async function deleteCommentBestEffort(page, runId, ms = 5000) {
  try {
    await Promise.race([
      page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } }),
      new Promise((resolve) => setTimeout(resolve, ms)),
    ])
  } catch {
    // Cleanup only — a failed/slow delete must never fail the test itself.
  }
}

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

// Regression test for: "if I submit to Claude, I get a menu instead of the
// message being sent — a refresh fixes it". Root cause: a plain mouse click
// onto this comment-index item (unlike every keyboard-driven way of moving
// state.selected) never released a stale cs.focus === 'comment' left over
// from an earlier, unrelated block's own comment thread. home.mjs's global
// onKeydown still gated its relatedActive() hijacking on that stale value, so
// Enter typed in the (cs.focus-independent) "Chat met Claude" composer got
// swallowed instead of reaching ClaudeChat.mjs's own send handler. Fixed by
// adding leaveRelated() to home.mjs's existing state.selected reset watch —
// see its own doc comment, and "closePrCommentChat" in
// .claude/docs/claude-chat-panel.md.
//
// Needs a REAL block-scoped comment (cs.focus === 'comment' only exists next
// to an actual diff), so this uses the shared PR 12903 fixture (real ingested
// blocks — see claude-chat-panel.spec.mjs's own tests for the same pattern),
// seeding both comments directly via the workflow API and cleaning them up
// afterwards.
test('a stale block-scoped cs.focus does not hijack Enter in the PR-comment Claude composer', async ({ page }) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

  // A block-scoped comment on the real block at data-idx="1" — clicking it
  // sets cs.focus === 'comment'.
  const blockComment = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'kan dit anders?', label, rowStart: -1, rowEnd: -1 },
  })
  const blockRunId = (await blockComment.json()).runId
  expect(blockRunId).toBeTruthy()

  // A separate PR-wide comment to open "Chat met Claude" on.
  const prWide = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Http/Controllers/Api/ContractController.php',
      line: 0,
      author: 'AI check',
      body: 'Dit endpoint valideert de invoer niet.',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  const prWideRunId = (await prWide.json()).runId
  expect(prWideRunId).toBeTruthy()

  try {
    // Reload so both comments are present from the start (avoids racing the
    // frontend's own poll cadence, same as claude-chat-panel.spec.mjs). The
    // new PR-wide comment-index item inserts itself ahead of every real
    // block (recomputeLeftList's own ranking), so data-idx="1" no longer
    // reliably points at the same real block any more — select it by its
    // own label text instead.
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.getByTestId('block-row').filter({ hasText: label }).first().click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> the comment conversation, cs.focus = 'comment'
    await expect(page.getByTestId('reaction-compose')).toBeFocused()

    // Move on to the PR-wide comment-index item with a plain mouse click —
    // WITHOUT ever pressing ←/Escape to release the block-scoped panel first,
    // exactly the sequence the bug report hit.
    // A plain .click() is flaky here (Playwright's actionability check
    // intermittently reports the row "outside of the viewport" even right
    // after scrolling — the sidebar's own internal scroll container, not the
    // page); dispatchEvent bypasses that check and still fires the row's real
    // @click handler.
    await page.getByTestId('block-row').filter({ hasText: 'Dit endpoint' }).first().dispatchEvent('click')
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await menu.getByTestId('command-row').getByText('Chat met Claude', { exact: true }).click()
    await expect(menu).toHaveCount(0)

    const compose = page.getByTestId('claude-chat-compose')
    await expect(compose).toBeFocused()

    await compose.fill('Kan dit sneller?')
    await compose.press('Enter')

    // The message was sent, not swallowed by a stray command menu.
    await expect(page.getByTestId('command-menu')).toHaveCount(0)
    await expect(page.getByTestId('claude-message-body').last()).toContainText(
      'Ik heb naar de code gekeken. Zal ik een aanpak voorstellen?',
    )
  } finally {
    // Best-effort cleanup: deleting a comment whose claude_chat conversation
    // was just reached via a stale-cs.focus jump has been observed to make
    // this particular signal round-trip unrelatedly slow in this environment
    // (separate from — and not caused by — the fix under test here). Race it
    // against a plain client-side timeout rather than let a slow cleanup call
    // fail the whole test; a leftover comment on the shared PR 12903 fixture
    // is harmless (every other spec filters/selects its own rows by content).
    await deleteCommentBestEffort(page, blockRunId)
    await deleteCommentBestEffort(page, prWideRunId)
  }
})
