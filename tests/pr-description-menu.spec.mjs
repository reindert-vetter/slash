import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// Enter on stop 1 (the PR-description column, state.showDescription) opens the
// PR-wide command menu ('pr' mode, same list as `/`) — and it must open *near
// the description*, not over the diff region far to the right: menuAnchor/
// menuRegion in home.mjs have a stop-1 exception (isDescriptionMenu) that
// anchors the palette on the pr-info-card and gives it the full left+width of
// the pr-info-column (mirror of the blokken-index exception). See
// .claude/docs/keyboard-navigation.md.
test.describe('PR Review Tree — PR-wide menu on the description column (stop 1)', () => {
  test('Enter on stop 1 opens the PR-wide menu positioned over the description column', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-column')).toBeVisible()

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
    // Root items: a pinned "Sluit menu" (withClose, always first) plus the
    // real ones. Deliberately NOT an exact toHaveCount here — PR_COMMANDS
    // (home.mjs) keeps growing (e.g. "Tests laten draaien" landed after this
    // test was written) and a hardcoded count on the root list is exactly
    // what broke last time; assert presence/order of the known first few
    // items instead, which survives a future addition.
    await expect(rows.nth(0)).toContainText('Sluit menu')
    await expect(rows.nth(1)).toContainText('Chat met Claude over deze PR')
    await expect(rows.nth(2)).toContainText('GitHub')

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

  // Outside stop 1, `/` opens the PR-wide menu (it always does now — see
  // "`/` always opens the PR menu" in command-palette.md), but from the index
  // it is anchored on the index exactly like Enter's own block palette
  // (isIndexMenu covers 'pr' there too), not on the description column.
  test('`/` outside stop 1 is anchored exactly like Enter', async ({ page }) => {
    await page.goto('/pr/12903')
    // By label, not by raw index — see "Sort order of the left list" in
    // blocks-and-ingest.md. CreatePaymentAction::execute reliably carries a
    // real changed row.
    await page.getByTestId('block-row').filter({ hasText: 'CreatePaymentAction::execute' }).click()
    await leaveSearchBox(page)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const menu = page.getByTestId('command-menu')

    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    const viaEnter = await page.getByTestId('command-anchor').boundingBox()
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    await page.keyboard.press('/')
    await expect(menu).toBeVisible()
    const viaSlash = await page.getByTestId('command-anchor').boundingBox()
    expect(Math.abs(viaSlash.x - viaEnter.x)).toBeLessThan(2)
    expect(Math.abs(viaSlash.width - viaEnter.width)).toBeLessThan(2)
    // Not the description column's anchor: that column isn't even open here.
    await expect(page.getByTestId('pr-info-column')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  // Regression: state.selected can still point at a comment-index item
  // (kind:'comment', see recomputeLeftList/commentBlockItem) while stop 1
  // owns the keyboard — e.g. a reviewer selects a comment-index "Start" row,
  // and then steps left into the description. Enter there must open the
  // PR-wide menu, not the comment item's own action menu ("Beantwoorden"/
  // "Resolve comment"/"Ignore") — see the !state.showDescription guard on the
  // selectedComment() branch in onKeydown (home.mjs).
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
    await leaveSearchBox(page)
    // A fresh open now lands on an unapproved ordinary block instead
    // (applyDefaultUnapprovedSelection, reversed 2026-08-20) — select the
    // comment item directly.
    await page.locator('[data-idx]').filter({ hasText: 'Overall this looks great' }).click()
    await expect(page.getByTestId('comment-detail-card')).toBeVisible()

    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('pr-info-column')).toBeVisible()

    await page.keyboard.press('Enter')
    const menu = page.getByTestId('command-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('GitHub')
    await expect(menu).not.toContainText('Beantwoorden')
    await expect(menu).not.toContainText('Resolve comment')

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })
})
