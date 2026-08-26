import { test, expect } from './_fixtures.mjs'

// Since splitClassHeaderMembers (phpscan.go) a class's constants/properties are
// no longer part of the one coarse <class-header> block: each is a PR block of
// its own, with its own diff, approval and index row. Explicit request: "header
// moet opgedeeld worden in losse blokken die per stuk goedgekeurd moeten
// worden."
//
// What this spec pins is the INDEX/render contract on top of that split:
//   - a member block referenced from a changed method loses its own index row
//     and shows under that method instead. That it renders as a REAL block
//     child there (own diff, approval, drill-down) rather than the read-only
//     leaf a member used to be is deliberately NOT asserted here: this fixture
//     seeds no worktree, so every child's diff/approval total is 0 either way
//     and the two branches are visually identical. The index row disappearing
//     IS the discriminator — only a child that resolves to a real PR block
//     reaches resolvedCallTargetIds at all.
//   - the <class-header> block that remains (a class's `use Trait;` statements)
//     stays a normal, visible, approvable row — the old
//     "swallowedClassHeaderIds" hiding of it is gone;
//   - an UNCHANGED constant is no block at all and still renders as a
//     read-only leaf.
//
// Backend attachment itself is covered by TestResolveClassMembersAttachedToSibling/
// TestResolveClassMembersAttachedToEverySibling/
// TestResolveClassMembersChangedMemberAttachesToSibling
// (callresolve_analysis_test.go); this spec seeds the blocks and callresolve
// rows directly (like related-class-members.spec.mjs).

test('a changed member block leaves the index and shows under the method that uses it', async ({ page }) => {
  await page.goto('/pr/114')

  // The member has no row of its own — it surfaces under `run` instead.
  await expect(page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::run' })).toHaveCount(1)
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::BATCH_SIZE' }),
  ).toHaveCount(0)
  // What is left of the header (its trait uses) keeps its own approvable row.
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow' }).filter({ hasText: 'Class-header' }),
  ).toHaveCount(1)

  await page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::run' }).click()
  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('ImportSubscriptionStatsFlow::BATCH_SIZE')
})

test('an unchanged constant is no block and stays a read-only leaf card', async ({ page }) => {
  await page.goto('/pr/114')

  const headerRow = page.getByTestId('block-row').filter({ hasText: 'LonelyHeaderFlow' })
  await expect(headerRow).toHaveCount(1)

  await headerRow.click()
  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('LonelyHeaderFlow::NAME')
  await expect(item).toContainText("NAME = 'lonely'")
  // No block of its own, so it never left the index — it was never in it.
  await expect(page.getByTestId('block-row').filter({ hasText: 'LonelyHeaderFlow::NAME' })).toHaveCount(0)
})

// A <class-header> block is never hidden any more, with or without member
// cards on a sibling — its remaining content is real changed code that must
// stay approvable.
test('a class-header with a changed sibling but no member cards stays in the index', async ({ page }) => {
  await page.goto('/pr/114')

  await expect(page.getByTestId('block-row').filter({ hasText: 'NoCardsFlow::run' })).toHaveCount(1)
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'NoCardsFlow' }).filter({ hasText: 'Class-header' }),
  ).toHaveCount(1)
})
