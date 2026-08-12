import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request: a comment linked to a real code line ("gekoppeld aan een
// regel code") belongs in the blocks index UNDER the changed files, under its
// own heading, shown by default and collapsible — see recomputeLeftList's
// rank() (home.mjs, b.lineAnchored) and lineCommentHeading (BlockList.mjs).
// A PR-wide/orphan comment (no regel at all) is unaffected and keeps ranking
// above everything, under the pre-existing "PR-comments"/"Mentioned" headings
// — not exercised here, see comment-index-items.spec.mjs for those.
test('a comment linked to a code line sorts under the changed files, under its own collapsible heading', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff

  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

  const created = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr: 12903,
      file,
      line: 1,
      author: 'reviewer',
      body: 'regelcomment voor sectie-test',
      label,
      gran: 'group',
      rowStart: 0,
      rowEnd: 0,
    },
  })
  const { runId } = await created.json()
  expect(runId).toBeTruthy()

  try {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const heading = page.getByTestId('line-comment-heading')
    await expect(heading).toBeVisible()

    const rows = page.getByTestId('block-row')
    const commentRow = rows.filter({ hasText: 'regelcomment voor sectie-test' })
    await expect(commentRow).toHaveCount(1)

    // The heading sits below at least the first row in the list (whatever
    // ranks ahead of it — a real changed-file row, or a leftover no-regel
    // comment item from another spec sharing this fixture, both rank ahead
    // of 2.5), and the comment row itself sits below the heading.
    const firstRowBox = await rows.first().boundingBox()
    const headingBox = await heading.boundingBox()
    const commentRowBox = await commentRow.boundingBox()
    expect(headingBox.y).toBeGreaterThan(firstRowBox.y)
    expect(commentRowBox.y).toBeGreaterThan(headingBox.y)

    // Shown expanded by default; collapsing hides the row but keeps the
    // heading (so it can be expanded again) — expanding brings it right back.
    await page.getByTestId('line-comment-toggle').click()
    await expect(commentRow).toBeHidden()
    await expect(heading).toBeVisible()
    await page.getByTestId('line-comment-toggle').click()
    await expect(commentRow).toBeVisible()
  } finally {
    await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
