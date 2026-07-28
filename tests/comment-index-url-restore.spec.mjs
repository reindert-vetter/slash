import { test, expect } from './_fixtures.mjs'

// A PR-wide comment (kind !== '') is a synthetic, navigable "Start" sidebar
// item (kind:'comment', see recomputeLeftList/commentBlockItem in home.mjs).
// Selecting one now also survives a refresh via `?sel=comment:<id>`,
// mirroring the existing `?sel=file:line` mechanism for a real block — see
// applyCommentRefRestore in home.mjs and "Comment-index items" in
// detail-layout.md. This used to be a deliberate non-goal ("a comment
// selection simply doesn't survive a refresh") — reversed on explicit
// request.

function mockComments(page, comments) {
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

function comment(id, body, status = 'open') {
  const now = new Date().toISOString()
  return {
    id,
    runId: 'run-' + id,
    pr: 12903,
    file: '',
    line: 0,
    author: 'octocat',
    body,
    createdAt: now,
    reactionCount: 0,
    status,
    source: 'github',
    kind: 'issue',
    reactions: [],
    rowStart: -1,
    rowEnd: -1,
  }
}

test.describe('Comment-index selection survives a refresh (?sel=comment:<id>)', () => {
  test('selecting a non-default comment writes ?sel=comment:<id> and a reload restores it', async ({ page }) => {
    await mockComments(page, [
      comment('ci-1', 'First PR-wide comment'),
      comment('ci-2', 'Second PR-wide comment, see also the kilo thing'),
      comment('ci-3', 'Third PR-wide comment'),
    ])
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    // A fresh open lands on the first unresolved comment item (rank -1, see
    // applyDefaultUnapprovedSelection) — step down onto the second one.
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('comment:ci-1')
    await page.keyboard.press('ArrowDown')

    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('comment:ci-2')
    const card = page.getByTestId('comment-detail-card').first()
    await expect(card).toContainText('Second PR-wide comment')

    await page.reload()
    await page.waitForLoadState('networkidle')

    expect(new URL(page.url()).searchParams.get('sel')).toBe('comment:ci-2')
    await expect(page.getByTestId('comment-detail-card').first()).toContainText('Second PR-wide comment')
    // list mode, not stuck in a stray diff — comment items have no diff.
    expect(new URL(page.url()).searchParams.get('mode') || 'list').toBe('list')
  })

  test('restoring onto an already-resolved comment reveals it despite the approved-hide default', async ({
    page,
  }) => {
    await mockComments(page, [
      comment('ci-1', 'Open comment', 'open'),
      comment('ci-2', 'Resolved comment', 'resolved'),
    ])
    await page.goto('/pr/12903?sel=' + encodeURIComponent('comment:ci-2'))
    await page.waitForLoadState('networkidle')

    // The comment restore is async — it retries from the comment-poll watch
    // once RelatedPanel's own comment fetch has landed (see
    // applyCommentRefRestore) — so wait for it before reading the card.
    await expect.poll(() => new URL(page.url()).searchParams.get('sel')).toBe('comment:ci-2')

    // The resolved comment counts as fully-approved (0/1 → 1/1, see
    // blockApproveCount's comment branch) and would normally hide behind the
    // "Toon N goedgekeurde blokken" toggle — the restore must pin it visible
    // and selected instead (revealSelectedIfHidden), same as a restored
    // ?sel=file:line landing on an already-approved block.
    await expect(page.getByTestId('comment-detail-card').first()).toContainText('Resolved comment')
    expect(new URL(page.url()).searchParams.get('sel')).toBe('comment:ci-2')
    await expect(page.getByTestId('toggle-approved')).toBeVisible()
  })
})
