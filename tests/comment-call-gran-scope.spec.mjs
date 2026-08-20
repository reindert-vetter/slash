import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for the reported bug: an AI risk finding anchored on a line
// (gran 'line') disappeared from the comment column as soon as the cursor
// zoomed to CALL granularity on that very same row — commentUnder
// (RelatedPanel.mjs) required `c.gran === 'call' && c.seg === t.seg` for every
// comment once the selected unit was a call segment, so a line/group comment
// covering the row matched nothing. The ⚠/💬 marker stayed on the row (that
// layer has no cursor scoping at all), which is exactly what the reviewer
// reported: "waar is de ai waarschuwing comment? Ik zie het niet."
//
// The filter is containment — call ⊂ line ⊂ group — so only ANOTHER call's
// comment is out of scope on a call segment.
test('a line comment stays visible when the cursor zooms to a call on its own row', async ({ page }) => {
  await page.goto('/pr/12903')
  await page.locator('[data-idx="1"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff, lands on the first change group

  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const fileLine = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim()

  // Place the comment through the real composer, so it carries the anchor the
  // reviewer's own composer computes (commentTarget, home.mjs) instead of a
  // hand-made row range.
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('zichtbaar op elke granulariteit van deze regel')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.keyboard.press('Enter'), // posts directly — an ordinary composer, no comment-kind menu
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  try {
    // Reload so the comment is present from the first render (same reason as
    // comment-range-first-row.spec.mjs: no racing the poll cadence).
    await page.goto('/pr/12903?sel=' + encodeURIComponent(fileLine))
    await expect(card).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff, same first change group

    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1)

    // f steps one granularity finer (group -> line -> call), all on the same
    // single-row change group, so the cursor never leaves the comment's row.
    // The comment must survive every step down to the call segment.
    for (let i = 0; i < 2 && !/gran=call/.test(page.url()); i++) {
      await page.keyboard.press('f')
      await expect(item).toHaveCount(1)
    }
    await expect(page).toHaveURL(/gran=call/)
    await expect(item).toHaveCount(1)
  } finally {
    await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
