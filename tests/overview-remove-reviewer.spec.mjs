import { test, expect, appReady } from './_fixtures.mjs'

// "Verwijder mij als reviewer" — the last item of a row's popover on
// /pr-overview (see canRemoveSelf/removeReviewerAction in src/overview.mjs).
// It only shows on a PR somebody ELSE opened, and its POST carries just the PR
// number: who is removed is resolved server-side from the authenticated user.
//
// /api/me is stubbed because the harness runs with SLASH_GITHUB=off, where the
// real endpoint answers {ok:false} — without a known local login the item is
// deliberately hidden, so nothing could be asserted at all. The rows come from
// the shared SLASH_INBOX fixture: 12888 is dave's, 12801 is my own.
test.describe('PR Review Tree — remove myself as reviewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, login: 'reindert-vetter', avatarUrl: '' }),
      })
    })
  })

  test('a foreign PR offers it as the last item and posts only the PR number', async ({ page }) => {
    const bodies = []
    await page.route('**/api/workflows/remove_reviewer', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"runId":"r1"}' })
    })

    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="pr-row"][data-pr="12888"]').click()
    const popover = page.locator('[data-testid="pr-popover"]')
    const remove = popover.locator('[data-testid="remove-reviewer"]')
    await expect(remove).toBeVisible()

    // Really the LAST actionable item of the menu, as asked for.
    const isLast = await popover.evaluate((el) => {
      const items = el.querySelectorAll('button, a')
      const last = items[items.length - 1]
      return !!last && last.dataset.testid === 'remove-reviewer'
    })
    expect(isLast).toBe(true)

    await remove.click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ pr: 12888 })
    // A successful removal closes the menu (and refreshes the inbox snapshot).
    await expect(popover).toHaveCount(0)
  })

  test('the row leaves the list at once and the top row is selected', async ({ page }) => {
    let inboxCalls = 0
    await page.route('**/api/inbox', async (route) => {
      inboxCalls++
      await route.continue()
    })
    await page.route('**/api/workflows/remove_reviewer', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"runId":"r1"}' })
    })

    await page.goto('/pr-overview')
    await appReady(page)

    const row = page.locator('[data-testid="pr-row"][data-pr="12888"]')
    await row.click()
    await page.locator('[data-testid="pr-popover"] [data-testid="remove-reviewer"]').click()

    // Gone immediately — not after the /api/inbox round trip, which still
    // serves 12888 from the shared SLASH_INBOX fixture.
    await expect(row).toHaveCount(0)

    // And it stays gone once that refetch (plus any later poll) has landed:
    // removedPrs is deliberately never emptied.
    const before = inboxCalls
    await expect.poll(() => inboxCalls).toBeGreaterThan(before)
    await expect(row).toHaveCount(0)

    // The selection lands on the new first row of the overview — the row the
    // reviewer was standing on just left the list, so without this there'd be
    // no ring at all. Same behaviour as the just-approved round trip.
    const firstRow = page.locator('[data-nav-row]').first()
    await expect(firstRow).toHaveClass(/ring-indigo-500\/50/)
  })

  test('my own PR does not offer it', async ({ page }) => {
    await page.goto('/pr-overview')
    await appReady(page)

    await page.locator('[data-testid="pr-row"][data-pr="12801"]').click()
    const popover = page.locator('[data-testid="pr-popover"]')
    await expect(popover).toBeVisible()
    await expect(popover.locator('[data-testid="remove-reviewer"]')).toHaveCount(0)
  })
})
