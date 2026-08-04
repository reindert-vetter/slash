import { test, expect, appReady } from './_fixtures.mjs'

// The on/off switch for the AUTOMATIC AI risk check (code_warning), placed
// next to the theme toggle (src/autowarn.mjs). Default is enabled; a click
// persists the toggle server-side via the auto_warn workflow (never a direct
// write) so GET /api/autowarn reflects it after a reload — unlike the theme
// preference, this one can't live in localStorage because the SERVER reads it
// at trigger time (see workflows-analysis.md, "AI risk check").
//
// A worker's DB lives for the whole worker (see
// .claude/docs/testing-playwright.md, "Shared state is reset per test, not
// per worker"), so this spec restores the toggle to enabled before it ends —
// otherwise a later spec on the same worker could unexpectedly find the
// automatic trigger switched off.
test('auto-warn toggle sits next to the theme toggle and persists across reload', async ({ page }) => {
  await page.goto('/pr/12903')
  await appReady(page)

  // Same slim row as the theme toggle, inside prInfoCard — only mounted while
  // the PR-description column is open (stop 1 of the nav chain). Reach it with
  // the same ← as tests/theme.spec.mjs.
  await expect(page.getByTestId('auto-warn-toggle')).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()

  const toggle = page.getByTestId('auto-warn-toggle')
  await expect(toggle).toBeVisible()
  // Default is enabled — text label carries the state, not just colour.
  await expect(toggle).toHaveText(/Risicocontrole aan/)

  await toggle.click()
  await expect(toggle).toHaveText(/Risicocontrole uit/)

  // Persisted server-side (not localStorage): a reload still shows "uit".
  // showDescription itself is ephemeral (not URL state), so reach stop 1 again.
  await page.reload()
  await appReady(page)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('pr-info-column')).toBeVisible()
  await expect(page.getByTestId('auto-warn-toggle')).toHaveText(/Risicocontrole uit/)

  // Restore to enabled for any later spec sharing this worker's DB.
  await page.getByTestId('auto-warn-toggle').click()
  await expect(page.getByTestId('auto-warn-toggle')).toHaveText(/Risicocontrole aan/)
})
