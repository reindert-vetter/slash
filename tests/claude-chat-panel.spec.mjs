import { test, expect, seededPr, evaluateSettled, leaveSearchBox } from './_fixtures.mjs'

// Verifies the embedded Claude conversation column (claude_chat workflow,
// see .claude/docs/comments-panel.md's "Embedded Claude chat" section):
// it renders as its own column next to the comment thread, → deepens one
// level further from an existing thread into it, a plain message round-trips
// through the fake claude backend (SLASH_CLAUDE_CHAT_TURNS, see
// _fixtures.mjs), a "question with choices" turn renders its option buttons,
// choosing one both records the answer and continues the conversation.
// The two separate agentic-action buttons ("Bewerk code"/"Commit wijziging")
// are gone — see .claude/docs/claude-chat-panel.md's "Triggering agentic
// actions" for what that leaves unreachable from the UI, and why "every turn
// gets the wider bereik" was NOT implemented as a bare frontend default.
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

  // A SECOND, later comment thread on the exact same unit (same file+label,
  // same "call" scope) — the context sent on the first Claude turn must fold
  // in BOTH threads (see claudeThreadContextBlock, RelatedPanel.mjs), ordered
  // chronologically with this one (created after the first) marked as the
  // most recent.
  const start2 = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'graag ook een early return toevoegen',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start2.json()).runId).toBeTruthy()

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

  // The comment card it hangs on stays expanded — not collapsed back to
  // compact — now that the keyboard sits on the Claude column: the merged
  // comment-claude-row card (home.mjs) shows both halves at once (see
  // commentCard in RelatedPanel.mjs).
  await expect(item).toHaveAttribute('data-expanded', 'true')

  // First turn: a plain text reply (see tests/fixtures/claude-chat-turns.json).
  // .first() is the reviewer's own just-sent message; the assistant's reply
  // is the second bubble (threadMessages ordering: user turn, then reply).
  //
  // The FIRST turn's invisible context must fold in BOTH already-written
  // comments on this unit (claudeThreadContextBlock, RelatedPanel.mjs),
  // chronologically, with the later one ("early return") marked as the most
  // recent — never dumped unordered, per Reindert's explicit request.
  await composer.fill('Kun je hier iets over zeggen?')
  const [firstMsgReq] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    composer.press('Enter'),
  ])
  const firstContext = firstMsgReq.postDataJSON().context
  expect(firstContext).toContain('kan dit sneller?')
  expect(firstContext).toContain('graag ook een early return toevoegen')
  expect(firstContext.indexOf('kan dit sneller?')).toBeLessThan(firstContext.indexOf('graag ook een early return'))
  expect(firstContext).toMatch(/graag ook een early return toevoegen.*meest recent/s)
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

  // Neither agentic action has a UI trigger left at all (both buttons and the
  // commit confirm menu are gone) — the composer sends every turn with the
  // plain, tool-less `action: ''` (see sendClaudeMessage's own doc comment in
  // RelatedPanel.mjs for why that default was NOT widened to 'edit', and
  // claude-chat-panel.md's "Triggering agentic actions" for the full,
  // explicitly flagged gap this leaves).
  await composer.fill('Nog een gewone vraag.')
  const [plainReq] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    composer.press('Enter'),
  ])
  expect(plainReq.postDataJSON().action).toBeFalsy()

  // ← steps back out of the chat straight onto the comment card it hangs on
  // (no more 'thread' stop in between).
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('reaction-compose')).toBeFocused()
})

