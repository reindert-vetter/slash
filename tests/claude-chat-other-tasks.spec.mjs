import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// "Selected: …" + the "other running Claude tasks" nested nav stop. Reviewer
// request: while looking at one conversation, see WHICH one it is (its own
// last comment text) and, if another conversation is running elsewhere in
// the PR, see its title too — navigable with ↓/↑ + Enter (or a click), the
// same rung the question-options list already offers. See "Where a turn on
// OTHER code is visible" / the "Selected: …" line in
// .claude/docs/claude-chat-panel.md.
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
  // "other running Claude tasks" list reports A by its own last comment text
  // (its opening body, since it has no replies) plus a status word — words,
  // never a bare colour, per the colourblind rule.
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
