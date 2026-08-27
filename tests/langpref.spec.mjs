import { test, expect } from './_fixtures.mjs'

// The per-type language settings on /settings: the interface itself, the AI
// explanations, and the reply Claude drafts for a review comment — plus the
// read-only "code and commits are always English" row. See
// .claude/docs/settings-page.md ("Language per output type").
//
// Every test restores the preference it changed: the whole worker shares one
// server/DB, and every OTHER spec asserts Dutch copy, so leaving the interface
// in English would break them.

const readPref = (page, kind) =>
  page.evaluate(
    (k) =>
      fetch('/api/langpref')
        .then((r) => r.json())
        .then((d) => d[k]),
    kind,
  )

test('every kind defaults to Dutch, and the commit row is a fixed rule without a toggle', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('settings-rows')).toBeVisible()

  for (const kind of ['ui', 'explain', 'reply']) {
    await expect(page.getByTestId('lang-toggle-' + kind)).toContainText('Nederlands')
  }

  const commitRow = page.getByTestId('settings-row-langcommit')
  await expect(commitRow).toBeVisible()
  // The word carries the meaning, not a colour (the reviewer is colourblind).
  await expect(page.getByTestId('lang-commit-fixed')).toHaveText('Altijd Engels')
  // Nothing to toggle here: the commit language is deliberately not a setting.
  await expect(commitRow.getByTestId('lang-toggle-commit')).toHaveCount(0)
})

test('switching the AI-explanation language persists, and does not touch the other kinds', async ({ page }) => {
  await page.goto('/settings')
  const toggle = page.getByTestId('lang-toggle-explain')
  await expect(toggle).toContainText('Nederlands')

  await toggle.click()
  await expect(toggle).toContainText('Engels')
  await expect.poll(() => readPref(page, 'explain')).toBe('en')
  // One kind's choice never leaks into another.
  expect(await readPref(page, 'reply')).toBe('nl')
  expect(await readPref(page, 'ui')).toBe('nl')

  await page.reload()
  await expect(page.getByTestId('lang-toggle-explain')).toContainText('Engels')

  // Leave the shared per-worker preference exactly as it was found.
  await page.getByTestId('lang-toggle-explain').click()
  await expect(page.getByTestId('lang-toggle-explain')).toContainText('Nederlands')
  await expect.poll(() => readPref(page, 'explain')).toBe('nl')
})

test('switching the interface language reloads the page in English, and back again', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('settings-rows')).toBeVisible()
  await expect(page.getByTestId('settings-back')).toContainText('Terug')

  await page.getByTestId('lang-toggle-ui').click()
  // setUiLang reloads, so wait on the translated copy rather than on the click.
  await expect(page.getByTestId('settings-back')).toContainText('Back')
  await expect(page.getByTestId('lang-toggle-ui')).toContainText('English')
  expect(await readPref(page, 'ui')).toBe('en')

  // Back to Dutch — and the localStorage paint cache follows, so the next spec
  // in this worker starts in Dutch too.
  await page.getByTestId('lang-toggle-ui').click()
  await expect(page.getByTestId('settings-back')).toContainText('Terug')
  await expect.poll(() => readPref(page, 'ui')).toBe('nl')
  expect(await page.evaluate(() => localStorage.getItem('uiLang'))).toBe('nl')
})
