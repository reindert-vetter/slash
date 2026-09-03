import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// The footer's chat list is EVERY chat of this PR, not only the ones with a
// turn running right now. Reviewer report: "ik zie maar 1 andere chat, maar er
// zijn veel meer chats bezig op dat moment ... laat een hele lijst zien van
// alle chats", answered with "alle chats van deze pr en chats die ik nog niet
// x seconden heb bekeken (ik denk 5 seconden)" — see "Andere chats in deze PR"
// in .claude/docs/claude-chat-panel.md.
//
// A page RELOAD is what makes this a real regression test: it empties every
// per-tab registry (claudeTurns.mjs' running/busy map AND its 2-minute
// finishedAt linger), so the old inclusion rule ("running now, or finished in
// the last 2 minutes") listed nothing at all afterwards. The new rule resolves
// the list from cc.conversations — the durable "here a Claude conversation
// really happened" set — so a chat the reviewer has not dwelt on for the full
// 5s stays listed across a reload, marked 'nieuw' (or 'bekeken' once the dwell
// did land).
test('every chat of the PR stays listed after a reload, with its own state word', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  for (const [file, body] of [
    ['a.php', 'eerste vraag over total'],
    ['b.php', 'tweede vraag over lines'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file, line: 0, author: 'AI check', body, kind: 'ai_warning', source: 'ai', local: true },
    })
    expect((await res.json()).runId).toBeTruthy()
  }

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

  // A real, stored turn against the offline `claude` stub (SLASH_CLAUDE_CHAT_
  // TURNS, see _fixtures.mjs) — so A is a genuine conversation in
  // cc.conversations, not just a tab-local "busy" flag.
  const a = await enterChatOn('eerste vraag over total')
  await a.fill('leg dit uit')
  await a.press('Enter')
  await expect(page.getByTestId('claude-message').filter({ hasText: 'leg dit uit' })).toBeVisible()

  // Reload: nothing is running any more and every per-tab registry is empty.
  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await enterChatOn('tweede vraag over lines')

  const otherTasks = page.getByTestId('claude-other-tasks').first()
  await expect(otherTasks).toBeVisible()
  await expect(otherTasks).toContainText('Andere chats in deze PR')
  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toContainText('leg dit uit')
  // A word carries the state, never a bare colour (colourblind rule): 'nieuw'
  // while the 5s dwell has not marked it seen, 'bekeken' once it has. Which of
  // the two is a timing detail of this test, but it can never be 'bezig' —
  // nothing is running after the reload.
  await expect(row).not.toHaveAttribute('data-state', 'busy')
  await expect(row).toContainText(/nieuw|bekeken/)
})
