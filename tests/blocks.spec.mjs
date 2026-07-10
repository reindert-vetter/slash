import { test, expect } from '@playwright/test'

// The fixture (tests/fixtures/blocks.json) has 9 blocks. They render sorted by
// (file, line); this is the expected label order. The first two share a file
// (CreatePaymentAction.php) — that adjacency drives the connector test.
const EXPECTED_LABELS = [
  'CreatePaymentAction::execute',
  'CreatePaymentAction::findOrCreateCustomer',
  'ProcessCartAction::handle',
  'AddressType::fromString',
  'ContractController::index',
  'Address::billingAddress',
  'Order::address',
  'up',
  'AddressTypeTest::test_it_casts_type',
]

test.describe('PR Review Tree — block list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('block-row')).toHaveCount(EXPECTED_LABELS.length)
  })

  test('renders header and all blocks in deterministic order', async ({ page }) => {
    await expect(page.getByText('Start — where do you want to begin?')).toBeVisible()
    await expect(page.getByText(`${EXPECTED_LABELS.length} starting points`)).toBeVisible()

    const rows = page.getByTestId('block-row')
    for (let i = 0; i < EXPECTED_LABELS.length; i++) {
      await expect(rows.nth(i)).toContainText(EXPECTED_LABELS[i])
    }

    // Category tags and status glyphs show up. The status is rendered as a mark
    // (see BlockList STATUS_STYLE): modified = -/+, added = +, removed = -. The
    // coloured status span is the only element in the row with that status colour.
    await expect(rows.nth(0)).toContainText('ACTION')
    await expect(rows.nth(0).locator('.text-amber-600')).toHaveText('-/+') // modified
    await expect(rows.nth(3)).toContainText('ENUM')
    await expect(rows.nth(3).locator('.text-emerald-600')).toHaveText('+') // added
    await expect(rows.nth(6).locator('.text-rose-600')).toHaveText('-') // removed
    await expect(rows.nth(7)).toContainText('MIGRATION')
  })

  test('arrow keys move the selection through the whole list', async ({ page }) => {
    const rows = page.getByTestId('block-row')
    const highlighted = page.locator('[data-testid="block-row"].bg-indigo-50')

    // First row selected by default.
    await expect(rows.nth(0)).toHaveClass(/bg-indigo-50/)

    // Walk down to the last row.
    for (let i = 1; i < EXPECTED_LABELS.length; i++) {
      await page.keyboard.press('ArrowDown')
      await expect(rows.nth(i)).toHaveClass(/bg-indigo-50/)
      await expect(highlighted).toHaveCount(1)
    }
    // Last row visible in the scroll viewport.
    await expect(rows.nth(EXPECTED_LABELS.length - 1)).toBeInViewport()

    // Clamp at the bottom.
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(EXPECTED_LABELS.length - 1)).toHaveClass(/bg-indigo-50/)

    // Walk back up to the top.
    for (let i = EXPECTED_LABELS.length - 2; i >= 0; i--) {
      await page.keyboard.press('ArrowUp')
      await expect(rows.nth(i)).toHaveClass(/bg-indigo-50/)
    }
    // Clamp at the top.
    await page.keyboard.press('ArrowUp')
    await expect(rows.nth(0)).toHaveClass(/bg-indigo-50/)
  })

  test('clicking a row selects it', async ({ page }) => {
    const rows = page.getByTestId('block-row')
    await rows.nth(4).click()
    await expect(rows.nth(4)).toHaveClass(/bg-indigo-50/)
  })

  test('detail panel shows the selected block card and the next one', async ({
    page,
  }) => {
    const panel = page.getByTestId('detail-panel')
    const cards = panel.locator('article')

    // Selected (0) + look-ahead (1) = two cards.
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[0])
    await expect(cards.nth(0)).toContainText('app/Actions/CreatePaymentAction.php:26')
    await expect(cards.nth(1)).toContainText(EXPECTED_LABELS[1])
    // The look-ahead card is dimmed.
    await expect(cards.nth(1)).toHaveClass(/opacity-50/)

    // Moving down advances the pair.
    await page.keyboard.press('ArrowDown')
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[1])
    await expect(cards.nth(1)).toContainText(EXPECTED_LABELS[2])

    // At the last row there is no look-ahead: a single card.
    for (let i = 1; i < EXPECTED_LABELS.length - 1; i++) {
      await page.keyboard.press('ArrowDown')
    }
    await expect(cards).toHaveCount(1)
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[EXPECTED_LABELS.length - 1])
  })

  test('dashed connector links two stacked cards from the same file', async ({
    page,
  }) => {
    const panel = page.getByTestId('detail-panel')
    const connector = panel.getByTestId('file-connector')

    // Rows 0 and 1 are both in CreatePaymentAction.php → connector shown.
    await expect(connector).toHaveCount(1)

    // Row 1 (findOrCreateCustomer) and row 2 (ProcessCartAction) differ → none.
    await page.keyboard.press('ArrowDown')
    await expect(connector).toHaveCount(0)

    // Back to the same-file pair → connector reappears.
    await page.keyboard.press('ArrowUp')
    await expect(connector).toHaveCount(1)
  })
})
