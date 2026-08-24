import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// "Selected: …" + the "other running Claude tasks" nested nav stop. Reviewer
// request: while looking at one conversation, see WHICH one it is (their own
// last Claude message, first sentence — see ownMessageTitle in
// RelatedPanel.mjs) and, if another conversation is running elsewhere in the
// PR, see its title too — navigable with ↓/↑ + Enter (or a click), the same
// rung the question-options list already offers. See "Where a turn on OTHER
// code is visible" / "Selected: …" in .claude/docs/claude-chat-panel.md.
//
// Two PR-wide (kind !== '') comments — same shape as
// pr-comment-claude-chat.spec.mjs — so each gets its own index row
// regardless of whether the synthetic PR carries any real diff blocks; a
// block-scoped comment would need a real, ingested block to land on (see
// openTask), which this lightweight fixture doesn't have.
//
// Same trick as claude-chat-parallel.spec.mjs: A's Signal POST is a HELD
// POST, so "a turn is in flight" is a steady state instead of a slow real
// turn.
test('the footer shows which chat is selected, and lets you jump to another one running elsewhere', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, file, body] of [
    ['a', 'a.php', 'eerste vraag over total'],
    ['b', 'b.php', 'tweede vraag over lines'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    conv[key] = (await res.json()).runId
    expect(conv[key]).toBeTruthy()
  }

  // Conversation A's Signal POST hangs until release() — every other one goes
  // through at once, exactly like claude-chat-parallel.spec.mjs.
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/signals/message', async (route) => {
    const url = route.request().url()
    if (url.includes('chat-' + conv.a)) await held
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'signalled' }),
    })
  })

  const enterChatOn = async (text) => {
    await page.getByTestId('block-row').filter({ hasText: text }).first().click()
    const compose = page.getByTestId('claude-chat-compose')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(compose).toBeFocused()
    return compose
  }

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(2)

  // Start A's turn (held) so it stays "running" for the rest of the test.
  const a = await enterChatOn('eerste vraag over total')
  await a.fill('leg dit uit')
  await a.press('Enter')

  // Walk to B — a chat with nothing of its own running.
  await enterChatOn('tweede vraag over lines')

  // "Selected: …" names the conversation currently in view (B), and the
  // "other running Claude tasks" list reports A by ownMessageTitle's own
  // fallback (neither has an own Claude message yet, so both read the anchor
  // comment's own real text) plus a status word — words, never a bare colour,
  // per the colourblind rule. The genuine "own Claude message" path (fetched
  // per running task) is covered separately below, where a REAL message is
  // sent instead of held/mocked away.
  const selected = page.getByTestId('claude-selected-line').first()
  await expect(selected).toBeVisible()
  await expect(selected).toContainText('tweede vraag over lines')

  const otherTasks = page.getByTestId('claude-other-tasks').first()
  await expect(otherTasks).toBeVisible()
  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toContainText('eerste vraag over total')
  await expect(row).toContainText('Claude')

  // ↓ from the rest position walks straight into this rung (B has no
  // code-preview cards of its own) and highlights the row (a ring PLUS a
  // leading glyph, never colour alone).
  await page.keyboard.press('ArrowDown')
  await expect(row).toHaveAttribute('data-active', 'true')
  await expect(row).toContainText('›')

  // Enter jumps to A: its own item becomes the one selected, and the Claude
  // composer for it gets the keyboard.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('claude-chat-compose')).toBeFocused()
  await expect(page.getByTestId('claude-selected-line').first()).toContainText('eerste vraag over total')
  // A is the one running now, so it no longer lists itself as an "other" task.
  await expect(page.getByTestId('claude-other-tasks')).toHaveCount(0)

  release()
  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})

// The "own last Claude message" path itself: this needs a REAL, stored user
// message (not a held/mocked Signal POST, which never reaches the real
// backend at all) — so this test lets A's send go through for real against
// the offline `claude` stub (SLASH_CLAUDE_CHAT_TURNS, see _fixtures.mjs),
// and keeps A "running" for the rest of the test purely via a mocked
// `chat.progress` SSE frame (same trick as claude-chat-progress.spec.mjs) —
// entirely independent of whether the real turn itself has already finished.
// otherRunningClaudeTasks' own fetch (ensureOtherTaskTitle, RelatedPanel.mjs)
// then hits A's REAL (unmocked) transcript once B is in view, so the row
// must show the first sentence of what was actually typed, not the old
// comment-text fallback.
test('the "other running Claude tasks" row fetches and shows the real own last message, first sentence', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const conv = {}
  for (const [key, file, body] of [
    ['a', 'a.php', 'eerste vraag over total'],
    ['b', 'b.php', 'tweede vraag over lines'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    conv[key] = (await res.json()).runId
    expect(conv[key]).toBeTruthy()
  }

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`
  // A only starts reporting "running" once markABusy() is called, AFTER the
  // real send below has actually landed — otherwise the very first
  // EventSource connection (opened at page load, before anything was sent)
  // would already list A as an "other running task" and cache its title as
  // '' (nothing own YET), which nothing in this mock would ever invalidate
  // afterwards (the real backend's own chat.message push isn't replicated
  // here — see ensureOtherTaskTitle's own doc comment on how that
  // invalidation works for real). Every connection (including a reconnect)
  // replays the current state, so it stays "busy" for as long as this test
  // needs it to once flipped on.
  let aBusy = false
  const markABusy = () => {
    aBusy = true
  }
  await page.route('**/api/events*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body:
        'retry: 300\n\n' +
        (aBusy
          ? frame({ type: 'chat.progress', pr, key: conv.a, seq: 1, data: { running: true, startedAt: Date.now() } })
          : ''),
    })
  })

  const enterChatOn = async (text) => {
    await page.getByTestId('block-row').filter({ hasText: text }).first().click()
    const compose = page.getByTestId('claude-chat-compose')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(compose).toBeFocused()
    return compose
  }

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(2)

  // A's own real message — unmocked, so it really lands in its transcript.
  const a = await enterChatOn('eerste vraag over total')
  await a.fill('Kun je dit optimaliseren? Het duurt te lang op grote datasets.')
  await a.press('Enter')
  // The message really landed (the offline `claude` stub answers fast, so by
  // now the turn has already finished — the footer's own "Selected: …"/
  // active-turn line isn't a useful check here since it hides again once
  // nothing is busy; the stored transcript is the reliable signal instead).
  await expect(page.getByTestId('claude-message').filter({ hasText: 'Kun je dit optimaliseren?' })).toBeVisible()
  // Only NOW does A start reporting "running" — see markABusy's own doc
  // comment above for why the ordering matters.
  markABusy()

  // Walk to B; A keeps reporting "running" via the mocked SSE frame above.
  await enterChatOn('tweede vraag over lines')
  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toBeVisible()
  // The fetch is async — Playwright's own polling `expect` covers the delay.
  await expect(row).toContainText('Kun je dit optimaliseren?')
  await expect(row).not.toContainText('eerste vraag over total')

  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
