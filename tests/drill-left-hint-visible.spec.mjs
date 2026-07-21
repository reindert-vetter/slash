import { test, expect } from './_fixtures.mjs'

// Verifies that the ‹-chevron hint (drill-left-hint) rendered just outside
// the focused drilled column's own left edge stays visible after drilling —
// not clipped by <main>'s overflow-x-auto. See the scroll-ml-4 comment on
// drillColumnCls in home.mjs: without that scroll-margin,
// scrollFocusIntoView's scrollIntoView({inline:'start'}) aligns the column's
// own box flush with <main>'s inner-left edge, which pushes the chevron
// (absolutely positioned 12px further left) mostly behind that edge.
//
// A plain `getBoundingClientRect().left >= 0` check would NOT catch this: the
// coordinate is relative to the whole browser viewport, and <main> itself
// sits at a positive left offset on the page (list/diff-mode padding), so the
// chevron's rect.left stays positive even when it's fully hidden behind
// <main>'s own clipping edge. Instead this measures the actual rendered
// intersection ratio (IntersectionObserver, which — unlike a raw rect check —
// accounts for ancestor `overflow` clipping), and compares it against <main>'s
// own bounding box.
//
// Fixture setup mirrors drill-open-animation.spec.mjs: PR 12903 (the only
// fixture PR backed by a real worktree) with a synthetic relation nesting
// findOrCreateCustomer under CreatePaymentAction::execute.
test('drill-left-hint chevron stays visible (not clipped by <main>) after drilling in', async ({ page }) => {
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

  const hint = page.getByTestId('drill-left-hint')
  await expect(hint).toBeVisible()

  // Give the deferred (requestAnimationFrame) scrollFocusIntoView call time
  // to settle before measuring.
  await page.waitForTimeout(300)

  const ratio = await hint.evaluate(
    (el) =>
      new Promise((resolve) => {
        const obs = new IntersectionObserver((entries) => {
          resolve(entries[0].intersectionRatio)
          obs.disconnect()
        })
        obs.observe(el)
      }),
  )
  // Without the scroll-ml-4 fix this comes out ~0.1 (only its rightmost sliver
  // peeking out from behind <main>'s left edge); with it, ~0.9 (the small
  // remaining gap is a sub-pixel rounding artifact of scrollIntoView's
  // alignment, not a regression).
  expect(ratio).toBeGreaterThan(0.75)
})
