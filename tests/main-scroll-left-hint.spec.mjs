import { test, expect } from './_fixtures.mjs'

// Reviewer request: the left-hand mirror of MainScrollRightHint
// (main-scroll-right-hint.spec.mjs) — a single, always-in-place button
// (data-testid=main-scroll-left-hint/-button) replacing the old two-icon
// diff-leave-rail (block-leave-diff + block-open-description) that used to
// be glued to the top-level diff card. It stays visible as long as there's
// a further column to reveal to the LEFT of whatever currently owns the
// keyboard, and each click steps back exactly ONE stop — the same thing a
// single ← already does — never a "jump straight to stop 1" shortcut:
// diff (stop 3) -> block list (stop 2) -> PR description (stop 1) ->
// /pr-overview.

test('a left-edge hint steps back one stop per click: diff -> list -> description', async ({ page }) => {
  await page.goto('/pr/12903')

  const hint = page.getByTestId('main-scroll-left-hint')
  const button = page.getByTestId('main-scroll-left-button')

  // Fresh load: list mode, description not open — there's still the
  // description column left to reveal, so the hint already shows.
  await expect(hint).toBeVisible()

  // ContractController::index has no local diff of its own, so entering the
  // diff and stepping back out leaves no stray `[data-change-active]` from a
  // look-ahead preview to confuse the assertion below (see "Sort order of
  // the left list" in blocks-and-ingest.md for why a block's sidebar
  // position says nothing about whether it carries a diff).
  const rows = page.getByTestId('block-row')
  await rows.filter({ hasText: 'ContractController::index' }).click()
  await page.keyboard.press('ArrowRight') // enter the diff (stop 3)
  await page.waitForTimeout(150)

  await expect(page.getByTestId('block-column')).toBeVisible()
  await expect(hint).toBeVisible()

  // Click 1: same end state as a single ← at the top level — back to the
  // block list (stop 2), the diff no longer owns the keyboard.
  await button.dispatchEvent('click')
  await page.waitForTimeout(150)
  await expect(page.getByTestId('pr-index')).toBeVisible()
  await expect(page.locator('[data-change-active]')).toHaveCount(0)

  // Still something further left (the PR description isn't open yet).
  await expect(hint).toBeVisible()

  // Click 2: steps from the list into stop 1, exactly like ← would there.
  await button.dispatchEvent('click')
  await page.waitForTimeout(150)
  await expect(page.getByTestId('pr-info-column')).toBeVisible()

  // Nothing left on this page, but the button stays: its next step leaves
  // for /pr-overview, exactly like ← at stop 1 (overviewExitUrl).
  await expect(hint).toBeVisible()
  await expect(button).toHaveAttribute('title', /PR-overzicht|PR overview/)

  // Click 3: exits to the PR overview, handing the PR + selection back.
  await button.dispatchEvent('click')
  await page.waitForURL(/\/pr-overview\?pr=.*&sel=/)
})

test('never shown for a drilled column — that keeps its own close-column button', async ({ page }) => {
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
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)

  const child = page.getByTestId('related-item').first()
  await expect(child).toContainText('findOrCreateCustomer')
  await child.click()
  await page.waitForTimeout(300)

  await expect(page.getByTestId('drill-column')).toHaveCount(1)
  await expect(page.getByTestId('main-scroll-left-hint')).toBeHidden()
  await expect(page.getByTestId('block-close-column')).toBeVisible()
})
