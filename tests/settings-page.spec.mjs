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

  test('Escape also returns from /settings, same as ←', async ({ page }) => {
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()

    await page.getByTestId('settings-button').click()
    await expect(page).toHaveURL(/\/settings\?from=/)

    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/\/pr-overview/)
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
  test('↑/↓ move the active row within a tab, Enter toggles theme', async ({ page }) => {
    await page.goto('/settings')
    const themeRow = page.getByTestId('settings-row-theme')
    await expect(themeRow).toBeVisible()

    const stored = () => page.evaluate(() => localStorage.getItem('theme'))
    expect(await stored()).toBeNull()
    await page.keyboard.press('Enter') // row 0 = theme (Weergave tab), cycles system -> light
    await expect.poll(stored).toBe('light')

    // theme -> keyboardhints -> debug, all within the "Weergave" tab.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('settings-row-debug')).toHaveAttribute('data-testid', 'settings-row-debug')
  })

  test('↑ off the top row reaches the tab bar; ←/→ switch tabs, ↓ re-enters the row list', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-tab-panel-display')).toBeVisible()
    await expect(page.getByTestId('settings-tab-panel-assistant')).toHaveClass(/hidden/)

    // Row 0 (theme) -> ↑ hands the keyboard to the tab bar.
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('settings-tabs')).toHaveClass(/ring-indigo-200|ring-indigo-500/)

    // display -> language -> assistant
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('settings-tab-assistant')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('settings-tab-panel-assistant')).toBeVisible()
    await expect(page.getByTestId('settings-tab-panel-display')).toHaveClass(/hidden/)

    // ↓ hands the keyboard back to the row list, landing on the assistant
    // tab's own first row (autowarn) — Space toggles it, same as a click.
    await page.keyboard.press('ArrowDown')
    const autoWarnLabel = () => page.getByTestId('auto-warn-toggle').innerText()
    const before = await autoWarnLabel()
    await page.keyboard.press(' ')
    await expect.poll(autoWarnLabel).not.toBe(before)
  })

  test('the open tab survives a refresh via ?tab=', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('settings-tab-account').click()
    await expect(page).toHaveURL(/[?&]tab=account/)
    await expect(page.getByTestId('settings-tab-panel-account')).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('settings-tab-account')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('settings-tab-panel-account')).toBeVisible()

    // The default tab (Weergave) is omitted from the URL, keeping it short.
    await page.getByTestId('settings-tab-display').click()
    await expect(page).not.toHaveURL(/[?&]tab=/)
  })

  test('every existing setting is still reachable, one per tab-panel', async ({ page }) => {
    await page.goto('/settings')
    const rows = {
      display: ['settings-row-theme', 'settings-row-keyboardhints', 'settings-row-debug'],
      language: ['settings-row-langui', 'settings-row-langexplain', 'settings-row-langreply', 'settings-row-langcommit'],
      assistant: ['settings-row-autowarn', 'settings-row-autoingestpref', 'settings-row-praisewords'],
      account: ['settings-row-auth', 'settings-row-checkout', 'settings-row-aliases', 'settings-row-notifyfilters'],
    }
    for (const [tab, rowIds] of Object.entries(rows)) {
      await page.getByTestId('settings-tab-' + tab).click()
      for (const rowId of rowIds) await expect(page.getByTestId(rowId)).toBeVisible()
    }
  })
})

test.describe('settings page — checkout-directory row', () => {
  test('is inactive/grey with an explanation when opened without a PR origin', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.getByTestId('settings-button').click()
    await expect(page).toHaveURL(/\/settings\?from=/)
    await page.getByTestId('settings-tab-account').click() // checkout lives in the "Account & Jira" tab
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
    await page.getByTestId('settings-tab-account').click() // "wie ben ik"/aliases live in the "Account & Jira" tab
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
    await page.getByTestId('settings-tab-assistant').click() // praise words live in the "AI-assistent" tab
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

test.describe('settings page — Jira notification filters (write path)', () => {
  test('a filter text can be added and removed again, and it really reaches the read model', async ({
    page,
  }) => {
    await page.goto('/settings')
    await page.getByTestId('settings-tab-account').click() // Jira notification filters live in the "Account & Jira" tab

    const chips = page.getByTestId('settings-notifyfilters-chips')
    // The two texts the reviewer named are the built-in default list.
    await expect(chips).toContainText('assigned a work item to you')

    const input = page.getByTestId('settings-notifyfilters-input')
    await input.click()
    await input.fill('e2e-filter-text')
    await input.press('Enter')
    await expect(chips).toContainText('e2e-filter-text')

    // Same fire-and-forget write as the alias/praise-word rows: wait for it to
    // land server-side before reloading, or the reload races it away.
    await expect
      .poll(() =>
        page.evaluate(() =>
          fetch('/api/notifyfilters')
            .then((r) => r.json())
            .then((d) => d.filters),
        ),
      )
      .toContain('e2e-filter-text')
    await page.reload()
    await expect(page.getByTestId('settings-notifyfilters-chips')).toContainText('e2e-filter-text')

    // Removing it is a supported state right down to an empty list (unlike a
    // praise word) — here we only take the one text back off again, so the run
    // leaves no residue.
    await page
      .getByTestId('settings-notifyfilters-chips')
      .locator('span', { hasText: 'e2e-filter-text' })
      .locator('button')
      .click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          fetch('/api/notifyfilters')
            .then((r) => r.json())
            .then((d) => d.filters),
        ),
      )
      .not.toContain('e2e-filter-text')
    await page.reload()
    await expect(page.getByTestId('settings-notifyfilters-chips')).not.toContainText('e2e-filter-text')
  })
})
