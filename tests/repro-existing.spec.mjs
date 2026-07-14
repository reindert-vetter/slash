import { test, expect } from '@playwright/test'

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
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1200) // code arrives late -> re-render
    // now place a comment live
    const body = 'late ' + i
    await page.getByTestId('new-comment').click().catch(() => {})
    await page.getByTestId('comment-compose').fill(body).catch(() => {})
    await page.getByTestId('comment-send').click().catch(() => {})
    await page.waitForTimeout(200)
    await page.getByTestId('command-input').fill('mijzelf').catch(() => {})
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    const listed = await page.getByTestId('related-panel').getByTestId('comment-item').filter({ hasText: body }).count()
    console.log(`ITER ${i}: listed=${listed} errs=${errors.length} ${errors.length ? JSON.stringify([...new Set(errors)]) : ''}`)
  }
})
