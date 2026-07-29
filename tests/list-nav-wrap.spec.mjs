import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The sidebar's ↑/↓ cursor forms one circular loop through the "Start" index:
//   first visible block → … → last visible block → toggle-approved (if any
//   hidden approved blocks exist) → toggle-ignored (if any hidden ignored
//   comments exist) → the search box → back to the first visible block
// ↑ walks the exact same loop backwards. Each toggle row is only a stop when
// it's actually rendered. See stepListSelection/searchStepSelection in
// home.mjs and the corresponding paragraph in keyboard-navigation.md.
//
// This replaces the older, simpler "↑ wraps straight to the bottom" test —
// that plain wrap no longer exists on its own: ↑ from the topmost block now
// always continues into the search box first (see below).

// mockComments seeds one PR-wide comment on PR 12903 (mirrors
// tests/comment-ignore.spec.mjs) so it can be turned into a toggle-ignored
// row via the comment-index item's own "Ignore" action.
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

// ignoreCommentRow walks the comment-index item's action menu to "Ignore" it
// (same three key presses as comment-ignore.spec.mjs), producing a
// toggle-ignored row at the bottom of the sidebar.
async function ignoreCommentRow(page) {
  const commentRow = page.getByTestId('block-row').filter({ hasText: 'Overall this looks great' })
  await commentRow.click()
  await page.keyboard.press('Enter')
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown') // "Resolve comment"
  await page.keyboard.press('ArrowDown') // "Ignore"
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
}

test.describe('PR Review Tree — sidebar ↑/↓ loop through the toggle rows and the search box', () => {
  test('↓/↑ walk through toggle-approved and the search box, wrapping at both ends', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    // Fully approve block 1 (CreatePaymentAction::execute) so a
    // toggle-approved row exists (same approach as
    // tests/selected-reveal-hidden.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await approve.click()
    await expect(approve).toBeChecked()

    const rows = page.getByTestId('block-row')
    const lastRow = rows.last()
    await lastRow.click()
    await expect(lastRow).toHaveClass(/bg-indigo-50/)

    // ↓ from the last visible block lands on the toggle-approved row.
    await page.keyboard.press('ArrowDown')
    const toggleApproved = page.getByTestId('toggle-approved')
    await expect(toggleApproved).toHaveClass(/bg-indigo-50/)
    await expect(lastRow).not.toHaveClass(/bg-indigo-50/)

    // ↓ again continues into the (empty) search box.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await expect(toggleApproved).not.toHaveClass(/bg-indigo-50/)

    // ↓ once more wraps the whole loop back to the first visible block.
    await page.keyboard.press('ArrowDown')
    await expect(rows.first()).toHaveClass(/bg-indigo-50/)
    await expect(page.getByTestId('block-search')).not.toBeFocused()

    // ↑ walks the exact same loop backwards: first block → search →
    // toggle-approved → last block.
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(toggleApproved).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('ArrowUp')
    await expect(lastRow).toHaveClass(/bg-indigo-50/)
  })

  test('↓/↑ walk through toggle-ignored and the search box, wrapping at both ends', async ({
    page,
  }) => {
    await mockComments(page)
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    await ignoreCommentRow(page)

    const rows = page.getByTestId('block-row')
    const lastRow = rows.last()
    await lastRow.click()
    await expect(lastRow).toHaveClass(/bg-indigo-50/)

    // ↓ from the last visible block lands on the toggle-ignored row.
    await page.keyboard.press('ArrowDown')
    const toggleIgnored = page.getByTestId('toggle-ignored')
    await expect(toggleIgnored).toHaveClass(/bg-indigo-50/)
    await expect(lastRow).not.toHaveClass(/bg-indigo-50/)

    // ↓ again continues into the (empty) search box.
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await expect(toggleIgnored).not.toHaveClass(/bg-indigo-50/)

    // ↓ once more wraps the whole loop back to the first visible block.
    await page.keyboard.press('ArrowDown')
    await expect(rows.first()).toHaveClass(/bg-indigo-50/)

    // ↑ walks the exact same loop backwards: first block → search →
    // toggle-ignored → last block.
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('block-search')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(toggleIgnored).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('ArrowUp')
    await expect(lastRow).toHaveClass(/bg-indigo-50/)
  })
})
