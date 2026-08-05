import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// After placing a comment tied to a piece of code, the reviewer wants to keep
// reviewing that code — not sit on the composer. placeComment (called by both
// COMPOSE_COMMANDS items, "Plaats comment" and "Alleen voor mijzelf") hands
// the keyboard back to the diff (exitRelated) OPTIMISTICALLY — immediately,
// before the POST + GET round-trip below even settles, not after a
// successful save — and home.mjs re-aligns <main> on it
// (scrollFocusIntoView), same as a plain ← exit out of the inline comment
// block. This test deliberately holds the mocked POST open (via routeGate)
// so a passing assertion proves the exit happened BEFORE the save, not just
// eventually.

test('placing a comment returns the keyboard to the diff before the save resolves', async ({ page }) => {
  // Mock the post so this test never leaves a real comment behind on the
  // shared PR 12903 fixture (other specs seed/assert their own comment lists
  // on the same blocks and would otherwise pick up this leftover row).
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

  // Enter opens the block command palette; "Comment op deze regel" starts the
  // inline composer and focuses it.
  await page.keyboard.press('Enter')
  await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  // Owning the composer now, the diff card loses its active border.
  await expect(blockCard).not.toHaveClass(/border-indigo-300/)
  await composer.fill('terug naar de code')

  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter') // "Plaats comment" (default, 2nd item — after the pinned "Sluit menu")
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  // The keyboard is already back on the diff — the mocked POST above is
  // still deliberately held open (routeGate), so this proves the exit is
  // optimistic rather than waiting for a successful save.
  await expect(blockCard).toHaveClass(/border-indigo-300/)

  // Let the held POST resolve so nothing lingers past the end of the test —
  // the mocked response never creates a real comment (fake runId), so there
  // is nothing further to assert here.
  releaseRoute()
})