// ↓ at the bottom of the Claude conversation (claudePos === 0) used to fall
// into the Onderliggende-code panel — an unwanted extra "menu" in the way of
// just continuing the review (explicit request). It now advances straight to
// the next visible block's diff instead, and — since the strict
// claudeChatVisible() invariant ties the Claude column to the comment column
// (visible ⟺ visible) — the just-left block's Claude/comment blocks are gone
// the moment the keyboard sits on a different, comment-less unit. Uses the
// shared PR 12903 fixture (real ingested blocks, see the test above), seeding
// the one comment it needs directly via the workflow API (mirrors
// related-nav.spec.mjs) and cleaning it up afterwards.
test('↓ at the bottom of the Claude chat advances to the next block, and the Claude/comment blocks disappear together', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'kan dit anders?', label, rowStart: -1, rowEnd: -1 },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()
  await expect
    .poll(async () => {
      const list = await (await page.request.get('/api/comments?pr=12903')).json()
      return list.some((x) => x.runId === runId)
    })
    .toBe(true)

  try {
    // Reload so the comment is present from the start (avoids racing the
    // frontend's own poll cadence, same as related-nav.spec.mjs).
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> the comment conversation
    await page.keyboard.press('ArrowRight') // comment -> claude
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()

    await composer.fill('Kun je hier iets over zeggen?')
    await composer.press('Enter')
    await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
    await expect(composer).toBeFocused() // still claudePos === 0

    await page.keyboard.press('ArrowDown')

    // Landed on the NEXT visible block's diff, not on Onderliggende code —
    // the panel released the keyboard entirely (relatedActive() is false), and
    // the block column now shows a DIFFERENT block than the one the chat hung
    // off (its h2 label no longer matches `label`).
    await expect(page.locator('[data-idx="2"]')).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('related-item')).toHaveCount(0)
    await expect(card).not.toContainText(label)

    // Block 2 carries no comment of its own, so BOTH the comment column and
    // the Claude column are gone together — never one without the other.
    await expect(page.getByTestId('comment-item')).toHaveCount(0)
    await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)
  } finally {
    await page.request.post('/api/workflows/' + runId + '/signals/delete', {
      data: { author: 'reviewer' },
    })
  }
})

// Composing a brand-new "Comment op deze regel" (cs.focus === 'new') shows
// the Claude column right away, before any comment genuinely exists on the
// backend — see "Optimistically visible while composing a brand-new comment"
// in claude-chat-panel.md. Sending Claude a message lazily creates the ONE
// backing comment (local, with a placeholder body since nothing was typed
// yet); "Plaats…" afterwards must not create a SECOND one — it updates the
// same anchor via a reply instead (ensureClaudeAnchorForNew/placeComment,
// RelatedPanel.mjs). Uses the shared PR 12903 fixture (real ingested blocks
// are needed to reach a block's own command palette — a seededPr() PR has
// none, see comment-delete.spec.mjs), and cleans up the one real comment it
// creates via the same delete Signal deleteComment itself uses, so no state
// leaks into another spec sharing that PR.
test('composing a new comment: the Claude column shows before it is placed, and a first Claude message lazily creates the ONE backing comment', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)
  // Block 0 has no local diff to step into (see place-comment-return-focus.
  // spec.mjs) — block 1 does, and (per that same spec + comment-nav-race.
  // spec.mjs, both of which mock the POST) carries no real comment yet.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  await expect(page.getByTestId('comment-item')).toHaveCount(0)
  await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)

  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()

  // The Claude column is visible right away, next to the still-unplaced,
  // still-empty composer — before any comment exists on the backend at all.
  await expect(page.getByTestId('claude-chat-column')).toBeVisible()
  await expect(page.getByTestId('comment-item')).toHaveCount(0)

  // Send Claude a message WITHOUT having typed anything into the "Comment op
  // deze regel" field yet — the lazy anchor falls back to
  // CLAUDE_ANCHOR_PLACEHOLDER for its body.
  const claudeComposer = page.getByTestId('claude-chat-compose')
  await claudeComposer.fill('Wat doet deze functie?')
  const [createRes, firstMsgReq] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
    claudeComposer.press('Enter'),
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  try {
    // Sending to Claude lazily created the ONE backing comment.
    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('Nog geen eigen comment getypt')
    // The Fake walks its programmed turn script with a cursor PER SESSION
    // (see claude.Fake.SetChatTurns), and this is a brand-new conversation,
    // so — like the file's first test — it sees the FIRST programmed reply,
    // no matter which other chat spec already ran on this worker's server.
    await expect(page.getByTestId('claude-message-body').last()).toContainText(
      'Ik heb naar de code gekeken',
    )

    // This conversation's FIRST turn invisibly carries the reviewer's
    // selection (file + the unit's code) as its own `context` field
    // (ChatMessageSignal.Context, chat_workflow.go's buildChatPrompt) —
    // `body` stays exactly what was typed, and so does the reviewer's own
    // rendered bubble, never mixed with the context block (see
    // claudeContextBlock in RelatedPanel.mjs).
    const firstPayload = firstMsgReq.postDataJSON()
    expect(firstPayload.body).toBe('Wat doet deze functie?')
    expect(firstPayload.context).toContain('Bestand:')
    expect(firstPayload.context).toContain('Voorbeeldcode:')
    await expect(page.getByTestId('claude-message-body').first()).toHaveText('Wat doet deze functie?')

    // A SECOND turn in the same conversation needs no context of its own —
    // the claude CLI's own --resume session already has it from the first
    // turn's prompt.
    await claudeComposer.fill('En dit stukje?')
    const [secondMsgReq] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/signals/message') && req.method() === 'POST'),
      claudeComposer.press('Enter'),
    ])
    expect(secondMsgReq.postDataJSON().context).toBeFalsy()

    // "Plaats…" must not start a SECOND comment next to it — it updates the
    // existing anchor via a reply instead.
    await composer.fill('Kun je dit uitleggen?')
    await page.getByTestId('comment-send').click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Plaats comment' }).click()
    await expect(menu).toBeHidden()

    await expect(item).toHaveCount(1) // still exactly one comment
    await item.click()
    await expect(page.getByTestId('comment-thread')).toContainText('Kun je dit uitleggen?')
  } finally {
    // Never leave this real, non-mocked comment behind on the shared PR
    // 12903 fixture (see place-comment-return-focus.spec.mjs for the same
    // leftover-state rationale).
    await page.request.post('/api/workflows/' + runId + '/signals/delete', {
      data: { author: 'reviewer' },
    })
  }
})

