import { test, expect } from './_fixtures.mjs'

// Task 37: a self-referencing relation edge (parentId === childId — a
// backend detector matching a block's own trigger back to itself, e.g. a
// recursive dispatch) made childrenOf() (home.mjs) list the SELECTED block
// as its own Onderliggende-code child: same title, same file:line, its own
// code — a literal duplicate of the card being viewed, with no self-loop
// guard (unlike nestedChangedKids' existing `kid.id === parentId` check).
// Reported live (screenshot: .claude/scratch/child-card-wider-than-selected.png),
// see the (now resolved) "Open investigation" section in
// .claude/docs/drilling.md for the two static candidates and how this one
// was confirmed by mocking a self-loop /api/relations row on the existing
// PR 12903 fixture (mirrors drill-preview.spec.mjs's fixture-override style).
test('a self-referencing relation edge does not list the block as its own child', async ({ page }) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          kind: 'event_listener',
        },
      ],
    })
  })

  await page.goto('/pr/12903')

  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)

  // No self-loop relation child ever shows up in the Onderliggende-code list —
  // the panel is empty for this block otherwise (its only relation is the
  // self-loop, filtered out; it has no resolved calls/test-covers here).
  await expect(page.getByTestId('related-item')).toHaveCount(0)
})
