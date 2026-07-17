import { test, expect } from './_fixtures.mjs'

// Command palette: pressing Enter opens a searchable menu overlaid on the
// next-block preview slot. Typing fuzzy-filters, ↑/↓ move the selection, Enter
// runs it, Esc closes. Block navigation is suspended while it's open. See
// CommandMenu.mjs + home.mjs (menu state, openMenu/closeMenu/runCommand, onKeydown).
test.describe('PR Review Tree — command palette', () => {
  test('Enter opens the floating menu just below the selection and Esc closes it', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    // Wait for the selected block's diff (the active-change anchor) to render.
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press('Enter')

    // The menu is visible, floating, with its input focused.
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    // The Enter keypress itself is not typed into the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')

    // It's positioned just below the active-change anchor (fixed popover): its top
    // sits at/after the anchor's bottom, and it's been placed (not at 0,0).
    const anchorBox = page.getByTestId('command-anchor')
    const menuTop = await anchorBox.evaluate((el) => el.getBoundingClientRect().top)
    const selTop = await page
      .locator('[data-change-active]')
      .first()
      .evaluate((el) => el.getBoundingClientRect().bottom)
    expect(menuTop).toBeGreaterThan(0)
    expect(menuTop).toBeGreaterThanOrEqual(selTop - 1)

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('typing fuzzy-filters and Enter runs the selected command', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await expect(approve).not.toBeChecked()

    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')
    const total = await rows.count()
    expect(total).toBeGreaterThan(1)

    // "keur" narrows to the "Keur dit block goed" command.
    await page.getByTestId('command-input').fill('keur')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Keur dit block goed')

    // Enter runs it: the menu closes and the block is approved.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(approve).toBeChecked()
  })

  test('no match falls back to "Maak hiermee een comment" and pre-fills the composer', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    // Nothing should be posted yet — the fallback only opens the composer, it
    // does not place the comment on its own.
    let posted = null
    await page.route('**/api/workflows/task_code_comment', async (route) => {
      posted = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')

    // A query matching no command collapses to the single comment fallback.
    await page.getByTestId('command-input').fill('dit klopt niet helemaal')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Maak hiermee een comment')

    // Enter runs it: the menu closes and the comments composer opens with the
    // typed text already in the textarea, ready to keep typing — nothing is
    // posted until the reviewer explicitly sends it.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeVisible()
    await expect(composer).toHaveValue('dit klopt niet helemaal')
    await expect(composer).toBeFocused()
    expect(posted).toBeNull()

    // Finishing now opens the comment-kind menu (the send button no longer places
    // directly); choosing "Alleen voor mijzelf" places the comment task as a
    // private note (local:true) with the (possibly extended) text.
    await composer.type(' extra.')
    await page.getByTestId('comment-send').click()
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Alleen voor mijzelf' }).click()
    await expect.poll(() => posted && posted.body).toBe('dit klopt niet helemaal extra.')
    expect(posted.pr).toBe(12903)
    expect(posted.file).toBeTruthy()
    expect(posted.local).toBe(true)
    // The placement carries the previewed snippet so the placed comment's thread
    // can show the same code the composer did (see composeTargetHint reuse).
    expect(posted.code).toBeTruthy()
    expect(posted.label).toBeTruthy()
  })

  // The comment-kind menu: Enter (or the send button) on a filled composer opens
  // a menu to choose what to do with the comment — a Claude command / git-commit
  // (both placeholders), a private note ("alleen voor mijzelf"), or Jira (a
  // submenu). Reuses the CommandMenu overlay via menu mode 'compose'. See
  // COMPOSE_COMMANDS in home.mjs.
  test('Enter on a filled composer opens the comment-kind menu (with a Jira submenu)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    let posted = null
    await page.route('**/api/workflows/task_code_comment', async (route) => {
      posted = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    // Open the composer via the command palette's comment action and type text.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('comment')
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).first().click()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeVisible()
    // The palette's "Comment op deze regel" hands the keyboard focus to the
    // composer directly (startComment mirrors toNew()): the reviewer can type
    // right away, Onderliggende code collapses to its icon rail, and the
    // "+ Comment op deze regel" button shows as selected.
    await expect(composer).toBeFocused()
    await expect(page.getByTestId('related-code-collapsed')).toBeVisible()
    await expect(page.getByTestId('new-comment')).toHaveClass(/border-indigo-400/)
    await composer.fill('dit is een notitie')

    // Enter opens the kind-menu (not a newline, not a direct place).
    await composer.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    const rows = page.getByTestId('command-row')
    await expect(rows.filter({ hasText: 'Claude commando' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'implementeren' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Alleen voor mijzelf' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Jira' })).toHaveCount(1)

    // Jira opens a submenu with three items; nothing posted yet.
    await rows.filter({ hasText: 'Jira' }).click()
    await expect(menu).toBeVisible()
    await expect(rows.filter({ hasText: 'Comment op ticket' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Subtaak aanmaken' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Nieuwe taak aanmaken' })).toHaveCount(1)
    expect(posted).toBeNull()

    // Esc backs out of the submenu to the root, then choose the private note.
    await page.keyboard.press('Escape')
    await expect(rows.filter({ hasText: 'Alleen voor mijzelf' })).toHaveCount(1)
    await rows.filter({ hasText: 'Alleen voor mijzelf' }).click()
    await expect(menu).not.toBeVisible()
    await expect.poll(() => posted && posted.body).toBe('dit is een notitie')
    expect(posted.local).toBe(true)
  })

  test('the approve command toggles the selected block', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await expect(approve).not.toBeChecked()

    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(approve).toBeChecked()
  })

  // Approval is granular now: the approve command targets the *current* navigation
  // unit, and its label names that unit — the whole block only in list mode, else
  // the selected lines / line / call at the active granularity.
  test('the approve label follows the selection granularity', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const rows = page.getByTestId('command-row')
    // Open the palette, read the approve command's label, then back out.
    const label = async () => {
      await page.keyboard.press('Enter')
      await page.getByTestId('command-input').fill('keur')
      const t = await rows.first().textContent()
      await page.keyboard.press('Escape')
      return t
    }

    // List mode → the whole block.
    expect(await label()).toContain('Keur dit block goed')
    // → into the diff: the label names the selected lines (a change group).
    await page.keyboard.press('ArrowRight')
    expect(await label()).toContain('Keur deze regels goed')
    // f drills finer — one line or one call — but never back to the whole block.
    await page.keyboard.press('f')
    expect(await label()).toMatch(/Keur deze (regel|call) goed/)
  })

  // The top-level checkbox is derived: a block is only "approved" once every
  // changed row is. Exercised on a mounted Block with known code so it doesn't
  // depend on the seeded PR's diff shape.
  test('a block is approved only once every changed row is', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const r = await page.evaluate(async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const { blockApproved, blockPartlyApproved, changedRows, blockRows } = await import(
        '/src/Block.mjs'
      )
      const b = reactive({
        category: 'ACTION',
        label: 'Foo::bar',
        status: 'modified',
        file: 'app/Foo.php',
        line: 26,
        code: {
          old: { start: 26, end: 28, text: 'public function bar(): int {\n    return 1;\n}' },
          new: {
            start: 26,
            end: 29,
            text: "public function bar(): ?int {\n    $x = 'hi';\n    return $x;\n}",
          },
        },
      })
      const all = changedRows(blockRows(b))
      const snap = () => ({ approved: blockApproved(b), partly: blockPartlyApproved(b) })
      const out = { total: all.length, none: snap() }
      b.approvedRows = [all[0]] // one row → partly approved
      out.some = snap()
      b.approvedRows = all.slice() // every row → fully approved
      out.allDone = snap()
      return out
    })
    expect(r.total).toBeGreaterThan(1)
    expect(r.none).toEqual({ approved: false, partly: false })
    expect(r.some).toEqual({ approved: false, partly: true })
    expect(r.allDone).toEqual({ approved: true, partly: false })
  })

  test('Open GitHub opens a submenu of two targets; Esc backs out to the root', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    await page.keyboard.press('Enter')
    const rows = page.getByTestId('command-row')
    const rootCount = await rows.count()

    // Choosing "Open GitHub" swaps the list to its two children (the menu stays open).
    await page.getByTestId('command-input').fill('github')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Open GitHub')
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Regel in Files changed')
    await expect(rows.nth(1)).toContainText('PR-pagina')
    // The submenu clears the query and re-focuses the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')
    await expect(page.getByTestId('command-input')).toBeFocused()

    // Esc backs out to the root (menu still open) rather than closing.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await expect(rows).toHaveCount(rootCount)

    // A second Esc closes the palette.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
  })

  test('the menu covers the right (new) pane — half width, right side', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    // Step into the diff so both panes are shown, then open the palette.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()

    // The palette matches the new pane's left edge and width (half the diff).
    // Poll so the post-transition re-placement (panel width animates ~200ms) settles.
    await expect
      .poll(async () => {
        const menu = await page
          .getByTestId('command-anchor')
          .evaluate((el) => el.getBoundingClientRect().left)
        const pane = await page
          .locator('[data-testid="detail-panel"] [data-pane="new"]')
          .first()
          .evaluate((el) => el.getBoundingClientRect().left)
        return Math.abs(menu - pane)
      })
      .toBeLessThan(2)
    const menuW = await page
      .getByTestId('command-anchor')
      .evaluate((el) => el.getBoundingClientRect().width)
    const paneW = await page
      .locator('[data-testid="detail-panel"] [data-pane="new"]')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.abs(menuW - paneW)).toBeLessThan(2)
  })

  test('the menu stays fully in the viewport (flips above when it would not fit below)', async ({
    page,
  }) => {
    // A short viewport leaves no room below the (centred) selection, so the menu
    // must move up rather than spill off the bottom. Either way it stays on-screen.
    await page.setViewportSize({ width: 1400, height: 520 })
    await page.goto('/pr/12903')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()

    const rect = await page
      .getByTestId('command-anchor')
      .evaluate((el) => el.getBoundingClientRect())
    const vh = await page.evaluate(() => window.innerHeight)
    expect(rect.top).toBeGreaterThanOrEqual(-1)
    expect(rect.bottom).toBeLessThanOrEqual(vh + 1)
  })

  test('block navigation is suspended while the menu is open', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    const panel = page.getByTestId('detail-panel')
    await expect(panel.locator('code.language-php').first()).toBeVisible()

    await page.keyboard.press('Enter')
    // ArrowRight would normally step into the diff; while the menu owns the
    // keyboard it moves the menu selection instead, so the panel stays narrow.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect(panel).toHaveClass(/left-\[29rem\]/)
    await expect(page).not.toHaveURL(/mode=diff/)
  })
})
