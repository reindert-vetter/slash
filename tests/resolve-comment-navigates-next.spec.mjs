import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Reviewer request (2026-08-26): "als ik een comment resolve, ga dan naar het
// volgende wat ik moet approven en anders comment wat nog niet resolved is".
// afterResolveAction (home.mjs) runs after BOTH "Resolve comment" entry
// points — the block-scoped thread's own menu (commentCommandsFor) and a
// comment-index row's menu (prCommentCommandsFor) — and, unlike
// afterApproveAction's postApprove follow-up, navigates DIRECTLY, with no
// confirm menu (explicit reviewer decision). Three-step order:
//   1. findNextUnapproved() — the same forward-only, no-wrap tree walk the
//      approve flow uses.
//   2. findNextUnresolvedComment() — the next comment-index row (forward-only,
//      no wrap) that still has an open comment.
//   3. offerReviewSubmitFollowup() — the same review-submit offer
//      afterApproveAction falls back to when nothing is left ahead, shared so
//      there is only one copy of that fallback.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs/review-submit-menu.spec.mjs:
// only CreatePaymentAction::execute and Order::address carry a real diff (one
// single-line group each) — every other block has zero changed rows. Blocks
// are selected by label, not by raw index (see "Sort order of the left list"
// in .claude/docs/blocks-and-ingest.md).
//
// Every seeded comment carries rowStart:-1/rowEnd:-1 (unknown anchor, matches
// every unit of its block) and the block's own live label/file, read off the
// DOM first — same shape as comment-resolved-skip.spec.mjs's own seeding, so
// it reliably resolves to a real anchored block instead of an orphan.
const BLOCK1_SEL = 'app/Actions/CreatePaymentAction.php:26' // CreatePaymentAction::execute
const BLOCK6_SEL = 'app/Models/Order.php:88' // Order::address
const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'
const BLOCK6_ID = '12903:app/Models/Order.php:Order::address'

function selParam(page) {
  return new URL(page.url()).searchParams.get('sel')
}

// clearBlockApproval — same sanctioned "set" signal with empty rows/calls as
// postapprove-menu.spec.mjs/review-submit-menu.spec.mjs's own helper, so every
// test here is idempotent regardless of run order/leftover approval on this
// shared anchor PR.
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

// approveViaPalette — same helper as review-submit-menu.spec.mjs.
async function approveViaPalette(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-input').fill('keur')
  await page.getByTestId('command-row').first().click()
}

// fullyApproveBothBlocks approves execute's and address's only group each via
// the palette (the only path that runs afterApproveAction/updates
// state.approvalTotal), leaving nothing left for findNextUnapproved to find —
// the shared baseline for the two tests below that exercise the fallback
// steps (2 and 3) rather than step 1.
async function fullyApproveBothBlocks(page) {
  await clearBlockApproval(page, BLOCK1_ID)
  await clearBlockApproval(page, BLOCK6_ID)
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await approveViaPalette(page)

  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').filter({ hasText: 'Ga door' }).click()
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await approveViaPalette(page)

  // Now fully approved — the review-submit follow-up opens; just close it, it
  // isn't what this file is testing.
  await expect(menu).toBeVisible()
  await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
  await expect(menu).not.toBeVisible()
}

// blockIdentity selects a block row by its visible text and reads its own
// live label/file straight off the card — see comment-resolved-skip.spec.mjs.
async function blockIdentity(page, rowText) {
  await page.getByTestId('block-row').filter({ hasText: rowText }).click()
  const card = page.getByTestId('block-column').locator('article').first()
  await expect(card).toBeVisible()
  const label = (await card.locator('h2').first().innerText()).trim()
  const file = (await card.locator('.font-mono.text-slate-500').first().innerText()).trim().split(':')[0]
  return { label, file }
}

async function seedComment(page, { file, label, line, body }) {
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr: 12903, file, line, author: 'reviewer', body, label, rowStart: -1, rowEnd: -1 },
  })
  const { runId } = await start.json()
  expect(runId).toBeTruthy()
  return runId
}

