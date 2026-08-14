import { test, expect } from './_fixtures.mjs'

// Regression for a reported bug: a top-level (non-test) block whose ONLY
// resolved caller is a TEST method kept jumping in and out of "Onderliggende
// code" every ~5 seconds — the sidebar visibly reordering itself with the
// reviewer just sitting there. Root cause: home.mjs's blockIdPrefix()
// rebuilds the real PR-block-id prefix ("<pr>" for the primary repo, see
// model.go's Block.ID) by copying it off state.blocks[0] — but state.blocks[0]
// isn't always a real block. Once the target block sorts to the bottom under
// "Onderliggende code" (testCallTargetIds' own childIds), the synthetic
// test_class row (groupTestClasses/testClassRowItem, id "testclass:...")
// becomes state.blocks[0], corrupting the prefix used to reconstruct
// testCallTargetIds'/resolvedCallTargetIds' childId — which un-classifies the
// very block that just moved, sorting it back to the top, which restores a
// real state.blocks[0] on the NEXT recompute, and so on: a feedback loop that
// oscillates once per recomputeLeftList() call (the comment-poll's
// indexComments() watch fires every 5s, see RelatedPanel.mjs's refreshTimer).
// Fixed by reading state.allBlocks[0] instead — real PR blocks only, never a
// synthetic test_class/comment/push-todo row.
//
// Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json, see
// test-class-grouping.spec.mjs) already has exactly the two block shapes this
// bug needs: StoreHelper::buildPayload (category OTHER, a lone top-level
// block) and two TEST classes that group into their own test_class rows
// (TriggersIndexTest, SettingsStoreTest). /api/callresolve is mocked with one
// row a TEST method "calls" — SettingsStoreTest::it_should_store_settings ->
// StoreHelper::buildPayload, status resolved — which is exactly the
// "test directly calls the production method it exercises" case
// testCallTargetIds exempts from the resolvedCallTargetIds hiding rule and
// sorts under "Onderliggende code" instead (home.mjs, home.mjs's own doc
// comment on testCallTargetIds).
const PR = 110

test('a test-called block does not flicker in/out of "Onderliggende code" across repeated recomputes', async ({
  page,
}) => {
  await page.route(`**/api/callresolve?pr=${PR}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          pr: PR,
          callerId: `${PR}:tests/Feature/SettingsStoreTest.php:SettingsStoreTest::it_should_store_settings`,
          callKey: 'buildPayload',
          status: 'resolved',
          kind: 'method_call',
          childFile: 'tests/Feature/StoreHelper.php',
          childClass: 'StoreHelper',
          childMethod: 'buildPayload',
          childLine: 7,
          childCode: 'function buildPayload() {}',
          model: '',
          confidence: '',
          updatedAt: new Date().toISOString(),
        },
      ]),
    }),
  )

  await page.goto(`/pr/${PR}`)

  const storeHelperRow = page.getByTestId('block-row').filter({ hasText: 'StoreHelper::buildPayload' })
  const underlyingHeading = page.getByTestId('underlying-heading')

  // Give it a moment to settle on the correct classification once
  // /api/callresolve has landed: StoreHelper::buildPayload sits under
  // "Onderliggende code", not as its own top-level row.
  await expect(underlyingHeading).toBeVisible()
  await expect(storeHelperRow).toHaveCount(1)

  // Sample the classification across two full 5s comment-poll cycles
  // (RelatedPanel.mjs's refreshTimer), which is exactly the cadence the
  // reported bug oscillated on. Every sample must agree: the heading stays
  // visible and the row's position relative to it never flips.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(5500)
    await expect(underlyingHeading, `still under Onderliggende code at tick ${i}`).toBeVisible()
    await expect(storeHelperRow, `row still present at tick ${i}`).toHaveCount(1)
    const headingBox = await underlyingHeading.boundingBox()
    const rowBox = await storeHelperRow.boundingBox()
    expect(rowBox.y, `row stays BELOW the Onderliggende-code heading at tick ${i}`).toBeGreaterThan(headingBox.y)
  }
})