// → from the still-open, not-yet-placed "Comment op deze regel" composer
// (cs.focus === 'new') reaches the Claude composer directly, without an
// anchor comment existing yet — enterClaudeChatFromNew, see "→ reaches the
// Claude composer directly from the still-open 'new' field" in
// claude-chat-panel.md. Complements the caret-guard mechanics already covered
// by tests/comment-arrowright-caret.spec.mjs with the RelatedPanel-specific
// behaviour: nothing is created by the mere navigation, ←/Escape both return
// to the SAME still-open composer with its draft intact (toNewFocus,
// mirroring toComment()), and ↓ at the bottom of the (anchor-less) Claude
// conversation still advances to the next visible block exactly as it does
// for an already-anchored one — the draft simply survives via composeDrafts,
// same as leaving the composer any other way. Uses PR 12903 (real ingested
// blocks are needed to reach a block's own command palette).
test('→ from the still-open new-comment composer reaches Claude directly, with the draft surviving ←/Escape/↓', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()

  const draftText = 'Nog niet geplaatst, maar ik wil al met Claude praten'
  await composer.type(draftText)
  await expect(composer).toHaveValue(draftText)

  // Caret sits at the end after typing — → jumps straight into the Claude
  // composer, and nothing is created by this navigation alone.
  const claudeComposer = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await expect(claudeComposer).toBeFocused()
  await expect(page.getByTestId('comment-item')).toHaveCount(0)

  // ← returns to the SAME still-open composer, draft intact (toNewFocus) —
  // not toComment(), which would assume a comment already exists.
  await page.keyboard.press('ArrowLeft')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue(draftText)

  // Escape does the exact same thing as ← here.
  await page.keyboard.press('ArrowRight')
  await expect(claudeComposer).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue(draftText)

  // ↓ at the bottom of this still-anchor-less conversation is UNCHANGED: it
  // still advances to the next visible block's diff (not a no-op), per the
  // explicit reviewer decision to keep the existing behaviour.
  await page.keyboard.press('ArrowRight')
  await expect(claudeComposer).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-idx="2"]')).toHaveClass(/bg-indigo-50/)
  await expect(page.getByTestId('comment-item')).toHaveCount(0)
  await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)

  // The draft itself was never lost — composeDrafts survives leaving the
  // composer via ↓, exactly like leaving it any other way. Navigating back to
  // the original block (via the keyboard — the sidebar row is out of the
  // diff-mode viewport right now) and reopening "Comment op deze regel"
  // restores it.
  await page.keyboard.press('ArrowLeft') // diff -> list, still on block 2
  await page.keyboard.press('ArrowUp') // back to block 1
  await expect(page.locator('[data-idx="1"]')).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('ArrowRight') // list -> diff
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  await expect(composer).toHaveValue(draftText)
})

