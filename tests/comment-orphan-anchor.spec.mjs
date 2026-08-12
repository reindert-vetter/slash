import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// An ingest refresh can rename or remove the symbol a comment was anchored to.
// Before the re-anchor pass existed such a comment was still in the DB and still
// served by /api/comments, but no view could reach it: recomputeView scopes the
// block-scoped index by file+label (no block carries that label any more) and
// prWideComments only picked up kind !== ''. It was visible NOWHERE.
//
// The re-anchor pass (reanchor.go) now marks it anchorState 'orphan', and the
// frontend gives it a "Start" row of its own — the same treatment a review comment
// that never mapped to a block already got, deliberately WITHOUT changing its
// `kind` (that would flip isPRWide on the backend and start mirroring its replies
// to GitHub as issue comments).
//
// Fixture PR 970600 (seeded in _fixtures.mjs): one surviving block, plus a comment
// on a vanished label marked orphan and one still pinned to the surviving block.
// Seeded rather than driven through the API because anchor_state is deliberately
// unreachable from the UI — the reply signal handler drops action/anchor.

const PR = 970600

test.describe('PR Review Tree — an orphaned comment anchor stays reachable', () => {
  test('an orphan gets its own index row, badged "verouderd"', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)

    // The comment whose label is gone shows as a navigable row under the
    // "PR-comments" heading, labelled with its own body snippet.
    const rows = page.locator('[data-testid="block-row"]')
    await expect(rows.filter({ hasText: 'Dit ophalen hoort in de repository' })).toHaveCount(1)
    await expect(page.locator('[data-testid="comment-heading"]')).toBeVisible()

    // The still-pinned comment gets a row of its own too, as long as it is
    // unresolved (see indexComments in RelatedPanel.mjs) — it stays reachable
    // through its own block as well, which is deliberate: one row, one thread.
    await expect(rows.filter({ hasText: 'Deze hangt nog wel aan bestaande code' })).toHaveCount(1)
  })

  test('selecting the orphan shows its thread with the stale-anchor badge', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)

    await page.locator('[data-testid="block-row"]').filter({ hasText: 'Dit ophalen hoort in de repository' }).click()

    // Selection alone renders the detail card (no hover, no Enter) — see
    // "Comment-index items" in detail-layout.md.
    const card = page.locator('[data-testid="comment-detail-card"]').first()
    await expect(card).toBeVisible()

    // The badge names the state in WORDS, never colour alone.
    const stale = card.locator('[data-testid="comment-stale-anchor"]')
    await expect(stale).toBeVisible()
    await expect(stale).toContainText('verouderd')

    // Its kind badge falls back to a readable label instead of rendering empty:
    // an orphan keeps kind '' (a block comment), so COMMENT_KIND_LABEL misses.
    await expect(card.locator('[data-testid="comment-detail-kind"]')).toContainText('Regelcomment')

    // The thread still shows the code the comment was placed on — a record of
    // what it was about, even though that code is gone from the PR.
    await expect(card).toContainText('Dit ophalen hoort in de repository')
  })

  test('the orphan counts as one unapproved item, like any other comment row', async ({ page }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)

    // blockApproveCount maps a comment row onto 0/1 (resolved == approved), so an
    // unresolved orphan shows an open 0/1 pill exactly like a PR-wide comment —
    // proof it went through the ordinary index machinery and not a bespoke path.
    const row = page.locator('[data-testid="block-row"]').filter({ hasText: 'Dit ophalen hoort in de repository' })
    await expect(row.locator('[data-testid="block-approval"]')).toContainText('0/1')
  })
})
