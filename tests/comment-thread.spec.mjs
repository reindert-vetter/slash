import { test, expect } from './_fixtures.mjs'

// Verifies: a placed comment shows its code snippet in the thread (feature 1)
// and its original body as the first chat bubble (feature 2).
test('placed comment shows code snippet + original body as first message', async ({ page }) => {
  // Use a PR of its own so this doesn't share the comments read-model with the
  // other comment spec (the test DB is shared across the parallel run).
  const pr = 970001
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'dit is de **eerste** comment',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  // The comments/taken sidebar is a fixed overlay toggled with `g` (see
  // detail-layout.md), collapsed by default.
  await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
  await page.keyboard.press('g')
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  // Feature 1: the code snippet box shows in the thread.
  await expect(page.getByTestId('comment-target')).toBeVisible()
  await expect(page.getByTestId('comment-target')).toContainText('total')

  // Feature 2: the original comment body appears as the first chat bubble.
  await expect(page.getByTestId('reaction-bubble').first()).toContainText('dit is de eerste comment')

  // The body is rendered as Markdown (renderMarkdown, commentBody in
  // RelatedPanel.mjs), not shown as plain text: **eerste** becomes <strong>.
  await expect(page.getByTestId('reaction-bubble').first().locator('strong')).toHaveText('eerste')
})
