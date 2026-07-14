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

  // Clicking an "Onderliggende code" item drills into it — the same drillIntoChild
  // path Enter takes on a focused child — opening it as its own diff column
  // (data-testid=drill-column) between the diff and the RelatedPanel.
  test('clicking an underlying-code item opens it as a drill column', async ({ page }) => {
    await page.goto('/pr/90')

    const child = page.getByTestId('related-item')
    await expect(child).toContainText('SendOrderMail::handle')
    const drill = page.getByTestId('drill-column')
    await expect(drill).toHaveCount(0)

    await child.click()

    await expect(drill).toHaveCount(1)
    await expect(drill).toContainText('SendOrderMail::handle')
  })

  // The "Onderliggende code" panel must FOLLOW the selected block. PR 91 has two
  // independent caller blocks (AlphaAction::run, BetaAction::run), each with its own
  // seeded resolved method-call child (tests/fixtures/callresolve.json); selecting a
  // different block must swap the panel to that block's child.
  //
  // This guards the contract broken by a real bug: the panel used to freeze on
  // whichever block was selected at page load and never follow the cursor. That was
  // an arrow.js reactivity artifact — the watch feeding setRelated buried its reads
  // inside relatedChildren()/unresolvedCalls() (which have early-returns), so its
  // settled dependency set dropped state.selected and it stopped re-firing. The fix
  // lists the navigation state inline in the watch getter (see home.mjs). NB: the
  // freeze itself only manifests with real-data load timing (callResolve + code
  // arriving in separate ticks), so this fixture test checks the behaviour, not that
  // exact timing; the fix was verified end-to-end against a real PR.
  test('the underlying-code panel follows the selected block (does not freeze)', async ({
    page,
  }) => {
    await page.goto('/pr/91')

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    const alpha = rows.filter({ hasText: 'AlphaAction::run' })
    const beta = rows.filter({ hasText: 'BetaAction::run' })

    // Select Alpha → its resolved call (and only its call) shows in the panel.
    await alpha.click()
    const item = page.getByTestId('related-item')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('AlphaTarget::resolveAlpha')

    // Selecting Beta must swap the panel to Beta's call — not stay on Alpha's.
    await beta.click()
    await expect(item).toHaveCount(1)
    await expect(item).toContainText('BetaTarget::resolveBeta')
    await expect(page.getByTestId('related-code')).not.toContainText('AlphaTarget')

    // And back again, to prove it tracks in both directions.
    await alpha.click()
    await expect(item).toContainText('AlphaTarget::resolveAlpha')
    await expect(page.getByTestId('related-code')).not.toContainText('BetaTarget')
  })
})
