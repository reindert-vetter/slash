import { test, expect } from './_fixtures.mjs'

// The review-submit follow-ups: opened by afterApproveAction (home.mjs) right
// after a palette approve action leaves NOTHING ahead to navigate to
// (findNextUnapproved()===null) — the complement of the postApprove
// follow-up covered in postapprove-menu.spec.mjs (which covers the "there IS
// something ahead" case). Two variants, both driven by state.approvalTotal
// (the PR-wide combined-approval count):
//   - fully approved (REVIEW_APPROVE_COMMANDS, menu mode 'reviewApprove'):
//     just "Keur de PR goed" / "Sluit menu".
//   - not yet fully approved (REVIEW_CHOICE_COMMANDS, menu mode
//     'reviewChoice'): "Keur de PR goed" / "Wijs de PR af" / "Sluit menu" —
//     the not-fully-approved half of this is also covered by
//     postapprove-menu.spec.mjs's own "nothing left ahead" test; this file
//     focuses on what actually gets POSTed to /api/workflows/submit_review.
//
// Both "Keur de PR goed" and (after typing a reason) "Wijs de PR af" call the
// real submit_review endpoint — SLASH_GITHUB=off (forced by the test harness,
// see _fixtures.mjs) means the backend's github.Fake accepts it without
// touching the network, so no mocking is needed; we only intercept the
// request here to assert exactly what was sent.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs: only block 1
// (CreatePaymentAction::execute, index 1) and block 6 (Order::address, index
// 6) carry a real diff (one single-line group each) — every other block has
// zero changed rows, so approving both of those two blocks is exactly "alles
// goedgekeurd" for this fixture.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const BLOCK6_ID = '12903:app/Models/Order.php:Order::address'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlockApproval resets one block's durable approval through the
// sanctioned write path (the approve workflow's `set` signal — an empty set
// removes the row) — same helper as selected-reveal-hidden.spec.mjs's
// clearBlock1Approval. This file's whole premise (state.approvalTotal exactly
// tracks blocks 1 and 6) breaks if either carries a leftover approval from an
// earlier test on the same worker DB (postapprove-menu.spec.mjs,
// sidebar-skip-approved.spec.mjs and selected-reveal-hidden.spec.mjs also
// durably approve block 1 on this same PR), so every test here clears both,
// BEFORE navigating, making it idempotent regardless of run order.
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
// (Enter → filter "keur" → click the (first, "approve") row) — the only path
// that runs afterApproveAction (the top checkbox stays a direct toggle, see
// its own doc comment in home.mjs).
async function approveViaPalette(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('keur')
  await page.getByTestId('command-row').first().click()
}

test.describe('PR Review Tree — review-submit follow-up (Keur de PR goed / Wijs de PR af)', () => {
  test('PR fully approved: "Keur de PR goed" POSTs event APPROVE with an empty body', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape')

    // Approve block 1's only group — this still leaves block 6 open, so it
    // opens the existing postApprove "Ga door" follow-up (unchanged
    // behaviour, see postapprove-menu.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)

    // Approve block 6's only group too — now NOTHING is left ahead AND the
    // whole PR (both real-diff blocks) is fully approved.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Keur de PR goed')
    await expect(rows.nth(1)).toContainText('Sluit menu')

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      rows.filter({ hasText: 'Keur de PR goed' }).click(),
    ])
    expect(request.method()).toBe('POST')
    expect(request.postDataJSON()).toEqual({ pr: 12903, event: 'APPROVE', body: '' })
    const response = await request.response()
    expect(response.status()).toBe(200)
    await expect(menu).not.toBeVisible()
  })

  test('PR not fully approved: "Wijs de PR af" requires a typed reason before it submits', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape')

    // Approve block 6 only — block 1 stays open, so the PR isn't fully done.
    await page.locator('[data-idx="6"]').click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('Wijs de PR af')
    await rows.filter({ hasText: 'Wijs de PR af' }).click()

    // The rejection-reason step: an empty textarea offers no command at all
    // (Enter must be a no-op, not a silent close-without-submitting — a
    // bodyless REQUEST_CHANGES is rejected by GitHub/the backend).
    await expect(menu).toBeVisible()
    const input = page.getByTestId('command-input')
    await expect(input).toHaveAttribute('placeholder', /Typ de reden voor afwijzing/)
    await expect(page.getByTestId('command-row')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible() // still open — nothing was submitted

    // Typing a reason reveals exactly one command; running it submits
    // REQUEST_CHANGES with that reason as the body.
    await input.fill('Graag nog een test toevoegen voor de foutafhandeling.')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await expect(page.getByTestId('command-row').first()).toContainText('Wijs de PR af met deze reden')

    const [request] = await Promise.all([
      page.waitForRequest('**/api/workflows/submit_review'),
      page.getByTestId('command-row').first().click(),
    ])
    expect(request.method()).toBe('POST')
    expect(request.postDataJSON()).toEqual({
      pr: 12903,
      event: 'REQUEST_CHANGES',
      body: 'Graag nog een test toevoegen voor de foutafhandeling.',
    })
    const response = await request.response()
    expect(response.status()).toBe(200)
    await expect(menu).not.toBeVisible()
  })
})