test.describe('PR Review Tree — resolving a comment navigates to the next thing', () => {
  test('resolving a block-scoped comment jumps straight to the next unapproved unit (step 1), no confirm menu', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const { label, file } = await blockIdentity(page, 'CreatePaymentAction::execute')
    const runId = await seedComment(page, { file, label, line: 1, body: 'a note on execute' })
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        return list.some((c) => c.runId === runId)
      })
      .toBe(true)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: label }).first().click()
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // list → diff
    await page.keyboard.press('ArrowRight') // diff → the comment thread

    const inlineComments = page.getByTestId('inline-comments')
    await expect(inlineComments.getByTestId('comment-item')).toHaveCount(1)
    await expect(page.getByTestId('reaction-compose')).toBeFocused()

    // Enter opens commentCommandsFor; "Resolve comment" is the default (2nd)
    // item, no menu stays open afterwards — this navigates immediately, not
    // via a "Ga door" confirm step.
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Resolve comment' }).click()
    await expect(menu).not.toBeVisible()

    // Same landing block-spanning search as postapprove-menu.spec.mjs's own
    // "Ga door" test — blocks 2-5 have no changes, so it skips straight to
    // Order::address.
    await expect.poll(() => selParam(page)).toBe(BLOCK6_SEL)
    await expect(page).toHaveURL(/mode=diff/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.find((c) => c.runId === runId).status).toBe('resolved')
  })

  test('resolving from the comment index jumps to the next not-yet-resolved comment (step 2) once nothing is left to approve', async ({
    page,
  }) => {
    await fullyApproveBothBlocks(page)
    // Fresh, query-less reload leaves diff mode (the last approve left the
    // page drilled into address's diff, collapsing the sidebar to width 0) —
    // both blocks are now fully approved, so they're also hidden from the
    // sidebar by default (state.showApproved); reveal them to read their
    // label/file.
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.getByTestId('toggle-approved').click()

    const execute = await blockIdentity(page, 'CreatePaymentAction::execute')
    const runIdA = await seedComment(page, { ...execute, line: 1, body: 'comment A (still open)' })
    const address = await blockIdentity(page, 'Order::address')
    const runIdB = await seedComment(page, { ...address, line: 1, body: 'comment B (still open)' })
    let idA, idB
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        idA = list.find((c) => c.runId === runIdA)?.id
        idB = list.find((c) => c.runId === runIdB)?.id
        return idA && idB ? 2 : 0
      })
      .toBe(2)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: 'comment A' }).first().click()
    // Both comments resolve to a real anchored block, so selecting the row
    // reads "as if fully expanded" (openCommentAnchorDrill, comments-panel.md)
    // instead of the plain PR-wide commentDetailCard — the `?sel=` reference
    // (the same id-based reference urlState.mjs mirrors, see CLAUDE.md's URL
    // state section) is the stable way to assert which row is selected.
    await expect.poll(() => selParam(page)).toBe('comment:' + idA)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // isOwnComment (no source/'ui') sorts "Resolve comment" first — the
    // default item.
    await expect(page.getByTestId('command-row').nth(1)).toContainText('Resolve comment')
    await page.getByTestId('command-row').filter({ hasText: 'Resolve comment' }).click()
    await expect(menu).not.toBeVisible()

    // Both real blocks are already approved, so findNextUnapproved finds
    // nothing — the fallback lands on comment B's own index row instead.
    await expect.poll(() => selParam(page)).toBe('comment:' + idB)

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.find((c) => c.runId === runIdA).status).toBe('resolved')
    expect(list.find((c) => c.runId === runIdB).status).not.toBe('resolved')
  })

  test('resolving the last open comment with nothing left to approve falls back to the review-submit offer (step 3)', async ({
    page,
  }) => {
    await fullyApproveBothBlocks(page)
    // Fresh, query-less reload leaves diff mode (the last approve left the
    // page drilled into address's diff, collapsing the sidebar to width 0) —
    // both blocks are now fully approved, so they're also hidden from the
    // sidebar by default (state.showApproved); reveal them to read their
    // label/file.
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.getByTestId('toggle-approved').click()

    const execute = await blockIdentity(page, 'CreatePaymentAction::execute')
    const runId = await seedComment(page, { ...execute, line: 1, body: 'the only remaining open comment' })
    let id
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        id = list.find((c) => c.runId === runId)?.id
        return !!id
      })
      .toBe(true)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: 'the only remaining open comment' }).first().click()
    // A line-anchored comment resolves to a real block, so it opens "as if
    // fully expanded" (openCommentAnchorDrill) rather than the plain
    // commentDetailCard — the `?sel=` reference is the stable way to assert
    // which row is selected (same reasoning as the step-2 test above).
    await expect.poll(() => selParam(page)).toBe('comment:' + id)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Resolve comment' }).click()

    // Both blocks were already approved and this was the last open comment,
    // so the whole PR now reads fully done — the same 'reviewApprove' offer
    // afterApproveAction's own "nothing left ahead" branch opens.
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Keur de HELE PR goed')

    await rows.filter({ hasText: 'Sluit menu' }).click()
    await expect(menu).not.toBeVisible()

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.find((c) => c.runId === runId).status).toBe('resolved')
  })
})

