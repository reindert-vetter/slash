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

// A SECOND, narrower dead end survived the fix above: an orphan comment that
// is ALSO a bare, never-taken-over Claude-chat anchor (its body is exactly
// CLAUDE_ANCHOR_PLACEHOLDER — "Chat over deze regel" and nothing else ever
// typed, isChatAnchorPlaceholder with no firstReviewerReplyOnPlaceholder).
// Such a comment is EXCLUDED from indexComments/commentBlockItem for that
// reason alone (same carve-out the general chat needed — see
// jumpToClaudeConversation's own doc comment), so it never got a
// 'comment:'-prefixed row like `orphan-1` above — and, before this fix,
// `chatItems`' own filter (recomputeLeftList, home.mjs) ALSO required its
// (nonexistent) anchor block, so it got no 'chat:'-prefixed row either. A
// TRUE dead end: no row anywhere, in the sidebar or in "Andere chats in deze
// PR", even though `otherClaudeChatsAll` itself already listed it (that list
// doesn't require a row at all). See "A third dead end" in
// .claude/docs/claude-chat-panel.md.
//
// Own PR (970602, tests/fixtures/orphan-chatanchor-blocks.json/
// orphan-chatanchor-comments.json) — this exact combination (orphan AND
// chat-only) isn't covered by the PR 970600 fixture above (its own orphan
// comment has a real, written body).
const CHATANCHOR_PR = 970602
const CHATANCHOR_COMMENT_ID = 'orphan-chat-1'

test('jump to an orphaned, never-written CHAT-ONLY anchor also opens its real conversation, badged "verouderd"', async ({
  page,
}) => {
  const chat = await page.request.post('/api/workflows/claude_chat', {
    data: { pr: CHATANCHOR_PR, commentId: CHATANCHOR_COMMENT_ID },
  })
  const chatRunId = (await chat.json()).runId
  expect(chatRunId).toBeTruthy()

  const signalRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
    data: { author: 'reviewer', body: 'wat betekent dit precies?' },
  })
  expect(signalRes.ok()).toBe(true)

  try {
    await page.goto('/pr/' + CHATANCHOR_PR)
    await leaveSearchBox(page)

    // The one real block — ChatAnchorAction::stillHere — has no comment of
    // its own (the fixture's only comment is the orphaned chat-only anchor,
    // scoped nowhere near it), so claudeChatVisible() stays false for it and
    // a further ArrowRight into a composer of its own doesn't apply here —
    // but hasCommentClaudeFooter() (otherClaudeChats().length > 0) already
    // shows the "Andere chats in deze PR" section from plain diff mode.
    await page.getByTestId('block-row').filter({ hasText: 'stillHere' }).click()
    await page.keyboard.press('ArrowRight') // list -> diff

    const otherTasks = page.getByTestId('claude-other-tasks')
    await expect(otherTasks).toBeVisible()
    const row = page.getByTestId('claude-task-row').filter({ hasText: 'wat betekent dit precies?' })
    await expect(row).toBeVisible()

    await row.click()

    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
    const selected = page.getByTestId('claude-selected-line').first()
    await expect(selected).toBeVisible()
    await expect(selected).toContainText('wat betekent dit precies?')
    await expect(page.url()).toContain('sel=chat%3A' + CHATANCHOR_COMMENT_ID)

    const staleBadge = selected.getByTestId('comment-stale-anchor')
    await expect(staleBadge).toBeVisible()
    await expect(staleBadge).toContainText('verouderd')
  } finally {
    await page.request.post('/api/workflows/' + chatRunId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})

