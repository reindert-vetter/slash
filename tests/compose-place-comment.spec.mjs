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

// Regression for a suspected race between cs.focus and the now-removed
// cs.composing flag: → into the still-unanchored Claude composer and back
// (toNewFocus) used to be the one path that could, in theory, leave the two
// out of step (see "isComposeOpen() now reads cs.focus directly" in
// comments-panel.md) — Enter still has to post directly after that round
// trip, not fall through to the browser's own newline insertion.
test('Enter still posts directly after -> into the Claude composer and back', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')

  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.type('overleeft de -> en terug naar Claude')

  const claudeComposer = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await expect(claudeComposer).toBeFocused()

  await page.keyboard.press('ArrowLeft')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('overleeft de -> en terug naar Claude')

  const postPromise = page.waitForRequest('**/api/workflows/task_code_comment')
  await page.keyboard.press('Enter')
  const postReq = await postPromise
  expect(postReq.postDataJSON().body).toBe('overleeft de -> en terug naar Claude')
  // Posted, not left behind with an inserted newline.
  await expect(composer).toHaveCount(0)
})

// Shift+Enter must still insert a newline instead of posting, in every place
// this task touched: the local @keydown on comment-compose (added alongside
// the removed Annuleer button) must not have turned Enter's own guard into an
// unconditional post.
test('Shift+Enter in the ordinary composer inserts a newline instead of posting', async ({ page }) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight')

  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.type('regel een')
  await composer.press('Shift+Enter')
  await composer.type('regel twee')

  await expect(composer).toHaveValue('regel een\nregel twee')
  await expect(page.getByTestId('command-menu')).toHaveCount(0)
})
