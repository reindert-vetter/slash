import { test, expect } from './_fixtures.mjs'

// The one general settings page (/settings, src/settings.mjs) — the entry
// buttons on /pr/<id> and /pr-overview, the `?from=` round trip back, keyboard
// navigation over the row list, and the two settings-page-only write paths
// (mention aliases, praise words) that go through the new app_settings
// workflow tracker. See .claude/docs/settings-page.md.

test.describe('settings page — entry buttons', () => {
  test('the gear button on /pr/<id> opens /settings and ← returns to the same PR', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('pr-index')).toBeVisible()
    // The button lives in prInfoCard's pr-info-theme-row (stop 1), same as
    // the theme/auto-warn toggles — open it with ←.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    const gear = page.getByTestId('settings-button')
    await expect(gear).toBeVisible()

    await gear.click()
    await expect(page).toHaveURL(/\/settings\?from=/)
    await expect(page.getByTestId('settings-rows')).toBeVisible()

    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/pr\/12903/)
  })

  test('the gear button on /pr-overview opens /settings and ← returns there', async ({ page }) => {
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()
    const gear = page.getByTestId('settings-button')
    await expect(gear).toBeVisible()

    await gear.click()
    await expect(page).toHaveURL(/\/settings\?from=/)

    // The keyboard ← does the same thing as the back button (mouse-navigation
    // convention: a click runs the same function a key runs).
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(/\/pr-overview/)
  })

  test('an invalid/missing ?from= falls back to /pr-overview (no open redirect)', async ({ page }) => {
    await page.goto('/settings?from=' + encodeURIComponent('https://evil.example/'))
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/pr-overview/)
  })
})

test.describe('settings page — keyboard row navigation', () => {
  test('↑/↓ move the active row, Enter toggles theme, Space toggles Live AI assistent', async ({ page }) => {
    await page.goto('/settings')
    const themeRow = page.getByTestId('settings-row-theme')
    const autoWarnRow = page.getByTestId('settings-row-autowarn')
    await expect(themeRow).toBeVisible()

    const stored = () => page.evaluate(() => localStorage.getItem('theme'))
    expect(await stored()).toBeNull()
    await page.keyboard.press('Enter') // row 0 = theme, cycles system -> light
    await expect.poll(stored).toBe('light')

    // theme -> keyboardhints -> langui -> langexplain -> langreply -> langcommit -> autowarn
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
    await expect(autoWarnRow).toHaveAttribute('data-testid', 'settings-row-autowarn')
    const autoWarnLabel = () => page.getByTestId('auto-warn-toggle').innerText()
    const before = await autoWarnLabel()
    await page.keyboard.press(' ')
    await expect.poll(autoWarnLabel).not.toBe(before)
  })
})

test.describe('settings page — checkout-directory row', () => {
  test('is inactive/grey with an explanation when opened without a PR origin', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.getByTestId('settings-button').click()
    await expect(page).toHaveURL(/\/settings\?from=/)
    const row = page.getByTestId('settings-row-checkout')
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/opacity-50/)
    await expect(page.getByTestId('settings-checkout-status')).toHaveText(/Open deze pagina vanuit een PR/)
  })
})

test.describe('settings page — mention aliases (write path)', () => {
  test('adding and removing an alias persists across reload, GitHub login stays read-only text', async ({
    page,
  }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-github-login')).toBeVisible()

    const input = page.getByTestId('settings-aliases-input')
    await input.click()
    await input.fill('e2e-alias')
    await input.press('Enter')

    const chips = page.getByTestId('settings-alias-chips')
    await expect(chips).toContainText('e2e-alias')

    // The optimistic chip appears immediately, but the actual write (ensure +
    // signal) is fire-and-forget from the click — wait for it to actually
    // land server-side before reloading, or the reload can race it away.
    await expect
      .poll(() => page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((d) => d.me.aliases)))
      .toContain('e2e-alias')

    await page.reload()
    await expect(page.getByTestId('settings-alias-chips')).toContainText('e2e-alias')

    // Remove it again so the run leaves no residue behind.
    await page
      .getByTestId('settings-alias-chips')
      .locator('span', { hasText: 'e2e-alias' })
      .locator('button')
      .click()
    await expect(page.getByTestId('settings-alias-chips')).not.toContainText('e2e-alias')
    await expect
      .poll(() => page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((d) => d.me.aliases)))
      .not.toContain('e2e-alias')
    await page.reload()
    await expect(page.getByTestId('settings-alias-chips')).not.toContainText('e2e-alias')
  })
})

test.describe('settings page — praise words (write path)', () => {
  test('adding a word works and the last remaining word cannot be removed', async ({ page }) => {
    await page.goto('/settings')
    const input = page.getByTestId('settings-praisewords-input')
    await input.click()
    await input.fill('fantastisch')
    await input.press('Enter')

    const chips = page.getByTestId('settings-praise-chips')
    await expect(chips).toContainText('fantastisch')
    const removeButtons = chips.locator('button')
    const total = await removeButtons.count()

    // Remove every word down to the last one — the final chip's remove button
    // must be disabled (the server would otherwise reject an empty
    // submission, see savePraiseWordsFile/handleWorkflows).
    for (let n = total; n > 1; n--) {
      await removeButtons.first().click()
      await expect(removeButtons).toHaveCount(n - 1)
    }
    await expect(removeButtons.first()).toBeDisabled()
  })
})
