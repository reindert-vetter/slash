import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Regression test for: "ik zie niet het menu wat ik normaal zou verwachten"
// (reported on an AI-risicowaarschuwing comment-index row). resolveCommands
// (home.mjs) gave the block palette a two-item no-match fallback ("Chat over
// deze regel"/"Comment op deze regel") but the prComment mode had none: typing
// an actual question fuzzy-matched none of prCommentCommandsFor's short
// labels and fell through to CommandMenu's bare "Geen commando's." — a dead
// end, since a comment-index item has no diff row to fall back to either. See
// "Filtering, submenus, and the no-match fallback" in
// .claude/docs/command-palette.md.

test('a comment-index row typed into the palette falls back to Chat/Beantwoorden instead of "Geen commando\'s"', async ({
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
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()

  // The static action list first (sanity: the menu isn't just always empty).
  await expect(page.getByTestId('command-row').filter({ hasText: 'Chat met Claude' })).toBeVisible()

  await page.getByTestId('command-input').fill('Klopt dit echt? geef code voorbeelden')
  const rows = page.getByTestId('command-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Chat over deze comment')
  await expect(rows.nth(1)).toContainText('Beantwoorden met deze tekst')
  await expect(page.getByText("Geen commando's.")).toHaveCount(0)

  // The chat item is the default (first row) — Enter runs it, opening the
  // embedded Claude composer prefilled with the typed question.
  await page.keyboard.press('Enter')
  await expect(menu).not.toBeVisible()
  const compose = page.getByTestId('claude-chat-compose')
  await expect(compose).toBeVisible()
  await expect(compose).toHaveValue('Klopt dit echt? geef code voorbeelden')
  await expect(compose).toBeFocused()
})

test('the fallback\'s second item pre-fills the reply field instead of the Claude composer', async ({
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
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()

  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('dit is geen bestaand commando')
  await page.getByTestId('command-row').filter({ hasText: 'Beantwoorden met deze tekst' }).click()
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  const reply = page.getByTestId('comment-detail-reply')
  await expect(reply).toBeVisible()
  await expect(reply).toHaveValue('dit is geen bestaand commando')
  await expect(reply).toBeFocused()
})
