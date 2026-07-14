import { test, expect } from './_fixtures.mjs'

// Verifies the new right-to-left drill-column keyboard navigation: after
// drilling, the keyboard focus lands on the new column's own diff (not its
// Onderliggende-code panel); ← steps focus back one column at a time WITHOUT
// closing the column; eventually ← returns to the original block's own diff,
// and one more ← exits to the list.
//
// Uses PR 12903 (the only fixture PR backed by a real worktree, so its blocks
// have real diffs) with a synthetic relation — injected by mocking
// /api/relations, no server-side seed change needed — nesting one of its
// existing blocks (findOrCreateCustomer) as a child of another
// (CreatePaymentAction::execute). Both are then real PR blocks with real
// change groups, so the drilled column is a genuine, navigable diff too.
test('drilled columns are navigable left/right with the keyboard', async ({ page }) => {
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

  const blockArticle = page.locator('[data-testid="block-column"] article').first()
  const drillColumn = page.getByTestId('drill-column')
  const drillArticle = drillColumn.locator('article').first()

  // Wait for the parent's diff to load, then step into it.
  const panel = page.getByTestId('detail-panel')
  await expect(panel.locator('code.language-php').first()).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  // Sanity: the top-level block's own diff owns the keyboard before drilling.
  await expect(blockArticle).toHaveClass(/border-indigo-300/)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()

  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)

  // 1. Focus lands on the NEW diff column, not its Onderliggende-code panel:
  // the drilled column's article carries the focused-diff border, the
  // top-level block's article no longer does, and no related-item shows the
  // "selected" ring (the panel isn't focused).
  await expect(drillArticle).toHaveClass(/border-indigo-300/)
  await expect(blockArticle).not.toHaveClass(/border-indigo-300/)
  const activeItem = page.locator('[data-testid="related-item"][data-active="true"]')
  await expect(activeItem).toHaveCount(0)

  // ↓ walks the drilled column's own change groups (its own cursor, not the
  // parent's state.change) without leaving the column or touching the parent.
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await expect(drillColumn).toHaveCount(1)
  await expect(drillArticle).toHaveClass(/border-indigo-300/)

  // 2. ← steps focus back onto the original block's diff — WITHOUT closing
  // the drilled column (it stays open, just dimmed).
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(1)
  await expect(blockArticle).toHaveClass(/border-indigo-300/)
  await expect(drillArticle).not.toHaveClass(/border-indigo-300/)

  // 3. One more ← drops back to the list (mode change) and clears the drill
  // stack — the existing diff→list behaviour, now also tearing down the
  // drilled columns that only make sense inside this diff session.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  await expect(drillColumn).toHaveCount(0)
  await expect(panel).toHaveClass(/left-\[29rem\]/)
})
