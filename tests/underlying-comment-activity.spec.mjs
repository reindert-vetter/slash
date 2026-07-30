import { test, expect } from './_fixtures.mjs'

// PR 970500 (tests/fixtures/commentactivity-blocks.json + -relations.json) has
// two blocks: CommentActivityParentAction::run (parent) and
// CommentActivityChildListener::handle, linked as an event_listener CHILD of
// the parent (the same relation shape as PR 90's dispatcher/listener pair in
// relations.spec.mjs). Own PR number so comment placement never collides with
// another spec's exact-count assertion (see the APPROVAL_RESET_PRS note in
// _fixtures.mjs).
//
// Verifies the sidebar's "there's an open comment somewhere in the
// underlying code" indicator (state.commentActivity, home.mjs's
// commentScopeKeys/commentActivitySummary watch + BlockList.mjs's
// commentActivityPill): a comment anchored on the CHILD rolls up onto the
// PARENT row (nestedPrBlocks — the same subtree approvalPill already uses),
// the avatar always names whoever posted the most recent MESSAGE across every
// open thread in scope (not just the most recently opened thread), "+N"
// counts OTHER open threads besides the one the avatar already represents
// (total minus one — a thread with a reply still counts once), and a
// resolved thread stops counting entirely — mirroring commentRowSet's own
// 💬-marker rule. Also verifies the same indicator on the child's own card
// in the "Onderliggende code" panel (RelatedPanel.mjs's
// commentActivityBadge), fed by the same commentScopeKeys/
// commentActivitySummary computed per child in home.mjs's relatedChildren.
test('sidebar rows show an activity indicator for open comments in their underlying-code subtree', async ({
  page,
}) => {
  const pr = 970500
  const parentFile = 'app/Actions/CommentActivityParentAction.php'
  const parentLabel = 'CommentActivityParentAction::run'
  const childFile = 'app/Listeners/CommentActivityChildListener.php'
  const childLabel = 'CommentActivityChildListener::handle'

  await page.goto('/pr/' + pr)
  const rows = page.getByTestId('block-row')
  await expect(rows).toHaveCount(2)
  const parentRow = rows.filter({ hasText: parentLabel })
  const childRow = rows.filter({ hasText: childLabel })

  // Nothing anchored yet — no indicator on either row.
  await expect(page.getByTestId('block-comment-activity')).toHaveCount(0)

  // A comment on the CHILD…
  const start1 = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: childFile, line: 5, gran: 'line', label: childLabel, author: 'alice', body: 'child issue' },
  })
  const runId1 = (await start1.json()).runId
  expect(runId1).toBeTruthy()

  await page.reload()

  // …rolls up onto the PARENT row (nestedPrBlocks subtree) as well as showing
  // directly on the child's own row — one open thread, so no "+N" yet.
  await expect(parentRow.getByTestId('block-comment-activity')).toBeVisible()
  await expect(parentRow.getByTestId('block-comment-activity').getByTestId('avatar-fallback')).toHaveText('AL')
  await expect(parentRow.getByTestId('block-comment-activity-count')).toHaveCount(0)
  await expect(childRow.getByTestId('block-comment-activity').getByTestId('avatar-fallback')).toHaveText('AL')

  // A second, separate thread directly on the PARENT itself, posted later —
  // the avatar follows the newest MESSAGE across every open thread in scope.
  const start2 = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: parentFile, line: 10, gran: 'line', label: parentLabel, author: 'bob', body: 'parent issue' },
  })
  const runId2 = (await start2.json()).runId
  expect(runId2).toBeTruthy()

  // A reply within bob's own thread, from a third person — still ONE thread
  // (count must stay 2, not 3): "+N" counts distinct conversations, never
  // individual messages within one.
  await page.request.post('/api/workflows/' + runId2 + '/signals/reply', {
    data: { author: 'carol', body: 'looking into it', done: false },
  })

  await page.reload()

  await expect(parentRow.getByTestId('block-comment-activity').getByTestId('avatar-fallback')).toHaveText('CA')
  // Two open threads total (child + parent's own) — the avatar already
  // represents one of them, so the "+N" badge shows the ONE other thread,
  // not the total of two.
  await expect(parentRow.getByTestId('block-comment-activity-count')).toHaveText('+1')
  // The child's own scope never sees the parent's comment — only its own.
  await expect(childRow.getByTestId('block-comment-activity').getByTestId('avatar-fallback')).toHaveText('AL')
  await expect(childRow.getByTestId('block-comment-activity-count')).toHaveCount(0)

  // The same indicator also shows on the child's own card in the parent's
  // "Onderliggende code" panel — only the avatar (one open thread on the
  // child itself), no "+N" badge.
  await parentRow.click()
  const relatedChild = page.getByTestId('related-code').getByTestId('related-item')
  await expect(relatedChild.getByTestId('related-comment-activity')).toBeVisible()
  await expect(relatedChild.getByTestId('related-comment-activity').getByTestId('avatar-fallback')).toHaveText('AL')
  await expect(relatedChild.getByTestId('related-comment-activity-count')).toHaveCount(0)

  // Resolving the child's thread (the sanctioned "/resolve" sentinel Signal)
  // removes it from the rollup entirely — same rule as the diff's 💬 marker.
  await page.request.post('/api/workflows/' + runId1 + '/signals/reply', {
    data: { author: 'reviewer', body: '/resolve', done: true },
  })

  await page.reload()

  await expect(childRow.getByTestId('block-comment-activity')).toHaveCount(0)
  await expect(parentRow.getByTestId('block-comment-activity').getByTestId('avatar-fallback')).toHaveText('CA')
  await expect(parentRow.getByTestId('block-comment-activity-count')).toHaveCount(0)

  // Same disappear-once-resolved behavior on the child's own related-item card.
  await parentRow.click()
  await expect(page.getByTestId('related-code').getByTestId('related-item').getByTestId('related-comment-activity')).toHaveCount(0)
})
