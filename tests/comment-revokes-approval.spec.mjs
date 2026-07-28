import { test, expect } from './_fixtures.mjs'

// "Als iemand een comment plaatst, dan wil ik dat de bijbehorende regel niet
// meer approved is" — placing a comment on an already-approved unit signals
// the reviewer that the code isn't OK after all, so its approval is retracted
// (revokeApprovalForComment, home.mjs), through the existing `set` Signal
// (persistApproval) — never a direct write. See blocks-and-ingest.md /
// detail-layout.md.
//
// The POST to task_code_comment itself is mocked (same precedent as
// place-comment-return-focus.spec.mjs) so this test doesn't leave a real,
// persisted comment behind on the shared PR 12903 fixture — the revoke logic
// runs purely off the commentTarget()/focusedBlock() snapshot captured before
// that call, so mocking it doesn't weaken what's actually under test here.
//
// Same PR 12903 fixture as postapprove-menu.spec.mjs/review-submit-menu.spec.mjs:
// block 1 (CreatePaymentAction::execute, index 1) carries a real, single-row
// changed group with several call segments.

async function mockCommentPost(page) {
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })
}

async function approvals(page) {
  const res = await page.request.get('/api/approvals?pr=12903')
  return res.json()
}

// persistApproval (home.mjs) is a fire-and-forget POST — the read model can
// lag a beat behind the reactive UI state, so every assertion that depends on
// a just-persisted approval polls for it instead of reading /api/approvals
// exactly once right after the triggering action.
async function waitForApprovalEntry(page, blockId) {
  await expect
    .poll(async () => {
      const rows = await approvals(page)
      return rows.some((r) => r.blockId === blockId)
    })
    .toBe(true)
  const rows = await approvals(page)
  return rows.find((r) => r.blockId === blockId)
}

// waitForCallCount polls until blockId's approvedCalls entry has exactly `n`
// keys (a fresh call-segment approve is likewise a fire-and-forget POST).
async function waitForCallCount(page, blockId, n) {
  await expect
    .poll(async () => {
      const rows = await approvals(page)
      const entry = rows.find((r) => r.blockId === blockId)
      return entry ? entry.calls.length : 0
    })
    .toBe(n)
  const rows = await approvals(page)
  return rows.find((r) => r.blockId === blockId)
}

// approveCurrentUnit approves the current navigation unit through the command
// palette (Enter -> the default 2nd row, "Keur ... goed") and, if approving it
// leaves nothing else ahead (opening a postApprove/review-submit follow-up
// menu), closes that follow-up so the next action starts from a clean slate.
async function approveCurrentUnit(page) {
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').nth(1).click()
  // Approving may leave nothing else ahead, opening a postApprove/review-submit
  // follow-up menu (afterApproveAction, home.mjs) once its async
  // findNextUnapproved() settles. Escape is a safe no-op when no menu is open
  // (menu.open is the only branch that claims it outside a compose/search/
  // editable-focus context, see onKeydown) — so pressing it unconditionally,
  // after giving the follow-up a moment to appear, reliably leaves no menu
  // open for the next action, instead of racing a one-shot isVisible() check.
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-menu')).not.toBeVisible()
}

async function placeComment(page, text) {
  await page.getByTestId('new-comment').click() // open + focus the composer
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill(text)
  await page.keyboard.press('Enter') // opens the compose-kind menu
  await page.keyboard.press('Enter') // "Plaats comment" (default, 2nd item)
  await expect(page.getByTestId('command-menu')).not.toBeVisible()
}

const BLOCK1_ID = '12903:app/Actions/CreatePaymentAction.php:CreatePaymentAction::execute'

// clearBlockApproval resets block 1's durable approval through the sanctioned
// write path (the approve workflow's `set` Signal — an empty set removes the
// row), same helper as postapprove-menu.spec.mjs/review-submit-menu.spec.mjs.
// The second test here deliberately leaves ONE call segment still approved
// (that's the point of the assertion) — afterEach cleans that up so it never
// leaks into another spec sharing this worker's DB/PR 12903 fixture, the same
// hygiene those other specs already rely on for this exact block.
async function clearBlockApproval(page, blockId) {
  const start = await page.request.post('/api/workflows/approve', { data: { pr: 12903 } })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId, rows: [], calls: [] },
  })
  await expect
    .poll(async () => {
      const rows = await approvals(page)
      return rows.every((r) => r.blockId !== blockId)
    })
    .toBe(true)
}

