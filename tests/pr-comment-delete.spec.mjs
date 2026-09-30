import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A PR-wide comment-index item (here: an unanchored AI risk finding) can be
// deleted from its own action menu. It could be resolved but never removed —
// prCommentCommandsFor had no delete item at all, even though the backend's
// delete Signal has always supported it (reported: "ik kan ai waarschuwing
// niet resolven of verwijderen"). See deletePrCommentItem in RelatedPanel.mjs.
test('a PR-wide AI finding can be deleted from the comment-index menu', async ({ page }) => {
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Foo.php',
      author: 'AI-controle',
      body: 'PR-brede bevinding die weg moet kunnen',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()
  await expect
    .poll(async () => {
      const l = await (await page.request.get('/api/comments?pr=12903')).json()
      return l.some((c) => c.runId === runId)
    })
    .toBe(true)

  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  const row = page.getByTestId('block-row').filter({ hasText: 'PR-brede bevinding die weg moet kunnen' })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.getByTestId('command-row').filter({ hasText: 'Verwijder comment' }).click()

  await expect(row).toHaveCount(0)
  await expect
    .poll(async () => {
      const l = await (await page.request.get('/api/comments?pr=12903')).json()
      return l.some((c) => c.runId === runId)
    })
    .toBe(false)
})

// ...but someone ELSE's comment, imported from GitHub, has no delete item at
// all: "ik wil geen comments van anderen kunnen verwijderen". The menu keeps
// Beantwoorden/Resolve, only Verwijder is gone. The backend enforces the same
// rule independently (deleteGithubComment's ownership guard, workflows.go) —
// this asserts the UI half. See isOwnComment in home.mjs.
test("someone else's imported comment has no delete item in its menu", async ({ page }) => {
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Foo.php',
      author: 'mweghorst',
      body: 'Comment van iemand anders die moet blijven staan',
      kind: 'issue',
      source: 'github',
      local: true,
    },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()
  await expect
    .poll(async () => {
      const l = await (await page.request.get('/api/comments?pr=12903')).json()
      return l.some((c) => c.runId === runId)
    })
    .toBe(true)

  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  const row = page.getByTestId('block-row').filter({ hasText: 'Comment van iemand anders die moet blijven staan' })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await expect(page.getByTestId('command-row').filter({ hasText: 'Beantwoorden' })).toHaveCount(1)
  await expect(page.getByTestId('command-row').filter({ hasText: 'Verwijder comment' })).toHaveCount(0)
})
