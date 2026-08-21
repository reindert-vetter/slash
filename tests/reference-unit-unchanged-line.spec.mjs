import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reference units: a line the PR did NOT change, but which carries a resolved
// call into underlying code, is selectable — so the reviewer can step right
// into that code — while staying UNapprovable. Reviewer request: "er zijn
// uitzonderlijke situaties waarbij je onderliggende code hebt gelinkt aan
// regels die niet zijn aangepast, zoals bij tests blokken. In dat geval wil ik
// ook de regel kunnen selecteren (niet approven enzo) zodat ik ook naar die
// onderliggende code kan gaan (door wederom naar rechts te drukken)."
// See referenceRows (home.mjs) + withReferenceUnits (Block.mjs).
//
// TEST-only, per a later follow-up request ("ik wil alleen navigeren door
// lines die ik kan goedkeuren, behalve in test bestanden"): navUnitsOf
// (home.mjs) only actually feeds referenceRows/declarationReferenceRow into a
// unit list when the CALLER block's own category is 'TEST' — see
// navUnitsOf's own comment and "Reference units" in
// .claude/docs/keyboard-navigation.md. Both halves are covered below: the
// TEST-category positive case (unchanged), and the default, non-TEST negative
// case.
//
// Fixture: CreatePaymentAction::execute (PR 12903) has exactly ONE changed
// line (the $order->…->update([...]) call, see materializeMainWorktrees in
// tests/_setup.mjs) and calls self::findOrCreateCustomer($order) — a real PR
// block of its own — from a line that is identical in base and head. The
// callresolve row is mocked so that call resolves. Its own category is
// 'ACTION' in the shared fixture (tests/fixtures/blocks.json); the positive
// tests below patch just that one field via /api/blocks so they can reuse the
// same heavily-shared worktree without touching materializeMainWorktrees.
const CALLER = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'

async function mockCallResolve(page) {
  await page.route('**/api/callresolve?pr=12903', async (route) => {
    await route.fulfill({
      json: [
        {
          pr: 12903,
          callerId: CALLER,
          callKey: 'findOrCreateCustomer',
          status: 'resolved',
          childFile: 'app/Actions/CreatePaymentAction.php',
          childClass: 'CreatePaymentAction',
          childMethod: 'findOrCreateCustomer',
          childLine: 70,
          childCode: 'private static function findOrCreateCustomer(Order $order): bool\n{\n    return true;\n}',
        },
      ],
    })
  })
}

// mockCallerCategory patches CreatePaymentAction::execute's own `category` in
// the /api/blocks response, leaving every other field (and every other
// block) untouched — the smallest way to exercise the TEST-only gate without
// a second worktree fixture.
async function mockCallerCategory(page, category) {
  await page.route('**/api/blocks?pr=12903', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const b of json) {
      if (b.class === 'CreatePaymentAction' && b.name === 'execute') b.category = category
    }
    await route.fulfill({ response: res, json })
  })
}

// activeRow reads the row index the diff cursor sits on.
async function activeRow(page) {
  return await page.locator('[data-change-active]').first().getAttribute('data-row')
}

// enterTestClassCallerDiff selects the (patched-to-TEST) execute block and
// steps into its diff. A TEST-category block is grouped into a single
// synthetic test_class row per class (testClassRowItem, home.mjs) — the row's
// own label is just the bare class name ("CreatePaymentAction"), and → first
// lands on the methodes-kolom (stop 2b) before a second → reaches the active
// method's own diff (see "Stop 2b" in .claude/docs/keyboard-navigation.md).
// findOrCreateCustomer stays its own ordinary ACTION row (not patched), so
// filtering on both "TEST" and the class name picks the grouped row uniquely.
async function enterTestClassCallerDiff(page) {
  await page.getByTestId('block-row').filter({ hasText: 'TEST' }).filter({ hasText: 'CreatePaymentAction' }).click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // into the methodes-kolom
  await page.keyboard.press('ArrowRight') // into the active method's diff
}

