import { test, expect } from './_fixtures.mjs'

// Keyboard reachability of the stale-tree notice (staleTreeRow, BlockList.mjs):
// reviewer request "als ik hier naarboven key druk, wil ik duidelijk ... row
// selecteren en daarop enter kunnen doen" — see keyboard-navigation.md's
// "circular loop" section. Mirrors blocks-stale-notice.spec.mjs's SSE setup.
test('ArrowUp from the topmost block selects the stale-tree row, and Enter reloads', async ({
  page,
}) => {
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
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  release()
  const notice = page.getByTestId('blocks-stale')
  await expect(notice).toHaveCount(1)

  // Land on the first visible block explicitly, then walk up onto the notice.
  await page.getByTestId('block-row').first().click()
  await page.keyboard.press('ArrowUp')

  // Selected: the same indigo border/ring every other focused stop uses, and
  // no ordinary block row reads as selected at the same time.
  await expect(notice).toHaveClass(/border-indigo-300/)
  await expect(page.getByTestId('block-row').first()).not.toHaveClass(/bg-indigo-50/)

  const loaded = page.waitForEvent('load')
  await page.keyboard.press('Enter')
  await loaded
})

test('ArrowDown from the stale-tree row returns to the first visible block', async ({ page }) => {
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
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  release()
  const notice = page.getByTestId('blocks-stale')
  await expect(notice).toHaveCount(1)

  await page.getByTestId('block-row').first().click()
  await page.keyboard.press('ArrowUp')
  await expect(notice).toHaveClass(/border-indigo-300/)

  await page.keyboard.press('ArrowDown')
  await expect(notice).not.toHaveClass(/border-indigo-300/)
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
})
