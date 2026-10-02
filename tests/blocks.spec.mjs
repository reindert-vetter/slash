import { test, expect } from './_fixtures.mjs'

// The fixture (tests/fixtures/blocks.json + relations.json) has 11 blocks.
// The left list first puts a fixed category tier on top (MIGRATION, ROUTE,
// CONTROLLER, REQUEST, RESOURCE — fileTier in home.mjs), so the migration's
// `up` and ContractController::index lead. Then it sorts by "most underlying
// blocks first" per FILE (TEST
// always last, regardless of its own count — see fileUnderlyingCount/
// fileOrder/fileRank in home.mjs and "Sort order of the left list" in
// .claude/docs/blocks-and-ingest.md). Only CreatePaymentAction.php has any
// relation children here (CreatePaymentAction::execute → the two
// GroupScopeChild blocks, see tests/fixtures/relations.json +
// group-scope.spec.mjs), so that file's two blocks (execute,
// findOrCreateCustomer) sort to the front of the rest; every other ordinary
// file ties at zero underlying blocks and keeps plain ingest order. Rows 2-3 sharing that
// file drives the connector test. The two GroupScopeChild blocks are
// themselves relation children: they stay navigable index rows but sort to
// the very bottom, under the "Onderliggende code" heading
// (recomputeLeftList's underlyingIds → BlockList.mjs).
const EXPECTED_LABELS = [
  'up',
  'ContractController::index',
  'CreatePaymentAction::execute',
  'CreatePaymentAction::findOrCreateCustomer',
  'ProcessCartAction::handle',
  'AddressType::fromString',
  'Address::billingAddress',
  'Order::address',
  'AddressTypeTest::test_it_casts_type',
  'GroupScopeChildA::run',
  'GroupScopeChildB::run',
]

// EXPECTED_ROW_LABELS mirrors EXPECTED_LABELS for the SIDEBAR row text only —
// index 8 (AddressTypeTest::test_it_casts_type, a lone TEST-category block)
// groups into a single test_class row labelled with the bare class name (see
// testClassRowItem/recomputeLeftList in home.mjs and "Grouping test methods
// per class" in .claude/docs/detail-layout.md); the diff/preview CARDS
// still show the real method's own `Class::method` label (see
// TestMethodsColumn/DetailPanel — the active method's own Block() card is
// unaffected by grouping), so EXPECTED_LABELS itself stays unchanged for
// that purpose.
const EXPECTED_ROW_LABELS = EXPECTED_LABELS.map((l, i) => (i === 8 ? 'AddressTypeTest' : l))

test.describe('PR Review Tree — block list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row')).toHaveCount(EXPECTED_LABELS.length)
  })

  test('renders header and all blocks in deterministic order', async ({ page }) => {
    await expect(page.getByText('Start — waar wil je beginnen?')).toBeVisible()
    await expect(page.getByText(`${EXPECTED_LABELS.length} startpunten`)).toBeVisible()

    const rows = page.getByTestId('block-row')
    for (let i = 0; i < EXPECTED_ROW_LABELS.length; i++) {
      await expect(rows.nth(i)).toContainText(EXPECTED_ROW_LABELS[i])
    }

    // Category tags and status glyphs show up. The status is rendered as a mark
    // (see BlockList STATUS_STYLE): modified = -/+, added = +, removed = -. The
    // coloured status span is the only element in the row with that status colour.
    await expect(rows.nth(2)).toContainText('ACTION')
    await expect(rows.nth(2).locator('.text-amber-600')).toHaveText('-/+') // modified
    await expect(rows.nth(1)).toContainText('CONTROLLER')
    await expect(rows.nth(1).locator('.text-amber-600')).toHaveText('-/+') // modified
    await expect(rows.nth(5)).toContainText('ENUM')
    await expect(rows.nth(5).locator('.text-emerald-600')).toHaveText('+') // added
    await expect(rows.nth(7).locator('.text-rose-600')).toHaveText('-') // removed
    await expect(rows.nth(0)).toContainText('MIGRATION')
  })

  test('arrow keys move the selection through the whole list', async ({ page }) => {
    const rows = page.getByTestId('block-row')
    const highlighted = page.locator('[data-testid="block-row"].bg-indigo-50')

    // Select row 0 explicitly — this test is about ↑/↓ traversal mechanics,
    // not about the fresh-open default pick.
    await rows.nth(0).click()
    await expect(rows.nth(0)).toHaveClass(/bg-indigo-50/)

    // Walk down to the last row.
    for (let i = 1; i < EXPECTED_LABELS.length; i++) {
      await page.keyboard.press('ArrowDown')
      await expect(rows.nth(i)).toHaveClass(/bg-indigo-50/)
      await expect(highlighted).toHaveCount(1)
    }
    // Last row visible in the scroll viewport.
    await expect(rows.nth(EXPECTED_LABELS.length - 1)).toBeInViewport()

    // ↓ past the last visible row now continues the sidebar's ↑/↓ loop into
    // the search box (no toggle row exists in this fixture — see
    // stepListSelection/searchStepSelection in home.mjs and
    // tests/list-nav-wrap.spec.mjs for the full loop, incl. the toggle rows).
    // The last row keeps its own highlight — the search box gets its own,
    // separate ring, exactly like the existing "browse while typing" feature.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await expect(rows.nth(EXPECTED_LABELS.length - 1)).toHaveClass(/bg-indigo-50/)

    // Re-select the last row (a click resets the loop) and walk back up to
    // the top.
    await rows.nth(EXPECTED_LABELS.length - 1).click()
    for (let i = EXPECTED_LABELS.length - 2; i >= 0; i--) {
      await page.keyboard.press('ArrowUp')
      await expect(rows.nth(i)).toHaveClass(/bg-indigo-50/)
    }
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

    // Select row 2 (CreatePaymentAction::execute) explicitly so the pair
    // below is deterministic.
    await page.getByTestId('block-row').nth(2).click()

    // Selected (2) + look-ahead (3) = two cards.
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[2])
    await expect(cards.nth(0)).toContainText('app/Actions/CreatePaymentAction.php:26')
    await expect(cards.nth(1)).toContainText(EXPECTED_LABELS[3])
    // The look-ahead card is dimmed.
    await expect(cards.nth(1)).toHaveClass(/opacity-50/)

    // Moving down advances the pair.
    await page.keyboard.press('ArrowDown')
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[3])
    await expect(cards.nth(1)).toContainText(EXPECTED_LABELS[4])

    // At the last row there is no look-ahead: a single card.
    for (let i = 3; i < EXPECTED_LABELS.length - 1; i++) {
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

    // Select row 3 (findOrCreateCustomer) explicitly (see the same comment in
    // "arrow keys move the selection through the whole list" above).
    await page.getByTestId('block-row').nth(3).click()

    // Row 3 (findOrCreateCustomer) and row 4 (ProcessCartAction) differ → no
    // connector.
    await expect(connector).toHaveCount(0)

    // Row 2 and row 3 are both in CreatePaymentAction.php → connector shown.
    await page.keyboard.press('ArrowUp')
    await expect(connector).toHaveCount(1)

    // Back to row 3 (different file as its look-ahead) → connector gone again.
    await page.keyboard.press('ArrowDown')
    await expect(connector).toHaveCount(0)
  })
})
