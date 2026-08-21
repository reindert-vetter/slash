import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A block's own declaration row is a reference unit when it is `status:
// "added"` yet its very first row (the signature) is itself unchanged — e.g.
// a previously interface-only/abstract method that only now gets a body, so
// the whole block reads "added" while the signature TEXT already existed
// verbatim. Reviewer request: "functie naam is niet selecteerbaar. ik wil dat
// daar de groep of line kan beginnen." See declarationReferenceRow (home.mjs)
// + withReferenceUnits (Block.mjs), and materializeSignatureRefWorktrees
// (tests/_setup.mjs) for the exact fixture shape.
//
// TEST-only, per a later follow-up request ("ik wil alleen navigeren door
// lines die ik kan goedkeuren, behalve in test bestanden") — navUnitsOf
// (home.mjs) only feeds declarationReferenceRow into a block's unit list
// when the block's own category is 'TEST'. The fixture's real category is
// 'ACTION' (tests/fixtures/signatureref-blocks.json); the positive tests
// below patch just that one field via /api/blocks, mirroring
// reference-unit-unchanged-line.spec.mjs's own mockCallerCategory.
const CLASS = 'SignatureRefAction'
const METHOD = 'decode'

// activeRow reads the row index the diff cursor sits on.
async function activeRow(page) {
  return await page.locator('[data-change-active]').first().getAttribute('data-row')
}

async function mockCategory(page, category) {
  await page.route('**/api/blocks?pr=120', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    for (const b of json) {
      if (b.class === CLASS && b.name === METHOD) b.category = category
    }
    await route.fulfill({ response: res, json })
  })
}

// enterTestClassBlockDiff selects the (patched-to-TEST) block and steps into
// its diff. A TEST-category block is grouped into a single synthetic
// test_class row per class (testClassRowItem, home.mjs) — a bare class-name
// row, not "SignatureRefAction::decode" — and → first lands on the
// methodes-kolom (stop 2b) before a second → reaches the active method's own
// diff (see "Stop 2b" in .claude/docs/keyboard-navigation.md).
async function enterTestClassBlockDiff(page) {
  await page.getByTestId('block-row').filter({ hasText: 'TEST' }).filter({ hasText: CLASS }).click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // into the methodes-kolom
  await page.keyboard.press('ArrowRight') // into the active method's diff
}

test.describe('PR Review Tree — an added TEST block\'s unchanged signature line is selectable', () => {
  test('at group granularity, ↑ reaches row 0 and the palette offers no approve there', async ({
    page,
  }) => {
    await mockCategory(page, 'TEST')
    await page.goto('/pr/120')
    await enterTestClassBlockDiff(page)
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
    await mockCategory(page, 'TEST')
    await page.goto('/pr/120')
    await enterTestClassBlockDiff(page)
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

test.describe('PR Review Tree — outside a TEST block, the same unchanged signature line is not a stop', () => {
  test('↑ off the topmost real change does not reach the unchanged signature row', async ({
    page,
  }) => {
    // No mockCategory: SignatureRefAction::decode keeps its real, non-TEST
    // fixture category ('ACTION').
    await page.goto('/pr/120')
    await page.getByTestId('block-row').filter({ hasText: `${CLASS}::${METHOD}` }).click()
    await leaveSearchBox(page)

    await page.keyboard.press('ArrowRight') // into the diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Walk all the way up through the block's own real change groups; row 0
    // (the signature) must never be the landing row any more.
    let row = await activeRow(page)
    for (let i = 0; i < 5; i++) {
      const before = row
      await page.keyboard.press('ArrowUp')
      row = await activeRow(page)
      expect(row).not.toBe('0')
      if (row === before) break // clamped — nothing further up to walk
    }
  })
})
