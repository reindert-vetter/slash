import { test, expect } from './_fixtures.mjs'

// /welcome is a standalone, animated showcase page — its own shell
// (welcome.html) and its own entry module (src/welcome.mjs), not linked from
// anywhere else yet (see .claude/docs/pages-and-routing.md). This spec only
// checks the page loads without error and that the same keys the real review
// tree uses (→/↓/Space/Enter forward, ←/↑ back) drive it, per the reviewer's
// explicit request to reuse those keys with the same meaning rather than
// invent a separate scheme.
test('welcome page loads, steps through scenes with the review tree own keys, and ends on a link back to the overview', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/welcome')
  await expect(page.getByTestId('welcome-scene')).toContainText('What does your future look like?')

  // → moves forward, same meaning as the review tree's left→right nav chain.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('welcome-scene')).toContainText("not just a linter anymore")

  // ← steps back exactly one scene, same as the nav chain's ← always peeling
  // back one stop.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('welcome-scene')).toContainText('What does your future look like?')

  // Space and Enter also move forward (Space mirrors "confirm this, move on";
  // Enter acts on the current stop) — walk to the closing scene.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i % 2 === 0 ? ' ' : 'Enter')
  }
  await expect(page.getByTestId('welcome-back-link')).toBeVisible()
  await expect(page.getByTestId('welcome-back-link')).toHaveAttribute('href', '/pr-overview')

  // One more forward key on the closing scene acts like following the link.
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/pr-overview$/)

  expect(errors).toEqual([])
})