// Narrowed the next day (2026-08-27, see afterResolveAction's own doc
// comment): the tree-walk-first order above is now ONLY for resolving/
// deleting an ordinary block-scoped comment while the sidebar cursor sits on
// a normal code block. While the cursor sits on the comment/chat "Start" row
// itself (isCommentIndexRowActive — a "Comments op regels" row, selected or
// with its own thread entered), resolving OR deleting it must skip
// findNextUnapproved entirely and land directly on the next still-open
// comment/chat row, even when the anchor block it lived on (or a sibling
// block) still has real unapproved work ahead — that's the one thing the
// tests below prove differently from the step-1 test above, which leaves
// both blocks unapproved but resolves from INSIDE the block's own diff, not
// from its comment-index row.
test.describe('PR Review Tree — resolving/deleting FROM a comment-index row skips straight to the next row', () => {
  test('resolving from a "Comments op regels" row skips findNextUnapproved, even though its own anchor block is still unapproved', async ({
    page,
  }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const execute = await blockIdentity(page, 'CreatePaymentAction::execute')
    const runIdA = await seedComment(page, { ...execute, line: 1, body: 'comment A (on an unapproved block)' })
    const address = await blockIdentity(page, 'Order::address')
    const runIdB = await seedComment(page, { ...address, line: 1, body: 'comment B (still open)' })
    let idA, idB
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        idA = list.find((c) => c.runId === runIdA)?.id
        idB = list.find((c) => c.runId === runIdB)?.id
        return idA && idB ? 2 : 0
      })
      .toBe(2)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: 'comment A' }).first().click()
    // Auto-drilled open "as if fully expanded" (openCommentAnchorDrill), same
    // as the step-2 test above — the sidebar cursor (curBlock()) stays on
    // this comment-index row, never on `execute` itself, even though its
    // anchor block IS `execute` and that block still has one unapproved
    // group of its own.
    await expect.poll(() => selParam(page)).toBe('comment:' + idA)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Resolve comment' }).click()
    await expect(menu).not.toBeVisible()

    // Old (tree-first) behavior would land inside execute's OWN still-open
    // diff group instead — this must skip straight to comment B's row.
    await expect.poll(() => selParam(page)).toBe('comment:' + idB)
    await expect(page).not.toHaveURL(/mode=diff/)

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.find((c) => c.runId === runIdA).status).toBe('resolved')
    expect(list.find((c) => c.runId === runIdB).status).not.toBe('resolved')
  })

  test('deleting a comment-index row (Verwijder comment) also skips straight to the next row', async ({ page }) => {
    await clearBlockApproval(page, BLOCK1_ID)
    await clearBlockApproval(page, BLOCK6_ID)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const execute = await blockIdentity(page, 'CreatePaymentAction::execute')
    const runIdA = await seedComment(page, { ...execute, line: 1, body: 'comment A (to be deleted)' })
    const address = await blockIdentity(page, 'Order::address')
    const runIdB = await seedComment(page, { ...address, line: 1, body: 'comment B (still open)' })
    let idA, idB
    await expect
      .poll(async () => {
        const list = await (await page.request.get('/api/comments?pr=12903')).json()
        idA = list.find((c) => c.runId === runIdA)?.id
        idB = list.find((c) => c.runId === runIdB)?.id
        return idA && idB ? 2 : 0
      })
      .toBe(2)

    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await page.locator('[data-idx]').filter({ hasText: 'comment A' }).first().click()
    await expect.poll(() => selParam(page)).toBe('comment:' + idA)

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    // isOwnComment sorts [Resolve comment, Beantwoorden, Verwijder comment] —
    // "Verwijder comment" is always last, never the default item.
    await page.getByTestId('command-row').filter({ hasText: 'Verwijder comment' }).click()
    await expect(menu).not.toBeVisible()

    // Old behavior had no navigation at all here — the row just vanished and
    // whatever recomputeLeftList's own clamp landed on stayed selected. This
    // must instead jump forward to comment B's own row.
    await expect.poll(() => selParam(page)).toBe('comment:' + idB)
    await expect(page).not.toHaveURL(/mode=diff/)

    const list = await (await page.request.get('/api/comments?pr=12903')).json()
    expect(list.find((c) => c.runId === runIdA)).toBeUndefined()
    expect(list.find((c) => c.runId === runIdB)?.status).not.toBe('resolved')
  })
})
