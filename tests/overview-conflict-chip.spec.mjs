import { test, expect, appReady } from './_fixtures.mjs'

// Reindert: "ik wil het zien als er een merge conflict is in een pr in pr
// overview". GitHub's `mergeable` was already carried into the client but never
// rendered — see "A merge conflict is shown as a chip" in
// .claude/docs/pr-overview.md.
//
// The rows come from the search endpoint, whose payload carries the heavy
// status fields INLINE (statusFor falls back to the row itself), so one mock
// covers both a conflicting and a mergeable row without touching the shared
// offline inbox fixture.
test.describe('PR overview — a merge conflict is visible on the row', () => {
  const row = (n, mergeable) => ({
    number: n,
    title: 'PR ' + n,
    author: 'alice',
    state: 'OPEN',
    url: 'https://example.test/' + n,
    updatedAt: new Date().toISOString(),
    isDraft: false,
    baseRefName: 'develop',
    headRefName: 'branch-' + n,
    mergeable,
    reviewDecision: 'REVIEW_REQUIRED',
    checksTotal: 0,
  })

  test('CONFLICTING gets a chip naming it, MERGEABLE and UNKNOWN get none', async ({ page }) => {
    await page.route('**/api/prs/search**', (route) =>
      route.fulfill({ json: { ok: true, prs: [row(800, 'CONFLICTING'), row(801, 'MERGEABLE'), row(802, 'UNKNOWN')] } }),
    )

    await page.goto('/pr-overview')
    await appReady(page)
    await page.locator('[data-testid="search"]').fill('anything')

    const rows = page.locator('[data-testid="search-results"] [data-testid="pr-row"]')
    await expect(rows).toHaveCount(3)

    // The WORD carries the meaning, not the tint (the reviewer is colourblind).
    await expect(rows.nth(0).locator('[data-testid="conflict-chip"]')).toContainText('Merge-conflict')
    // A mergeable PR looks exactly as it did before, and so does one whose
    // merge state GitHub hasn't computed yet — no invented signal.
    await expect(rows.nth(1).locator('[data-testid="conflict-chip"]')).toHaveCount(0)
    await expect(rows.nth(2).locator('[data-testid="conflict-chip"]')).toHaveCount(0)

    // The review chip still renders next to it: the stack's own key changed to
    // include `mergeable`, so the extra chip must not replace it.
    await expect(rows.nth(0).locator('[data-testid="review-chip"]')).toBeVisible()
  })
})