test.describe('PR Review Tree — a call on an unchanged line is selectable (TEST blocks only)', () => {
  test('↓ reaches the unchanged call line, the palette offers no approve there, and → opens its code', async ({
    page,
  }) => {
    await mockCallResolve(page)
    await mockCallerCategory(page, 'TEST')
    await page.goto('/pr/12903')
    await enterTestClassCallerDiff(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The block has ONE changed group; the resolved call on the unchanged
    // `self::findOrCreateCustomer($order)` line adds a second, landable unit.
    // It sits ABOVE the changed line in the method body, so ↑ reaches it.
    const changedRow = await activeRow(page)
    await page.keyboard.press('ArrowUp')
    const refRow = await activeRow(page)
    expect(refRow).not.toBe(changedRow)
    expect(Number(refRow)).toBeLessThan(Number(changedRow))

    // Nothing to approve here: the palette leaves the approve item out.
    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows.filter({ hasText: 'goed' })).toHaveCount(0)
    await expect(rows.filter({ hasText: 'Trek goedkeuring' })).toHaveCount(0)
    // The other block actions are unchanged.
    await expect(rows.filter({ hasText: 'Comment op deze regel' })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // Space is a no-op approval-wise on this line (it only continues).
    await page.keyboard.press('Space')
    const approvals = await (await page.request.get('/api/approvals?pr=12903')).json()
    const row = Array.isArray(approvals) ? approvals.find((r) => r.blockId === CALLER) : null
    const approvedRows = row && Array.isArray(row.rows) ? row.rows : []
    expect(approvedRows).not.toContain(Number(refRow))

    // Back on the reference line, → steps into the Onderliggende-code column,
    // which is scoped to exactly the call that line makes. A fresh page load
    // re-selects the row from a known state regardless of wherever Space's
    // own auto-continue left the keyboard.
    await page.goto('/pr/12903')
    await enterTestClassCallerDiff(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => activeRow(page)).toBe(refRow)

    await page.keyboard.press('ArrowRight')
    const cards = page.getByTestId('related-item')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('findOrCreateCustomer')
    await expect(cards.first()).toHaveAttribute('data-active', 'true')

    // Enter drills it open as its own column — the whole point of being able
    // to stand on that line.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('drill-column')).toBeVisible()
  })

  test('a child with neither an approve counter nor a comment avatar shows the eye', async ({
    page,
  }) => {
    await mockCallResolve(page)
    await mockCallerCategory(page, 'TEST')
    await page.goto('/pr/12903')
    await enterTestClassCallerDiff(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowRight')

    const card = page.getByTestId('related-item').first()
    await expect(card).toBeVisible()
    // findOrCreateCustomer's own body is identical in base and head, so it has
    // no changed rows: no approve counter, no comment avatar — the eye takes
    // that slot ("alleen bekijken", shape not colour).
    await expect(card.getByTestId('related-approval')).toHaveCount(0)
    await expect(card.getByTestId('related-comment-activity')).toHaveCount(0)
    await expect(card.getByTestId('related-view-only')).toBeVisible()
  })
})

test.describe('PR Review Tree — outside a TEST block, an unchanged reference line is not a stop', () => {
  test('↑ off the only approvable unit does not reach the unchanged call line', async ({ page }) => {
    await mockCallResolve(page)
    // No mockCallerCategory: CreatePaymentAction::execute keeps its real,
    // non-TEST fixture category ('ACTION').
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    const changedRow = await activeRow(page)

    // execute is the first block in its file (findOrCreateCustomer is
    // declared further down), has no description, and — with the reference
    // unit gone — no unit above its one real change group at all, so ↑ is a
    // plain no-op here instead of reaching the unchanged call line.
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => activeRow(page)).toBe(changedRow)

    // The palette still only reflects the one real, approvable unit.
    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows.filter({ hasText: 'goed' })).toHaveCount(1)
  })
})
