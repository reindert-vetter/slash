import { test, expect } from './_fixtures.mjs'

// Verifies: every comment row and every reply/thread bubble shows its author
// (name) plus an avatar — an image when a URL is known, otherwise the
// initials-fallback circle (see src/avatar.mjs, extracted from the PR-list's
// reviewerAvatar in src/overview.mjs). Comments/replies carry an `author`
// login but no avatarUrl today (see detail-layout.md's datamodel note), so
// this always exercises the initials-fallback path — which is also what a
// SLASH_GITHUB=off/offline run needs to look right.
test('comment row, reply bubble, and PR-wide item all show author + avatar', async ({ page }) => {
  const pr = 970002
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'octocat',
      body: 'root comment',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()

  // A reply from a different author, so the thread shows two distinct
  // author lines — not just the synthetic opening message.
  await page.request.post('/api/workflows/' + runId + '/signals/reply', {
    data: { author: 'reviewer', body: 'a reply', done: false },
  })

  await page.goto('/pr/' + pr)
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')

  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await expect(item.getByTestId('comment-author')).toHaveText('octocat')
  // No avatarUrl in the data → the initials-fallback circle, not an <img>.
  await expect(item.getByTestId('avatar-fallback')).toHaveText('OC')

  await item.click()

  const bubbles = page.getByTestId('reaction-bubble')
  await expect(bubbles).toHaveCount(2)
  const authors = page.getByTestId('reaction-author')
  await expect(authors.nth(0)).toHaveText('octocat')
  await expect(authors.nth(1)).toHaveText('reviewer')
  await expect(page.getByTestId('reaction-author-line').first().getByTestId('avatar-fallback')).toHaveText('OC')
  await expect(page.getByTestId('reaction-author-line').nth(1).getByTestId('avatar-fallback')).toHaveText('RE')
})

// Same coverage for the PR-wide comment block (issue-comment style, no
// file:line anchor) — its own render path (prWideItem in RelatedPanel.mjs)
// must show author + avatar too. task_code_comment rejects an empty `file`
// (see handleTaskCodeComment), so — like tests/pr-wide-comments.spec.mjs —
// this mocks GET /api/comments directly instead of starting a real run.
test('PR-wide comment item shows author + avatar', async ({ page }) => {
  const now = new Date().toISOString()
  const comments = [
    {
      id: 'avatar-pw-1',
      runId: 'run-avatar-pw-1',
      pr: 12903,
      file: '',
      line: 0,
      author: 'octocat',
      body: 'a pr-wide comment',
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'github',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
  ]
  await page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )

  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft') // stop 1: open the PR description column

  const item = page.getByTestId('pr-wide-item').first()
  await expect(item).toBeVisible()
  await expect(item.getByTestId('pr-wide-author')).toHaveText('octocat')
  // Scope to the summary row's own author-line — the thread may already be
  // open by default (first item selected) and would otherwise also match a
  // reaction-author-line avatar-fallback.
  await expect(item.getByTestId('pr-wide-author-line').getByTestId('avatar-fallback')).toHaveText('OC')
})
