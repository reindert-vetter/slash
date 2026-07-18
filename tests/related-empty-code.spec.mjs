import { test, expect } from './_fixtures.mjs'

// The "Onderliggende code" card used to render "code laden…" for ANY child with
// falsy code, conflating "still loading" with "loaded but genuinely empty" — an
// empty child stayed on "code laden…" forever. The child descriptors now carry a
// `loading` flag (home.mjs) so the panel can show a final "geen code gevonden"
// state (data-testid=related-empty) once a load has finished empty.
test.describe('PR Review Tree — related child with empty code', () => {
  // Embedded case: a resolved method_call child's code rides along in the
  // callresolve row (no lazy /api/code fetch), so an empty childCode is a final
  // state the moment the panel renders — never "code laden…". PR 96 seeds one
  // caller with one resolved call whose childCode is "".
  test('a method_call child with empty embedded code shows "geen code gevonden" immediately', async ({
    page,
  }) => {
    await page.goto('/pr/96')

    const item = page.getByTestId('related-item')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('GammaTarget::resolveGamma')

    // The final empty state, not the loading placeholder.
    await expect(page.getByTestId('related-empty')).toBeVisible()
    await expect(page.getByTestId('related-empty')).toContainText('geen code gevonden')
    await expect(item).not.toContainText('code laden…')
  })

  // Lazy case: a relation child (a real PR block) loads its code via /api/code
  // (ensureCode). PR 90's child block has no worktree on disk, so that fetch
  // completes with an error/empty text — before the fix this was exactly the
  // "code laden… forever" symptom; now it must converge on "geen code gevonden".
  test('a lazy PR-block child whose code load finishes empty converges on "geen code gevonden"', async ({
    page,
  }) => {
    await page.goto('/pr/90')

    const item = page.getByTestId('related-item')
    await expect(item).toContainText('SendOrderMail::handle')

    // The load completes (quickly — the worktree is missing) and settles on the
    // final empty state instead of hanging on "code laden…".
    await expect(page.getByTestId('related-empty')).toBeVisible()
    await expect(item).not.toContainText('code laden…')
  })
})
