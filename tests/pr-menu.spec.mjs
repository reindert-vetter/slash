import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The `/` key opens the menu belonging to WHERE THE KEYBOARD IS
// (contextMenuMode, home.mjs) — with a block selected that is the block
// palette, exactly what Enter opens there; the general PR-wide tree menu below
// is what `/` falls back to on a stop with no menu of its own (stop 1, the two
// toggle rows), which is why every test here steps left into stop 1 first.
// That PR-wide menu: a pinned "Sluit menu" first (withClose, home.mjs), then
// "GitHub" (the default item, where the selection opens — defaultSel) and
// "Jira" (both with their own submenus, each with its own pinned "Sluit
// menu"), the description toggle, and "Alles keuren" (its own two-item
// submenu — "Alle code aanpassingen goedkeuren" / "Alle goedkeuringen
// intrekken"). It reuses the same floating CommandMenu overlay
// (menu mode 'pr' — see
// home.mjs PR_COMMANDS + onKeydown, resolveCommands). Reaching /pr-overview
// itself no longer goes through this menu — only via the ← nav-chain exit
// (stop 1, state.showDescription, see tests/nav-chain.spec.mjs).
test.describe('PR Review Tree — `/` PR menu', () => {
  test('`/` opens the PR-wide tree with GitHub / Jira', async ({ page }) => {
    await page.goto('/pr/12903')
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md.
    await block1Row.click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    // Step left into stop 1 (the PR description) — a stop with no menu of its
    // own, where `/` falls back to the PR-wide menu.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    // The `/` keypress itself is not typed into the input.
    await expect(page.getByTestId('command-input')).toHaveValue('')

    const rows = page.getByTestId('command-row')
    // Root items: a pinned "Sluit menu" (withClose, always first), then the
    // real ones. Deliberately NOT an exact toHaveCount on this root list —
    // PR_COMMANDS (home.mjs) keeps growing (e.g. "Tests laten draaien"
    // landed after this test was written, between the description toggle
    // and the bulk retract-all item) and a hardcoded count here is exactly
    // what broke last time; assert each known item's presence/order instead,
    // which survives a future addition. The submenu counts below stay exact
    // — those are closed, stable lists.
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.filter({ hasText: 'Toon volledige omschrijving' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Alles keuren' })).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('GitHub opens a submenu (open / comment); Jira opens its three items', async ({ page }) => {
    await page.goto('/pr/12903')
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md.
    await block1Row.click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1 — where `/` opens the PR-wide menu
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
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
    // pinned "Sluit menu" first). No exact toHaveCount on the root list here
    // either (see the note above) — just confirm we're really back at root.
    await page.keyboard.press('Escape')
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
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
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md.
    await block1Row.click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('ArrowLeft') // stop 1 — where `/` opens the PR-wide menu
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
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
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md.
    await block1Row.click()
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
    // No exact toHaveCount on this root list — see the note in the `/`
    // test above; PR_COMMANDS keeps growing.
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('GitHub')
    await expect(rows.nth(2)).toContainText('Jira')
    await expect(rows.filter({ hasText: 'Toon volledige omschrijving' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Alles keuren' })).toHaveCount(1)
  })

  // `/` is no longer hardwired to the PR-wide menu: it opens the menu of the
  // stop that owns the keyboard (contextMenuMode). With a block selected that
  // is the block palette — the same list Enter opens there — so typing
  // straight into it reaches "Chat over deze regel" (resolveCommands' default
  // no-match fallback). See "`/` opens the menu of the current stop" in
  // .claude/docs/command-palette.md.
  test('`/` on a selected block opens the BLOCK palette, and typing reaches the Claude chat item', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    await block1Row.click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')
    const rows = page.getByTestId('command-row')

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toHaveValue('')
    // The block palette, not the PR-wide one.
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('goed')
    await expect(rows.nth(1)).not.toContainText('GitHub')
    await expect(rows.filter({ hasText: 'Comment op deze regel' })).toHaveCount(1)

    // Typing something no command matches lands on the chat item, first.
    await page.getByTestId('command-input').fill('waarom staat dit hier')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Chat over deze regel')
  })

  // A comment-index row keeps its own menu on `/` too (prComment), mirroring
  // Enter there — the same contextMenuMode branch. The comment is mocked the
  // same way tests/comment-index-items.spec.mjs does it (one route, serving
  // whatever the closure holds, so a poll can never race an unroute).
  test("`/` on a comment-index row opens that item's own menu", async ({ page }) => {
    const now = new Date().toISOString()
    await page.route('**/api/comments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'prmenu-ci-1',
            runId: 'run-prmenu-ci-1',
            pr: 12903,
            file: '',
            line: 0,
            author: 'octocat',
            body: 'Een algemene opmerking over deze PR',
            createdAt: now,
            reactionCount: 0,
            status: 'open',
            source: 'github',
            kind: 'issue',
            reactions: [],
            rowStart: -1,
            rowEnd: -1,
          },
        ]),
      })
    })
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    const commentRow = page.getByTestId('block-row').filter({ hasText: 'algemene opmerking' })
    await expect(commentRow).toHaveCount(1)
    await commentRow.click()

    await page.keyboard.press('/')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    // The comment item's own menu (prCommentCommandsFor), not the PR-wide one.
    await expect(page.getByTestId('command-row').filter({ hasText: 'Beantwoorden' })).toHaveCount(1)
    await expect(page.getByTestId('command-row').filter({ hasText: 'Jira' })).toHaveCount(0)
  })

  // "Alles keuren" (PR_COMMANDS) — reviewer request: a submenu grouping the
  // two whole-PR bulk approval actions ("Alle code aanpassingen goedkeuren" /
  // "Alle goedkeuringen intrekken"), reached through its own two-item
  // submenu (like "PR keuren") so a stray Enter can't discard/grant review
  // work by accident — opening the submenu is itself the "one extra Enter"
  // confirm, neither child needs a further nested confirm row.
  test('"Alles keuren" → "Alle goedkeuringen intrekken" clears an approved block\'s approval', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    // Block 1 (CreatePaymentAction::execute) reliably has one changed row —
    // see command-menu.spec.mjs's own note on why block 0 doesn't work here.
    await block1Row.click()
    await leaveSearchBox(page)
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await expect(approve).not.toBeChecked()

    // Approve it via the block palette; a fully approved top-level block
    // hides from the "Start" list by default (see approval.md).
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).not.toBeVisible()
    await expect(block1Row).toHaveCount(0)

    // Step left into stop 1 and open the PR-wide menu, then run the bulk
    // retract via the "Alles keuren" submenu.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    await page.getByTestId('command-input').fill('alles keuren')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await page.keyboard.press('Enter') // into the "Alles keuren" submenu
    await expect(page.getByTestId('command-row')).toHaveCount(3) // pinned "Sluit menu" + the two bulk actions
    await page.getByTestId('command-row').filter({ hasText: 'Alle goedkeuringen intrekken' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // The block is no longer fully approved, so it reappears in the list.
    await expect(block1Row).toHaveCount(1)
    await block1Row.click()
    await expect(approve).not.toBeChecked()
  })

  // The mirror image: "Alle code aanpassingen goedkeuren" approves every
  // changed row across the whole PR (approveAllForPr) — new, non-trivial,
  // regression-sensitive: it needs ensureCode first to compute changedRows,
  // same as an ordinary block approve.
  test('"Alles keuren" → "Alle code aanpassingen goedkeuren" approves an unapproved block', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    const block1Row = page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' })
    await block1Row.click()
    await leaveSearchBox(page)
    const approve = page.getByTestId('detail-panel').locator('input[type=checkbox]').first()
    await expect(approve).not.toBeChecked()

    // Step left into stop 1 and open the PR-wide menu, then run the bulk
    // approve via the "Alles keuren" submenu.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()
    await page.keyboard.press('/')
    await page.getByTestId('command-input').fill('alles keuren')
    await expect(page.getByTestId('command-row')).toHaveCount(1)
    await page.keyboard.press('Enter') // into the "Alles keuren" submenu
    await expect(page.getByTestId('command-row')).toHaveCount(3) // pinned "Sluit menu" + the two bulk actions
    await page.getByTestId('command-row').filter({ hasText: 'Alle code aanpassingen goedkeuren' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // The block is now fully approved, so it hides from the "Start" list.
    await expect(block1Row).toHaveCount(0)
  })
})
