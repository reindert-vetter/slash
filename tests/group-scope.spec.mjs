import { test, expect } from './_fixtures.mjs'

// PR 12903's CreatePaymentAction::execute is the block conventions.md anchors
// diff-navigation tests on — it reliably carries exactly one real changed
// line (see conventions.md's "Data-kanttekening"). tests/fixtures/blocks.json
// seeds two extra, otherwise-unused child blocks under this PR
// (GroupScopeChildA/B); tests/fixtures/relations.json links both as
// event_listener children of `execute`, one (`A`) anchored (via the new
// `line` field, see relations.go's matchLine) on that one real changed line,
// the other (`B`) on an unrelated line elsewhere in the block's body. Both are
// hidden from the left list as usual (they are relation children), so this
// doesn't disturb blocks.spec.mjs's exact-9-row fixture.
const DEEP_LINK = '/pr/12903?mode=diff&sel=app%2FActions%2FCreatePaymentAction.php%3A26'

test.describe('PR Review Tree — line/call hide vs group reorder scoping', () => {
  // "Als ik een group selecteer" (the default granularity on entering a diff):
  // a relation child outside the selected group's line range is NOT dropped
  // from the panel — it just sorts below the in-scope one ("group blokken
  // bovenaan, en dan daaronder wat niet in de blok zit").
  test('group granularity reorders in-scope relation children above out-of-scope ones (does not hide)', async ({
    page,
  }) => {
    await page.goto(DEEP_LINK) // default gran is 'group', default chg is 0
    await expect(page.getByTestId('block-column')).toBeVisible()

    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(2)
    // ChildA's relation line (67) sits inside the selected group's line range
    // (the block's one real changed line) → groupTier 0, sorts first. ChildB
    // (line 30, elsewhere in the block) is not hidden, only reordered below it.
    await expect(items.nth(0)).toContainText('GroupScopeChildA')
    await expect(items.nth(1)).toContainText('GroupScopeChildB')
  })

  // "Als ik een line selecteer, dan wil ik alleen onderliggende code zien van
  // die line" — at 'line' granularity a relation child is HIDDEN outright
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
