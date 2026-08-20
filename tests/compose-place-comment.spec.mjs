import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// An ORDINARY new-comment composer (not converting an AI-controle finding, see
// convert-warning-to-comment.spec.mjs for that path) posts straight away on
// Enter/the "Plaats…" button — no comment-kind menu — reviewer request: only
// turning an AI finding into a public comment deserves that extra look, a
// plain new comment should just post. runComposePost (home.mjs) is the shared
// implementation both the composer's own "Plaats comment" menu item (used by
// convertWarningToComment's flow) and this direct shortcut call. See "The
// compose (comment-kind) menu" in .claude/docs/command-palette.md.
//
// It also refreshes the Taken column (pollWorkflows) right after placing,
// instead of waiting for the next WORKFLOWS_POLL_MS (2.5s) tick — see
// detail-layout.md / keyboard-navigation.md.

test('Enter on a filled ordinary composer posts directly, with no comment-kind menu', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff

  // Enter opens the block command palette; "Comment op deze regel" starts the
  // inline composer (startComment, RelatedPanel.mjs) and focuses it.
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('publieke comment zonder menu')

  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  // The Taken column (workflows-panel) polls GET /api/workflows every 2.5s
  // (WORKFLOWS_POLL_MS in home.mjs) — waiting for one to fire within well
  // under that window (here: 1s) after placing proves this is the explicit
  // pollWorkflows() call after a successful placeComment, not a coincidental
  // timer tick.
  const refreshPromise = page.waitForResponse(
    (r) => r.url().includes('/api/workflows?pr=') && r.request().method() === 'GET',
    { timeout: 1000 }
  )

  await page.keyboard.press('Enter') // posts directly — no menu in between

  // The comment-kind menu never appears for an ordinary composer.
  await expect(page.getByTestId('command-menu')).toHaveCount(0)

  const postReq = await postPromise
  const posted = postReq.postDataJSON()
  expect(posted.body).toBe('publieke comment zonder menu')
  // Always a normal, public comment — never local.
  expect(posted.local).toBeFalsy()

  await refreshPromise

  // The comment shows up as an inline card right away (loadComments already
  // ran as part of createComment/placeComment).
  await expect(
    page.getByTestId('inline-comments').getByTestId('comment-item').filter({ hasText: 'publieke comment zonder menu' })
  ).toHaveCount(1)
})

test('the composer\'s own "Plaats…" button posts directly too (a click runs the same function as Enter)', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')

  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('publieke comment via de knop')

  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  await page.getByTestId('comment-send').click()

  await expect(page.getByTestId('command-menu')).toHaveCount(0)
  const postReq = await postPromise
  expect(postReq.postDataJSON().body).toBe('publieke comment via de knop')
})
