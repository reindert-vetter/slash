import { test, expect } from '@playwright/test'

// The `/` key opens a general, PR-wide tree menu (distinct from Enter's
// block palette): "Naar PR-overzicht", "GitHub" and "Jira", the latter two
// with their own submenus. It reuses the same floating CommandMenu overlay
// (menu mode 'pr' — see home.mjs PR_COMMANDS + onKeydown, resolveCommands).
test.describe('PR Review Tree — `/` PR menu', () => {
  test('`/` opens the PR-wide tree with overview / GitHub / Jira', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    // The `/` keypress itself is not typed into the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')

    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Naar PR-overzicht')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('GitHub opens a submenu (open / comment); Jira opens its three items', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    const rows = page.getByTestId('command-row')

    // GitHub → its two children.
    await page.getByTestId('command-input').fill('github')
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Open op GitHub')
    await expect(rows.nth(1)).toContainText('Comment plaatsen')

    // Esc backs out to the root, then Jira → its three children.
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(3)
    await page.getByTestId('command-input').fill('jira')
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('Openen in nieuw tab')
    await expect(rows.nth(1)).toContainText('Comment plaatsen')
    await expect(rows.nth(2)).toContainText('Subtask maken')
  })

  test('GitHub → Comment plaatsen opens the line-comment composer', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    await page.getByTestId('command-input').fill('github')
    await page.keyboard.press('Enter') // into the GitHub submenu
    const rows = page.getByTestId('command-row')
    await rows.nth(1).click() // "Comment plaatsen"

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page.getByTestId('comment-compose')).toBeVisible()
  })

  test('Naar PR-overzicht navigates to the overview', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    await page.getByTestId('command-row').first().click() // "Naar PR-overzicht"
    await page.waitForURL('**/pr-overview')
  })
})
