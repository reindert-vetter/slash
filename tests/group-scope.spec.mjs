import { test, expect } from './_fixtures.mjs'

// PR 12903's CreatePaymentAction::execute is the block conventions.md anchors
// diff-navigation tests on — it reliably carries exactly one real changed
// line (see conventions.md's "Data-kanttekening"). tests/fixtures/blocks.json
// seeds two extra, otherwise-unused child blocks under this PR
// (GroupScopeChildA/B); tests/fixtures/relations.json links both as
// event_listener children of `execute`, one (`A`) anchored (via the `line`
// field, see relations.go's matchLine) on that one real changed line, the
// other (`B`) on an unrelated line elsewhere in the block's body. Both also
// sit at the bottom of the left list under the "Onderliggende code" heading
// (relation children stay navigable index rows, see recomputeLeftList in
// home.mjs); blocks.spec.mjs's fixture-order list includes them.
const DEEP_LINK = '/pr/12903?mode=diff&sel=app%2FActions%2FCreatePaymentAction.php%3A26'

test.describe('PR Review Tree — group/line/call all hide out-of-scope relation children', () => {
  // "If I select a group" (the default granularity on entering a diff):
  // a relation child outside the selected group's line range is now HIDDEN
  // outright — the same hard filter as line/call, no longer merely sorted
  // below the in-scope one (see groupTierForLine/relatedChildren in home.mjs
  // and "Onderliggende-code scoping" in detail-layout.md).
  test('group granularity hides out-of-scope relation children outright, like line/call', async ({
    page,
  }) => {
    await page.goto(DEEP_LINK) // default gran is 'group', default chg is 0
    await expect(page.getByTestId('block-column')).toBeVisible()

    const items = page.getByTestId('related-item')
    // ChildA's relation line (67) sits inside the selected group's line range
    // (the block's one real changed line) → groupTier 0, stays visible.
    // ChildB (line 30, elsewhere in the block) is now hidden entirely.
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('GroupScopeChildA')
  })

  // "If I select a line, then I only want to see underlying code of
  // that line" — at 'line' granularity a relation child is HIDDEN outright
  // (relatedChildren's `scoped` flag), regardless of how close its own
  // relation line sits to the selected line. Only method-call children can
  // ever show at this fine a level.
  test('line granularity hides relation children outright, regardless of their line', async ({
    page,
  }) => {
    await page.goto(DEEP_LINK + '&gran=line')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)
  })

  // "…netzo met call" — same hard hide one level finer.
  test('call granularity also hides relation children outright', async ({ page }) => {
    await page.goto(DEEP_LINK + '&gran=call')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)
  })
})
