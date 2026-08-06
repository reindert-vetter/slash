import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for the reported bug: an LLM finding that pins to a block
// but not to a specific row (anchoredWarning, code_warning.go) used to be
// saved unpinned (rowStart -1), which the frontend's own "unknown anchor →
// shown anywhere within this block" leniency (commentUnder, RelatedPanel.mjs)
// then surfaced under EVERY group/line/call of that block, not just the one
// the reviewer happened to be looking at when the finding was made. It now
// anchors on the block's own first changed row instead (a real row, so the
// existing row-containment filter applies normally) and carries
// blockWide: true so the frontend can still badge it as being about the
// whole block, not specifically that first row — see comments.Comment.
// BlockWide's own doc comment and anchoredWarning in code_warning.go.
//
// Placed directly via the task_code_comment workflow API (mirrors how
// claude-chat-panel.spec.mjs/related-nav.spec.mjs seed comments on PR 12903's
// real ingested blocks) rather than driving the actual code_warning LLM
// workflow — the backend anchoring/fallback logic itself is covered by
// TestAnchoredWarningFallsBackToBlockWideFirstRow (code_warning_test.go).
test('a block-wide-anchored AI finding shows its "hele blok" label on the group it hangs off, and disappears on a different unit', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff, lands on the first change group

  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]

  // Place an ordinary "reference" comment on the currently selected unit,
  // purely to learn a REAL row anchor (rowStart/rowEnd/gran) the same way the
  // reviewer's own composer would compute it — anchoredWarning's fallback
  // must land on an equally real row, never rowStart: -1.
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('referentie voor de rij-anchor')
  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.keyboard.press('Enter'), // "Plaats comment" (default, 2nd item)
  ])
  const refRunId = (await createRes.json()).runId
  expect(refRunId).toBeTruthy()

  let warningRunId
  try {
    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    const ref = list.find((c) => c.runId === refRunId)
    expect(ref).toBeTruthy()

    // Clean up the reference comment — only its anchor was needed.
    await page.request.post('/api/workflows/' + refRunId + '/signals/delete', { data: { author: 'reviewer' } })

    const start = await page.request.post('/api/workflows/task_code_comment', {
      data: {
        pr: 12903,
        file,
        line: ref.line,
        author: 'AI check',
        body: 'Dit raakt de hele methode, niet één regel.',
        label,
        gran: ref.gran,
        rowStart: ref.rowStart,
        rowEnd: ref.rowEnd,
        source: 'ai',
        local: true,
        blockWide: true,
      },
    })
    warningRunId = (await start.json()).runId
    expect(warningRunId).toBeTruthy()
    await expect
      .poll(async () => {
        const l = await (await page.request.get('/api/comments?pr=12903')).json()
        return l.some((x) => x.runId === warningRunId)
      })
      .toBe(true)

    // Reload so the comment is present from the start (avoids racing the
    // frontend's own poll cadence, same as related-nav.spec.mjs).
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff, same first change group

    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1)
    await expect(item.getByTestId('comment-block-wide')).toBeVisible()
    await expect(item.getByTestId('comment-block-wide')).toContainText('hele blok')
    await expect(item.getByTestId('comment-ai-warning')).toBeVisible()

    // Moving to a different unit — the next change group of this same block,
    // or (if this block has only one group) the next block entirely — must
    // make the block-wide finding disappear: it must never leak into a
    // selection it isn't actually about.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('comment-item')).toHaveCount(0)
  } finally {
    if (warningRunId) {
      await page.request.post('/api/workflows/' + warningRunId + '/signals/delete', { data: { author: 'reviewer' } })
    }
  }
})
