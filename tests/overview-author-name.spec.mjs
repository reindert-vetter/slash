import { test, expect } from './_fixtures.mjs'

// Each inbox row starts with WHO wrote the PR — the avatar with the author's
// real first name under it — instead of the old git-pull-request glyph (which
// only distinguished draft from open by colour, meaningless for a colourblind
// reviewer; draft is still spelled out by the "Concept" chip). The name comes
// from GET /api/names (the local names.json override, then the GitHub profile
// name — see usernames.go); a login nobody knows a name for falls back to the
// bare login, unmodified.
//
// The harness runs with SLASH_GITHUB=off, so the real endpoint resolves nothing
// — these tests stub it, which is also the only way to exercise the fallback and
// the resolved case side by side in one run.
test.describe('PR overview — author name + avatar per row', () => {
  test('shows the first name of the resolved full name, and the bare login when unknown', async ({ page }) => {
    await page.route('**/api/names**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        // "alice" resolves, "dave" deliberately does not (empty name).
        body: JSON.stringify({
          ok: true,
          names: { alice: { name: 'Alice Anderson', avatarUrl: '' }, dave: { name: '', avatarUrl: '' } },
        }),
      })
    })

    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const alice = page.locator('[data-testid="row-author"][data-author="alice"]').first()
    await expect(alice).toContainText('Alice')
    await expect(alice).not.toContainText('Anderson') // only the first token
    // The full name plus the login stays reachable, so the account behind a
    // first name is still findable.
    await expect(alice).toHaveAttribute('title', 'Alice Anderson (alice)')

    const dave = page.locator('[data-testid="row-author"][data-author="dave"]').first()
    await expect(dave).toContainText('dave') // no real name → the login, as-is
    await expect(dave).toHaveAttribute('title', 'dave')

    // The login no longer sits in the meta line — the author column replaced it.
    const row = page.locator('[data-testid="pr-row"]', { has: page.locator('[data-author="alice"]') }).first()
    await expect(row).toContainText('#') // repo#number is still there
  })

  test('a login with no name at all still renders an author column (never an empty slot)', async ({ page }) => {
    // /api/names failing outright must not cost the column: every row keeps its
    // avatar + login.
    await page.route('**/api/names**', (route) => route.fulfill({ status: 500, body: '' }))

    await page.goto('/pr-overview')
    await page.waitForLoadState('networkidle')

    const authors = page.locator('[data-testid="row-author"]')
    await expect(authors.first()).toBeVisible()
    const login = await authors.first().getAttribute('data-author')
    await expect(authors.first()).toContainText(login)
  })
})
