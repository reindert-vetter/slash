import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A mouse selection shows the command palette passively (home.mjs's
// showPassiveMenu/hidePassiveMenu, home.mjs's resolveClickSelection/
// resolveRangeSelection) — the replacement for the removed per-row/group
// gutter approve toggles, see "A mouse selection shows the palette passively"
// in .claude/docs/command-palette.md. Reuses PR 102 (RangeSelectAction::execute,
// four changed lines in two groups) — see tests/diff-row-mouse-select.spec.mjs.
test.describe('PR Review Tree — a mouse selection shows the palette passively', () => {
  test('clicking a row shows the palette under it, without owning the keyboard', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const changedRows = card.locator('[data-pane="new"] [data-changed="1"]')
    await changedRows.filter({ hasText: '$a' }).click()

    // The passive preview is up: same command list Enter would open, but no
    // full-screen catch layer.
    const anchor = page.locator('[data-testid="command-anchor"][data-passive="1"]')
    await expect(anchor).toBeVisible()
    await expect(page.getByTestId('command-overlay')).toHaveCount(0)
    await expect(page.getByTestId('command-row').filter({ hasText: 'Keur deze regel goed' })).toBeVisible()

    // The keyboard still navigates the diff — it is NOT captured by the menu.
    await page.keyboard.press('ArrowDown')
    await expect(page).toHaveURL(/chg=1/)
    // Any keypress dismisses the now-stale preview.
    await expect(anchor).toHaveCount(0)
  })

  test('clicking a command row in the passive preview runs it immediately, no Enter needed', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    await rowA.click()

    await page.getByTestId('command-row').filter({ hasText: 'Keur deze regel goed' }).click()

    // The action ran (the row is now approved) and the preview is gone.
    await expect(page.locator('[data-testid="command-anchor"]')).toHaveCount(0)
    await expect(rowA.locator('span[title="Goedgekeurd"]')).toBeVisible()
  })

  test('Enter still opens the real, keyboard-owning menu on the same selection', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click()
    await expect(page.locator('[data-testid="command-anchor"][data-passive="1"]')).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-overlay')).toBeVisible()
    await expect(page.locator('[data-testid="command-anchor"][data-passive="1"]')).toHaveCount(0)
    await expect(page.getByTestId('command-input')).toBeFocused()
  })

  test('the passive preview has no pinned "Sluit menu" row, has a close button next to the input instead, and shorter rows than the real menu', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    await rowA.click()

    const anchor = page.locator('[data-testid="command-anchor"][data-passive="1"]')
    await expect(anchor).toBeVisible()
    await expect(anchor.getByTestId('command-row').filter({ hasText: 'Sluit menu' })).toHaveCount(0)
    const closeButton = anchor.getByTestId('command-close-passive')
    await expect(closeButton).toBeVisible()
    await expect(closeButton).toHaveText('Sluit menu')

    const passiveRowHeight = await anchor.getByTestId('command-row').first().evaluate((el) => el.getBoundingClientRect().height)

    // Clicking it closes the preview, same as any other command.
    await closeButton.click()
    await expect(anchor).toHaveCount(0)

    // The real, keyboard-owning menu keeps the pinned row and a taller row.
    await rowA.click()
    await page.keyboard.press('Enter')
    const overlay = page.getByTestId('command-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.getByTestId('command-row').first()).toContainText('Sluit menu')
    const openRowHeight = await overlay.getByTestId('command-row').first().evaluate((el) => el.getBoundingClientRect().height)
    expect(openRowHeight).toBeGreaterThan(passiveRowHeight)
  })

  test('no menu shows a right-hand hint badge on its rows', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click()
    await page.keyboard.press('Enter')

    const row = page.getByTestId('command-overlay').getByTestId('command-row').filter({ hasText: 'Open GitHub' })
    await expect(row).toBeVisible()
    // Only the label span is left — no second, right-hand hint-badge span.
    await expect(row.locator('span')).toHaveCount(1)
  })

  test('clicking outside the diff dismisses the passive preview', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click()
    const anchor = page.locator('[data-testid="command-anchor"][data-passive="1"]')
    await expect(anchor).toBeVisible()

    // A click on empty page background (no [data-row], no command-anchor,
    // no other handler at all) — the sidebar itself is off-screen in diff
    // mode, so this can't reuse it as the "outside" target.
    await page.mouse.click(4, 4)
    await expect(anchor).toHaveCount(0)
  })
})