// A brand-new "Comment op deze regel" on a unit that ALREADY has a comment
// (with its own Claude conversation, complete with prior turns) must get its
// own, wholly separate comment + Claude block — never silently continue the
// existing conversation. Regression test for a bug where toNew()/
// ensureClaudeAnchorForNew (RelatedPanel.mjs) resolved "is there already an
// anchor here" via chatAnchorComment()/selComment(), which happily matched
// ANY existing comment on the unit, not just one this draft itself created —
// so opening a second, brand-new comment on an already-commented line kept
// showing (and appending to) the FIRST comment's Claude transcript instead of
// starting fresh. Uses PR 12903 (real ingested blocks, see the tests above).
test('a new comment on an already-commented line gets its own comment + Claude block, not the existing one', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line: 1, author: 'reviewer', body: 'kan dit anders?', label, rowStart: -1, rowEnd: -1 },
  })
  const runId1 = (await start.json()).runId
  expect(runId1).toBeTruthy()
  await expect
    .poll(async () => {
      const list = await (await page.request.get('/api/comments?pr=12903')).json()
      return list.some((x) => x.runId === runId1)
    })
    .toBe(true)

  let runId2 = null
  try {
    // Reload so the first comment is present from the start.
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff
    await page.keyboard.press('ArrowRight') // diff -> the (only) comment conversation
    await page.keyboard.press('ArrowRight') // comment -> claude

    // Give the FIRST comment's own conversation some real history — the exact
    // ingredient the bug ignored.
    const composer = page.getByTestId('claude-chat-compose')
    await expect(composer).toBeFocused()
    await composer.fill('Kun je hier iets over zeggen?')
    await composer.press('Enter')
    await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
    await expect(page.getByTestId('claude-message')).toHaveCount(2)

    // Back to the diff, then start a wholly new comment on the same line.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter') // block command palette
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    const newComposer = page.getByTestId('comment-compose')
    await expect(newComposer).toBeFocused()

    // The Claude column is visible right away (per "Optimistically visible
    // while composing a brand-new comment") — but it must show a FRESH, EMPTY
    // transcript, not the first comment's 2 existing messages.
    await expect(page.getByTestId('claude-chat-column')).toBeVisible()
    await expect(page.getByTestId('claude-chat-empty')).toBeVisible()
    await expect(page.getByTestId('claude-message')).toHaveCount(0)

    // Sending a message from here must create a SECOND, brand-new backing
    // comment — not reply onto the first one's thread.
    const claudeComposer = page.getByTestId('claude-chat-compose')
    await claudeComposer.fill('Nog een vraag over deze regel')
    const [createRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
      ),
      claudeComposer.press('Enter'),
    ])
    runId2 = (await createRes.json()).runId
    expect(runId2).toBeTruthy()
    expect(runId2).not.toBe(runId1)

    await expect(page.getByTestId('comment-item')).toHaveCount(2)

    // The first comment's OWN conversation still shows exactly its 2
    // original messages — untouched by the second draft's send.
    await page.getByTestId('comment-item').filter({ hasText: 'kan dit anders?' }).click()
    await page.keyboard.press('ArrowRight') // comment -> claude
    await expect(page.getByTestId('claude-message')).toHaveCount(2)
    await expect(page.getByTestId('claude-message-body').last()).not.toContainText('Nog een vraag')
  } finally {
    await page.request.post('/api/workflows/' + runId1 + '/signals/delete', {
      data: { author: 'reviewer' },
    })
    if (runId2) {
      await page.request.post('/api/workflows/' + runId2 + '/signals/delete', {
        data: { author: 'reviewer' },
      })
    }
  }
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
      { id: 'm3', role: 'assistant', kind: 'draft_reply', body: 'Concept: dit endpoint is niet meer in gebruik.' },
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
  const draftBadge = host.getByTestId('claude-message-draft-reply')
  await expect(draftBadge).toBeVisible()
  await expect(draftBadge).toContainText('concept in comment-veld gezet')

  // Neither badge is present on a plain assistant turn.
  await evaluateSettled(page, async () => {
    const { claudeChatColumn } = await import('/src/ClaudeChat.mjs')
    const messages = [{ id: 'm4', role: 'assistant', body: 'Gewoon een antwoord.' }]
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
  await expect(plainHost.getByTestId('claude-message-draft-reply')).toHaveCount(0)
})

