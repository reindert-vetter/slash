import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// A follow-up to "Selected: …" plus a navigable list of other running
// conversations (see .claude/docs/claude-chat-panel.md, "A finished task
// lingers for 2 minutes, clearly marked done"). The sibling feature in that
// same doc section — reaching this same list with ↑ from Onderliggende code
// when NO comment exists at all on the current unit (`enterFooterTasks`,
// `cs.focus === 'tasks'`) — is covered by
// tests/claude-task-footer-no-comment-nav.spec.mjs, on its own PR 127
// fixture (a relation-only block pair, no worktree needed) rather than the
// shared PR 12903 worktree fixture originally considered here.

// Reviewer request: a task should not vanish from "Ook bezig elders" the
// INSTANT it finishes — it should linger for 2 minutes, clearly marked done
// (a word plus a differing shape, never colour alone). Sends A's message for
// REAL against the offline `claude` stub (fast, no mocked progress needed at
// all): setTurnBusy(id, true) → await → setTurnBusy(id, false) is exactly the
// busy/not-busy transition markFinishedIfJustStopped (claudeTurns.mjs) stamps
// finishedAt on, entirely client-side.
test('a task that just finished lingers in "Ook bezig elders", marked "Klaar"', async ({ page }, testInfo) => {
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

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(2)

  await page.getByTestId('block-row').filter({ hasText: 'eerste vraag over total' }).first().click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const composeA = page.getByTestId('claude-chat-compose')
  await expect(composeA).toBeFocused()
  await composeA.fill('Kun je dit optimaliseren?')
  await composeA.press('Enter')
  // The real (offline stub) turn answers fast — the stored transcript
  // actually showing the sent message is the reliable "the round trip (and
  // thus the busy → not-busy transition) has already happened" signal, same
  // reasoning as claude-chat-other-tasks.spec.mjs's own markABusy comment.
  await expect(page.getByTestId('claude-message').filter({ hasText: 'Kun je dit optimaliseren?' })).toBeVisible()

  await page.getByTestId('block-row').filter({ hasText: 'tweede vraag over lines' }).first().click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')

  const row = page.getByTestId('claude-task-row').first()
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-done', 'true')
  await expect(row).toContainText('Klaar')
  await expect(row).toContainText('✓')
})
