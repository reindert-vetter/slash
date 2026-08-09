import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Placing an "algemene" (PR-wide) comment — the `/` menu's "Algemene comment
// plaatsen" (startPrWideComment, RelatedPanel.mjs). Before this existed that
// item ran startComment, the ordinary LINE-comment composer, so it either
// placed a line comment on whatever unit the cursor sat on or (with a
// PR-comment index row selected) silently did nothing at all behind a
// "Nieuwe comment · undefined:undefined" header. See "Placing a PR-wide
// comment yourself" in .claude/docs/comments-panel.md.

// openPrWideComposer walks the `/` menu to the composer, from the block index.
async function openPrWideComposer(page) {
  // `/` opens the menu of the current stop (contextMenuMode, home.mjs), so the
  // PR-wide menu now lives one step left of the index: stop 1, the PR
  // description column.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.getByTestId('command-row').filter({ hasText: 'GitHub' }).first().click()
  await page.getByTestId('command-row').filter({ hasText: 'Algemene comment plaatsen' }).click()
  await expect(page.getByTestId('comment-compose')).toBeFocused()
}

test('the `/` menu places a real PR-wide comment, which then shows in the block index', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)

  await openPrWideComposer(page)

  // The header names the PR, never a file:line — reading one off the selection
  // is what produced the reported "undefined:undefined".
  const composer = page.getByTestId('comment-composer')
  await expect(composer).toContainText('Nieuwe algemene comment · hele PR')
  await expect(composer).not.toContainText('undefined')

  await page.getByTestId('comment-compose').fill('Algemene opmerking over deze hele PR')

  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter') // runs the default "Plaats comment"

  // Kind "issue" with no anchor at all — that Kind is exactly what makes it a
  // navigable index row instead of an invisible line comment.
  const posted = (await postPromise).postDataJSON()
  expect(posted.kind).toBe('issue')
  expect(posted.file).toBe('')
  expect(posted.body).toBe('Algemene opmerking over deze hele PR')

  // It shows up in the block index under the "PR-comments" heading, and the
  // selection lands on that brand-new row (setCommentSelectRequest ->
  // blockRefPending -> applyCommentRefRestore).
  const row = page.getByTestId('block-row').filter({ hasText: 'Algemene opmerking over deze hele PR' })
  await expect(row).toHaveCount(1)
  await expect(row).toHaveClass(/bg-indigo-50/)
  await expect(page.getByTestId('comment-heading')).toBeVisible()
})

test('the index and code columns hide while composing, and ArrowLeft brings them back', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)

  const index = page.getByTestId('pr-index')
  const blockColumn = page.getByTestId('block-column')
  await expect(index).not.toHaveClass(/opacity-0/)
  await expect(blockColumn).not.toHaveClass(/hidden/)

  await openPrWideComposer(page)

  // Both slide out of the way, so the composer isn't squeezed in beside an
  // index and a diff it has nothing to do with.
  await expect(index).toHaveClass(/opacity-0/)
  await expect(blockColumn).toHaveClass(/hidden/)
  // No Claude column either: its lazily-created anchor comment would be
  // anchored on the current diff unit, which a general comment is not.
  await expect(page.getByTestId('claude-chat-card')).toHaveCount(0)

  // ← closes the composer (exitRelated), which clears the flag and brings
  // everything straight back.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('comment-composer')).toHaveCount(0)
  await expect(index).not.toHaveClass(/opacity-0/)
  await expect(blockColumn).not.toHaveClass(/hidden/)
})
