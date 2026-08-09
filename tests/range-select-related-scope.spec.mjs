import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// A Shift+arrow line/group-range selection (state.rangeAnchor) is supposed to
// behave exactly like a bigger group everywhere a single unit already does —
// see the "rangeAnchor" section in keyboard-navigation.md. Approve/comment/
// the Claude-chat context already merged onto the range via rangeUnit();
// callScopeMethods/groupLineRange (home.mjs) — which decide which
// Onderliggende-code children the panel shows for the block/column that owns
// the keyboard — did NOT: they only ever looked at the lone cursor unit
// (cur.change), ignoring cur.rangeAnchor entirely. Fixed by reusing the
// existing focusedActiveUnit() helper (the same range-aware computation
// activeGroup() already uses for highlighting) instead of a second,
// range-blind unit lookup.
//
// Reuses the PR 100 fixture from call-arrows.spec.mjs (materializeArrowWorktrees):
// ArrowCallerAction::execute has TWO changed groups — an unrelated one first
// (a changed $flag/$note pair, no call site at all — the DEFAULT active unit
// on entering the diff) and, after an unchanged line, a second group with the
// two call lines (arrowHelper/arrowPlain). 'group' granularity hides a child
// whose call site sits outside the active unit (group-scope.spec.mjs), so the
// arrowHelper child is normally invisible while the cursor sits on the first
// group alone.
test.describe('PR Review Tree — Shift+arrow range widens Onderliggende-code scoping like a bigger group', () => {
  test('merging the unrelated first group with the call-site group reveals the call child, same as stepping onto it directly', async ({
    page,
  }) => {
    await page.goto('/pr/100')
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // execute's diff, gran 'group', default unit 0 ($flag/$note)
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const arrowHelperItem = page.locator('[data-testid=related-item][data-child-id*="arrowHelper"]')
    // The lone cursor unit (group 0) doesn't cover either call site yet.
    await expect(arrowHelperItem).toHaveCount(0)

    // Shift+ArrowDown merges group 0 with group 1 (the call-site group) into
    // one range — the Onderliggende-code panel must widen along with it,
    // exactly as if the cursor had simply stepped onto group 1 alone
    // (see call-arrows.spec.mjs's own, non-range assertion of this same
    // child becoming visible).
    await page.keyboard.press('Shift+ArrowDown')
    await expect(arrowHelperItem).toBeVisible()

    // Collapsing the range with a plain (non-shift) step narrows the scope
    // straight back to whichever single unit the cursor lands on — same
    // "an ordinary step releases the selection" rule as everywhere else.
    await page.keyboard.press('ArrowUp')
    await expect(arrowHelperItem).toHaveCount(0)
  })
})
