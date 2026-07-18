import { test, expect } from './_fixtures.mjs'

// Verifies the drill-hint chips in the Onderliggende-code panel: a child card
// whose block itself has changed underlying code (nestedChangedKids in
// home.mjs) shows a dashed connector to a narrow chip column on its right
// (data-testid=related-nested) — one chip per changed grandchild with its
// title, file, change status and approval count — while a child without
// changed grandchildren shows no chips at all. Clicking a chip drills TWO
// levels in one go: the child's own column plus the grandchild's column
// (stopPropagation keeps the card's one-level drill out of it).
//
// Uses PR 12903 with routed relations (the drill-collapse.spec.mjs pattern):
// execute → findOrCreateCustomer → ProcessCartAction::handle gives the
// findOrCreateCustomer card a chip for handle; execute → handle directly
// makes handle a sibling card WITHOUT chips (it has no children of its own —
// the routed relations replace the seeded ones, and the seeded callresolve/
// testcovers fixtures carry no PR-12903 rows). /api/blockstats is routed too
// so the chip's approval total is deterministic (independent of the local
// worktree contents).
const HANDLE_ID = '12903:app/Actions/ProcessCartAction.php:ProcessCartAction::handle'

test.describe('drill-hint chips next to Onderliggende-code cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/relations?pr=12903', async (route) => {
      await route.fulfill({
        json: [
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            childId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            kind: 'event_listener',
          },
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::findOrCreateCustomer',
            childId: HANDLE_ID,
            kind: 'event_listener',
          },
          {
            pr: 12903,
            parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
            childId: HANDLE_ID,
            kind: 'event_listener',
          },
        ],
      })
    })
    // Deterministic approval total for the chip target, regardless of what the
    // shared worktrees currently contain; every other block falls back to the
    // client-side count as usual.
    await page.route('**/api/blockstats?pr=12903', async (route) => {
      await route.fulfill({ json: { pr: 12903, totals: { [HANDLE_ID]: 4 } } })
    })
  })

  test('a child with changed underlying code gets a connector + chip; one without gets none', async ({
    page,
  }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    // Both children of execute render as cards; only findOrCreateCustomer —
    // which itself has a changed child (handle) — carries the chip column.
    const childCard = page
      .getByTestId('related-item')
      .filter({ hasText: 'findOrCreateCustomer' })
    await expect(childCard).toBeVisible()
    const nested = page.getByTestId('related-nested')
    await expect(nested).toHaveCount(1)
    // The chip column sits in the same flex row as the findOrCreateCustomer
    // card (its sibling), not inside any other card's row.
    await expect(childCard.locator('xpath=..').getByTestId('related-nested')).toHaveCount(1)

    // The chip names the grandchild: title (last :: segment), file basename,
    // change status and approval done/total.
    const chip = page.getByTestId('related-nested-chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText('handle')
    await expect(chip).toContainText('ProcessCartAction.php')
    await expect(chip.getByTestId('related-nested-status')).toHaveText('modified')
    await expect(chip.getByTestId('related-nested-approval')).toHaveText('0/4')

    // The handle card is a direct child too, but has no children of its own —
    // no connector/chips in its row.
    const handleCard = page
      .getByTestId('related-item')
      .filter({ hasText: 'ProcessCartAction::handle' })
    await expect(handleCard).toBeVisible()
    await expect(handleCard.locator('xpath=..').getByTestId('related-nested')).toHaveCount(0)
  })

  test('clicking a chip drills two levels deep in one go', async ({ page }) => {
    await page.goto('/pr/12903')

    const rows = page.getByTestId('block-row')
    await rows.filter({ hasText: 'CreatePaymentAction::execute' }).click()

    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)

    const chip = page.getByTestId('related-nested-chip')
    await expect(chip).toBeVisible()
    await chip.click()
    await page.waitForTimeout(300)

    // Two drill levels: the deepest (handle) keeps the focused drill-column
    // shape, the intermediate one (findOrCreateCustomer) collapsed to a rail,
    // and the top-level block collapsed too — exactly the two-level end state
    // of drill-collapse.spec.mjs, reached in a single chip click.
    const drillColumn = page.getByTestId('drill-column')
    await expect(drillColumn).toHaveCount(1)
    await expect(drillColumn).toContainText('ProcessCartAction')
    const level1Rail = page.locator('[data-testid="drill-collapsed"][data-drill-idx="0"]')
    await expect(level1Rail).toBeVisible()
    await expect(level1Rail).toContainText('findOrCreateCustomer')
    await expect(page.getByTestId('block-collapsed')).toBeVisible()
  })
})
