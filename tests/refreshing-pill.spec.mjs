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
