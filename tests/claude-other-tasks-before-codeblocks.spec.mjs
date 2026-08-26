import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Regression: ↓ from the Claude composer's rest position used to reach a
// unit's OWN code-preview cards before "Ook bezig elders in deze PR", even
// though that block renders ABOVE the cards on screen — reviewer report:
// "ook elders bezig kan ik pas selecteren nadat ik gegenereerde codeblokken
// (van chat) naar beneden heb gedrukt. ik wil dat na de chat het [Ook bezig
// elders] geselecteerd wordt, en pas als ik daarna naar beneden ga, het de
// gegenereerde codeblokken selecteert (en daarna onderliggende blokken)".
// Fixed by swapping cs.claudeTasksPos/cs.previewPos in handleRelatedKey's
// 'claude' branch (both ↓ and ↑) — see "Reordered" in
// .claude/docs/claude-chat-panel.md. This is the one scenario no existing
// spec covers: BOTH rungs present at once (an own code-preview card AND
// another conversation running elsewhere in the same PR).
//
// Same "held Signal POST" trick as claude-chat-other-tasks.spec.mjs to keep
// conversation A "running" for the whole test.
test('↓ from the Claude composer reaches "Ook bezig elders" before this unit\'s own code-preview cards', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const a = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: 'a.php', line: 0, author: 'AI check', body: 'eerste vraag over total', kind: 'ai_warning', source: 'ai', local: true },
  })
  const aRunId = (await a.json()).runId
  expect(aRunId).toBeTruthy()

  // B carries its own fenced code block, so its Claude column gets a
  // code-preview card of its own once opened (recomputeCodePreviews reads
  // every fence in the comment/Claude columns alike — see
  // code-fence-preview.spec.mjs).
  const b = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'b.php',
      line: 0,
      author: 'AI check',
      body: 'tweede vraag over lines\n```php\n$second = 2;\n```',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  expect((await b.json()).runId).toBeTruthy()

  // A's Signal POST hangs until release() — every other one goes through at
  // once.
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/signals/message', async (route) => {
    const url = route.request().url()
    if (url.includes('chat-' + aRunId)) await held
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'signalled' }) })
  })

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await expect(page.getByTestId('block-row')).toHaveCount(2)

  // Start A's turn (held) so it keeps reporting "running" for the rest of
  // the test.
  await page.getByTestId('block-row').filter({ hasText: 'eerste vraag over total' }).first().click()
  const composeA = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(composeA).toBeFocused()
  await composeA.fill('leg dit uit')
  await composeA.press('Enter')

  // Walk to B and enter its own Claude chat.
  await page.getByTestId('block-row').filter({ hasText: 'tweede vraag over lines' }).first().click()
  const composeB = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(composeB).toBeFocused()

  const otherTasks = page.getByTestId('claude-other-tasks').first()
  await expect(otherTasks).toBeVisible()
  const taskRow = page.getByTestId('claude-task-row').first()
  await expect(taskRow).toContainText('eerste vraag over total')
  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toHaveCount(1)

  // First ↓: "Ook bezig elders" gets highlighted, not the code card.
  await page.keyboard.press('ArrowDown')
  await expect(taskRow).toHaveAttribute('data-active', 'true')
  await expect(card).toHaveAttribute('data-active', 'false')
  await expect(composeB).not.toBeFocused()

  // Second ↓: the code-preview card is next, the task row is no longer
  // highlighted.
  await page.keyboard.press('ArrowDown')
  await expect(card).toHaveAttribute('data-active', 'true')
  await expect(taskRow).toHaveAttribute('data-active', 'false')

  // ↑ reverses in the same order: back onto the task row, then the composer.
  await page.keyboard.press('ArrowUp')
  await expect(taskRow).toHaveAttribute('data-active', 'true')
  await expect(card).toHaveAttribute('data-active', 'false')
  await page.keyboard.press('ArrowUp')
  await expect(taskRow).toHaveAttribute('data-active', 'false')
  await expect(composeB).toBeFocused()

  release()
  // No cleanup: seededPr gives this test its own PR on a per-worker server/DB.
})
