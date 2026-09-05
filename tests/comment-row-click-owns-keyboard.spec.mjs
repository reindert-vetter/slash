import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A fresh open (no ?sel=) lands on stop 1 — the PR-description column owns the
// keyboard (state.showDescription, home.mjs). Clicking an index row is "a real
// choice" (state.blockIndexEntered), and since this fix the KEYBOARD follows
// that choice too, mirroring enterDiff's mouse path: ownership moves to the
// index while the description column merely stays VISIBLE via
// state.descriptionPinned. Without it, Enter on a just-clicked PR-comment
// "Start" row opened the PR-wide menu ("Chat met Claude over deze PR"/GitHub/
// Jira) instead of the row's own action menu — found live against the
// slash-test fixture; the comment actions were unreachable by keyboard until
// the reviewer happened to press → first.
//
// Anchor PR 12903 (real blocks, so the fresh-open stop-1 treatment actually
// applies — a block-less PR never reaches it) + a mocked unanchored PR-wide
// comment, same shape as mention-highlight.spec.mjs's own mock.
test('Enter right after clicking a comment-index row on a fresh open opens the row\'s own menu', async ({
  page,
}) => {
  await page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'prwide-1', runId: 'run-prwide-1', pr: 12903, file: '', line: 0,
          author: 'dennissloove', body: 'algemene opmerking over deze PR',
          createdAt: new Date().toISOString(), reactionCount: 0, status: 'open',
          source: 'github', kind: 'issue', reactions: [], rowStart: -1, rowEnd: -1,
        },
      ]),
    }),
  )
  await page.goto('/pr/12903', { keepDescription: true }) // NO ?sel= and no auto-skip — a genuinely fresh open on stop 1
  await leaveSearchBox(page)
  // Stop 1 owns the page: the PR-info column is showing.
  await expect(page.getByTestId('pr-info-column')).toBeVisible()

  await page.locator('[data-idx]').filter({ hasText: 'algemene opmerking' }).first().click()
  await expect(page.getByTestId('comment-detail-card')).toBeVisible()
  // The description column stays visible (pinned) — visibility, not ownership.
  await expect(page.getByTestId('pr-info-column')).toBeVisible()

  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  // The row's OWN action menu, not the PR-wide one.
  await expect(page.getByTestId('command-row').filter({ hasText: 'Resolve comment' })).toBeVisible()
  await expect(page.getByTestId('command-row').filter({ hasText: 'Chat met Claude over deze PR' })).toHaveCount(0)
})
