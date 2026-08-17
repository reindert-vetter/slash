import { test, expect, appReady } from './_fixtures.mjs'

// The "Taken" block is a keyboard stop within stop 1 (the PR-description
// column): ↓ walks from the description card into the list and then row by row,
// ↑ walks back and releases the cursor to the description again, → leaves stop 1
// for the tree exactly as it does from the card itself, and Enter opens the
// focused ROW's own menu instead of the PR-wide one. See "Walking into the Taken
// block" in .claude/docs/keyboard-navigation.md.
//
// PR 12903 is the block-fixture-backed worktree PR (read-only, see
// .claude/docs/testing-playwright.md); the rows come from a stubbed
// /api/problems, the same way pr-page-problems.spec.mjs seeds them.
const at = (m) => new Date(Date.now() - m * 60_000).toISOString()

function stubFiveLogRows(page) {
  return page.route('**/api/problems', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        failedRuns: [],
        prTitles: {},
        logErrors: [1, 2, 3, 4, 5].map((n) => ({
          at: at(n),
          scope: 'pr_status',
          pr: 12903,
          message: 'melding ' + n,
        })),
      }),
    }),
  )
}

async function openTaken(page) {
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
}

test.describe('Taken — keyboard navigation within stop 1', () => {
  test('↓ walks in and down, ↑ walks back out to the description', async ({ page }) => {
    await stubFiveLogRows(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    // The description card owns the cursor first — no row is focused yet.
    const focused = page.locator('[data-task-focused=true]')
    await expect(focused).toHaveCount(0)

    await page.keyboard.press('ArrowDown')
    await expect(focused).toHaveCount(1)
    await expect(focused).toContainText('melding 1')

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(focused).toContainText('melding 3')

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(focused).toContainText('melding 1')

    // One more ↑ releases the cursor back to the description card itself,
    // instead of getting stuck on the first row.
    await page.keyboard.press('ArrowUp')
    await expect(focused).toHaveCount(0)
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
  })

  test('a row past the 3,5-row window scrolls itself into view', async ({ page }) => {
    await stubFiveLogRows(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-task-focused=true]')).toContainText('melding 5')
    await expect.poll(() => page.getByTestId('tasks-list').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })

  test('Enter on a focused row opens that row menu, not the PR menu', async ({ page }) => {
    await stubFiveLogRows(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Verberg deze melding')
  })

  test('→ from a focused row still steps right into the tree and the diff', async ({ page }) => {
    await stubFiveLogRows(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-task-focused=true]')).toHaveCount(1)

    await page.keyboard.press('ArrowRight') // out of stop 1, into the block index
    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
    await page.keyboard.press('ArrowRight') // into the diff
    await expect(page.getByTestId('code-diff').first()).toBeVisible()
  })

  test('coming back to stop 1 lands on the description, not a stale row', async ({ page }) => {
    await stubFiveLogRows(page)
    await page.goto('/pr/12903')
    await appReady(page)
    await openTaken(page)

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-task-focused=true]')).toContainText('melding 2')

    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await expect(page.locator('[data-task-focused=true]')).toHaveCount(0)
  })
})
