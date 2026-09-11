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

// An unanchored comment-index item (an AI-controle finding, any other PR-wide
// comment, an orphan) shows the ORDINARY right-hand Claude column, exactly as a
// block-scoped comment does — reviewer request: "ik wil hetzelfde blokje zien
// als normaal rechts. Bij alle algemene comments en ai waarschuwingen." The
// column is on screen for as long as such an item is selected
// (isPrCommentScope → claudeChatVisible, RelatedPanel.mjs); "Chat met Claude"
// (prCommentCommandsFor, home.mjs) only ensures the Execution and focuses its
// composer, since the item has no code context to reach it via → (see
// claude-chat-panel.md's "chain, key by key"). It replaced an embedded second
// copy inside the item's own detail card (the `pcc` toggle) — one chat, one
// surface. See ".claude/docs/claude-chat-panel.md" for the mechanism this
// reuses (chatAnchorComment's `s.prComment` branch,
// syncClaudeAnchorForSelection).
//
// The seeded comment must be a REAL backend record (not a mocked GET) —
// POST /api/workflows/claude_chat's own handler (handleClaudeChatStart,
// tasks_api.go) looks the commentId up in the real comments module and 400s
// with "unknown comment" otherwise, regardless of what /api/comments answers.

test('a PR-wide comment-index item shows the ordinary Claude column, and "Chat met Claude" round-trips a message', async ({
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

  // The Claude column is simply THERE, next to the item — no command needed,
  // same card the block-scoped chat renders in.
  await expect(page.getByTestId('claude-chat-card')).toBeVisible()
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeVisible()
  // ...and the comment-detail card now renders INSIDE this same column
  // (isPrCommentScope's own slot in InlineComments) instead of a separate
  // block-column card next to it — the two merge into one visual block, see
  // "The comment-detail card moved into the merged comment-claude-row" in
  // comments-panel.md.
  await expect(page.getByTestId('inline-comments')).toBeVisible()
  await expect(page.getByTestId('inline-comments').getByTestId('comment-detail-card')).toBeVisible()

  // "Chat met Claude" now only ensures the Execution and focuses the composer.
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await menu.getByTestId('command-row').getByText('Chat met Claude', { exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(compose).toBeFocused()

  await compose.fill('Kan dit sneller?')
  await compose.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText(
    'Ik heb naar de code gekeken. Zal ik een aanpak voorstellen?',
  )
})

// Regression test for: "status van draaiende chat vraag moet onderin de blok
// staan, niet onderin de comment blokje" — CommentClaudeFooter's live-turn
// section ("Selected: …" + "Claude denkt na… · Ns" + Stop) rendered TWICE:
// once from home.mjs's own call (the wide comment-claude-row footer, below
// both columns) and once more from commentDetailCard's own internal call
// (the small PR-comment card itself), because commentDetailCard passed the
// comment's id into the very same, unrestricted CommentClaudeFooter — whose
// live-turn section reads the globally anchored conversation regardless of
// that id. Fixed with a `batchOnly` flag on the commentDetailCard call (see
// "The menu button … and the shared comment/Claude footer" in
// .claude/docs/comments-panel.md). Driven via a mocked chat.progress SSE
// frame, same technique as claude-chat-panel.spec.mjs's own "navigating away
// hides it" test, so the "still running" window is deterministic.
test('a running Claude turn on a PR-comment item shows its status once, not also inside the small comment card', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
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
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
  let connections = 0
  await page.route('**/api/events*', async (route) => {
    connections++
    const body =
      connections === 1
        ? 'retry: 300\n\n'
        : 'retry: 300\n\n' +
          frame({
            type: 'chat.progress',
            pr,
            key: conversationId,
            seq: 1,
            data: { running: true, phase: 'thinking', startedAt: Date.now() - 1000, updatedAt: Date.now() },
          })
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    })
  })
  await page.route('**/api/chat/progress*', (route) => {
    const running = { running: true, phase: 'thinking', startedAt: Date.now() - 1000, updatedAt: Date.now() }
    const perPR = new URL(route.request().url()).searchParams.get('commentId') === null
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        perPR ? { ok: true, running: { [conversationId]: running } } : { ok: true, running: true, progress: running },
      ),
    })
  })

  try {
    await page.goto('/pr/' + pr)
    await leaveSearchBox(page)
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    // The live status shows exactly once, in the wide footer below both
    // columns — never a second time inside the small comment card itself.
    await expect(page.getByTestId('claude-chat-status')).toHaveCount(1)
    await expect(page.getByTestId('claude-chat-status')).toContainText('Claude denkt na')
    await expect(page.getByTestId('comment-detail-card').getByTestId('claude-chat-status')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card').getByTestId('claude-selected-line')).toHaveCount(0)
    await expect(page.getByTestId('comment-detail-card').getByTestId('comment-claude-footer-claude')).toHaveCount(0)
  } finally {
    await deleteCommentBestEffort(page, conversationId)
  }
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
  // By label, not by raw index — see "Sort order of the left list" in
  // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
  // real changed row.
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

  // A block-scoped comment on the real selected block — clicking it sets
  // cs.focus === 'comment'.
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
    // The PR-wide section now sorts right above "Comments op regels" (rank
    // 2.4), so the block-scoped comment seeded above can be its immediate
    // NEXT sidebar row — the look-ahead preview then also renders a (dimmed)
    // comment-detail-card for that one. `.first()` is the selected/focused
    // one (see commentDetailCard's own `preview` styling).
    await expect(page.getByTestId('comment-detail-card').first()).toBeVisible()

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

// The → chain reaches that same column: reviewer request "ik wil hier naar
// rechts kunnen drukken, dan moet ik naar de chat kunnen gaan" — a selected
// comment-index item used to dead-end after ONE → (into its own thread, the
// pct cursor), because home.mjs only routed ↑/↓/← there and the generic
// ArrowRight branch's own `!isPrCommentThreadFocused(sc)` guard then made the
// second → a silent no-op. Now the second → steps into the Claude column
// (stop 5b), exactly like the block-scoped 'thread' + → does, and ← steps
// straight back into the thread (never via the 'comment' level, which does
// not exist for such an item — its comment column is `hidden`). See
// handlePrCommentThreadKey / handleRelatedKey's 'claude' branch.
test('→ steps from a PR-comment item into its thread and on into the Claude chat, ← comes back', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
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
  const card = page.getByTestId('comment-detail-card')
  await expect(card).toBeVisible()

  // Reviewer request: "ik wil dat de chat alleen geselecteerd is als ik het
  // ook echt selecteer door naar rechts te gaan... de border moet een color
  // krijgen als ik naar rechts ga, niet daarvoor". Plain ↑/↓ selection (this
  // item is already the sidebar selection at this point) must NOT paint the
  // card's border indigo yet — only an actual → does.
  await expect(card).not.toHaveClass(/border-indigo-300/)
  await expect(card).toHaveClass(/border-slate-300/)

  const thread = page.getByTestId('comment-detail-thread')
  const compose = page.getByTestId('claude-chat-compose')

  // First → : into the item's own thread (the ring on the thread container is
  // the only visible signal at the rest position pct.pos === 0). The card's
  // own border now turns indigo too, since the keyboard has genuinely
  // entered it.
  await page.keyboard.press('ArrowRight')
  await expect(thread).toHaveClass(/ring-2/)
  await expect(compose).not.toBeFocused()
  await expect(card).toHaveClass(/border-indigo-300/)

  // Second → : on into the Claude column, and the thread ring hands off so
  // only one thing reads as focused — at this (default, narrow) viewport the
  // comment half goes READ-ONLY once Claude owns the keyboard (see
  // "Read-only, not a rail" in .claude/docs/comments-panel.md): the thread
  // stays visible (still readable), it just no longer carries the ring/
  // focus styling, and its card is marked data-readonly="true".
  await page.keyboard.press('ArrowRight')
  await expect(compose).toBeFocused()
  await expect(thread).not.toHaveClass(/ring-2/)
  await expect(page.getByTestId('comment-detail-card')).toHaveAttribute('data-readonly', 'true')

  // ← : straight back into the thread, not onto an invisible 'comment' level.
  await page.keyboard.press('ArrowLeft')
  await expect(thread).toHaveClass(/ring-2/)
  await expect(compose).not.toBeFocused()

  // ...and → still works from there, so the two are a real round trip.
  await page.keyboard.press('ArrowRight')
  await expect(compose).toBeFocused()
})
