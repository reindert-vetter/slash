import { test, expect } from './_fixtures.mjs'

// Verifies the SSE half of callresolve's live update: resolve_call's LLM
// search runs fire-and-forget well after POST /api/ingest already returned
// (autoStartResolveCall, .claude/docs/workflows-analysis.md), so a reviewer
// who stays on the page — right after "Genereer review-boom" redirects into
// /pr/<id> — must still see the resolved child appear on its own, instead of
// only a LATER fresh tab (which fetches the by-then-already-resolved read
// model) showing more (see .claude/docs/server-events.md).
//
// Driven entirely through mocked network, like claude-chat-progress.spec.mjs.
// PR 91 (tests/fixtures/relations-blocks.json/callresolve.json) already has a
// real, permanently-seeded `resolved` call for AlphaAction::run. /api/callresolve
// is mocked to hide that row until the test itself lets go; the single
// /api/events connection is deliberately held open (never fulfilled) until the
// same moment, so the "callresolve.changed" frame can only ever reach the page
// after the "still nothing yet" assertion below has already settled — no
// reconnect-timing race like the chat spec's "first connection empty, second
// carries the frames" needs, since here there is only ever one connection.
test('a callresolve row that resolves after page load appears without navigating away', async ({ page }) => {
  let release
  const released = new Promise((r) => (release = r))
  let hidden = true

  await page.route('**/api/callresolve?pr=91', async (route) => {
    if (hidden) {
      await route.fulfill({ json: [] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/events*', async (route) => {
    await released // never resolves until the test says so
    hidden = false
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'callresolve.changed', pr: 91, seq: 1 })}\n\n`,
    })
  })

  await page.goto('/pr/91')
  const alpha = page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' })
  await alpha.click()

  // Hidden by the mock, and the SSE connection is still pending: no
  // Onderliggende-code child yet, as if resolve_call's search hadn't landed.
  await expect(page.getByTestId('related-item')).toHaveCount(0)

  // Let the held-open /api/events connection deliver its one frame.
  release()

  // The frontend refetches on its own — no click, no navigation, no reload.
  const item = page.getByTestId('related-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('AlphaTarget::resolveAlpha')
})
