import { test, expect } from './_fixtures.mjs'

// PR 119 (materializeWhenScopeWorktrees, tests/_setup.mjs) seeds a
// class-level #[CoversMethod] on WhenScopeTest::it_computes_twice — its
// testcovers.json entry carries no `line` at all, the same shape
// testcovers_analysis.go's classZoneText fallback produces for a real
// class-level annotation (see 121be8d). Without a natural single anchor
// line, testCoverGroupTier (home.mjs) scopes the covers child to the test's
// own "// When" section (whenSectionRows) instead of showing it on every
// group unconditionally.
//
// The seeded test method has TWO separate Given/When/Then cycles and is
// entirely `added`, so MAX_GROUP (5, Block.mjs's changeGroups) splits its 24
// rows into 5 groups — see materializeWhenScopeWorktrees' own doc comment
// for the exact row/group layout. The two "// When" STATEMENT rows (10, 18)
// land in two DIFFERENT groups (G2, G3): a genuine straddle, not just "the
// first When found". The comment rows themselves (9, 17, inside G1/G3) must
// never show the card on their own — only the statement that follows.
const SEL =
  'sel=testclass%3Atests%2FFeature%2FWhenScopeTest.php%3A%3AWhenScopeTest' +
  '&tmethod=tests%2FFeature%2FWhenScopeTest.php%3A13'
const BASE = `/pr/119?mode=diff&${SEL}`

test.describe('a class-level #[CoversMethod] covers child scopes to the test\'s own "// When" section', () => {
  test('hidden on Given/comment/Then groups, shown on both // When groups (straddling)', async ({
    page,
  }) => {
    // G0 — #[Test]/signature/{/"// Given"/$subject=... — before either // When.
    await page.goto(BASE + '&chg=0')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    // G1 — $b/$c/$d/blank/the FIRST "// When" COMMENT itself — its own
    // statement sits in G2, so the comment row alone must not show the card.
    await page.goto(BASE + '&chg=1')
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    // G2 — the first "// When" statement's own row (10).
    await page.goto(BASE + '&chg=2')
    const items2 = page.getByTestId('related-item')
    await expect(items2).toHaveCount(1)
    await expect(items2.nth(0)).toContainText('WhenScopeSubject::compute')

    // G3 — the SECOND "// When" statement's own row (18) — a different
    // group than G2, proving whenSectionRows unions every "// When"
    // occurrence rather than only the first.
    await page.goto(BASE + '&chg=3')
    const items3 = page.getByTestId('related-item')
    await expect(items3).toHaveCount(1)
    await expect(items3.nth(0)).toContainText('WhenScopeSubject::compute')

    // G4 — "// Then" + both assertions + the closing brace.
    await page.goto(BASE + '&chg=4')
    await expect(page.getByTestId('related-item')).toHaveCount(0)
  })

  test('list mode stays unscoped — the covers child always shows', async ({ page }) => {
    await page.goto('/pr/119')
    await page.getByTestId('block-row').filter({ hasText: 'WhenScopeTest' }).click()
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('WhenScopeSubject::compute')
  })
})
