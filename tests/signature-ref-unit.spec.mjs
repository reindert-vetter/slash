import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A block's own declaration row is a reference unit when it is `status:
// "added"` yet its very first row (the signature) is itself unchanged — e.g.
// a previously interface-only/abstract method that only now gets a body, so
// the whole block reads "added" while the signature TEXT already existed
// verbatim. Reviewer request: "functie naam is niet selecteerbaar. ik wil dat
// daar de groep of line kan beginnen." See declarationReferenceRow (home.mjs)
// + withReferenceUnits (Block.mjs), and materializeSignatureRefWorktrees
// (tests/_setup.mjs) for the exact fixture shape.
const BLOCK = 'SignatureRefAction::decode'

// activeRow reads the row index the diff cursor sits on.
async function activeRow(page) {
  return await page.locator('[data-change-active]').first().getAttribute('data-row')
}

test.describe('PR Review Tree — an added block\'s unchanged signature line is selectable', () => {
  test('at group granularity, ↑ reaches row 0 and the palette offers no approve there', async ({
    page,
  }) => {
    await page.goto('/pr/120')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // The real change sits in the body (rows below the signature); ↑ from
    // there reaches the signature line's own reference unit at row 0.
    const changedRow = await activeRow(page)
    expect(Number(changedRow)).toBeGreaterThan(0)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => activeRow(page)).toBe('0')

    // Nothing to approve on the signature: the palette leaves the approve
    // item out, same as any other reference unit.
    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows.filter({ hasText: 'goed' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // ↑ again stays put — row 0 is the top of the block.
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => activeRow(page)).toBe('0')
  })

  test('at line granularity, ↑ also reaches row 0', async ({ page }) => {
    await page.goto('/pr/120')
    await page.getByTestId('block-row').filter({ hasText: BLOCK }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('f') // group → line

    let row = await activeRow(page)
    let reachedZero = row === '0'
    // Walk up through every changed line until the signature's own unit.
    for (let i = 0; i < 5 && !reachedZero; i++) {
      await page.keyboard.press('ArrowUp')
      row = await activeRow(page)
      reachedZero = row === '0'
    }
    expect(reachedZero).toBe(true)
  })
})
