import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The postApprove follow-up menu: approving via the command palette (not the
// top checkbox — that stays a direct toggle) opens a small follow-up menu when
// there's a next not-yet-approved unit still ahead: "Ga door" or "Sluit
// menu". See afterApproveAction / findNextUnapproved / POSTAPPROVE_COMMANDS
// in home.mjs.
//
// The seeded PR 12903 fixture (tests/fixtures/blocks.json) only carries a real
// diff on two of its nine blocks: CreatePaymentAction::execute (one
// single-line group) and Order::address (also one group) — every other block
// has no changed rows at all. That shape is exactly what's needed to exercise
// the block-overstijgend "volgende" search without relying on incidental diff
// content elsewhere in the PR.
//
// The left list's sidebar position of a block is a display grouping, not a
// stable index to lean on (see "Sort order of the left list" in
// .claude/docs/blocks-and-ingest.md) — every block below is selected by its
// own label, not by raw `[data-idx]`.
//
// The selected block's identity is asserted via the `?sel=` URL param (see
// urlState.mjs/bindUrlState) rather than the sidebar's `[data-idx]` rows: a
// fully-approved top-level block is hidden from the sidebar by default
// (state.showApproved, see BlockList.mjs) — exactly what approving
// execute's only group does to it — so its row disappears from the DOM the
// moment the approve command runs.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlockApproval resets one block's durable approval through the
// sanctioned write path (the approve workflow's `set` signal — an empty set
// removes the row), same helper as selected-reveal-hidden.spec.mjs's
// clearBlock1Approval. Used only by the "not fully approved" test below,
// which specifically depends on block 1 still being un-approved (several
// other specs — sidebar-skip-approved.spec.mjs, selected-reveal-hidden.spec.mjs
// — durably approve it on this same PR/worker DB) — makes that one test
// idempotent regardless of run order.
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
test.describe('PR Review Tree — postApprove follow-up menu', () => {
  test('approving opens the follow-up; "Sluit menu" just closes it (no navigation)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step it into its diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Approve execute's only group via the palette.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // The follow-up opens automatically with exactly the two choices: "Sluit
    // menu" pinned first, then the default "Ga door…" (where the selection
    // opens).
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Ga door')

    // Choosing "Sluit menu" just closes it — no navigation.
    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
    expect(selParam(page)).toBe(BLOCK1_SEL)
  })

  test('"Ga door" jumps block-overstijgend to the next not-approved unit', async ({ page }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
    await expect(menu).not.toBeVisible()

    // Blocks 2-5 have no changes at all, so "volgende" skips straight past them
    // to block 6 (Order::address) — the next block that actually has an
    // unapproved unit — landing in its diff on the first (only) group.
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
  })

  test('un-approving (revoking) does not open the follow-up', async ({ page }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Approve, then dismiss the follow-up without navigating away.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Un-approve the same unit — the command now reads "Trek … in" — and
    // confirm no follow-up appears this time. ("trek goedk" rather than just
    // "trek": the bare substring is also a fuzzy subsequence match of "Comment
    // op deze regel … task", so it doesn't uniquely narrow the list.)
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('trek goedk')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await expect(page.getByTestId('command-row').first()).toContainText('Trek goedkeuring')
    await page.getByTestId('command-row').first().click()
    await expect(menu).not.toBeVisible()
    // Give an (absent) delayed follow-up a moment to have shown up were it
    // going to — findNextUnapproved awaits a network fetch, so a false
    // positive here would appear a beat later, not instantly.
    await page.waitForTimeout(300)
    await expect(menu).not.toBeVisible()
  })

  // Approving from the blokken-index itself (Enter with no ArrowRight — state.mode
  // stays 'list') skips the postApprove follow-up menu entirely — there's
  // nothing else to choose there anyway (no diff/drill to jump into), so it
  // always jumps straight to the next not-yet-approved block. See the
  // `keepList` branch of afterApproveAction/applyNextUnapproved in home.mjs.
  test('approving from the blokken-index skips the follow-up menu and jumps straight to the next unapproved block', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index — CreatePaymentAction::execute has a real
    // unit to approve.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)
    await expect(page).not.toHaveURL(/mode=diff/)

    // Approve execute's only group via the palette, straight from the index.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // No follow-up menu opens this time — the palette closes right away
    // (runCommand's own close, not a postApprove follow-up).
    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    // Lands on block 6 (the next not-yet-approved block, same skip-past-2-5 as
    // the diff-mode case above) but never enters its diff: no `mode=diff` in
    // the URL, and the sidebar keeps its normal on-screen list-mode width (in
    // diff mode it collapses to width 0 — see BlockList.mjs).
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('pr-index')).toHaveClass(/w-\[26rem\]/)
    await expect(page.getByTestId('pr-index')).not.toHaveClass(/\bw-0\b/)
  })

  // "Nothing left ahead" no longer just closes the palette — it now opens one
  // of the two review-submit follow-ups (reviewApprove/reviewChoice, see
  // afterApproveAction/REVIEW_APPROVE_COMMANDS/REVIEW_CHOICE_COMMANDS in
  // home.mjs). This case (block 1 — CreatePaymentAction::execute — left
  // un-approved) exercises the NOT-fully-done branch; the fully-done branch
  // and the actual submit_review network calls are covered in
  // tests/review-submit-menu.spec.mjs.
  test('nothing left ahead, PR not fully approved: opens the goedkeuren/afwijzen choice', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()
    await page.keyboard.press('Escape')

    // Select Order::address directly (by label, not by raw index) and step
    // into its diff — it's the last block in the fixture with any changed
    // rows at all (the ones after it have none), so approving it leaves
    // nothing ahead to jump to. CreatePaymentAction::execute is left
    // un-approved, so the PR overall isn't fully approved yet.
    const block6Row = page.getByTestId('block-row').filter({ hasText: 'Order::address' })
    await block6Row.click()
    await expect(block6Row).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')
    await expect(rows.nth(2)).toContainText('Wijs de PR af')

    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()
  })
})
