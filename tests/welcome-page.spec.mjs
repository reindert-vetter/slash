import { test, expect } from './_fixtures.mjs'

// /welcome is a standalone, animated showcase page — its own shell
// (welcome.html) and its own entry module (src/welcome.mjs +
// src/WelcomeBlock.mjs), not linked from anywhere else yet (see
// .claude/docs/pages-and-routing.md). This revision replaced the earlier
// full-screen slideshow with one continuously growing tree: blocks connect
// to the right of each other, one at a time, driven by a right-click on the
// canvas (or a key) — the exact same interaction the real review tree uses
// for its own right-click context menu ("a right-click opens the exact same
// menu a key runs", see .claude/docs/command-palette.md) — and a final step
// zooms out to fit the whole built tree in view.
test('welcome page builds its tree one block at a time via right-click/keys, then zooms out to fit it all', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-node')).toHaveCount(0)
  await expect(page.getByTestId('welcome-hint')).toContainText('start building the tree')

  // Enter drives the same "advance" a right-click on empty canvas does —
  // deterministic regardless of where a block happens to be on screen.
  const total = 8 // WELCOME_SEQUENCE length
  for (let i = 0; i < total; i++) {
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('welcome-node')).toHaveCount(i + 1)
  }
  await expect(page.getByTestId('welcome-back-link')).toHaveCSS('opacity', '0')

  // Right-click ON an already-placed block opens its decorative action menu
  // instead of building the next block — "and you can do things" — and
  // leaves the block count untouched.
  await page.getByTestId('welcome-node').last().click({ button: 'right' })
  await expect(page.getByTestId('welcome-node-menu')).toBeVisible()
  await expect(page.getByTestId('welcome-node')).toHaveCount(total)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('welcome-node-menu')).toBeHidden()

  // ← undoes one block (mirrors the review tree's own ←/↑ "step back one
  // stop" meaning), → (or Enter) redoes it.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('welcome-node')).toHaveCount(total - 1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('welcome-node')).toHaveCount(total)

  // One more forward step, with every block already placed, zooms out to
  // fit the whole tree — the back-link fades in only once that happened.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('welcome-hint')).toContainText('whole tree')
  await expect(page.getByTestId('welcome-back-link')).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('welcome-back-link')).toHaveAttribute('href', '/pr-overview')

  // Right-clicking empty canvas again, now that it's zoomed out, restarts
  // the build from scratch.
  await page.mouse.click(80, 80, { button: 'right' })
  await expect(page.getByTestId('welcome-node')).toHaveCount(0)

  expect(errors).toEqual([])
})
