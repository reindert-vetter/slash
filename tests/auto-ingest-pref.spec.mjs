import { test, expect } from './_fixtures.mjs'

// The reviewer's repo-wide preference for AUTOMATIC review-tree generation
// ("mijn eigen prs, daarvan mogen de trees automatisch worden gegenereerd") —
// the 3-way toggle (off/own/all) shared between /settings and the
// /pr-overview header. See .claude/docs/workflows-trackers.md ("pr_inbox")
// for the mechanism; this only covers the UI toggle + its read/write path.
// Cycle order is own -> all -> off -> own (see autoingestpref.mjs's MODES),
// starting from the default "own". Each test below is self-contained about
// which state it starts from (both share the worker's own DB/tracker, so a
// later test cannot assume the untouched default).

test('defaults to "own", cycles own -> all -> off on /pr-overview, and persists across reload', async ({
  page,
}) => {
  await page.goto('/pr-overview')
  await expect(page.getByTestId('inbox')).toBeVisible()

  const toggle = page.getByTestId('auto-ingest-pref-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toContainText('mijn PR')

  await toggle.click()
  await expect(toggle).toContainText('alle PR')
  await expect
    .poll(() => page.evaluate(() => fetch('/api/autoingestpref').then((r) => r.json()).then((d) => d.mode)))
    .toBe('all')

  await toggle.click()
  await expect(toggle).toContainText('uit')
  await expect
    .poll(() => page.evaluate(() => fetch('/api/autoingestpref').then((r) => r.json()).then((d) => d.mode)))
    .toBe('off')

  await page.reload()
  await expect(page.getByTestId('auto-ingest-pref-toggle')).toContainText('uit')

  // Cycle back to "own" so this test leaves the shared per-worker preference
  // exactly as it found it — the next test in this worker must not depend on
  // (or be surprised by) this test's own trail.
  await page.getByTestId('auto-ingest-pref-toggle').click()
  await expect(page.getByTestId('auto-ingest-pref-toggle')).toContainText('mijn PR')
})

test('the same toggle is reachable and reusable from the /settings row', async ({ page }) => {
  await page.goto('/settings')
  await page.getByTestId('settings-tab-assistant').click() // lives in the "AI-assistent" tab
  const row = page.getByTestId('settings-row-autoingestpref')
  await expect(row).toBeVisible()
  const toggle = row.getByTestId('auto-ingest-pref-toggle')
  await expect(toggle).toBeVisible()
  const before = await toggle.innerText()
  await toggle.click()
  await expect.poll(() => toggle.innerText()).not.toBe(before)
})
