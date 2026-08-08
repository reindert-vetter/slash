import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Space on a unit that calls into code which itself still has unapproved work
// must NOT approve the whole unit: it approves only up to AND INCLUDING the
// call segment that leads into that code, and goes there (reviewer request —
// see descendIntoUnapprovedCall/approveThroughCall in home.mjs). Approving a
// whole group in one press would otherwise silently tick off call sites whose
// underlying code the reviewer never opened.
//
// PR 100 (tests/fixtures/arrow-blocks.json + arrow-callresolve.json, the same
// fixture call-arrows.spec.mjs uses): ArrowCallerAction::execute has two
// changed groups — an unrelated $flag/$note pair first, then a group with two
// adjacent call lines. The first of those calls arrowHelper, which resolves to
// the also-changed ArrowHelperService::arrowHelper block (itself calling the
// changed ArrowNestedService::arrowNested); the second calls arrowPlain, which
// resolves into a file this PR doesn't touch and therefore has no subtree to
// review at all.
const CALLER_ID = '100:app/Actions/ArrowCallerAction.php:ArrowCallerAction::execute'

async function callerApproval(page) {
  const res = await page.request.get('/api/approvals?pr=100')
  const rows = await res.json()
  return (Array.isArray(rows) ? rows : []).find((r) => r.blockId === CALLER_ID) || null
}

// clearApproval resets the caller's durable approval through the sanctioned
// write path (the approve workflow's `set` signal — an empty set removes the
// row), so this spec is idempotent regardless of run order on the worker DB.
async function clearApproval(page) {
  const start = await page.request.post('/api/workflows/approve', { data: { pr: 100 } })
  const { runId } = await start.json()
  await page.request.post(`/api/workflows/${runId}/signals/set`, {
    data: { blockId: CALLER_ID, rows: [], calls: [] },
  })
  await expect
    .poll(async () => (await callerApproval(page)) === null)
    .toBe(true)
}

test('Space approves only up to the call whose underlying code is still open, and drills there', async ({
  page,
}) => {
  await clearApproval(page)
  await page.goto('/pr/100')

  await expect(page.getByTestId('block-row')).toHaveCount(1)
  await leaveSearchBox(page)

  // Into the diff (lands on the unrelated first group), then down to the group
  // holding both call lines.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.locator('[data-testid=related-item][data-child-id*="arrowHelper"]'),
  ).toBeVisible()

  await page.keyboard.press(' ')

  // It went INTO arrowHelper's own column rather than approving the group and
  // moving on.
  const drill = page.getByTestId('drill-column')
  await expect(drill).toHaveCount(1)
  await expect(drill).toContainText('arrowHelper')

  // The caller is approved only up to that call: the row is NOT fully approved
  // (so it never graduated into approvedRows), it carries per-segment keys for
  // the segments up to and including `->arrowHelper(`, and the SECOND call line
  // (arrowPlain, further down the same group) is untouched.
  await expect
    .poll(async () => {
      const a = await callerApproval(page)
      return a && a.calls ? a.calls.length : 0
    })
    .toBeGreaterThan(0)
  const approval = await callerApproval(page)

  const callRow = Number(approval.calls[0].split(':')[0])
  for (const key of approval.calls) {
    expect(Number(key.split(':')[0])).toBe(callRow)
  }
  expect(approval.rows || []).not.toContain(callRow)
  // The arrowPlain line sits below the arrowHelper line in the same group and
  // must not have been swept along.
  expect(approval.rows || []).not.toContain(callRow + 1)
})

// The counterpart: a call whose target has nothing left to approve (or isn't a
// PR block at all) must not divert Space — it approves the unit as always.
test('Space approves the unit normally when the calls underneath have nothing open', async ({
  page,
}) => {
  await clearApproval(page)
  await page.goto('/pr/100')
  await leaveSearchBox(page)

  // The FIRST group ($flag/$note) contains no call site at all.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await page.keyboard.press(' ')

  // No drill column opened; the group's own rows are approved outright.
  await expect(page.getByTestId('drill-column')).toHaveCount(0)
  await expect
    .poll(async () => {
      const a = await callerApproval(page)
      return a && a.rows ? a.rows.length : 0
    })
    .toBeGreaterThan(0)
})
