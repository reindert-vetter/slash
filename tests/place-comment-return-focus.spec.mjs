import { test, expect } from './_fixtures.mjs'

// After placing a comment tied to a piece of code, the reviewer wants to keep
// reviewing that code — not sit on the composer row. placeComment (called by
// both COMPOSE_COMMANDS items, "Plaats comment" and "Alleen voor mijzelf") now
// hands the keyboard back to the diff (exitRelated) right after saving, and
// home.mjs re-aligns <main> on it (scrollFocusIntoView), same as a plain ←
// exit out of the sidebar. The sidebar itself stays open — only the keyboard
// focus moves. See detail-layout.md ("Comments/taken-sidebar").

test('placing a comment returns the keyboard to the diff, sidebar stays open', async ({ page }) => {
  // Mock the post so this test never leaves a real comment behind on the
  // shared PR 12903 fixture (other specs seed/assert their own comment lists
  // on the same blocks and would otherwise pick up this leftover row).
  await page.route('**/api/workflows/task_code_comment', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"runId":"fake-run"}' })
  })

  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
  await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
  // Block 0 (ContractController::index, CONTROLLER-first) has no local diff to
  // step into (see command-menu.spec.mjs) — select block 1, which does.
  await page.locator('[data-idx="1"]').click()
  await page.keyboard.press('ArrowRight') // list -> diff

  const blockCard = page.locator('[data-testid="block-column"] article').first()
  await expect(blockCard).toHaveClass(/border-indigo-300/)

  await page.keyboard.press('Meta+ArrowRight') // open sidebar, highlight composer row
  await expect(page.getByTestId('comments-sidebar')).toBeVisible()
  // Owning the sidebar now, the diff card loses its active border.
  await expect(blockCard).not.toHaveClass(/border-indigo-300/)

  await page.keyboard.press('Enter') // focus the composer
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()
  await composer.fill('terug naar de code')

  await page.keyboard.press('Enter') // opens the compose-kind menu
  await expect(page.getByTestId('command-menu')).toBeVisible()
  await page.keyboard.press('Enter') // "Plaats comment" (default, 2nd item — after the pinned "Sluit menu")
  await expect(page.getByTestId('command-menu')).not.toBeVisible()

  // The sidebar stays open (comment placed, visible) ...
  await expect(page.getByTestId('comments-sidebar')).toBeVisible()
  await expect(page.getByTestId('sidebar-collapsed')).toHaveCount(0)
  // ... but the keyboard is back on the diff: the block card is active again,
  // and ArrowDown/f walk the diff's own change groups rather than the sidebar.
  await expect(blockCard).toHaveClass(/border-indigo-300/)
})
