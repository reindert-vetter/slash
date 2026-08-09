import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The per-line "onderliggende code" badge (Block.mjs's lineSummaryBadge, fed
// by home.mjs's lineChildSummaries — an avatar+N comment-activity indicator
// plus a done/total approve fraction, rendered at the right edge of the diff
// line the underlying code is anchored to). Every child is anchored on its
// OWN exact call-site row (2026-07-31: an earlier version rolled every child
// anchored within one of the block's own structural change-groups up onto
// that group's FIRST row, which combined several stacked, unrelated calls
// into one badge on the first call's line — see the "line-summary per-line
// anchoring" describe block below for the regression test proving the fix;
// this first block predates that fix and never actually exercised the
// rollup, see its own note). Reuses PR 100's existing call-arrow fixture
// (tests/fixtures/arrow-blocks.json + arrow-callresolve.json,
// materializeArrowWorktrees in tests/_setup.mjs — real worktrees on disk):
// ArrowCallerAction::execute calls ArrowHelperService::arrowHelper on a
// changed line; arrowHelper itself calls ArrowNestedService::arrowNested on
// its own changed line, so approving both rolls up into a combined
// done/total on the CALLER's own diff line — exactly like
// subtreeApproveCount's sidebar rollup, just anchored to one line instead of
// the whole block.
//
// arrowHelper has 2 changed rows of its own ($value=1→2, the arrowNested(1→2)
// call), arrowNested has 1 (return $x*2→3) — total 3, gran-independent (the
// badge shows regardless of the current navigation cursor, unlike the
// Onderliggende-code panel itself).
test.describe('PR Review Tree — per-line onderliggende-code badge', () => {
  test('shows a done/total approve fraction on the call-site line, updating as the underlying code is approved', async ({
    page,
  }) => {
    await page.goto('/pr/100')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the diff

    const badge = page.getByTestId('line-underlying-summary')
    await expect(badge).toBeVisible()
    // Not yet approved: no checkmark, 0 of 3 underlying rows done.
    await expect(badge).toContainText('0/3')
    await expect(badge).not.toContainText('✓')
    // Anchored on the actual call-site row, not some other row. NOTE: in this
    // fixture arrowHelper's own call site already happens to be the FIRST
    // row of its 2-line change-group (arrowHelper/arrowPlain), so this
    // assertion alone can't distinguish per-line anchoring from the old
    // group-rollup — see the dedicated "line-summary per-line anchoring"
    // describe block below for that.
    const row = page.locator('[data-row]').filter({ has: badge })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('arrowHelper')

    // Drill into arrowHelper (Onderliggende code → first child, prio 0 since
    // its own definition is a changed PR block) and approve its one group
    // (both its changed rows) via the command palette. The DEFAULT group
    // (the unrelated $flag/$note pair, see call-arrows.spec.mjs) doesn't cover
    // arrowHelper's own call site, and 'group' now hides an out-of-scope
    // Onderliggende-code child outright (see group-scope.spec.mjs) — step to
    // the second group first (the per-line badge itself, checked above, is
    // gran-independent and was already visible regardless).
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight') // → related panel
    const arrowHelperItem = page.getByTestId('related-item').first()
    await expect(arrowHelperItem).toContainText('arrowHelper')
    await arrowHelperItem.click() // drill in

    await expect(page.getByTestId('drill-column')).toContainText('ArrowHelperService::arrowHelper')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').nth(1).click() // "Keur ... goed"
    // A follow-up menu always opens here (either "Ga door" or the
    // PR-submit choice, depending on what's left) — dismiss it.
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // Drill one level deeper into arrowNested (arrowHelper's own resolved
    // call) and approve it too.
    await page.keyboard.press('ArrowRight') // → arrowHelper's own related panel
    const arrowNestedItem = page.getByTestId('related-item').first()
    await expect(arrowNestedItem).toContainText('arrowNested')
    await arrowNestedItem.click()

    await expect(page.getByTestId('drill-column')).toContainText('ArrowNestedService::arrowNested')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').nth(1).click()
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Sluit menu' }).click()
    await expect(page.getByTestId('command-menu')).not.toBeVisible()

    // Pop back out of both drilled columns to the top-level caller's own
    // diff — the badge must reflect the now-complete underlying subtree.
    await page.keyboard.press('ArrowLeft') // close arrowNested column
    await page.keyboard.press('ArrowLeft') // close arrowHelper column

    await expect(badge).toContainText('✓ 3/3')
  })

  // Regression (2026-07-30): the badge used to roll up ONLY underlying-code
  // children (relation children / resolved calls / covers targets) — a
  // comment placed directly on a line with no such child showed no avatar
  // at all, even though the exact same avatar+N badge exists everywhere else
  // for "there's an open comment here". Reindert's explicit choice: a
  // comment on the line itself now counts too (home.mjs's
  // lineChildSummaries + commentRowSet, RelatedPanel.mjs's
  // commentActivitySummary(keys, matchesRow)). NOTE: the comment below lands
  // on $flag, which is already the FIRST row of its own ($flag/$note)
  // change-group, so this test likewise doesn't exercise the group-rollup
  // fix below — it only proves comment-only rows get a badge at all.
  test('a comment placed directly on a line with no underlying-code child also shows the avatar+N badge', async ({
    page,
  }) => {
    await page.goto('/pr/100')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the diff — lands on the FIRST group ($flag/$note), which has no call site/child at all

    const flagRow = page.locator('[data-row]').filter({ hasText: '$flag' })
    await expect(flagRow.getByTestId('line-underlying-summary')).toHaveCount(0)

    await page.keyboard.press('Enter')
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.fill('is dit nodig?')
    await page.keyboard.press('Enter') // opens the compose-kind menu
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.keyboard.press('Enter') // default: "Plaats comment"

    const badge = flagRow.getByTestId('line-underlying-summary')
    await expect(badge).toBeVisible()
    // No underlying code here, so no done/total fraction — only the avatar.
    await expect(badge).not.toContainText('/')
    // This one WAS posted (it has a GitHub root of its own), so the badge
    // names its author. See the private-note counterpart below.
    await expect(badge.getByTestId('avatar-fallback')).toBeVisible()
    await expect(badge).toHaveAttribute('title', /open reactie/)
  })

  // Reindert: "als ik alleen een local comment heb op een regel, maak hier dan
  // een note icoontje van ipv mijn avatar". A private "Alleen voor mijzelf"
  // note never reaches GitHub (createComment with local:true — the workflow
  // skips the post, so githubId stays 0; see isLocalComment in
  // RelatedPanel.mjs), and an avatar answers "who is waiting for you", which
  // says nothing about your own note — seeing your own face on it is noise.
  //
  // The distinction is carried by SHAPE (a square note vs. the round avatar)
  // plus the badge's own title text, never by colour — the colorblind rule.
  test('a line whose only comment is a private note shows the note glyph, not the avatar', async ({
    page,
  }) => {
    // PR 112, not the PR 100 the sibling test above uses: comments persist for
    // the rest of a worker's run (see "A spec that SEEDS data" in
    // .claude/docs/testing-playwright.md), and a row carrying BOTH a posted
    // comment and a private note is a mixed scope that deliberately keeps the
    // avatar — so the two tests must not share a PR. PR 112's own spec (below)
    // asserts badge counts and the "0/1"/"0/2" fractions, neither of which a
    // comment changes, so this is safe in either order.
    await page.goto('/pr/112')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the diff

    await page.keyboard.press('Enter')
    await page.getByTestId('command-row').filter({ hasText: 'Comment op deze regel' }).click()
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()
    await composer.fill('even bij mezelf checken')
    await page.keyboard.press('Enter') // opens the compose-kind menu
    await expect(page.getByTestId('command-menu')).toBeVisible()
    await page.getByTestId('command-row').filter({ hasText: 'Alleen voor mijzelf' }).click()

    // Located BY the glyph rather than by row text, so this holds whichever
    // row the step landed on — and the count doubles as the "a private note
    // never renders an avatar" assertion.
    const noteBadge = page
      .getByTestId('line-underlying-summary')
      .filter({ has: page.getByTestId('line-note-icon') })
    await expect(noteBadge).toHaveCount(1)
    await expect(noteBadge).toHaveAttribute('title', /eigen notitie/)
    await expect(noteBadge.getByTestId('avatar-fallback')).toHaveCount(0)
  })
})

// Regression (2026-07-31, Reindert): the badge used to roll every child
// anchored anywhere within one of the block's own structural change-groups
// up onto that group's FIRST row — reported as a bug once a group contained
// several stacked, unrelated calls (e.g. three separate requestCss(...)
// calls in one group): they all combined onto the first call's line,
// hiding that the other calls had underlying code of their own too. Fixed
// by anchoring every child on its own exact row (home.mjs's
// lineChildSummaries no longer rolls up via changeGroups at all).
//
// PR 112's caller (tests/fixtures/linesummary-blocks.json +
// linesummary-callresolve.json, materializeLineSummaryWorktrees in
// tests/_setup.mjs) has exactly ONE change-group spanning TWO adjacent call
// lines — lineSummaryFirst() then lineSummarySecond() — each resolving to a
// DIFFERENT, changed PR block: lineSummaryFirst has 1 changed row of its
// own, lineSummarySecond has 2. Before the fix both calls would have shown a
// single combined "0/3" on the first (lineSummaryFirst) line only; the fix
// must show two independent badges, "0/1" on lineSummaryFirst's own line and
// "0/2" on lineSummarySecond's own line.
test.describe('PR Review Tree — per-line onderliggende-code badge — per-line anchoring', () => {
  test('two calls stacked in the same change-group each get their own independent badge', async ({ page }) => {
    await page.goto('/pr/112')
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // step into the diff

    const badges = page.getByTestId('line-underlying-summary')
    await expect(badges).toHaveCount(2)

    // The badge only ever renders on the canonical (new/right) side of a
    // row (see approveHere in Block.mjs), so filtering rows BY the badge
    // itself — rather than by the call text, which also appears unchanged
    // on the old/left side of the same row — uniquely picks out each line.
    const firstRow = page.locator('[data-row]').filter({ has: badges.filter({ hasText: '0/1' }) })
    const secondRow = page.locator('[data-row]').filter({ has: badges.filter({ hasText: '0/2' }) })
    await expect(firstRow).toHaveCount(1)
    await expect(secondRow).toHaveCount(1)
    await expect(firstRow).toContainText('lineSummaryFirst')
    await expect(secondRow).toContainText('lineSummarySecond')
  })
})
