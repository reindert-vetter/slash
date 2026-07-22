import { test, expect } from './_fixtures.mjs'

// The compose-kind menu (Enter/"Plaats…" on a filled composer, menu mode
// 'compose', COMPOSE_COMMANDS in home.mjs) used to offer no way to place a
// normal, public comment — only placeholders plus "Alleen voor mijzelf" (a
// private note that never reaches GitHub). That left the reviewer with no
// keyboard/click path to actually post a comment. "Plaats comment" is the
// default item — the 2nd row, right after the pinned "Sluit menu" (withClose)
// — and the menu opens selected there (defaultSel), so "type, Enter, Enter"
// places a normal comment again. Both this item and "Alleen voor mijzelf"
// also refresh the Taken column (pollWorkflows) right after placing, instead
// of waiting for the next WORKFLOWS_POLL_MS (2.5s) tick — see
// detail-layout.md / keyboard-navigation.md.

test('Enter on a filled composer defaults to "Plaats comment" (public) and refreshes Taken immediately', async ({
  page,
}) => {
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
  await page.keyboard.press('ArrowRight') // list -> diff

  // Cmd+ArrowRight opens the sidebar and highlights "+ Comment op deze regel" (no
  // auto-focus, see enterComments in RelatedPanel.mjs); Enter opens+focuses
  // the composer.
  await page.keyboard.press('Meta+ArrowRight')
  await expect(page.getByTestId('comments-sidebar')).toBeVisible()
  await page.keyboard.press('Enter')
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('publieke comment via het compose-menu')

  await page.keyboard.press('Enter') // opens the compose-kind menu
  const menu = page.getByTestId('command-menu')
  await expect(menu).toBeVisible()
  const rows = page.getByTestId('command-row')

  // "Sluit menu" is the pinned first row; "Plaats comment" is the 2nd row and
  // starts selected (defaultSel) — the same ring-highlight CommandMenu gives
  // any selected row.
  await expect(rows.first()).toHaveText(/Sluit menu/)
  const defaultRow = rows.nth(1)
  await expect(defaultRow).toHaveText(/Plaats comment/)
  await expect(defaultRow).toHaveClass(/ring-indigo-200/)
  // The other choices are still there, just no longer the only real action.
  await expect(rows.filter({ hasText: 'Alleen voor mijzelf' })).toHaveCount(1)

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

  await page.keyboard.press('Enter') // run the default ("Plaats comment") item

  const postReq = await postPromise
  const posted = postReq.postDataJSON()
  expect(posted.body).toBe('publieke comment via het compose-menu')
  // The whole point: unlike "Alleen voor mijzelf", this posts publicly.
  expect(posted.local).toBeFalsy()

  await expect(menu).not.toBeVisible()
  await refreshPromise

  // The comment shows up in the index right away (loadComments already ran as
  // part of createComment/placeComment).
  await expect(
    page
      .getByTestId('comments-sidebar')
      .getByTestId('comment-item')
      .filter({ hasText: 'publieke comment via het compose-menu' })
  ).toHaveCount(1)
})
