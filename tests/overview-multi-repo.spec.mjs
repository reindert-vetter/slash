import { test, expect, appReady } from './_fixtures.mjs'

// slash reviews more than one repository (see repos.go + the "repos" block in
// data/settings.json). The overview lists PRs from every configured repo in the
// same sections, which raises exactly one hard question per row: which repo is
// this? A PR number alone no longer answers it — plug-and-pay-ops PR 12 and
// plug-and-pay PR 12 are different pull requests.
//
// The shared SLASH_INBOX fixture carries one plug-and-pay-ops row (PR 12), and
// the harness configures that repo in TEST_DATA_DIR/settings.json (see
// materializeSettings in _setup.mjs) — without that entry the server would
// canonicalize an unknown repo to "" (i.e. read it as the primary repo).
test.describe('PR Review Tree — PRs from a second repository', () => {
  const opsRow = '[data-testid="pr-row"][data-pr="plug-and-pay/plug-and-pay-ops#12"]'

  // The row's identity is its (repo, number) pair, not the bare number: that is
  // what `data-pr`/`data-nav-key`/every per-PR state map key is (prUid). A row
  // from the PRIMARY repo keeps the bare number, so nothing about the
  // single-repo world changed.
  test('a second-repo row is keyed by repo+number, a primary-repo row by number alone', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator(opsRow)).toBeVisible()
    await expect(page.locator('[data-testid="pr-row"][data-pr="12888"]')).toBeVisible()
  })

  // The repo is named in a WORD on the row (never colour alone) and the "#12"
  // meta line is prefixed with that row's OWN repo slug instead of the
  // snapshot's.
  test('the row names its repository', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    const badge = page.locator(opsRow).locator('[data-testid="repo-badge"]')
    await expect(badge).toHaveText('plug-and-pay-ops')
    await expect(page.locator(opsRow)).toContainText('plug-and-pay/plug-and-pay-ops#12')

    // A primary-repo row has no badge at all — its rows look exactly as they did
    // before there was a second repo.
    await expect(page.locator('[data-testid="pr-row"][data-pr="12888"] [data-testid="repo-badge"]')).toHaveCount(0)
  })

  // The status pills are backfilled from GET /api/inbox/status, whose map is
  // keyed by statusKey — the bare number for the primary repo, "<slug>#<n>"
  // otherwise. If that key didn't round-trip, this row would render without its
  // reviewer strip while the primary rows have theirs.
  test('its status pills come back under the repo-scoped key', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    await expect(page.locator(opsRow).locator('[data-testid="reviewers"]')).toBeVisible()
  })

  // Opening the row's popover must address THAT row, not the primary repo's PR
  // 12 (which the fixture doesn't even have — the point is the uid is what the
  // popover state holds).
  test('its popover opens on the row itself', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator(opsRow).click()
    const popover = page.locator(opsRow).locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover.locator('[data-testid="close-popover"]')).toBeVisible()
    // Its GitHub link points at the second repo, not at plug-and-pay.
    await expect(popover.locator('a[href*="plug-and-pay-ops/pull/12"]')).toHaveCount(1)
  })
})
