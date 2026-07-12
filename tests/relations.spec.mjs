import { test, expect } from '@playwright/test'

// PR 90 (tests/fixtures/relations-blocks.json + relations.json) has two blocks:
// a dispatcher (PlaceOrderAction::execute) and a listener (SendOrderMail::handle).
// A seeded event_listener relation makes the listener a CHILD of the dispatcher,
// so it is pulled out of the left list and shown in the RelatedPanel instead.
test.describe('PR Review Tree — block relations', () => {
  test('a child block leaves the left list and nests under its parent on the right', async ({
    page,
  }) => {
    await page.goto('/pr/90')

    // Only the parent (non-child) block remains in the left list.
    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0)).toContainText('PlaceOrderAction::execute')
    await expect(page.getByTestId('block-row')).not.toContainText('SendOrderMail::handle')

    // The child shows in the "Onderliggende code" panel (top-right of the block).
    const related = page.getByTestId('related-code')
    await expect(related).toContainText('Onderliggende code')
    const child = page.getByTestId('related-item')
    await expect(child).toHaveCount(1)
    await expect(child).toContainText('SendOrderMail::handle')
    await expect(child).toContainText('app/Listeners/SendOrderMail.php')
  })
})
