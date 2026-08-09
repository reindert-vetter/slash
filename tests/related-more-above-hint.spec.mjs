import { test, expect } from './_fixtures.mjs'

// Selecting an Onderliggende-code child that sits BELOW another one scrolls it
// to the top of its column (alignToTopVertical, RelatedPanel.mjs) instead of
// merely into view, so it can't stay half out of sight — and a slim sticky
// header then says how many items sit above it ("▲ N hierboven",
// data-testid=related-more-above), since the list would otherwise read as if
// it started at the selected card. ↑ still walks back up. Reviewer request:
// "als ik een onderliggende code of comment blok selecteer die beneden een
// ander zit … dan wil ik dat die bovenaan komt te staan … zet een hint bovenin
// zodat we weten dat er nog iets boven staat".
//
// Two sibling children of CreatePaymentAction::execute, mocked the same way
// tests/drill-sibling-walk.spec.mjs does it, so the panel has something to
// walk down through.
test('the Onderliggende-code column shows a "hierboven" hint once the cursor moves down', async ({
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
  const hint = page.getByTestId('related-more-above')

  // On the first child there is nothing above it — no hint.
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(hint).toHaveCount(0)

  // ↓ to the second child: the hint appears and names how many sit above.
  await page.keyboard.press('ArrowDown')
  await expect(cards.nth(1)).toHaveAttribute('data-active', 'true')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('1 hierboven')
  // The word carries the meaning; the ▲ is the second, non-colour cue.
  await expect(hint).toContainText('▲')
  // The selected card is genuinely in view, not pushed below the fold.
  await expect(cards.nth(1)).toBeInViewport()

  // ↑ walks back up and the hint disappears again.
  await page.keyboard.press('ArrowUp')
  await expect(cards.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(hint).toHaveCount(0)

  // Leaving the panel (← back to the diff) drops the hint too — it only ever
  // describes the panel's own cursor.
  await page.keyboard.press('ArrowDown')
  await expect(hint).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(hint).toHaveCount(0)
})
