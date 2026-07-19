import { test, expect } from './_fixtures.mjs'

// Repro for: placing a comment while a drilled column (Onderliggende code
// opened as its own diff column) is focused must reference *that* column's
// block + unit, not the top-level selected block's — see
// commentTarget()/focusedBlock() in home.mjs and placeComment()/
// commentsSection() in RelatedPanel.mjs.
//
// Setup mirrors tests/drill-focus.spec.mjs: PR 12903, a synthetic relation
// nesting Order::address under CreatePaymentAction::execute, both real PR
// blocks with real diffs.
async function drillIntoAddress(page) {
  await page.route('**/api/blocks?pr=12903', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const b of json) {
      if (b.class === 'Order' && b.name === 'address') b.status = 'modified'
    }
    await route.fulfill({ response: res, json })
  })
  await page.route('**/api/relations?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          parentId: '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute',
          childId: '12903:app/Models/Order.php:Order::address',
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
  await page.keyboard.press('ArrowRight') // enter the parent's own diff
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item')
  await expect(child).toContainText('address')
  await child.click()

  const drillColumn = page.getByTestId('drill-column')
  await expect(drillColumn).toHaveCount(1)
  await page.waitForTimeout(300)
  return drillColumn
}

async function ensureSidebarOpen(page) {
  if ((await page.getByTestId('comments-sidebar').count()) === 0) {
    await page.keyboard.press('Meta+ArrowRight')
  }
}

test('composing a comment while a drilled column is focused targets that column, not the top-level block', async ({
  page,
}) => {
  await drillIntoAddress(page)

  await ensureSidebarOpen(page)
  if ((await page.getByTestId('comment-compose').count()) === 0) {
    await page.getByTestId('new-comment').click()
  }

  const hint = page.getByTestId('comment-target')
  await expect(hint).toBeVisible()
  // The label must be the drilled child's class::method, not the top-level
  // block's (CreatePaymentAction::execute).
  await expect(hint).toContainText('Order::address')
  await expect(hint).not.toContainText('CreatePaymentAction::execute')

  // The "Nieuwe comment · <file>:<line>" thread header must reference the
  // drilled child's file too.
  await expect(page.getByTestId('comment-thread')).toContainText('Order.php')
  await expect(page.getByTestId('comment-thread')).not.toContainText('CreatePaymentAction.php')

  // The drilled column landed on a single-line group.
  await expect(hint).toContainText('een groep wijzigingen')

  // Placing it now must save+anchor on Order.php, not the top-level block's file.
  await page.getByTestId('comment-compose').fill('drilled column comment')
  await page.getByTestId('comment-send').click()
  await page.getByText('Alleen voor mijzelf').click()

  const item = page
    .getByTestId('comments-sidebar')
    .getByTestId('comment-item')
    .filter({ hasText: 'drilled column comment' })
  await expect(item).toHaveCount(1, { timeout: 4000 })
  await expect(item.getByTestId('comment-meta')).toContainText('Order.php')
  await expect(item.getByTestId('comment-meta')).not.toContainText('CreatePaymentAction.php')
})
