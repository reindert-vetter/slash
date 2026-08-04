import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Space is a one-key shortcut for exactly what the palette's "Keur ... goed"
// already does, immediately followed by "Ga door" — see spaceKey/
// afterApproveAction's `auto` flag in home.mjs. Already standing on an
// approved unit, Space does not toggle it off, it only jumps to the next
// unapproved unit; reaching the end opens the same review-submit menu a
// natural "Ga door" chain ends in.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs/review-submit-menu.spec.mjs:
// only block 1 (CreatePaymentAction::execute, index 1) and block 6
// (Order::address, index 6) carry a real diff (one single-line group each) —
// every other block has zero changed rows.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const BLOCK6_ID = '12903:app/Models/Order.php:Order::address'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlockApproval resets one block's durable approval through the
// sanctioned write path (the approve workflow's `set` signal — an empty set
// removes the row), same helper as postapprove-menu.spec.mjs/
// review-submit-menu.spec.mjs. Makes every test here idempotent regardless of
// run order on the same worker DB.
async function clearBlockApproval(page, blockId) {
  const start = await page.request.post('/api/workflows/approve', { data: { pr: 12903 } })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId, rows: [], calls: [] },
  })
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/approvals?pr=12903')
      const rows = await res.json()
      return Array.isArray(rows) && rows.every((r) => r.blockId !== blockId)
    })
    .toBe(true)
}

// approveViaPalette approves the current unit through the command palette
// (Enter → filter "keur" → click the first row) — used here only to set up a
// known "already approved" starting point, never to exercise Space itself.
async function approveViaPalette(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('keur')
  await page.getByTestId('command-row').first().click()
}

test.describe('PR Review Tree — Space (approve + continue)', () => {
  test('Space approves the current unit and jumps straight to the next unapproved unit, no menu ever opens', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press(' ')

    // No postApprove confirm menu ever shows up, but the "Ga door" jump still
    // happens: blocks 2-5 have no changes, so it skips straight to block 6.
    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(menu).not.toBeVisible()

    const res = await page.request.get('/api/approvals?pr=12903')
    const rows = await res.json()
    expect(rows.some((r) => r.blockId === BLOCK1_ID)).toBe(true)
  })

  test('Space on an already-approved unit does not retract it, it only jumps to the next unapproved unit', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    // Approve block 1 the ordinary way (palette), then dismiss the follow-up
    // without navigating, so the keyboard stays put on the now-approved unit.
    await approveViaPalette(page)
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press(' ')

    // Block 1 stays approved (Space never retracts) and the keyboard lands on
    // block 6, the next not-yet-approved unit.
    await expect(menu).not.toBeVisible()
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    const res = await page.request.get('/api/approvals?pr=12903')
    const rows = await res.json()
    expect(rows.some((r) => r.blockId === BLOCK1_ID)).toBe(true)
  })

  test('Space with nothing left ahead opens the same review-submit menu as the end of a "Ga door" chain', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // First Space: approves block 1, jumps to block 6 (still something ahead).
    await page.keyboard.press(' ')
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Second Space: approves block 6 — now nothing is left ahead and both
    // real-diff blocks are fully approved, so the review-submit menu opens,
    // same as the natural end of a palette "Ga door" chain.
    await page.keyboard.press(' ')

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
  })

  test('Space is a no-op while typing in a composer — it types a literal space instead', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('comment op deze')
    await page.getByTestId('command-row').first().click()

    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeVisible()
    await composer.fill('hallo')
    await composer.press(' ')
    await composer.press('w')
    await expect(composer).toHaveValue('hallo w')

    // Nothing got approved — the space stayed inside the field.
    const res = await page.request.get('/api/approvals?pr=12903')
    const rows = await res.json()
    expect(rows.some((r) => r.blockId === BLOCK1_ID)).toBe(false)
  })
})
