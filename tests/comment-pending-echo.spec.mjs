import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Regression test for the reported bug: after placing a comment, the
// reviewer only ever saw the generic "Bezig…" footer text — no sign of the
// comment they just typed — because placeComment hands the keyboard back to
// the diff (exitRelated) BEFORE the POST + GET round-trip settles (see
// place-comment-return-focus.spec.mjs), and the real compact card only
// exists once the round-trip has actually finished. cs.pendingComment now
// gives the reviewer their own typed message back immediately, the same way
// a just-sent Claude chat message stays visible while the reply comes in —
// see RelatedPanel.mjs's pendingCommentFor/pendingCommentBubble.
//
// This test deliberately holds the mocked POST open (via routeGate), exactly
// like place-comment-return-focus.spec.mjs, so a passing assertion proves
// the echo is visible WHILE the save is still in flight, not only afterwards.
test('placing a comment shows the typed text immediately, before the save resolves', async ({ page }) => {
  let releaseRoute
  const routeGate = new Promise((resolve) => {
    releaseRoute = resolve
  })
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    await routeGate
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })

  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await leaveSearchBox(page)
  // Block 0 (ContractController::index, CONTROLLER-first) has no local diff to
  // step into (see command-menu.spec.mjs) — select block 1, which does.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  const blockCard = page.locator('[data-testid="block-column"] article').first()
  await expect(blockCard).toHaveClass(/border-indigo-300/)

  await page.keyboard.press('Enter') // block command palette
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('mijn zojuist verstuurde comment')

  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter') // "Plaats comment" (default)
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  // The keyboard is already back on the diff (optimistic exit, unaffected by
  // this feature) — the mocked POST is still deliberately held open.
  await expect(blockCard).toHaveClass(/border-indigo-300/)

  // The reviewer's own message shows up right away — same spot the real
  // compact card takes over in once the save actually finishes.
  const pending = page.getByTestId('comment-item-pending')
  await expect(pending).toBeVisible()
  await expect(pending).toContainText('mijn zojuist verstuurde comment')
  await expect(pending).toContainText('Bezig met plaatsen')

  // Let the held POST resolve — the echo disappears once cs.pendingComment
  // clears (the mocked runId never creates a real comment, so no compact
  // card takes its place here; that hand-off is covered by the ordinary
  // inline-comments.spec.mjs assertions against the real backend).
  releaseRoute()
  await expect(pending).toBeHidden()
})
