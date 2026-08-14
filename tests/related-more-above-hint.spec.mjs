import { test, expect } from './_fixtures.mjs'

// Selecting an Onderliggende-code child that sits BELOW another one scrolls it
// to the top of its column (alignToTopVertical, RelatedPanel.mjs), and every
// card the cursor has stepped past on the way down collapses to just its
// header (data-collapsed="true") — the code excerpt/drill-hint chips fall
// away. Stepping back up (↑) un-collapses it again. Reviewer request: "als ik
// van de eerste onderliggende code naar beneden ga, dan wil ik dat de
// bovenstaande blokken ingeklapt worden, en als ik naar boven ga, dan moet het
// weer uitgeklapt worden. onderstaande blokken moeten uitgevouwen zijn."
//
// Two sibling children of CreatePaymentAction::execute, mocked the same way
// tests/drill-sibling-walk.spec.mjs does it, so the panel has something to
// walk down through.
test('a card above the Onderliggende-code cursor collapses to its header, and un-collapses on ↑', async ({
  page,
}) => {
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Models/Order.php:Order::address',
          kind: 'event_listener',
        },
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
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()

  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight') // into the diff
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await page.keyboard.press('ArrowRight') // into the Onderliggende-code column

  const cards = page.getByTestId('related-item')
  await expect(cards).toHaveCount(2)
  // Both children's code loads asynchronously and relatedChildren's prio/size
  // sort can re-order once it lands — wait for it to settle before relying on
  // list position (same guard as tests/drill-sibling-walk.spec.mjs).
  await expect(cards.nth(0).locator('code.language-php')).toBeVisible()
  await expect(cards.nth(1).locator('code.language-php')).toBeVisible()

  // On the first child there is nothing above it — nothing collapsed.
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(cards.nth(0)).toHaveAttribute('data-collapsed', 'false')
  await expect(cards.nth(1)).toHaveAttribute('data-collapsed', 'false')

  // ↓ to the second child: the first card collapses to just its header (no
  // more code excerpt), the second stays expanded.
  await page.keyboard.press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(cards.nth(0)).toHaveAttribute('data-collapsed', 'true')
  await expect(cards.nth(0).locator('code.language-php')).toHaveCount(0)
  await expect(cards.nth(1)).toHaveAttribute('data-collapsed', 'false')
  await expect(cards.nth(1).locator('code.language-php')).toBeVisible()
  // The collapsed card's header (label) is still visible, and the selected
  // card is genuinely in view.
  await expect(cards.nth(0)).toBeVisible()
  await expect(cards.nth(1)).toBeInViewport()

  // ↑ walks back up: the first card un-collapses again.
  await page.keyboard.press('ArrowUp')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(cards.nth(0)).toHaveAttribute('data-collapsed', 'false')
  await expect(cards.nth(0).locator('code.language-php')).toBeVisible()
})
