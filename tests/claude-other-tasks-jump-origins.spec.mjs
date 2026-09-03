import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression: jumpToClaudeConversation (home.mjs) — the Enter/click action of
// an "Andere chats in deze PR" row — is a best-effort dispatcher over several
// very different origins a chat can have been started from (see
// .claude/docs/claude-chat-panel.md). Two of those origins turned out to be
// dead ends: clicking the row silently did nothing.
//
// 1. The general (PR-wide, code-less) chat — its anchor comment carries a
//    truthy `kind` ('issue', the plain PR-wide comment shape, see
//    isGeneralChatAnchor/openChatComments), so jumpToClaudeConversation took
//    the jumpToCommentRow('comment:'+id) branch. But a general-chat anchor is
//    deliberately EXCLUDED from indexComments/commentBlockItem
//    (isChatAnchorPlaceholder) — it only ever gets a 'chat:'-prefixed row
//    (chatBlockItem) — so that ref never resolved.
// 2. A comment anchored to a real, changed PR block that has no place of its
//    own in state.blocks (a resolved-method-call target reachable only as an
//    Onderliggende-code child, see jumpToBlockOwnPlace's own doc comment) —
//    openTask only ever searched state.blocks/a test_class row's methods, so
//    it silently gave up.

// Both conversations are seeded through the workflow API directly (same
// pattern as claude-chat-other-tasks.spec.mjs) rather than built up live
// through several UI actions in sequence: the panel's own doubly-nested
// "Andere chats in deze PR" toggle (comment-claude-footer wrapping
// claude-other-tasks wrapping its own row list) only settles cleanly across
// ONE genuine 0->1 transition — chaining several live state changes first
// (posting a comment through the composer, opening/closing the general-chat
// overlay, entering Claude) flips it back and forth and can wedge the nested
// row list empty even once the underlying data has long since settled to 1
// (a separate, deeper arrow.js rendering gap, not this fix's own bug — see
// "A triple-nested toggle can wedge the innermost keyed list empty" in
// .claude/docs/claude-chat-panel.md).
test('jump to the general chat from "Andere chats in deze PR" opens its overlay', async ({ page }) => {
  const ANCHOR_BODY = '(Nog geen eigen comment getypt — gesprek met Claude gestart.)'
  // The general chat's own anchor — the exact shape startPrGeneralChat itself
  // creates (kind 'issue', no file, the fixed placeholder body, local). No
  // real turn needed: isGeneralChatAnchor makes it show up in "Andere chats"
  // the moment it EXISTS (see openChatComments' own doc comment).
  const general = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file: '', line: 0, author: 'reviewer', body: ANCHOR_BODY, kind: 'issue', source: 'ui', local: true },
  })
  expect((await general.json()).runId).toBeTruthy()

  // An ordinary inline comment on a real block/line — the conversation that
  // will be "in view" while the general chat shows up as an "other" row.
  const inline = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Actions/CreatePaymentAction.php',
      label: 'CreatePaymentAction::findOrCreateCustomer',
      line: 40,
      author: 'reviewer',
      body: 'is dit de juiste aanpak?',
      kind: '',
      source: 'ui',
      local: true,
    },
  })
  expect((await inline.json()).runId).toBeTruthy()

  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)

  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('ArrowRight') // diff -> comment head (hasVisibleComments())
  await page.keyboard.press('ArrowRight') // comment -> claude
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

  const otherTasks = page.getByTestId('claude-other-tasks')
  await expect(otherTasks).toBeVisible()
  // otherTaskTitleFor falls back to chatTaskTitle (the anchor comment's own
  // body) while no real turn has been fetched yet — the placeholder text,
  // not the "Algemene chat" label (that's only the SIDEBAR index row's own
  // title, chatBlockItem, unrelated to this panel row).
  const generalRow = page.getByTestId('claude-task-row').filter({ hasText: 'Nog geen eigen comment' })
  await expect(generalRow).toBeVisible()

  await generalRow.click()
  await expect(page.getByTestId('general-chat-overlay')).toBeVisible()
})

// PR 100 (tests/fixtures/arrow-blocks.json, see call-arrows.spec.mjs):
// ArrowCallerAction::execute is the only top-level block; the changed
// definition it calls, ArrowHelperService::arrowHelper, is a resolved-call
// child with no place of its own in state.blocks — reachable only by
// drilling into "Onderliggende code" from the caller.
test('jump to a chat anchored on a drilled-only Onderliggende-code child lands on its code and thread', async ({
  page,
}) => {
  await page.goto('/pr/100')
  await expect(page.getByTestId('block-row')).toHaveCount(1)
  await leaveSearchBox(page)

  // A real comment (and thus a jumpable "Andere chats" row) anchored
  // directly on the drilled-only child — created through the workflow API
  // like comment-first-group-fallback.spec.mjs's own PR-100 fixture reuse,
  // since there is no on-screen composer for a block outside the index.
  const res = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 100,
      file: 'app/Services/ArrowHelperService.php',
      label: 'ArrowHelperService::arrowHelper',
      line: 7,
      author: 'reviewer',
      body: 'kan dit korter?',
      source: 'ui',
      local: true,
    },
  })
  const runId = (await res.json()).runId
  expect(runId).toBeTruthy()

  // A real turn on THIS conversation (not the caller's, held below) — same
  // two-step POST/signal ensureAndLoadChat/sendClaudeMessage do from the UI
  // — so it lands in cc.conversations (otherClaudeChatsAll's own source for
  // a conversation that isn't currently running) and the panel shows it as
  // an "other" row from the very first render, no live toggle needed.
  const chat = await page.request.post('/api/workflows/claude_chat', { data: { pr: 100, commentId: runId } })
  const chatRunId = (await chat.json()).runId
  expect(chatRunId).toBeTruthy()
  const signalRes = await page.request.post('/api/workflows/' + chatRunId + '/signals/message', {
    data: { author: 'reviewer', body: 'kan dit korter, leg uit' },
  })
  expect(signalRes.ok()).toBe(true)

  try {
    // Hold the Signal POST open so this conversation reads as "busy" without
    // needing a real transcript — same trick claude-chat-other-tasks.spec.mjs
    // uses for its own "elsewhere" row.
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    await page.route('**/signals/message', async (route) => {
      await held
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"signalled"}' })
    })

    await page.goto('/pr/100')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // execute's diff
    await page.keyboard.press('Enter') // block command palette
    await page.getByTestId('command-row').filter({ hasText: 'Chat over deze regel' }).click()
    const compose = page.getByTestId('claude-chat-compose')
    await expect(compose).toBeFocused()
    await compose.fill('leg dit uit')
    await compose.press('Enter') // held above -> stays "busy" for the rest of the test

    const otherTasks = page.getByTestId('claude-other-tasks')
    await expect(otherTasks).toBeVisible()
    const row = page.getByTestId('claude-task-row').filter({ hasText: 'kan dit korter, leg uit' })
    await expect(row).toBeVisible()
    await row.click()

    // Landed on the child's own drilled column: its code is visible, the
    // top-level rail for the (unrelated, previously selected) caller block is
    // hidden, and the keyboard sits in the anchor's own Claude composer.
    await expect(page.getByTestId('drill-column').filter({ hasText: 'arrowHelper' })).toBeVisible()
    await expect(page.getByTestId('comment-item').filter({ hasText: 'kan dit korter?' })).toBeVisible()
    await expect(page.getByTestId('claude-chat-compose')).toBeFocused()

    release()
  } finally {
    await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
