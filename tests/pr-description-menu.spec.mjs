import { test, expect } from './_fixtures.mjs'

// Enter on stop 1 (the PR-description column, state.showDescription) opens the
// PR-wide command menu ('pr' mode, same list as `/`) — and it must open *near
// the description*, not over the diff region far to the right: menuAnchor/
// menuRegion in home.mjs have a stop-1 exception (isDescriptionMenu) that
// anchors the palette on the pr-info-card and gives it the full left+width of
// the pr-info-column (mirror of the blokken-index exception). See
// .claude/rules/keyboard-navigation.md.
test.describe('PR Review Tree — PR-wide menu on the description column (stop 1)', () => {
  test('Enter on stop 1 opens the PR-wide menu positioned over the description column', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    // ← from the block-index opens stop 1 (the description column).
    await page.keyboard.press('ArrowLeft')
    const info = page.getByTestId('pr-info-column')
    await expect(info).toBeVisible()

    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    // Enter on stop 1 opens the PR-wide menu (not the block palette).
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('command-input')).toBeFocused()
    const rows = page.getByTestId('command-row')
    // 6 root items: a pinned "Sluit menu" (withClose, always first) plus the
    // 5 real ones — the code_warning PR-wide risk check sits before the
    // description toggle (see PR_COMMANDS in home.mjs).
    await expect(rows).toHaveCount(6)
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Naar PR-overzicht')
    await expect(rows.nth(2)).toContainText('GitHub')
    await expect(rows.nth(3)).toContainText('Jira')

    // Positioning: the palette takes the description column's left + width
    // (26rem) — so it floats over/near the description, not at the diff
    // preview to the right. The column slides in over a 200ms transition and
    // openMenu re-positions after 220ms, so poll until it settles.
    const anchor = page.getByTestId('command-anchor')
    await expect
      .poll(async () => {
        const a = await anchor.boundingBox()
        const c = await info.boundingBox()
        // The pr-index slides right (200ms) to make room for stop 1 — poll
        // until it has settled clear of the palette too.
        const idx = await page.getByTestId('pr-index').boundingBox()
        if (!a || !c || !idx) return false
        return (
          Math.abs(a.x - c.x) <= 10 &&
          Math.abs(a.width - c.width) <= 10 &&
          // And well left of the (settled) pr-index.
          a.x + a.width <= idx.x + 10
        )
      })
      .toBe(true)

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('`/` outside stop 1 keeps the default diff-region positioning', async ({ page }) => {
    await page.goto('/pr/12903')
    // Block 0 (CONTROLLER-first) has no local diff preview; select block 1.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    await page.keyboard.press('/')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()

    // No description column open → the palette sits over the diff's NEW pane
    // (the default region), i.e. to the right of the pr-index.
    const a = await page.getByTestId('command-anchor').boundingBox()
    const idx = await page.getByTestId('pr-index').boundingBox()
    expect(a.x).toBeGreaterThan(idx.x + idx.width - 10)

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  // Regression: state.selected can still point at a comment-index item
  // (kind:'comment', see recomputeLeftList/commentBlockItem) while stop 1
  // owns the keyboard — e.g. a fresh PR-wide comment auto-selects the first
  // "Start" row, and the reviewer then steps left into the description. Enter
  // there must open the PR-wide menu, not the comment item's own action menu
  // ("Beantwoorden"/"Resolve comment"/"Ignore") — see the !state.showDescription
  // guard on the selectedComment() branch in onKeydown (home.mjs).
  test('Enter on stop 1 opens the PR-wide menu, not the comment-item menu, when a comment row is selected', async ({
    page,
  }) => {
    const now = new Date().toISOString()
    await page.route('**/api/comments?*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ci-desc-1',
            runId: 'run-ci-desc-1',
            pr: 12903,
            file: '',
            line: 0,
            author: 'octocat',
            body: 'Overall this looks great, one nit below',
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
      }),
    )
    await page.goto('/pr/12903')
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    // A fresh open auto-selects the unresolved comment item (rank -1, first).
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Naar PR-overzicht')
    await expect(menu).not.toContainText('Beantwoorden')
    await expect(menu).not.toContainText('Resolve comment')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })
})
