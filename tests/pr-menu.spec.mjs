import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The `/` key opens a general, PR-wide tree menu (distinct from Enter's
// block palette): a pinned "Sluit menu" first (withClose, home.mjs), then
// "GitHub" (the default item, where the selection opens — defaultSel) and
// "Jira" (both with their own submenus, each with its own pinned "Sluit
// menu"), the code_warning risk check, and the description toggle. It
// reuses the same floating CommandMenu overlay (menu mode 'pr' — see
// home.mjs PR_COMMANDS + onKeydown, resolveCommands). Reaching /pr-overview
// itself no longer goes through this menu — only via the ← nav-chain exit
// (stop 1, state.showDescription, see tests/nav-chain.spec.mjs).
test.describe('PR Review Tree — `/` PR menu', () => {
  test('`/` opens the PR-wide tree with GitHub / Jira', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    // The `/` keypress itself is not typed into the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')

    const rows = page.getByTestId('command-row')
    // 5 root items: a pinned "Sluit menu" (withClose, always first) plus the
    // 4 real ones — the code_warning PR-wide risk check sits before the
    // description toggle (see PR_COMMANDS in home.mjs).
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.nth(3)).toContainText("Diepgravend onderzoek")
    await expect(rows.nth(4)).toContainText('Toon volledige omschrijving')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('GitHub opens a submenu (open / comment); Jira opens its three items', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    const rows = page.getByTestId('command-row')

    // GitHub → its three children (Open op GitHub / PR keuren / Comment
    // plaatsen — see "PR keuren" in home.mjs PR_COMMANDS), plus its own pinned
    // "Sluit menu" first.
    await page.getByTestId('command-input').fill('github')
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Open op GitHub')
    await expect(rows.nth(2)).toContainText('PR keuren')
    await expect(rows.nth(3)).toContainText('Algemene comment plaatsen')

    // Esc backs out to the root, then Jira → its three children (plus its own
    // pinned "Sluit menu" first).
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(5) // root: Sluit menu/GitHub/Jira/risk-check/description
    await page.getByTestId('command-input').fill('jira')
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Openen in nieuw tab')
    await expect(rows.nth(2)).toContainText('Comment plaatsen')
    await expect(rows.nth(3)).toContainText('Subtask maken')
  })

  test('GitHub → Comment plaatsen opens the line-comment composer', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (ContractController::index, CONTROLLER-first — see categoryRank
    // in home.mjs) has no local diff to preview; select block 1
    // (CreatePaymentAction::execute).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    await page.getByTestId('command-input').fill('github')
    await page.keyboard.press('Enter') // into the GitHub submenu
    const rows = page.getByTestId('command-row')
    await rows.nth(3).click() // "Comment plaatsen" (after the pinned "Sluit menu", "Open op GitHub" and "PR keuren")

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(page.getByTestId('comment-compose')).toBeVisible()
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
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    const rows = page.getByTestId('command-row')

    // Block 0 in the list: Enter opens the block-scoped palette.
    await expect(menu).not.toBeVisible()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(rows.first()).toContainText('Sluit menu')
    await expect(rows.nth(1)).not.toContainText('GitHub')
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Step left out of the list into stop 1 (the PR-description column).
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.nth(3)).toContainText("Diepgravend onderzoek")
    await expect(rows.nth(4)).toContainText('Toon volledige omschrijving')
  })
})
