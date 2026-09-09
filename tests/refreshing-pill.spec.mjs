import { test, expect } from './_fixtures.mjs'

// The "wordt bijgewerkt" pill (⟳, chat_refresh_pending.go) and the auto-refresh
// it drives: reviewer request "als claude net een aanpassing heeft gedaan...
// dan wil ik dat gelijk zien (of juist dat het weg is)" — the pre-existing
// `ongepusht`/staleTreeRow pair didn't say anything about the CODE shown having
// caught up with a landed edit yet, and required a manual click to refresh. See
// .claude/docs/pending-push.md.
//
// GET /api/chat/checkout and /api/events are mocked, like checkout-chip.spec.mjs/
// blocks-stale-notice.spec.mjs; PR 102's real, permanently-seeded fixture
// (rangeselect-blocks.json) has two blocks in the SAME file
// (RangeSelectAction::execute/::other), which is exactly the "sibling block in
// a touched file" this feature needs — /api/blocks itself is mocked only to
// simulate ::execute having been removed by the landed edit.

function mockCheckout(page, refreshingFiles) {
  return page.route('**/api/chat/checkout?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkout: { 102: { pr: 102, runId: 'chatmerge-102', refreshingFiles: refreshingFiles() } },
      }),
    }),
  )
}

test('the pill shows on the index row and the diff card while a landed edit awaits re-ingest', async ({ page }) => {
  await mockCheckout(page, () => ['app/Actions/RangeSelectAction.php'])
  await page.goto('/pr/102')

  const row = page
    .getByTestId('block-row')
    .filter({ hasText: 'RangeSelectAction::execute' })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('row-refreshing')).toContainText('wordt bijgewerkt')

  await row.click()
  await expect(page.getByTestId('block-refreshing').first()).toContainText('wordt bijgewerkt')
})

test('a blocks.changed event carrying landedFiles in its OWN payload refreshes automatically and follows the selection to a sibling in the same file — even when the (purely cosmetic) checkout read model never caught up', async ({
  page,
}) => {
  let release
  const released = new Promise((r) => (release = r))
  let landed = false

  await page.route('**/api/blocks?pr=102*', async (route) => {
    if (!landed) {
      await route.continue()
      return
    }
    // The landed edit removed RangeSelectAction::execute entirely. `id`/`label`
    // are normally computed server-side (Block.MarshalJSON/makeLabel) — since
    // this route bypasses that, both are supplied explicitly here in the same
    // shape.
    await route.fulfill({
      json: [
        {
          id: '102:app/Actions/RangeSelectAction.php:RangeSelectAction::other',
          pr: 102,
          file: 'app/Actions/RangeSelectAction.php',
          class: 'RangeSelectAction',
          name: 'other',
          label: 'RangeSelectAction::other',
          category: 'ACTION',
          line: 16,
          endLine: 20,
          status: 'modified',
          side: 'new',
        },
      ],
    })
  })
  // Deliberately ALWAYS empty: this is the exact race the server-side ordering
  // bug produced (blocks.changed reaching the tab before this separately
  // polled read model ever reflected the landing). The auto-refresh below must
  // not depend on it at all — only on the event's own payload.
  await mockCheckout(page, () => [])
  await page.route('**/api/events*', async (route) => {
    await released // never resolves until the test says so
    landed = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body:
        'retry: 300\n\n' +
        `data: ${JSON.stringify({
          type: 'blocks.changed',
          pr: 102,
          seq: 1,
          data: { landedFiles: ['app/Actions/RangeSelectAction.php'] },
        })}\n\n`,
    })
  })

  await page.goto('/pr/102')
  const execute = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })
  await execute.click()
  // No pill either — the checkout read model never reported anything pending,
  // by design of this test. The auto-refresh below must fire regardless.
  await expect(page.getByTestId('row-refreshing')).toHaveCount(0)

  release()

  // Own landing → applied automatically, never the manual stale-tree notice.
  await expect(page.getByTestId('blocks-stale')).toHaveCount(0)
  // execute() is gone; the selection moved to the OTHER block in the SAME file
  // rather than the generic reset-to-the-first-row fallback.
  await expect(page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })).toHaveCount(0)
  const other = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::other' })
  await expect(other).toHaveCount(1)
  await expect(other).toHaveClass(/bg-indigo-50/)
})

test('a plain blocks.changed with no landedFiles payload still falls back to the manual stale-tree notice (a colleague\'s push)', async ({
  page,
}) => {
  let release
  const released = new Promise((r) => (release = r))

  await mockCheckout(page, () => [])
  await page.route('**/api/events*', async (route) => {
    await released
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'blocks.changed', pr: 102, seq: 1 })}\n\n`,
    })
  })

  await page.goto('/pr/102')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await expect(page.getByTestId('blocks-stale')).toHaveCount(0)

  release()

  await expect(page.getByTestId('blocks-stale')).toHaveCount(1)
})

// The vangnet: a blocks.changed frame whose OWN payload came back empty (the
// exact race a server-side ordering bug can produce) must still be recognised
// as OUR OWN landing — not the manual stale-tree fallback above — whenever the
// separately-polled checkout read model already knows a landed edit is being
// re-ingested for this file (see checkoutRefreshingFiles' own doc comment and
// the onEvent('blocks.changed', ...) branch it feeds). Before this fix,
// ensureCode's codeRequested guard for the touched file never got invalidated
// in this case, leaving the block on its pre-landing source and the
// TopLoadingBar spinning forever ("oneindig aan het laden").
test('a blocks.changed event with no landedFiles payload, but the checkout read model already known to be refreshing this file, still auto-refreshes', async ({
  page,
}) => {
  let release
  const released = new Promise((r) => (release = r))
  let landed = false

  await mockCheckout(page, () => ['app/Actions/RangeSelectAction.php'])
  await mockApprovals(page)
  await mockLandedCode(page, () => landed)
  await page.route('**/api/events*', async (route) => {
    await released
    landed = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      // Deliberately no data.landedFiles at all — the same shape as the
      // "colleague pushed" test above, but this time the checkout read model
      // (mocked above) says otherwise.
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'blocks.changed', pr: 102, seq: 1 })}\n\n`,
    })
  })

  await page.goto('/pr/102')
  const row = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })
  await row.click()
  const diff = selectedCard(page)
  await expect(diff).toContainText('$a = 1;')
  const bar = page.getByTestId('top-loading-bar')
  await expect(bar).toBeHidden()

  release()

  // Recognised as our own landing via the checkout read model — never the
  // manual stale-tree notice.
  await expect(page.getByTestId('blocks-stale')).toHaveCount(0)
  // The landed source arrives without a manual reload, and the loading bar
  // never gets stuck spinning.
  await expect(diff).toContainText('$a = 4242;')
  await expect(bar).toBeHidden()
})

