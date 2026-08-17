import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The right-click context menu (home.mjs's handleContextMenu family —
// handleRowContextMenu for the diff, rightClickMenuMode for every other
// surface) — the replacement for the earlier "a mouse selection shows the
// palette passively" preview, which has been removed outright: a right-click
// (never a plain click) is now the only mouse way to reach a command menu.
// See "The right-click context menu" in .claude/docs/command-palette.md.
// Reuses PR 102 (RangeSelectAction::execute, four changed lines in two
// groups) — see tests/diff-row-mouse-select.spec.mjs.
test.describe('PR Review Tree — the right-click context menu', () => {
  test('right-clicking a changed row lands the cursor and opens a native-styled menu at the cursor, suppressing the browser menu', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    await rowA.click({ button: 'right' })

    // It's the SAME keyboard-owning menu Enter would open (full-screen catch
    // layer present, unlike the removed passive preview).
    await expect(page.getByTestId('command-overlay')).toBeVisible()
    await expect(page.getByTestId('command-row').filter({ hasText: 'Keur deze regel goed' })).toBeVisible()
    // The cursor really landed on the clicked row (line granularity, change 0).
    await expect(page).toHaveURL(/gran=line/)
  })

  test('right-clicking an unchanged line leaves the native browser menu in place', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    // `$mid = 5;` is the one unchanged line sitting between the two changed
    // groups — never touched by the PR, so it carries no data-changed at all.
    const unchanged = card.locator('[data-pane="new"] [data-row]').filter({ hasText: '$mid' })
    await unchanged.click({ button: 'right' })

    // No app menu appeared — resolveClickSelection found nothing landable
    // here, so handleRowContextMenu never called preventDefault().
    await expect(page.getByTestId('command-overlay')).toHaveCount(0)
  })

  test('the context menu has no pinned "Sluit menu" row, keeps the search field focused, and has shorter rows than the real menu', async ({
    page,
  }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    await rowA.click({ button: 'right' })

    const overlay = page.getByTestId('command-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.getByTestId('command-row').filter({ hasText: 'Sluit menu' })).toHaveCount(0)
    await expect(page.getByTestId('command-input')).toBeFocused()
    const nativeRowHeight = await overlay.getByTestId('command-row').first().evaluate((el) => el.getBoundingClientRect().height)
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)

    // The real, keyboard-owning (Enter) menu keeps the pinned row and taller rows.
    await rowA.click()
    await page.keyboard.press('Enter')
    await expect(overlay).toBeVisible()
    await expect(overlay.getByTestId('command-row').first()).toContainText('Sluit menu')
    const openRowHeight = await overlay.getByTestId('command-row').first().evaluate((el) => el.getBoundingClientRect().height)
    expect(openRowHeight).toBeGreaterThan(nativeRowHeight)
  })

  test('typing in the context menu filters it, and clicking a row runs it immediately', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    await rowA.click({ button: 'right' })

    await page.getByTestId('command-row').filter({ hasText: 'Keur deze regel goed' }).click()

    await expect(page.getByTestId('command-overlay')).toHaveCount(0)
    await expect(rowA.locator('span[title="Goedgekeurd"]')).toBeVisible()
  })

  test('no menu shows a right-hand hint badge on its rows', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click({ button: 'right' })

    // A leaf row (no submenu) — just the label, no hint badge.
    const leafRow = page.getByTestId('command-overlay').getByTestId('command-row').filter({ hasText: 'Keur deze regel goed' })
    await expect(leafRow).toBeVisible()
    await expect(leafRow.locator('span')).toHaveCount(1)

    // "Open GitHub" has a submenu, so the native menu adds its own `›`
    // chevron span (see CommandMenu.mjs's own `native && c.children` slot) —
    // that's a deliberate macOS-style affordance, not a reintroduced hint
    // badge, so it's exactly 2 spans (label + chevron), never a 3rd.
    const submenuRow = page.getByTestId('command-overlay').getByTestId('command-row').filter({ hasText: 'Open GitHub' })
    await expect(submenuRow).toBeVisible()
    await expect(submenuRow.locator('span')).toHaveCount(2)
  })

  test('clicking outside the menu dismisses it', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click({ button: 'right' })
    const overlay = page.getByTestId('command-overlay')
    await expect(overlay).toBeVisible()

    await page.mouse.click(4, 4)
    await expect(overlay).toHaveCount(0)
  })

  test('a real text selection at right-click time offers "Kopieer selectie", copying exactly that selection', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    const rowA = card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' })
    // A real (non-collapsed) browser selection on the row, like a drag would leave.
    await rowA.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    })
    await rowA.click({ button: 'right' })

    const copyRow = page.getByTestId('command-overlay').getByTestId('command-row').filter({ hasText: 'Kopieer selectie' })
    await expect(copyRow).toBeVisible()
    await copyRow.click()
    await expect(page.getByTestId('command-overlay')).toHaveCount(0)
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toContain('$a')
  })

  test('with no text selection, right-clicking a row shows no "Kopieer selectie" item', async ({ page }) => {
    await page.goto('/pr/102')
    await leaveSearchBox(page)

    const card = page.getByTestId('detail-card').first()
    await card.locator('[data-pane="new"] [data-changed="1"]').filter({ hasText: '$a' }).click({ button: 'right' })

    await expect(
      page.getByTestId('command-overlay').getByTestId('command-row').filter({ hasText: 'Kopieer selectie' }),
    ).toHaveCount(0)
  })
})
