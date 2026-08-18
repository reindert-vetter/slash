import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Comment hiervan maken" on a comment-INDEX sidebar item
// (prCommentCommandsFor, home.mjs) used to always call
// convertPrWideWarningToComment (RelatedPanel.mjs) — whose guard requires
// `c.kind`, i.e. it only ever did anything for a genuinely PR-wide finding.
// A line-anchored finding (commentBlockItem's b.lineAnchored) gets its own
// "Comments op regels" sidebar row too, reaches this exact same menu, and
// used to silently no-op: filled reply field, menu, then nothing at all — no
// request, no visible change (see .claude/docs/comments-panel.md's
// "Converting an AI-controle finding into a real comment"). This is
// convert-warning-to-comment.spec.mjs's own "an anchored finding" case, but
// reached via the sidebar row instead of a direct `?sel=` on the block —
// which is the path that was actually broken.
test('Comment hiervan maken on a line-anchored finding, reached via its own sidebar row', async ({ page }) => {
  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  const aiBody = 'deze early return slaat de validatie van het tweede argument over'
  const seeded = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file,
      line: 1,
      author: 'AI check',
      body: aiBody,
      source: 'ai',
      local: true,
      label,
      gran: 'line',
      rowStart: 2,
      rowEnd: 2,
    },
  })
  expect(seeded.ok()).toBeTruthy()
  const { runId } = await seeded.json()
  expect(runId).toBeTruthy()

  // Reload so recomputeLeftList picks up the freshly seeded finding as its
  // own "Comments op regels" sidebar row, then select that row directly —
  // NOT via ?sel= on the real block (that's convert-warning-to-comment.spec.mjs's
  // own "an anchored finding" case, which never went through the broken path).
  await page.goto('/pr/12903')
  await leaveSearchBox(page)
  const row = page.getByTestId('block-row').filter({ hasText: aiBody.slice(0, 30) })
  await expect(row).toBeVisible()
  await row.click()

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  const rows = menu.getByTestId('command-row')
  // Same shape as prCommentCommandsFor's PR-wide case (see
  // convert-warning-to-comment.spec.mjs): "Sluit menu", "Beantwoorden"
  // (default), "Verwijder comment", "Comment hiervan maken", "Chat met
  // Claude", "Zet op GitHub" (the finding is local), "Ignore" — an AI finding
  // has no "Resolve comment" (isAiComment, home.mjs).
  await expect(rows).toHaveCount(7)
  const convertRow = rows.filter({ hasText: 'Comment hiervan maken' })
  await expect(convertRow).toHaveCount(1)
  await convertRow.click()
  await expect(menu).toHaveCount(0)

  // Unlike the genuinely PR-wide case (which repurposes the sidebar item's
  // own "Beantwoorden" reply field, comment-detail-reply), a line-anchored
  // finding's detail view still drills into its real block — so this opens
  // the SAME block-scoped "+ Nieuwe comment" composer commentCommandsFor's
  // own item does (convertWarningToComment/warningOverride), not
  // comment-detail-reply.
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue(aiBody)
  await expect(page.getByTestId('comment-composer')).toContainText('Comment van AI-controle')

  const editedBody = 'laten we hier het tweede argument alsnog expliciet valideren'
  await composer.fill(editedBody)
  await page.getByTestId('comment-send').click()
  const composeMenu = page.getByTestId('command-menu')
  await expect(composeMenu).toBeVisible()
  await expect(composeMenu.getByTestId('command-row').nth(1)).toContainText('Plaats comment')
  await page.keyboard.press('Enter')
  await expect(composeMenu).toHaveCount(0)

  // The replacement becomes its own new "Comments op regels" sidebar row —
  // placeComment's optimistic exit (see RelatedPanel.mjs) hands the keyboard
  // back to the diff, so the reviewer no longer sits on the just-deleted
  // finding's own sidebar row to see it echoed inline there.
  await expect(page.getByTestId('block-row').filter({ hasText: editedBody.slice(0, 30) })).toBeVisible()

  const list = await (await page.request.get('/api/comments?pr=12903')).json()
  const created = list.find((c) => c.body === editedBody)
  expect(created).toBeTruthy()
  expect(created.source).not.toBe('ai')
  expect(created.local).toBeFalsy()
  // Never downgraded into an unanchored PR-wide "issue" comment: the
  // replacement keeps the ORIGINAL finding's own anchor.
  expect(created.kind).toBeFalsy()
  expect(created.file).toBe(file)
  expect(created.label).toBe(label)
  expect(created.gran).toBe('line')
  expect(created.rowStart).toBe(2)
  expect(created.rowEnd).toBe(2)

  // ...and the original finding is gone, everywhere.
  await expect
    .poll(async () => {
      const rows2 = await (await page.request.get('/api/comments?pr=12903')).json()
      return rows2.some((c) => c.id === runId)
    })
    .toBe(false)
})
