import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A PR-wide AI risk finding (code_warning's unanchored "ai_warning" comment)
// used to show an author avatar in the block index — an "AI" initials circle
// that read like just another person's comment. It now shows the same
// warning-triangle glyph the panels already use, until the reviewer puts the
// finding on GitHub (githubId != 0), from which point it is an ordinary
// comment again. See categoryOrAvatar/isLocalAiWarning in BlockList.mjs.
test('a not-yet-published AI finding shows a warning icon in the index, a human comment an avatar', async ({
  page,
}) => {
  const warn = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Foo.php',
      author: 'AI-controle',
      body: 'AI-bevinding met waarschuwingsicoon',
      kind: 'ai_warning',
      source: 'ai',
      local: true,
    },
  })
  const warnRunId = (await warn.json()).runId
  expect(warnRunId).toBeTruthy()

  const human = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file: 'app/Foo.php',
      author: 'reviewer',
      body: 'Gewone PR-brede opmerking',
      kind: 'issue',
      local: true,
    },
  })
  const humanRunId = (await human.json()).runId
  expect(humanRunId).toBeTruthy()

  try {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const warnRow = page.getByTestId('block-row').filter({ hasText: 'AI-bevinding met waarschuwingsicoon' })
    await expect(warnRow).toHaveCount(1)
    await expect(warnRow.getByTestId('block-row-ai-warning')).toBeVisible()

    const humanRow = page.getByTestId('block-row').filter({ hasText: 'Gewone PR-brede opmerking' })
    await expect(humanRow).toHaveCount(1)
    await expect(humanRow.getByTestId('block-row-ai-warning')).toHaveCount(0)

    // Such a finding anchored to no block at all, so its detail card's only
    // statement of what it is about is the file it named — folded into the
    // card's footer meta line (RelatedPanel.mjs's commentDetailCard, the same
    // truncateMiddle(file):line shape compactConversation's own "comment-meta"
    // line uses), which used to be stored but never shown.
    // .first(): the look-ahead preview card of the next comment item sits in
    // the same column and, here, names the same file.
    await warnRow.click()
    await expect(page.getByTestId('comment-detail-meta').first()).toContainText('app/Foo.php')
  } finally {
    for (const id of [warnRunId, humanRunId]) {
      await page.request.post('/api/workflows/' + id + '/signals/delete', { data: { author: 'reviewer' } })
    }
  }
})