// A comment_action "reply" directive must land in the LEFT comment thread's
// own reply composer for the reviewer to edit and send themselves — never
// post itself. Driving the real claude subprocess would again need the
// comment's run id known before the SLASH_CLAUDE_CHAT_TURNS fixture file
// loads (see the badge test above), so this drives the same effect through
// GET /api/chat, mocked to return a chat.KindDraftReply turn — exactly the
// shape chat_workflow.go's saveChatDraftReply persists, and exactly what
// RelatedPanel.mjs's applyPendingDraftReplies (the code under test) reads.
// The backend's own "reply never signals the comment thread" guarantee is
// covered separately, end-to-end, by
// TestClaudeChatCommentActionDraftsReplyWithoutTouchingCommentThread in
// chat_workflow_test.go.
test('Claude chat: a drafted reply lands in the comment composer, appended under an existing draft, never auto-posted', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'is dit nog in gebruik?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const conversationId = (await start.json()).runId
  expect(conversationId).toBeTruthy()

  const draftBody = 'Concept van Claude: dit endpoint wordt niet meer aangeroepen.'
  await page.route('**/api/chat?commentId=' + conversationId, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [{ id: 'draft-1', role: 'assistant', kind: 'draft_reply', body: draftBody }] }),
    }),
  )

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  // The reviewer's own half-typed reply must survive, with Claude's draft
  // appended underneath it — never overwritten, never discarded.
  const reply = page.getByTestId('reaction-compose')
  await expect(reply).toBeVisible()
  await reply.fill('Eigen tekst die ik al had getypt.')

  await page.keyboard.press('ArrowRight') // comment -> claude, which loads /api/chat (mocked above)
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()

  await expect(reply).toHaveValue('Eigen tekst die ik al had getypt.\n\n' + draftBody)

  // It never became a real reply on the comment thread itself — only the
  // reviewer's own opening comment shows as a bubble.
  await expect(page.getByTestId('reaction-bubble')).toHaveCount(1)
})

