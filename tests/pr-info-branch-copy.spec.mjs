import { test, expect } from './_fixtures.mjs'

// Reviewer request: "als ik druk op de branch, wil ik het copy" — the branch
// name in the PR-info column (pr-info-meta, home.mjs) is now clickable and
// copies itself to the clipboard, reusing the shared copyCodeToClipboard
// mechanism from codeCopy.mjs (same "Gekopieerd!" word-flash feedback as the
// code-fence copy button — see code-fence-copy.spec.mjs). Same mockClipboard
// shape as that spec.
test.use({ viewport: { width: 1600, height: 1000 } })

async function mockClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied = t
          return Promise.resolve()
        },
        readText: () => Promise.resolve(window.__copied),
      },
    })
  })
}

test('clicking the branch name in the PR-info column copies it and flashes "Gekopieerd!"', async ({ page }) => {
  await mockClipboard(page)
  await page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pr: 12903,
        title: 'STAT-1117: churn endpoint',
        url: 'https://github.com/x/y/pull/12903',
        headRef: 'feature/STAT-1117-be-churn-endpoint',
      }),
    }),
  )
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await page.keyboard.press('ArrowLeft') // stop 1: the PR-info column

  const branch = page.getByTestId('pr-info-branch')
  await expect(branch).toBeVisible()
  await expect(branch).toHaveText('feature/STAT-1117-be-churn-endpoint')
  await expect(branch).toHaveAttribute('title', 'Klik om de branchnaam te kopiëren')
  await expect(branch).toHaveClass(/cursor-pointer/)

  await branch.click()
  const copied = await page.evaluate(() => window.__copied)
  expect(copied).toBe('feature/STAT-1117-be-churn-endpoint')
  await expect(branch).toHaveText('Gekopieerd!')

  // Reverts to the branch name again after the flash.
  await expect(branch).toHaveText('feature/STAT-1117-be-churn-endpoint', { timeout: 3000 })
})
