import { test, expect } from './_fixtures.mjs'

// Verifies the small one-shot entrance animation on a newly-opened drilled
// Onderliggende-code column (see the drillOpenMarker comment in home.mjs +
// the .drill-enter keyframes in index.html): the animation class is present
// right after drilling in, and a plain navigation step *inside* that column
// (ArrowDown — same drill entry, same .key(...)) must NOT remount the node
// (and thus must not replay the animation). Node identity is proven with an
// ad-hoc marker attribute set imperatively right after opening: a remount
// would lose it, since it's not part of arrow.js's own render output.
//
// Fixture setup mirrors drill-focus.spec.mjs: PR 12903 (the only fixture PR
// backed by a real worktree) with a synthetic relation nesting
// findOrCreateCustomer under CreatePaymentAction::execute.
test('drilling in animates once and does not replay on a later navigation step', async ({ page }) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
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
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)

  // 1. The freshly-mounted column carries the entrance-animation class.
  await expect(drillColumn).toHaveClass(/drill-enter/)

  // Tag the live DOM node with an ad-hoc marker — arrow.js's own render never
  // sets this, so it only survives if the node is reused/patched, not
  // recreated, by the next render pass.
  await drillColumn.evaluate((el) => el.setAttribute('data-node-marker', 'same-node'))

  // 2. A plain navigation step within the drilled column (its own change-group
  // cursor, not a fresh drillIntoChild) must not remount the column: the
  // marker survives, proving no new node — and thus no animation replay —
  // was created.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillColumn).toHaveAttribute('data-node-marker', 'same-node')
})
