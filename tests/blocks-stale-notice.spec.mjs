import { test, expect } from './_fixtures.mjs'

// The stale-tree notice: an ingest refresh swaps a PR's blocks while a tab is
// already open (a colleague pushed — the PR 13255 symptom), the server publishes
// blocks.changed, and the tab says so instead of silently showing a tree that is
// one version behind. See .claude/docs/server-events.md.
//
// Driven entirely through a mocked /api/events, like
// callresolve-live-update.spec.mjs: the single SSE connection is held open until
// the test itself lets go, so the frame can only reach the page after the
// "nothing yet" assertion has already settled.

test('a blocks.changed event puts a reload notice above the index', async ({ page }) => {
  let release
  const released = new Promise((r) => (release = r))

  await page.route('**/api/events*', async (route) => {
    await released // never resolves until the test says so
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'blocks.changed', pr: 91, seq: 1 })}\n\n`,
    })
  })

  await page.goto('/pr/91')
  await expect(page.getByTestId('block-row').first()).toBeVisible()

  // The SSE connection is still pending, so nothing has changed yet.
  await expect(page.getByTestId('blocks-stale')).toHaveCount(0)

  release()

  // The notice appears on its own — no click, no navigation.
  const notice = page.getByTestId('blocks-stale')
  await expect(notice).toHaveCount(1)
  // The WORDS carry the meaning, not the amber tint (the colour-blind rule).
  await expect(notice).toContainText('Nieuwe commits')
  await expect(notice).toContainText('herlaad de boom')
})

// The notice is a NOTICE, not an auto-refresh: the tree it sits above must be
// left exactly as it was, so a reviewer mid-approve keeps their cursor and their
// loaded diff. This pins the deliberate product choice, not an implementation
// detail — an auto-refreshing variant would fail here.
test('the notice leaves the selection and the tree untouched', async ({ page }) => {
  let release
  const released = new Promise((r) => (release = r))

  await page.route('**/api/events*', async (route) => {
    await released
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 300\n\n' + `data: ${JSON.stringify({ type: 'blocks.changed', pr: 91, seq: 1 })}\n\n`,
    })
  })

  await page.goto('/pr/91')
  const alpha = page.getByTestId('block-row').filter({ hasText: 'AlphaAction::run' })
  await alpha.click()

  const before = await page.evaluate(() => location.search)
  const rowsBefore = await page.getByTestId('block-row').count()

  release()
  await expect(page.getByTestId('blocks-stale')).toHaveCount(1)

  // Same navigation position, same list — the reviewer decides when to reload.
  expect(await page.evaluate(() => location.search)).toBe(before)
  await expect(page.getByTestId('block-row')).toHaveCount(rowsBefore)
  // The selected row keeps its selection styling (what the rest of the suite
  // asserts selection with — there is no data-selected attribute).
  await expect(alpha).toHaveClass(/bg-indigo-50/)
})
