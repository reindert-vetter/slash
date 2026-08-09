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
// Fixture: CreatePaymentAction::execute (PR 12903) has exactly ONE changed
// line (the $order->…->update([...]) call, see materializeMainWorktrees in
// tests/_setup.mjs) and calls self::findOrCreateCustomer($order) — a real PR
// block of its own — from a line that is identical in base and head. The
// callresolve row is mocked so that call resolves.
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

// activeRow reads the row index the diff cursor sits on.
async function activeRow(page) {
  return await page.locator('[data-change-active]').first().getAttribute('data-row')
}

test.describe('PR Review Tree — a call on an unchanged line is selectable', () => {
  test('↓ reaches the unchanged call line, the palette offers no approve there, and → opens its code', async ({
    page,
  }) => {
    await mockCallResolve(page)
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff
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
    // which is scoped to exactly the call that line makes.
    await page.keyboard.press('ArrowLeft') // back to the list (Space may have moved on)
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await page.keyboard.press('ArrowRight')
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
    await page.goto('/pr/12903')
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
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