// PR 102's head worktree holds `$a = 1;` in RangeSelectAction::execute (see
// materializeRangeSelectWorktrees, tests/_setup.mjs). Patching the LIVE
// /api/code response is how these two tests simulate "the ingest refresh moved
// the head worktree to the landed commit": GET /api/code always reads that
// worktree straight off disk (code.go), so the server has the new source the
// moment the refresh completes — the only thing that ever kept it off screen
// was home.mjs's own per-block codeRequested cache.
function mockLandedCode(page, landed) {
  return page.route('**/api/code?*', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (landed() && json && json.new && typeof json.new.text === 'string') {
      json.new.text = json.new.text.replace('$a = 1;', '$a = 4242;')
    }
    await route.fulfill({ response: res, json })
  })
}

// The currently-selected card, like diff-code-vs-title.spec.mjs does it: there
// are several elements carrying data-testid=code-diff on the page at once (the
// pane container plus each side's own <code>, in the selected card AND in the
// look-ahead preview below it), so a bare .first() silently walks to a
// different card as soon as the refresh re-renders the column.
const selectedCard = (page) => page.locator('[data-testid="block-column"] article').first()

const EXECUTE_ID = '102:app/Actions/RangeSelectAction.php:RangeSelectAction::execute'

// Two of ::execute's four changed rows pre-approved ($a/$b, rows 2 and 3 of the
// block — see materializeRangeSelectWorktrees), so the refresh has something to
// lose: b.approvedRows lives ON the block object, and the refresh replaces every
// one of those objects with a fresh copy from /api/blocks.
function mockApprovals(page) {
  return page.route('**/api/approvals?pr=102*', (route) =>
    route.fulfill({ json: [{ blockId: EXECUTE_ID, rows: [2, 3], calls: [] }] }),
  )
}

test('the auto-refresh really re-reads the source of the touched files, and keeps the approvals', async ({
  page,
}) => {
  let release
  const released = new Promise((r) => (release = r))
  let landed = false

  await mockCheckout(page, () => [])
  await mockApprovals(page)
  await mockLandedCode(page, () => landed)
  await page.route('**/api/events*', async (route) => {
    await released
    landed = true
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body:
        'retry: 300\n\n' +
        `data: ${JSON.stringify({
          type: 'blocks.changed',
          pr: 102,
          seq: 1,
          data: { landedFiles: ['app/Actions/RangeSelectAction.php'] },
        })}\n\n`,
    })
  })

  await page.goto('/pr/102')
  const row = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })
  await row.click()
  const diff = selectedCard(page)
  await expect(diff).toContainText('$a = 1;')
  const approval = row.getByTestId('block-approval')
  const approvedBefore = await approval.innerText()
  expect(approvedBefore).toContain('2/4')

  release()

  // The landed source, without any manual reload: before this fix the
  // codeRequested cache made ensureCode a no-op for this block forever, so the
  // fresh (code-less) block objects left the card with no diff at all.
  await expect(diff).toContainText('$a = 4242;')
  await expect(diff).not.toContainText('$a = 1;')
  // ...and the reviewer's own approvals are still there (loadApprovals is
  // re-run against the fresh objects).
  await expect(approval).toHaveText(approvedBefore)
})

test('a landing whose SSE frames never arrive is still picked up by the treeCaughtUp poll', async ({
  page,
}) => {
  let reads = 0
  let landed = false

  await mockCheckout(page, () => [])
  await mockApprovals(page)
  await mockLandedCode(page, () => landed)
  // No events at all: this connection simply never delivers anything, which is
  // what a dropped blocks.changed/pendingpush.changed pair looks like from the
  // tab's side. Only loadPendingPush's own timer can recover from that.
  await page.route('**/api/events*', () => {})
  await page.route('**/api/pending-push?*', async (route) => {
    reads++
    if (reads > 1) landed = true
    await route.fulfill({
      json: {
        ok: true,
        pending: {
          102: {
            headRef: 'feature/range',
            sha: reads > 1 ? 'bbbbbbbb' : 'aaaaaaaa',
            ahead: 1,
            files: ['app/Actions/RangeSelectAction.php'],
            state: 'ready',
            treeCaughtUp: true,
          },
        },
      },
    })
  })

  await page.goto('/pr/102')
  const row = page.getByTestId('block-row').filter({ hasText: 'RangeSelectAction::execute' })
  await row.click()
  const diff = selectedCard(page)
  // The FIRST read only establishes the baseline sha — it must never refresh.
  await expect(diff).toContainText('$a = 1;')

  // The next timer tick sees a new caught-up sha and applies it by itself
  // (PENDING_PUSH_POLL_MS, home.mjs).
  await expect(diff).toContainText('$a = 4242;', { timeout: 25000 })
})
