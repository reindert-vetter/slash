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

  // Same rule one granularity finer, on reviewer request (live PR 13431, the
  // `getJson(...)` line of an added test method): the per-line badge
  // (lineChildSummaries) already anchors such a covers child on every
  // "// When" STATEMENT row, so the panel must agree when the cursor sits on
  // exactly that row — it used to say "Geen onderliggende code." there,
  // because 'line'/'call' scoping dropped every covers child outright.
  // lineAnchoredTestCoverChildren (home.mjs) is the one exception; see
  // "A covers child stays visible at gran='line' on its own anchor row" in
  // .claude/docs/underlying-code.md.
  //
  // The line-unit indices come from the same 24-row layout the group test
  // above walks (this method is entirely `added`, so every row is its own
  // line unit): 8 = the first "// When" COMMENT, 9 = its statement,
  // 14 = the second "// When" comment, 15 = its statement.
  test('shown at gran=line on a // When statement row, hidden on the comment row and other lines', async ({
    page,
  }) => {
    const LINE = BASE + '&gran=line'

    // The first "// When" statement row — the covers child shows, exactly as
    // its per-line badge on that same row promises.
    await page.goto(LINE + '&chg=9')
    const items = page.getByTestId('related-item')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('WhenScopeSubject::compute')

    // The SECOND "// When" statement row too — whenSectionRows unions every
    // occurrence at this granularity as well, not only the first.
    await page.goto(LINE + '&chg=15')
    await expect(page.getByTestId('related-item')).toHaveCount(1)

    // The "// When" comment row itself stays empty ("cursor op de
    // comment-regel zelf toont de kaart niet").
    await page.goto(LINE + '&chg=8')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)

    // An ordinary Given line stays empty as well — this is an anchor-row
    // exception, not a return to "always visible".
    await page.goto(LINE + '&chg=5')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await expect(page.getByTestId('related-item')).toHaveCount(0)
  })
})
