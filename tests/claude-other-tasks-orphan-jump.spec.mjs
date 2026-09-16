import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: jumping to an ORPHAN comment's own row of "Andere chats in
// deze PR" (its block was renamed/removed, anchorState 'orphan' — see
// .claude/docs/claude-chat-panel.md, "A third dead end") used to be a silent
// dead end, same shape as the two already covered in
// claude-other-tasks-jump-origins.spec.mjs: jumpToClaudeConversation fell
// into openTask's file/label lookup, which can never find an orphan's block
// (that's what orphan means), fell through to openTaskDrilledAnchor, which
// equally found nothing — the only visible effect was the caller's own
// cs.claudeTasksPos reset (the row's highlight ring disappearing) plus this
// function's own unconditional trailing enterClaudeChat re-focusing
// whatever conversation was ALREADY open. Reported as "hier op drukken kan
// niet ... alleen de deselectie".
//
// Reviewer product decision, confirmed: the row stays (never filtered out
// for being orphaned), a click/Enter opens that conversation's REAL
// transcript, and the existing "verouderd — code verdwenen" badge
// (staleAnchorBadge) marks — right there, next to CommentClaudeFooter's own
// "Selected: …" line, not only in the comment thread/index list — that its
// code is gone.
//
// Reuses PR 970600 (tests/fixtures/orphan-blocks.json/orphan-comments.json,
// see comment-orphan-anchor.spec.mjs's own doc comment for why anchorState
// is seeded rather than driven through the API — it's deliberately
// unreachable from the UI) instead of a fresh seededPr: only this fixture
// carries a genuinely orphaned comment to jump to. orphan-1 already exists
// as a comment row from that seed; this test only adds a Claude
// conversation on top of it (a claude_chat workflow run + one signalled
// message), which doesn't touch anything comment-orphan-anchor.spec.mjs
// itself asserts on (block-row counts, the approval pill).
const PR = 970600

test('jump to an orphaned comment\'s own row opens its real conversation, badged "verouderd"', async ({ page }) => {
  const chat = await page.request.post('/api/workflows/claude_chat', { data: { pr: PR, commentId: 'orphan-1' } })
  const chatRunId = (await chat.json()).runId
  expect(chatRunId).toBeTruthy()

  // A real (unmocked) Signal, sent through page.request — a Node-side HTTP
  // call, not something page.route could intercept anyway (unlike the
  // browser's own composer send, which claude-chat-other-tasks.spec.mjs
  // holds) — so this conversation gets an actual stored reviewer message
  // (answered by the offline `claude` stub, SLASH_CLAUDE=off), landing it in
  // cc.conversations for otherClaudeChatsAll to find, same as
  // claude-other-tasks-jump-origins.spec.mjs's own drilled-anchor case does.
  const signalRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
    data: { author: 'reviewer', body: 'kan je hier meer over vertellen?' },
  })
  expect(signalRes.ok()).toBe(true)

  try {
    await page.goto('/pr/' + PR)
    await leaveSearchBox(page)

    // The one real (non-orphan) block — OrphanAction::stillHere — is the
    // "currently in view" conversation while orphan-1 shows up as "other".
    await page.getByTestId('block-row').filter({ hasText: 'stillHere' }).click()
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> comment head (pinned-1 makes this visible)
    await page.keyboard.press('ArrowRight') // comment -> claude
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    const otherTasks = page.getByTestId('claude-other-tasks')
    await expect(otherTasks).toBeVisible()
    const row = page.getByTestId('claude-task-row').filter({ hasText: 'kan je hier meer over vertellen?' })
    await expect(row).toBeVisible()

    await row.click()

    // The row's OWN conversation is now open — not the stillHere one that
    // was in view before the jump.
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
    const selected = page.getByTestId('claude-selected-line').first()
    await expect(selected).toBeVisible()
    await expect(selected).toContainText('kan je hier meer over vertellen?')

    // The reused staleAnchorBadge sits right next to that line — the
    // reviewer can tell, without hunting through the comment thread, that
    // this conversation's own code is gone.
    const staleBadge = selected.getByTestId('comment-stale-anchor')
    await expect(staleBadge).toBeVisible()
    await expect(staleBadge).toContainText('verouderd')
  } finally {
    await page.request.post('/api/workflows/' + chatRunId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
