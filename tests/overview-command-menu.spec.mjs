import { test, expect } from './_fixtures.mjs'

// `/` on the PR overview opens a general command menu — the same CommandMenu
// component /pr/<id> uses for every one of its palettes — instead of focusing
// the search box. For now it holds nothing but the pinned "Sluit menu" and a
// free-text field; the per-row popover is unchanged and stays the item-level
// menu. See "The general `/` command menu" in .claude/docs/pr-overview.md.
test.describe('PR overview — the general `/` menu', () => {
  test('`/` opens the menu with only "Sluit menu"; Escape and the close item both close it', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).toHaveCount(0)

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    // The `/` itself is not typed into the field, and the field has focus.
    const input = page.getByTestId('command-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    // …and the search box did NOT take the keystroke (its old behaviour).
    await expect(page.getByTestId('search')).not.toBeFocused()

    const rows = page.getByTestId('command-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Sluit menu')

    // Typing is free text; nothing matches yet, so the empty state shows.
    await input.fill('wat dan ook')
    await expect(rows).toHaveCount(0)
    await expect(menu).toContainText("Geen commando's")

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Reopening works (a fresh, disposable menu state each time) and the
    // pinned close item runs.
    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toHaveValue('')
    await page.getByTestId('command-row').first().click()
    await expect(menu).toHaveCount(0)
  })

  test('the menu owns the keyboard: row navigation is suspended while it is open', async ({
    page,
  }) => {
    await page.goto('/pr-overview')
    await expect(page.getByTestId('inbox')).toBeVisible()
    const rows = page.locator('[data-nav-row]')
    await expect(rows.first()).toBeVisible()

    // Select a row, then open the menu and press ArrowDown: the selection must
    // not move (the menu's own ↑/↓ handling claims it).
    await page.keyboard.press('ArrowDown')
    const before = await page.locator('[data-nav-row].ring-indigo-300, [data-nav-row][class*="ring-indigo"]').count()
    await page.keyboard.press('/')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    const after = await page.locator('[data-nav-row].ring-indigo-300, [data-nav-row][class*="ring-indigo"]').count()
    expect(after).toBe(before)

    // A row click still opens the ordinary per-row popover once the menu is
    // closed — that surface is deliberately unchanged.
    await page.keyboard.press('Escape')
    await rows.first().dispatchEvent('click')
    await expect(page.getByTestId('close-popover')).toBeVisible()
  })
})
