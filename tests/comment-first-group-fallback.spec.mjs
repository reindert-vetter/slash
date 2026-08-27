import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for the reported bug: selecting a block from the index shows
// every one of its comments (nothing narrowed yet), but the moment `→` steps
// the keyboard into the diff — landing, by default, on the block's own FIRST
// changed group — a comment sitting on a LATER group of that same block
// disappeared entirely: no marker to reach it with, even though the reviewer
// hadn't made any choice about that comment's own row at all, only "enter the
// diff". commentUnder (RelatedPanel.mjs) now has one narrow fallback: such a
// comment is pinned to the block's first changed group and shown there —
// but deliberately does NOT follow any further ("op de eerste aangepaste
// regel plaatsen, dieper moet niet mee", Reindert): a different group, or
// narrowing the very same first group to line/call granularity, hide it
// again exactly like before this fallback existed.
//
// Reuses the PR 100 fixture from call-arrows.spec.mjs/range-select-related-
// scope.spec.mjs: ArrowCallerAction::execute has TWO changed groups — an
// unrelated one first (the default active unit on entering the diff) and,
// after an unchanged line, a second group with the call lines.
test('a comment on a later group is pinned to the block\'s first group, and does not follow deeper', async ({
  page,
}) => {
  await page.goto('/pr/100')
  await expect(page.getByTestId('block-row')).toHaveCount(1)
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // execute's diff, gran 'group', default unit 0

  const fileLine = (
    await page.getByTestId('block-column').locator('article').first().locator('.font-mono.text-slate-500').first().innerText()
  ).trim()

  // Move onto the SECOND group and place the comment there through the real
  // composer, so it carries the real anchor commentTarget (home.mjs) computes
  // for that group — not group 0, the one this test keeps returning to.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('hangt op de tweede groep')
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/workflows/task_code_comment') && res.request().method() === 'POST',
    ),
    page.keyboard.press('Enter'), // posts directly — an ordinary composer, no comment-kind menu
  ])
  const runId = (await createRes.json()).runId
  expect(runId).toBeTruthy()

  try {
    // Reload so the comment is present from the first render (no racing the
    // frontend's own poll cadence, same as the other commentUnder specs).
    await page.goto('/pr/100?sel=' + encodeURIComponent(fileLine))
    await expect(page.getByTestId('block-column').locator('article').first()).toBeVisible()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // back to gran 'group', default unit 0 — NOT the comment's own group

    const item = page.getByTestId('comment-item')
    await expect(item).toHaveCount(1) // pinned to the block's first group

    await page.keyboard.press('f') // narrow group 0 to line granularity — the pin does not follow
    await expect(page).toHaveURL(/gran=line/)
    await expect(item).toHaveCount(0)

    await page.keyboard.press('d') // back to group granularity, still on group 0
    await expect(item).toHaveCount(1)

    await page.keyboard.press('ArrowDown') // onto the comment's own, real group
    await expect(item).toHaveCount(1) // shown via ordinary containment, unaffected by the fallback
  } finally {
    await page.request.post('/api/workflows/' + runId + '/signals/delete', { data: { author: 'reviewer' } })
  }
})
