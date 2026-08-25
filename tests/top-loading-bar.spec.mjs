import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// TopLoadingBar (src/TopLoadingBar.mjs) — a full-width strip fixed at the true
// top of the screen shown while the currently active TOP-LEVEL block's code
// is still being fetched (topLoadingActive in home.mjs). Reported need: the
// per-card "loading code…" text can land anywhere on screen (e.g. right after
// an approve-triggered auto-advance to the next block), so a fixed top strip
// gives a stable, always-visible loading signal.
//
// Fixture: PR 12903 (see space-approve-continue.spec.mjs for the same
// fixture's block layout). Block 1 (CreatePaymentAction::execute) is the one
// whose /api/code response is delayed here.
test('top loading bar shows while the selected block\'s code is fetching, and hides once it arrives', async ({
  page,
}) => {
  let releaseDelay
  const delay = new Promise((resolve) => {
    releaseDelay = resolve
  })
  await page.route('**/api/code**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('name') === 'execute') {
      await delay
    }
    await route.fallback()
  })

  await page.goto('/pr/12903')
  const bar = page.getByTestId('top-loading-bar')
  // The default selection isn't delayed (it isn't `execute`), so the bar
  // settles hidden once the initial page load finishes.
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await expect(bar).toBeHidden()

  // By label, not by raw index — see "Sort order of the left list" in
  // blocks-and-ingest.md. Its /api/code fetch is the one delayed above.
  await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')

  // execute's code fetch is still held open — the top bar is up.
  await expect(bar).toBeVisible()

  releaseDelay()

  // Once the delayed fetch resolves, the diff renders and the bar hides again.
  await expect(page.locator('[data-change-active]').first()).toBeVisible()
  await expect(bar).toBeHidden()
})
