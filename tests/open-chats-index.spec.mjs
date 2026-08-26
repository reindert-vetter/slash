import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Openstaande chats" (home.mjs's openChatComments/chatBlockItem,
// BlockList.mjs's openChatsHeading/chatUnreadIcon) — a comment with an
// existing Claude conversation that has no index row of its own anywhere
// else. Here: a bare "Chat over deze regel" anchor (CLAUDE_ANCHOR_PLACEHOLDER
// body, never taken over by the reviewer's own reply) — indexComments()
// deliberately never gives such a comment a row (see comments-panel.md), so
// without this section its already-answered conversation would be
// unreachable from the sidebar at all.
//
// Mocked against the real anchor PR 12903 (needs a genuinely ingested block
// for commentAnchorBlock to resolve — a bare seeded PR has no blocks at
// all), same shape as comment-anchor-expanded-view.spec.mjs's
// mockAnchoredComment.
//
// Covers three things end to end: the row appears exactly once, a second
// ArrowRight from it lands straight in the Claude composer (skipping the
// comment-thread step entirely — there is no real comment to show), and the
// blue-eye unread indicator — backed by the DURABLE
// chat_conversations.seen_at column, see chat_workflow.go's "seen" Signal
// action — disappears once the conversation is actually opened. The
// module-level round trip for seen_at itself (the truly novel,
// regression-sensitive part) is covered by Go tests instead (modules/chat's
// TestSeenAt, chat_workflow_test.go's TestClaudeChatSeenSignalStampsSeenAt) —
// this is the one frontend-wiring check, kept to a single mocked spec per
// "prefer a quick, targeted test over a slow e2e one".
const FILE = 'app/Http/Controllers/Api/ContractController.php'
const LABEL = 'ContractController::index'
const COMMENT_ID = 'anchor-chat-1'
const ANCHOR_BODY = '(Nog geen eigen comment getypt — gesprek met Claude gestart.)'

test('a bare chat anchor with no comment row of its own shows under "Openstaande chats", unread until opened', async ({
  page,
}) => {
  const now = new Date().toISOString()
  const comment = {
    id: COMMENT_ID,
    runId: 'run-' + COMMENT_ID,
    pr: 12903,
    file: FILE,
    label: LABEL,
    line: 30,
    author: 'reviewer',
    body: ANCHOR_BODY,
    createdAt: now,
    reactionCount: 0,
    status: 'open',
    source: 'ui',
    kind: '',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
  }
  await page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([comment]) }),
  )

  let seenAt = ''
  let seenSignalled = false
  const messages = [
    { id: 'm-user', conversationId: COMMENT_ID, role: 'user', body: 'Kun je hier iets over zeggen?', createdAt: now },
    {
      id: 'm-assistant',
      conversationId: COMMENT_ID,
      role: 'assistant',
      body: 'Ik heb naar de code gekeken.',
      createdAt: now,
    },
  ]

  await page.route('**/api/chat?pr=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, conversations: [COMMENT_ID], seenAt: seenAt ? { [COMMENT_ID]: seenAt } : {} }),
    }),
  )
  await page.route('**/api/chat?commentId=' + COMMENT_ID + '*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, messages, summary: '', summaryStatus: '', seenAt }),
    }),
  )
  await page.route('**/api/chat/progress*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, running: false }) }),
  )
  await page.route('**/api/workflows/claude_chat', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'chat-' + COMMENT_ID }) }),
  )
  await page.route('**/signals/message', async (route) => {
    const body = route.request().postDataJSON()
    if (body && body.action === 'seen') {
      seenSignalled = true
      seenAt = new Date().toISOString()
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
  })

  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  await expect(page.getByTestId('open-chats-heading')).toBeVisible()
  // The one row directly under the heading — not matched by text, since a
  // fresh comment_titles run could replace the label with a generated title
  // unrelated to the raw placeholder body.
  const row = page.locator('[data-testid="open-chats-heading"] ~ [data-testid="block-row"]').first()
  await expect(row).toBeVisible()
  await expect(row.getByTestId('chat-unread-icon')).toBeVisible()

  await row.click()
  await page.keyboard.press('ArrowRight') // reveals the drilled anchor's highlight
  await page.keyboard.press('ArrowRight') // straight into the chat — no comment-thread step
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  await expect(page.getByTestId('reaction-compose')).toHaveCount(0)
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')

  await expect.poll(() => seenSignalled).toBe(true)

  // A fresh reload now sees the (mocked) durable seenAt and no longer shows
  // the unread icon.
  await page.reload()
  await leaveSearchBox(page)
  const rowAfter = page.locator('[data-testid="open-chats-heading"] ~ [data-testid="block-row"]').first()
  await expect(rowAfter).toBeVisible()
  await expect(rowAfter.getByTestId('chat-unread-icon')).toHaveCount(0)
})