// "Opgeruimd zodra bekeken en zonder vervolg" — the reviewer's own product
// decision (a middle ground between "always show" and "never show"):
// reuses the EXACT SAME rule otherClaudeChatsAll already applies to every
// other chat (isChatSeenAndAnswered — chatStateOf === 'seen' AND an answer
// was ever given), now also gating chatItems' orphan bypass
// (recomputeLeftList, home.mjs) — no second mechanism. Once such an orphan
// chat-only conversation has settled, it quietly drops out of BOTH the
// "Openstaande chats" sidebar section and "Andere chats in deze PR".
test('an orphaned chat-only row is dropped once it is seen and answered, from both lists', async ({ page }) => {
  const commentId = CHATANCHOR_COMMENT_ID
  const chat = await page.request.post('/api/workflows/claude_chat', { data: { pr: CHATANCHOR_PR, commentId } })
  const chatRunId = (await chat.json()).runId
  expect(chatRunId).toBeTruthy()

  try {
    const signalRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
      data: { author: 'reviewer', body: 'is dit expres zo?' },
    })
    expect(signalRes.ok()).toBe(true)

    // Wait for the real, stored reply (the offline `claude` stub answers
    // fast — see claude-chat-other-tasks.spec.mjs's own doc comment) —
    // "answered" (otherTaskAnswered) needs an actual assistant message in
    // the transcript.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/chat?commentId=' + commentId)
        const json = await res.json()
        return (json.messages || []).some((m) => m.role === 'assistant')
      })
      .toBe(true)

    // The durable "seen" Signal — same one scheduleChatSeenDwell fires after
    // a real 5s dwell in the UI, driven directly here so the test doesn't
    // need to wait on that timer.
    const seenRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
      data: { action: 'seen' },
    })
    expect(seenRes.ok()).toBe(true)

    await page.goto('/pr/' + CHATANCHOR_PR)
    await leaveSearchBox(page)

    // Not under "Openstaande chats" at all — the section itself only exists
    // for a chatOnly row, and this was the only one in this fixture.
    await expect(page.getByTestId('open-chats-heading')).toHaveCount(0)

    // Not in "Andere chats in deze PR" either, from the stillHere block's
    // own footer (see the jump test above for why one ArrowRight is enough).
    await page.getByTestId('block-row').filter({ hasText: 'stillHere' }).click()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('claude-task-row').filter({ hasText: 'is dit expres zo?' })).toHaveCount(0)
    await expect(page.getByTestId('claude-other-tasks')).toHaveCount(0)
  } finally {
    await page.request.post('/api/workflows/' + chatRunId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})

// The `?sel=chat:<id>` refresh gap: applyBlockRefRestore used to route only
// 'comment:'/'testclass:' refs — a 'chat:' ref (the URL a chatOnly row's own
// selection writes, see state.blockRef's `b.kind === 'comment' ? b.id : …`)
// fell through to the plain-block branch, which requires `b.kind !==
// 'comment'` and so could never match. A manually selected "Openstaande
// chats" row therefore lost its selection on every refresh.
test('a manually selected orphaned chat-only row survives a refresh', async ({ page }) => {
  const commentId = CHATANCHOR_COMMENT_ID
  const chat = await page.request.post('/api/workflows/claude_chat', { data: { pr: CHATANCHOR_PR, commentId } })
  const chatRunId = (await chat.json()).runId
  expect(chatRunId).toBeTruthy()

  try {
    const signalRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
      data: { author: 'reviewer', body: 'blijft dit zo bestaan na een refresh?' },
    })
    expect(signalRes.ok()).toBe(true)

    await page.goto('/pr/' + CHATANCHOR_PR)
    await leaveSearchBox(page)

    await expect(page.getByTestId('open-chats-heading')).toBeVisible()
    const row = page.locator('[data-testid="open-chats-heading"] ~ [data-testid="block-row"]').first()
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.url()).toContain('sel=chat%3A' + commentId)

    await page.reload()
    await leaveSearchBox(page)

    await expect(page.url()).toContain('sel=chat%3A' + commentId)
    // The restored selection really landed on this row's own conversation,
    // not merely an echoed URL — same "Selected: …" + badge check as the
    // jump tests above. Two ArrowRights, same as open-chats-index.spec.mjs's
    // own chatOnly row (the first reveals the drilled anchor's highlight,
    // the second lands in the composer — "no comment-thread step").
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
    const selected = page.getByTestId('claude-selected-line').first()
    await expect(selected).toContainText('blijft dit zo bestaan na een refresh?')
    await expect(selected.getByTestId('comment-stale-anchor')).toContainText('verouderd')
  } finally {
    await page.request.post('/api/workflows/' + chatRunId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
