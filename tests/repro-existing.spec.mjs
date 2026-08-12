import { test, expect } from './_fixtures.mjs'

// Force the load-order race: comments arrive & render BEFORE the block code, so the
// later code-load re-render tears down the comment subtrees (arrow.js orphan).
test('delayed code load + seeded comments: arrow orphan + list update', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 91, file: 'app/Actions/AlphaAction.php', line: 20, author: 'reviewer', body: 'seed one', label: 'AlphaAction::run', gran: 'group', rowStart: 0, rowEnd: 4, code: 'public function run()\n{\n    return 1;\n}', local: true },
  })

  // Delay code responses so comments win the race on load.
  await page.route('**/api/code**', async (route) => {
    await new Promise((r) => setTimeout(r, 900))
    await route.continue()
  })

  for (let i = 0; i < 6; i++) {
    errors.length = 0
    await page.goto('/pr/91')
    await page.waitForTimeout(400) // comments load; code still pending
    // Land on the BLOCK, explicitly: every unresolved comment (including the one
    // seeded above and each one this loop places) now has its own index row that
    // sorts ahead of the blocks, and a fresh open picks the first unapproved
    // item — which would be such a row, not the diff this repro is about (see
    // indexComments in RelatedPanel.mjs).
    await page
      .locator('[data-idx]')
      .filter({ hasText: 'AlphaAction::run' })
      .first()
      .click()
      .catch(() => {})
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1200) // code arrives late -> re-render
    // now place a comment live — comments render inline, next to the diff;
    // opened via the command palette's "Comment op deze regel" (there is no
    // dedicated trigger row any more — see openNewComment in _fixtures.mjs;
    // inlined here, tolerantly, to match this repro's own .catch() style).
    await page.keyboard.press('Enter').catch(() => {})
    await page
      .getByTestId('command-row')
      .filter({ hasText: 'Comment op deze regel' })
      .click()
      .catch(() => {})
    const body = 'late ' + i
    await page.getByTestId('comment-compose').fill(body).catch(() => {})
    await page.getByTestId('comment-send').click().catch(() => {})
    await page.waitForTimeout(200)
    await page.getByTestId('command-input').fill('mijzelf').catch(() => {})
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    const listed = await page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: body }).count()
    console.log(`ITER ${i}: listed=${listed} errs=${errors.length} ${errors.length ? JSON.stringify([...new Set(errors)]) : ''}`)
  }
})