// The composer grows in height as its content grows (textareaAutoGrow.mjs,
// shared with the comment composers in RelatedPanel.mjs — see
// .claude/docs/claude-chat-panel.md's "Auto-grow composer textareas"), and
// "Stuur" sits BESIDE it (`flex items-end gap-2`, same row, same pattern as
// the comment thread's own reaction-compose/reaction-send — see "The
// embedded Claude chat column" in .claude/docs/detail-layout.md), not
// stacked below it. A direct-mount unit test, same pattern as the badge test
// above.
test('Claude chat composer grows with multi-line content and resets after sending', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('pr-index')).toBeVisible()

  await evaluateSettled(page, async () => {
    const { claudeChatColumn } = await import('/src/ClaudeChat.mjs')
    const view = {
      messages: () => [],
      status: () => 'ready',
      busy: () => false,
      progress: () => null,
      elapsed: () => 0,
      claudePos: () => 0,
    }
    const host = document.createElement('div')
    host.id = 'claude-chat-grow-host'
    document.body.appendChild(host)
    claudeChatColumn(view, { onSend: () => {} })(host)
  })

  const host = page.locator('#claude-chat-grow-host')
  const composer = host.getByTestId('claude-chat-compose')
  const send = host.getByTestId('claude-chat-send')

  // "Stuur" sits beside the composer (same row, bottom-aligned), not below it.
  const composerBox = await composer.boundingBox()
  const sendBox = await send.boundingBox()
  expect(sendBox.x).toBeGreaterThanOrEqual(composerBox.x + composerBox.width - 1)
  expect(Math.abs(sendBox.y + sendBox.height - (composerBox.y + composerBox.height))).toBeLessThan(2)

  const startHeight = composerBox.height
  await composer.fill('regel een\nregel twee\nregel drie\nregel vier\nregel vijf')
  await expect(async () => {
    const grownBox = await composer.boundingBox()
    expect(grownBox.height).toBeGreaterThan(startHeight)
  }).toPass()

  await composer.press('Enter')
  await expect(async () => {
    const resetBox = await composer.boundingBox()
    expect(resetBox.height).toBe(startHeight)
  }).toPass()
})

// "Wis Claude-gesprek" (chat_workflow.go's chatActionClear): a command-palette
// item, confirm-gated (two Enters, mirroring "Keur de HELE PR goed"'s own
// REVIEW_APPROVE_CONFIRM_COMMANDS submenu), reachable only while the composer
// is NOT the focused element (claudePos > 0 — see focusClaudeComposer) so a
// plain Enter on the composer itself keeps sending/newlining as before.
test('Wis Claude-gesprek: confirm-gated command palette clears the transcript', async ({ page }, testInfo) => {
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
  await page.keyboard.press('ArrowRight') // comment -> claude
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  await composer.fill('Kun je hier iets over zeggen?')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  await expect(page.getByTestId('claude-message')).toHaveCount(2)

  // Enter while the composer is still the focused element must NOT open the
  // menu — it's the ordinary send/newline key there.
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  // Step up into the transcript — blurs the composer (focusClaudeComposer) —
  // before Enter is free to open the Claude-scoped menu.
  await page.keyboard.press('ArrowUp')
  await expect(composer).not.toBeFocused()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('command-row').filter({ hasText: 'Wis Claude-gesprek' })).toBeVisible()

  // First Enter opens the confirm submenu, not the clear itself — the
  // transcript must still be there.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-row').filter({ hasText: 'Ja, wis dit gesprek' })).toBeVisible()
  await expect(page.getByTestId('claude-message')).toHaveCount(2)

  // Second Enter (the confirm step) actually clears it.
  await page.keyboard.press('Enter')
  await expect(menu).not.toBeVisible()
  await expect(page.getByTestId('claude-chat-empty')).toBeVisible()
  await expect(page.getByTestId('claude-message')).toHaveCount(0)
})

// A just-sent message must stay in view, and must STAY in view once the live
// progress line disappears again — regression for a bug where a newly
// appended bubble landed below the fold of claude-chat-thread's own
// overflow-auto (nothing ever moved that div's scrollTop) and stayed there
// even after the turn finished. `max-height` is forced small via an injected
// style so the thread overflows deterministically regardless of how short
// the fixture replies are.
test('a just-sent Claude message scrolls into view and stays there once the turn finishes', async ({ page }, testInfo) => {
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
  await page.addStyleTag({ content: '[data-testid="claude-chat-thread"] { max-height: 90px !important; }' })
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()
  await page.keyboard.press('ArrowRight') // comment -> claude
  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()
  const thread = page.getByTestId('claude-chat-thread')

  const distanceFromBottom = () =>
    thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

  await composer.fill('Kun je hier iets over zeggen?')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  // The reply just landed at the bottom of an overflowing thread — it must
  // already be scrolled into view.
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2)

  // A second turn (renders as option buttons) must land in view the same way.
  await composer.fill('Stel een aanpak voor.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-question-option')).toHaveCount(3)
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2)
})
