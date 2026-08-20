import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for the reported bug: a comment placed on a whole group (or
// on a multi-row Shift range) vanished from the inline comment cards as soon
// as the cursor sat on a narrower unit — commentUnder (RelatedPanel.mjs)
// required the comment's row range to be fully CONTAINED in the selected unit,
// so a wider comment matched nothing below its own extent, even though every
// row of that range carries a 💬 marker (commentRowSet). It now also matches
// when the selected unit starts on exactly the comment's own first row — and
// deliberately ONLY there, not on every row it happens to overlap.
//
// Both comments are placed straight through the task_code_comment workflow API
// (like comment-block-wide-anchor.spec.mjs) with a range WIDER than the unit
// the cursor sits on — that is precisely the anchor a Shift+↑/↓ range or a
// coarser-granularity comment stores, and the fixture's own change groups are
// too small to build one through the keyboard.
test('a comment wider than the selected unit shows on its own start row only', async ({ page }) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff, lands on the first change group

  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()
  const file = fileLine.split(':')[0]

  // Place a throwaway comment on the current unit through the real composer,
  // purely to learn a REAL row anchor the way the reviewer's own composer
  // computes it (commentTarget, home.mjs).
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('referentie voor de rij-anchor')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.keyboard.press('Enter'), // posts directly — an ordinary composer, no comment-kind menu
  ])
  const refRunId = (await createRes.json()).runId
  expect(refRunId).toBeTruthy()

  const list = await (await page.request.get('/api/comments?pr=12903')).json()
  const ref = list.find((c) => c.runId === refRunId)
  expect(ref).toBeTruthy()
  expect(ref.rowStart).toBeGreaterThan(0)
  await page.request.post('/api/workflows/' + refRunId + '/signals/delete', { data: { author: 'reviewer' } })

  const runIds = []
  try {
    // Both ranges are wider than the selected unit and both overlap it; only
    // the first one starts on the unit's own first row.
    const place = async (body, rowStart, rowEnd) => {
      const res = await page.request.post('/api/workflows/task_code_comment', {
        data: {
          pr: 12903,
          file,
          line: ref.line,
          author: 'reviewer',
          body,
          label,
          gran: 'group',
          rowStart,
          rowEnd,
        },
      })
      expect(res.ok()).toBeTruthy()
      runIds.push((await res.json()).runId)
    }
    await place('begint op deze rij', ref.rowStart, ref.rowEnd + 4)
    await place('begint een rij eerder', ref.rowStart - 1, ref.rowEnd + 4)

    // Reload so both comments are present from the start (avoids racing the
    // frontend's own poll cadence, same as comment-block-wide-anchor).
    await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
    await expect(card.locator('h2').first()).toHaveText(label)
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff, same first change group

    const item = page.getByTestId('comment-item')
    await expect(item.filter({ hasText: 'begint op deze rij' })).toHaveCount(1)
    await expect(item.filter({ hasText: 'begint een rij eerder' })).toHaveCount(0)
  } finally {
    for (const id of runIds) {
      await page.request.post('/api/workflows/' + id + '/signals/delete', { data: { author: 'reviewer' } })
    }
  }
})
