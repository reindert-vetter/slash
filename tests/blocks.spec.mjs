import { test, expect } from './_fixtures.mjs'

// The fixture (tests/fixtures/blocks.json) has 11 blocks. The left list sorts
// by category priority (ROUTE first, then CONTROLLER, then everything else
// ordered by how much of that category is still left to approve — TEST
// always last — see categoryRank/categoryRemaining in home.mjs and "Sort
// order of the left list" in .claude/docs/blocks-and-ingest.md); this fixture
// has no ROUTE block, so the sole CONTROLLER (ContractController::index)
// moves to the front. ACTION and MODEL both have exactly 1 row left to
// approve (CreatePaymentAction::execute, Order::address) and tie — ACTION
// wins that tie on original ingest order — while ENUM/MIGRATION/TEST all
// have 0 left, sorting after both, TEST always last of all regardless of its
// own count. Rows 1-2 share a file (CreatePaymentAction.php) — that adjacency
// drives the connector test. The two GroupScopeChild blocks are relation
// children (see tests/fixtures/relations.json + group-scope.spec.mjs): those
// stay navigable index rows but sort to the very bottom, under the
// "Onderliggende code" heading (recomputeLeftList's underlyingIds →
// BlockList.mjs).
const EXPECTED_LABELS = [
  'ContractController::index',
  'CreatePaymentAction::execute',
  'CreatePaymentAction::findOrCreateCustomer',
  'ProcessCartAction::handle',
  'Address::billingAddress',
  'Order::address',
  'AddressType::fromString',
  'up',
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
    await expect(rows.nth(0)).toContainText('CONTROLLER')
    await expect(rows.nth(0).locator('.text-amber-600')).toHaveText('-/+') // modified
    await expect(rows.nth(1)).toContainText('ACTION')
    await expect(rows.nth(6)).toContainText('ENUM')
    await expect(rows.nth(6).locator('.text-emerald-600')).toHaveText('+') // added
    await expect(rows.nth(5).locator('.text-rose-600')).toHaveText('-') // removed
    await expect(rows.nth(7)).toContainText('MIGRATION')
  })

  test('arrow keys move the selection through the whole list', async ({ page }) => {
    const rows = page.getByTestId('block-row')
    const highlighted = page.locator('[data-testid="block-row"].bg-indigo-50')

    // Row 0 is not the fresh-open DEFAULT any more (applyDefaultUnapprovedSelection
    // now tie-breaks by (file, line) — see "Land a fresh PR open on the first
    // block of the first-changed file" — so CreatePaymentAction::execute, row 1,
    // wins on this fixture); this test is about ↑/↓ traversal mechanics, not
    // about the default pick itself, so select row 0 explicitly first.
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

    // Row 0 is not the fresh-open default any more (see the same comment in
    // "arrow keys move the selection through the whole list" above) — select
    // it explicitly so the pair below is deterministic.
    await page.getByTestId('block-row').nth(0).click()

    // Selected (0) + look-ahead (1) = two cards.
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toContainText(EXPECTED_LABELS[0])
    await expect(cards.nth(0)).toContainText('app/Http/Controllers/Api/ContractController.php:30')
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

    // Row 0 is not the fresh-open default any more (see the same comment in
    // "arrow keys move the selection through the whole list" above) — select
    // it explicitly.
    await page.getByTestId('block-row').nth(0).click()

    // Row 0 (ContractController, CONTROLLER-first) and row 1 (CreatePaymentAction
    // execute) differ → no connector.
    await expect(connector).toHaveCount(0)

    // Rows 1 and 2 are both in CreatePaymentAction.php → connector shown.
    await page.keyboard.press('ArrowDown')
    await expect(connector).toHaveCount(1)

    // Row 2 (findOrCreateCustomer) and row 3 (ProcessCartAction) differ → none.
    await page.keyboard.press('ArrowDown')
    await expect(connector).toHaveCount(0)

    // Back to the same-file pair → connector reappears.
    await page.keyboard.press('ArrowUp')
    await expect(connector).toHaveCount(1)
  })
})
