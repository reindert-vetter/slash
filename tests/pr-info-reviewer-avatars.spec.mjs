import { test, expect } from './_fixtures.mjs'

// The PR-info column's top row shows the reviewer avatars with their status
// badges (same reviewerAvatar as /pr-overview) instead of a "Weergave" label,
// refetched from GET /api/inbox/status every time stop 1 opens.
test.use({ viewport: { width: 1600, height: 1000 } })

test('stop 1 shows reviewer avatars with status badges, refetched on every open', async ({ page }) => {
  let calls = 0
  await page.route('**/api/inbox/status**', (route) => {
    calls++
    const reviewers = [
      { login: 'alice', avatarUrl: '', state: 'PENDING', team: false },
      { login: 'bob', avatarUrl: '', state: 'APPROVED', team: false },
    ]
    if (calls > 1) reviewers.push({ login: 'carol', avatarUrl: '', state: 'CHANGES_REQUESTED', team: false })
    const url = new URL(route.request().url())
    const key = url.searchParams.get('prs')
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, statuses: { [key]: { reviewers } } }) })
  })
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await page.keyboard.press('ArrowLeft')

  const row = page.getByTestId('pr-info-reviewer-avatars')
  await expect(row).toBeVisible()
  await expect(row.locator('> span')).toHaveCount(2)
  await expect(row).not.toContainText('Weergave')
  await expect(page.getByTestId('pr-info-reviewers')).toHaveCount(0)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await expect(row.locator('> span')).toHaveCount(3)
})
