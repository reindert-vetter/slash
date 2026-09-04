import { test, expect } from './_fixtures.mjs'

// GitHub refuses a review submission (approve OR request-changes) when the
// PR's own author and the authenticated gh user are the same login — the
// PR-13535 diagnosis: it used to reach `gh` and fail with a bare
// "exit status 1". The backend now rejects it fast (rejectSelfReview,
// workflows.go, submit_review_test.go); this file covers the FRONTEND half —
// isOwnPR/REVIEW_APPROVE_COMMANDS/REVIEW_CHOICE_COMMANDS/openReviewMenu/
// runCommand's hasRealCommands check (home.mjs) — which must never even show
// the choice on your own PR.
//
// Same PR 12903 fixture and BLOCK1/BLOCK6 as review-submit-menu.spec.mjs:
// approving both real-diff blocks is exactly "alles goedgekeurd".
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const BLOCK6_ID = '12903:app/Models/Order.php:Order::address'

const ME = 'reindert-vetter'

// mockOwnPR makes the frontend believe the local reviewer authored this PR:
// /api/me reports ME as the authenticated login, and /api/pr's real response
// is passed through unchanged except for `author`, which is overwritten to
// ME — avoids having to replicate the endpoint's whole JSON shape by hand.
async function mockOwnPR(page) {
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, login: ME, avatarUrl: '' }),
    }),
  )
  await page.route('**/api/pr?*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.author = ME
    await route.fulfill({ response, json })
  })
}

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

async function approveViaPalette(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('keur')
  await page.getByTestId('command-row').first().click()
}

test.describe('PR Review Tree — a review menu is never offered on your own PR', () => {
  test('fully approving your own PR skips the review-submit menu and jumps to the PR overview', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await mockOwnPR(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    // Block 6 is still open, so this is the ordinary postApprove "Ga door"
    // follow-up — unaffected by isOwnPR (that only gates the review-submit
    // menu, never the plain approve-and-continue one).
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    // Approve block 6 too — now the whole PR is fully approved, which would
    // normally open 'reviewApprove' ("Sluit menu" / "Keur de HELE PR goed").
    // On your own PR that item is filtered out (isOwnPR), leaving nothing but
    // "Sluit menu" — so the menu never opens at all, and the reviewer lands
    // on /pr-overview instead.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    await expect(page).toHaveURL(/\/pr-overview\?/)
    await expect(menu).not.toBeVisible()
  })

  test('approving your own PR with an earlier block still open returns to that unapproved block instead of the PR overview', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)
    await mockOwnPR(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    // Approve BLOCK6 (the LATER block) first — BLOCK1 stays unapproved.
    // findNextUnapproved is forward-only/no-wrap, so from BLOCK6 there's
    // nothing left AHEAD, even though BLOCK1 (earlier in the list) still
    // needs approval — this used to fall through to offerReviewSubmitFollowup
    // -> openReviewMenu('reviewChoice'), whose only real items are filtered
    // out on your own PR (isOwnPR), sending the reviewer straight to
    // /pr-overview despite the PR not actually being fully reviewed.
    await page.getByTestId('block-row').filter({ hasText: 'Order::address' }).click()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await approveViaPalette(page)

    // No review-submit menu, no navigation away — the reviewer instead lands
    // back on the still-unapproved BLOCK1's own diff.
    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()
    await expect(page).toHaveURL(/\/pr\/12903/)
    await expect(page).not.toHaveURL(/\/pr-overview/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })).toHaveClass(
      /bg-indigo-50/,
    )
  })

  test('`/` → GitHub → "PR keuren" redirects straight to the PR overview instead of opening an empty choice', async ({
    page,
  }) => {
    await mockOwnPR(page)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'GitHub' }).click()

    const rows = page.getByTestId('command-row')
    await expect(rows.filter({ hasText: 'PR keuren' })).toBeVisible()
    await rows.filter({ hasText: 'PR keuren' }).click()

    await expect(page).toHaveURL(/\/pr-overview\?/)
    await expect(menu).not.toBeVisible()
  })
})
