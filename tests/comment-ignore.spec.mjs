import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// "Ignore" — a fourth item in the PR-comment index item's action menu
// (prCommentCommandsFor, ms.mode === 'prComment') that hides a comment from
// the "PR-comments" section into its own, SEPARATE "Verborgen comments"
// section (own "Toon N verborgen comments" toggle), independent of resolving.
// See "Comment-index items" in detail-layout.md. Deliberately ephemeral
// (state.ignoredComments) — not a persisted Signal, so no /api/workflows
// route mock is needed for the ignore action itself.

function mockComments(page) {
  const now = new Date().toISOString()
  const comments = [
    {
      id: 'ci-1',
      runId: 'run-ci-1',
      pr: 12903,
      file: '',
      line: 0,
      author: 'octocat',
      body: 'Overall this looks great, one nit below',
      createdAt: now,
      reactionCount: 0,
      status: 'open',
      source: 'github',
      kind: 'issue',
      reactions: [],
      rowStart: -1,
      rowEnd: -1,
    },
  ]
  return page.route('**/api/comments?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(comments) }),
  )
}

test.describe('Ignoring a PR-comment index item', () => {
  test('Ignore hides the row into its own "Verborgen comments" toggle, and back', async ({ page }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('comment-heading')).toBeVisible()
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Ignore')
    await page.keyboard.press('ArrowDown') // "Resolve comment"
    await page.keyboard.press('ArrowDown') // "Verwijder comment"
    await page.keyboard.press('ArrowDown') // "Chat met Claude"
    await page.keyboard.press('ArrowDown') // "Ignore"
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)

    // Row disappears from the ordinary "PR-comments" section in the sidebar
    // (scoped to pr-index — the detail card to the right still shows the
    // same text, unaffected by the sidebar-visibility toggle); a SEPARATE
    // toggle appears, distinct from the approved-blocks one.
    const index = page.getByTestId('pr-index')
    await expect(index.getByTestId('comment-heading')).toHaveCount(0)
    const toggle = page.getByTestId('toggle-ignored')
    await expect(toggle).toBeVisible()
    await expect(toggle).toContainText('Toon 1 verborgen comment')
    await expect(index.getByText('Overall this looks great')).toHaveCount(0)

    // Reveal it: its own "Verborgen comments" heading, still selectable, and
    // its menu now offers "Ignore ongedaan maken".
    await toggle.click()
    await expect(index.getByTestId('hidden-comment-heading')).toBeVisible()
    const row = index
      .getByTestId('block-row')
      .filter({ hasText: 'Overall this looks great' })
    await expect(row).toBeVisible()
    await row.click()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Ignore ongedaan maken')
    await page.keyboard.press('ArrowDown') // "Resolve comment"
    await page.keyboard.press('ArrowDown') // "Verwijder comment"
    await page.keyboard.press('ArrowDown') // "Chat met Claude"
    await page.keyboard.press('ArrowDown') // "Ignore ongedaan maken"
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)

    // Un-ignoring puts it straight back in the ordinary "PR-comments" list
    // (the toggle is still open, so nothing is hidden right now).
    await expect(index.getByTestId('comment-heading')).toBeVisible()
    await expect(page.getByTestId('toggle-ignored')).toHaveCount(0)
  })
})
