import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// findNextUnapproved's "descend into Onderliggende code / walk the rest of a
// test-class row's methods" logic used to be nested inside one
// `if (focused && inDiff)` gate (home.mjs) — but `inDiff` is false in LIST
// mode (state.mode==='list', state.focusLevel===0), i.e. exactly the state
// the reviewer is in the moment they select a block/test method and approve
// it via the command palette WITHOUT ever pressing → into its diff first
// (the realistic way to review a small, freshly ADDED test method or a
// single-line change). That gap made findNextUnapproved() return null
// despite clearly remaining unapproved content elsewhere in the same
// block/row, which surfaced as the reported bug: the reviewer was offered
// "Keur de HELE PR goed" / "Wijs de PR af" (afterApproveAction's
// reviewApprove/reviewChoice follow-up, see the "No more 'next'" section in
// keyboard-navigation.md) instead of simply continuing.
//
// Two, independently reproducible shapes of the same root cause:
//  - a test_class row's remaining METHODS (not real state.blocks entries —
//    see testClassRowItem/recomputeLeftList in detail-layout.md), and
//  - an ordinary block's own Onderliggende-code CHILD that is itself a
//    resolved method_call target AND a real, changed PR block — such a
//    child is hidden from the flat sidebar entirely (resolvedCallTargetIds,
//    recomputeLeftList), so it's reachable only via the Onderliggende-code
//    walk (orderedChildBlocks/firstUnapprovedInSubtree), never via the
//    generic "next top-level block" fallback.
// Both are fixed by the same change: those two lookups no longer require
// `inDiff`, only step 1 (resuming a diff cursor) still does — see
// findNextUnapproved's own doc comment in home.mjs.

test.describe('findNextUnapproved from list mode — test-class sibling methods', () => {
  // Fixture: PR 110 (tests/fixtures/testclassgroup-blocks.json,
  // materializeTestClassGroupWorktrees in _setup.mjs) — TriggersIndexTest has
  // two changed methods, it_should_index_triggers (first, one changed line)
  // and it_should_filter_triggers (second, one changed line, still 0/1).
  const PR = 110

  test('approving the active method straight from the list (no →) lands on the next unapproved method instead of offering to approve the whole PR', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await page.getByTestId('block-row').filter({ hasText: 'TriggersIndexTest' }).click()
    // Deliberately no ArrowRight at all — stay in list mode, exactly the
    // reported repro (approving a test method straight from "Start").
    await expect(page).not.toHaveURL(/mode=diff/)
    await expect(page.getByTestId('test-method-row').nth(0)).toHaveClass(
      /bg-indigo-50|dark:bg-indigo-500\/15/,
    )

    // Approve the active (first) method's only group via the palette.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // Approving from the blokken-index always skips any follow-up menu
    // (`keepList`, see afterApproveAction/applyNextUnapproved) — before the
    // fix that still held, but findNextUnapproved() itself returned null
    // (never having looked at the row's remaining methods from list mode),
    // so `!target` opened "Sluit menu / Keur de HELE PR goed / Wijs de PR
    // af" regardless of keepList. After the fix, a target IS found (the
    // still-unapproved second method), so no follow-up opens at all.
    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    // The selection actually landed on the second (still 0/1) method.
    await expect(page.getByTestId('test-method-row').nth(1)).toHaveClass(
      /bg-indigo-50|dark:bg-indigo-500\/15/,
    )
    await expect(page).not.toHaveURL(/mode=diff/)
  })
})

test.describe('findNextUnapproved from list mode — an Onderliggende-code child hidden from the sidebar', () => {
  // Fixture: PR 112 (tests/fixtures/linesummary-blocks.json +
  // linesummary-callresolve.json, materializeLineSummaryWorktrees in
  // _setup.mjs, already used by line-underlying-summary.spec.mjs) —
  // LineSummaryCallerAction::execute (top-level, one change-group spanning
  // two call lines) resolves BOTH lineSummaryFirst/lineSummarySecond to
  // real, separately CHANGED PR blocks (LineSummaryFirstService/
  // LineSummarySecondService) — both hidden from state.blocks entirely
  // (resolvedCallTargetIds), reachable only through the Onderliggende-code
  // walk, never through the flat "next state.blocks row" fallback.
  const PR = 112

  test('approving the caller from the list does not offer "Keur de HELE PR goed" while its resolved children are still unapproved', async ({
    page,
  }) => {
    await page.goto(`/pr/${PR}`)
    await leaveSearchBox(page)
    // Deliberately no ArrowRight — stay in list mode.
    await expect(page).not.toHaveURL(/mode=diff/)

    // Approve the caller's only group (both call lines) via the palette.
    await page.keyboard.press('Enter')
    await page.getByTestId('command-input').fill('keur')
    await page.getByTestId('command-row').first().click()

    // afterApproveAction's own follow-up (postApprove, or — if
    // findNextUnapproved() finds nothing — reviewApprove/reviewChoice) only
    // opens once findNextUnapproved()'s promise settles, a couple of
    // microtask ticks after the click — checking "not visible" right away
    // would trivially pass before that promise has even resolved (the
    // "asserting a transient state" pitfall, see conventions.md), fix or no
    // fix. Wait for the PR-wide total to actually reflect the approve
    // (2 of the caller's own rows landing, out of 5 total: caller 2 +
    // lineSummaryFirst 1 + lineSummarySecond 2) — by the time that reactive
    // update has landed, any follow-up menu this approve would open has
    // already had its chance to appear too.
    const summary = page.getByTestId('approval-summary')
    await expect(summary).toContainText('2/5')

    // Before the fix: findNextUnapproved() never descended into
    // orderedChildBlocks(focused) from list mode, so it found nothing —
    // even though BOTH children still sit at 0/N — and opened the
    // reviewApprove/reviewChoice follow-up instead.
    const menu = page.getByTestId('command-menu')
    await expect(menu).not.toBeVisible()

    // Confirms the absent menu really would have been reviewChoice (not a
    // coincidental "everything happens to be done" empty state): the
    // PR-wide total still has outstanding rows — the two children's own
    // changed lines.
    const [done, total] = (await summary.textContent()).match(/(\d+)\/(\d+)/).slice(1).map(Number)
    expect(done).toBeLessThan(total)
  })
})
