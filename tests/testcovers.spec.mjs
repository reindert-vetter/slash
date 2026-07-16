import { test, expect } from './_fixtures.mjs'

// PR 92 (tests/fixtures/testcovers-blocks.json + testcovers.json) has a test
// block (OrderCoverageTest::testBillingAddress) whose #[CoversMethod] was
// resolved statically to a production method (Order::billingAddress) that is
// ALSO changed in this PR. Both directions of the coverage link must show:
// the test's "Onderliggende code" lists the covered method, and — recursing
// via a drill — the covered method's own "Onderliggende code" lists the test
// that covers it back.
test.describe('PR Review Tree — test coverage', () => {
  test('a test covers a production method — both directions show, and drilling recurses', async ({
    page,
  }) => {
    await page.goto('/pr/92')

    // Test coverage hides NEITHER side: both the covering test AND the covered
    // production method stay in the left list. The covered method is a changed,
    // primary reviewable block (unlike a call-target or listener from an
    // unchanged file), so a test must never make it vanish from the tree.
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'OrderCoverageTest::testBillingAddress' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Order::billingAddress' })).toHaveCount(1)

    // Direction 1 (test → geteste methode): with the test selected, the covered
    // method shows as underlying code, with a diff-stat (it's changed too).
    await rows.filter({ hasText: 'OrderCoverageTest::testBillingAddress' }).click()
    const child = page.getByTestId('related-item')
    await expect(child).toHaveCount(1)
    await expect(child).toContainText('Order::billingAddress')
    await expect(child).toContainText('app/Models/Order.php')

    // Drilling into it opens it as its own diff column — direction 2
    // (geteste productiemethode → dekkende test) then shows the covering test
    // back in ITS OWN "Onderliggende code" panel.
    await child.click()
    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('Order::billingAddress')

    const drilledChild = page.getByTestId('related-item')
    await expect(drilledChild).toHaveCount(1)
    await expect(drilledChild).toContainText('OrderCoverageTest::testBillingAddress')
  })

  // PR 93 has two tests: one with no coverage annotation at all (permanent
  // warning, never sent to an LLM) and one whose class-level-only annotation
  // (#[CoversClass]) the LLM search could not pin to a specific method
  // (notfound) — both show the warning icon, with different wording.
  test('a test with no usable coverage annotation shows the warning (two variants)', async ({
    page,
  }) => {
    await page.goto('/pr/93')

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    const warning = page.getByTestId('related-covers-warning')

    await rows.filter({ hasText: 'UnannotatedTest::testSomethingWithoutCoverage' }).click()
    await expect(warning).toHaveCount(1)
    await expect(warning).toContainText('geen #[CoversMethod]/@covers gevonden')

    await rows.filter({ hasText: 'NotfoundTest::testClassLevelOnly' }).click()
    await expect(warning).toHaveCount(1)
    await expect(warning).toContainText('#[CoversClass] gevonden')
  })

  // PR 94 has a test whose class-level-only annotation was resolved by the
  // LLM (status "found") — the child carries the "bron: sonnet" badge, the
  // same pattern as an LLM-found method_call child.
  test('an LLM-found class-level coverage child shows the bron badge', async ({ page }) => {
    await page.goto('/pr/94')

    await page.getByTestId('block-row').filter({ hasText: 'FoundTest::testFound' }).click()
    const child = page.getByTestId('related-item')
    await expect(child).toHaveCount(1)
    await expect(child).toContainText('Invoice::total')
    await expect(child).toContainText('bron: sonnet')
    await expect(page.getByTestId('related-covers-warning')).toHaveCount(0)
  })
})
