import { test, expect } from './_fixtures.mjs'

// A <class-header> block whose class has ANOTHER changed (non-header) block in
// this PR must not show up as its own row in the index — its member cards
// attach to that sibling instead (resolveClassMembers, backend rule 9, +
// swallowedClassHeaderIds in home.mjs). Explicit request: "laat de headerkaart
// alleen zien als je het echt niet onder aangepaste code kan plaatsen." A
// class with ONLY a header change (no sibling) keeps the pre-existing
// behaviour — the header stays visible with its own member card. Backend
// attachment itself is covered by TestResolveClassMembersAttachedToSibling/
// TestResolveClassMembersAttachedToEverySibling (callresolve_analysis_test.go);
// this spec seeds the callresolve rows directly (like related-class-members.
// spec.mjs) to prove the render/index contract on top of that.

test('a class-header with a changed sibling hides from the index, its members attach to the sibling', async ({
  page,
}) => {
  await page.goto('/pr/114')

  // The header itself never gets a row — only the sibling ACTION block does.
  await expect(page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::run' })).toHaveCount(1)
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::<class-header>' }),
  ).toHaveCount(0)
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow' }).filter({ hasText: 'Class-header' }),
  ).toHaveCount(0)

  await page.getByTestId('block-row').filter({ hasText: 'ImportSubscriptionStatsFlow::run' }).click()
  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('ImportSubscriptionStatsFlow::BATCH_SIZE')
  await expect(item).toContainText('BATCH_SIZE = 100')
})

test('a class-header with NO changed sibling stays visible with its own member card', async ({ page }) => {
  await page.goto('/pr/114')

  const headerRow = page.getByTestId('block-row').filter({ hasText: 'LonelyHeaderFlow' })
  await expect(headerRow).toHaveCount(1)

  await headerRow.click()
  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('LonelyHeaderFlow::NAME')
  await expect(item).toContainText("NAME = 'lonely'")
})

// The swallow needs POSITIVE evidence that the members really landed on a
// sibling: at least one class_member: callresolve row on that sibling. A class
// with a changed header AND a changed sibling but NO such row (the resolve_call
// workflow hasn't run yet, failed, or the backend deliberately kept the header
// as its own caller because its own member changed — headerHasOwnChange,
// callresolve_analysis.go) keeps its header as a normal, approvable index row.
test('a class-header whose members did NOT land on a sibling stays in the index', async ({ page }) => {
  await page.goto('/pr/114')

  await expect(page.getByTestId('block-row').filter({ hasText: 'NoCardsFlow::run' })).toHaveCount(1)
  await expect(
    page.getByTestId('block-row').filter({ hasText: 'NoCardsFlow' }).filter({ hasText: 'Class-header' }),
  ).toHaveCount(1)
})