test.afterEach(async ({ page }) => {
  await clearBlockApproval(page, BLOCK1_ID)
})

test('placing a comment retracts the approval of the group/line it hangs on', async ({ page }) => {
  await mockCommentPost(page)
  await page.goto('/pr/12903')
  await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff, block 1, gran 'group'

  await approveCurrentUnit(page)
  const beforeEntry = await waitForApprovalEntry(page, BLOCK1_ID)
  expect(beforeEntry.rows.length).toBeGreaterThan(0)

  // Visual confirmation: the top checkbox now shows real progress ("N/N"
  // rather than "0/N").
  const checkboxLabel = page.locator('[data-testid="block-column"] article').first().locator('label')
  await expect(checkboxLabel).toContainText(/approve \d+\/\d+/)
  const summaryBefore = await checkboxLabel.textContent()
  expect(summaryBefore).not.toMatch(/approve 0\//)

  await placeComment(page, 'deze regel klopt niet, graag aanpassen')

  // The approval for this block's row(s) is gone — and durably so (a fresh
  // GET, not merely the in-memory reactive state).
  await expect
    .poll(async () => {
      const rows = await approvals(page)
      return rows.some((r) => r.blockId === BLOCK1_ID && r.rows.length > 0)
    })
    .toBe(false)

  // Visual confirmation: the checkbox no longer shows that row as approved.
  await expect(checkboxLabel).toContainText(/approve 0\//)
})

// gotoCallUnit navigates directly to a specific call-granularity unit index
// via the URL (gran=call&chg=N) instead of sequential f/d keyboard steps.
// Load-bearing here: approving a call segment whose next unapproved sibling
// sits within the SAME block auto-navigates the cursor there right away
// (afterApproveAction's "stay in this block" shortcut, see
// keyboard-navigation.md) — so a plain 'f'/'d' walk after an approve action
// lands on a moving target instead of the specific segment this test wants.
// A fresh, explicit URL navigation always resolves to the SAME deterministic
// unit (unitsFor(rows, 'call')[N] on this fixture's fixed source), regardless
// of any auto-navigation an earlier approve triggered.
async function gotoCallUnit(page, index) {
  const url = new URL(page.url())
  url.searchParams.set('gran', 'call')
  if (index) url.searchParams.set('chg', String(index))
  else url.searchParams.delete('chg')
  await page.goto(url.toString())
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
}

test('a call-segment comment retracts only that ONE segment, not its row-mates', async ({ page }) => {
  await mockCommentPost(page)
  await page.goto('/pr/12903')
  await page.keyboard.press('Escape')
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('f') // group -> call (a single-row group jumps straight to 'call')
  await expect(page).toHaveURL(/gran=call/)

  await approveCurrentUnit(page) // approve call segment 0
  const seg0Entry = await waitForCallCount(page, BLOCK1_ID, 1)
  const seg0Key = seg0Entry.calls[0]

  // Explicitly (re)select segment 1 — see gotoCallUnit's own doc comment for
  // why this must be a fresh navigation rather than a keyboard 'f' step.
  await gotoCallUnit(page, 1)
  await approveCurrentUnit(page) // approve call segment 1

  const beforeEntry = await waitForCallCount(page, BLOCK1_ID, 2)
  expect(beforeEntry.calls).toContain(seg0Key)
  const seg1Key = beforeEntry.calls.find((k) => k !== seg0Key)

  // Explicitly (re)select segment 0 to place the comment there — same reason.
  await gotoCallUnit(page, 0)
  await placeComment(page, 'dit ene stukje moet anders')

  await expect
    .poll(async () => {
      const rows = await approvals(page)
      const entry = rows.find((r) => r.blockId === BLOCK1_ID)
      return entry ? entry.calls : null
    })
    .toEqual([seg1Key])
})
