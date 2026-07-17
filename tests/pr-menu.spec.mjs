import { test, expect } from './_fixtures.mjs'

// The `/` key opens a general, PR-wide tree menu (distinct from Enter's
// block palette): "Naar PR-overzicht", "GitHub" and "Jira", the latter two
// with their own submenus. It reuses the same floating CommandMenu overlay
// (menu mode 'pr' — see home.mjs PR_COMMANDS + onKeydown, resolveCommands).
test.describe('PR Review Tree — `/` PR menu', () => {
  test('`/` opens the PR-wide tree with overview / GitHub / Jira', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    // The `/` keypress itself is not typed into the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')

    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Naar PR-overzicht')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.nth(3)).toContainText('Toon volledige omschrijving')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('GitHub opens a submenu (open / comment); Jira opens its three items', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
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
    await expect(rows).toHaveCount(4)
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
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
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
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    await page.getByTestId('command-row').first().click() // "Naar PR-overzicht"
    await page.waitForURL('**/pr-overview')
  })

  // Enter on stop 1 (the PR-description column, state.showDescription) has no
  // block context to act on, so it opens the same PR-wide menu as `/` instead
  // of the block-scoped palette (see onKeydown's `openMenu(state.showDescription
  // ? 'pr' : 'block')`). Block 0 in the list is a different stop and keeps the
  // regular block palette (COMMANDS), asserted here for contrast.
  test('Enter on stop 1 (PR description) opens the PR-wide menu; block 0 keeps the block palette', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    const rows = page.getByTestId('command-row')

    // Block 0 in the list: Enter opens the block-scoped palette.
    await expect(menu).not.toBeVisible()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(rows.first()).not.toContainText('Naar PR-overzicht')
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Step left out of the list into stop 1 (the PR-description column).
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Naar PR-overzicht')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.nth(3)).toContainText('Toon volledige omschrijving')
  })
})
