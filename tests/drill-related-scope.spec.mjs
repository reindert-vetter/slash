import { test, expect } from './_fixtures.mjs'

// Onderliggende-code scoping (relatedChildren/callScopeMethods/groupLineRange/
// resolvedCallChildren in home.mjs) is supposed to hide a line/call-scoped
// child outright for whichever column currently owns the keyboard — the
// top-level selected block OR a focused DRILLED column, using ITS OWN
// state.drillCursor[level-1] cursor (see "Kolom-navigatie" in
// detail-layout.md). Before the fix, `isTopCursor` (relatedChildren) and the
// guards in callScopeMethods/groupLineRange were hardcoded to `b === curBlock()
// && !state.drill.length` — the instant ANY drilling was active
// (state.drill.length > 0), line/call scoping stopped applying to the
// drilled column's own panel entirely (it always showed its full,
// list-mode-like child set), regardless of the drilled cursor's own
// granularity/position. resolvedCallChildren's `hideOutOfScope` had the same
// bug independently (it read the top-level state.gran directly).
//
// Reuses the PR 100 fixture from call-arrows.spec.mjs (materializeArrowWorktrees
// + arrow-blocks.json/arrow-callresolve.json): ArrowCallerAction::execute calls
// arrowHelper (a changed PR block) — drilling into it lands on
// ArrowHelperService::arrowHelper, which itself has TWO adjacent changed lines
// forming one group: `$value = 2;` (no call site) then
// `$nested = $this->service->arrowNested(2);` (resolves to the also-changed
// ArrowNestedService::arrowNested — a method_call child in THIS drilled
// column's own Onderliggende-code panel).
test.describe('PR Review Tree — Onderliggende-code scoping in a focused drilled column', () => {
  test('line/call scoping inside a drilled column follows its own drillCursor, not the top-level cursor', async ({
    page,
  }) => {
    await page.goto('/pr/100')
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('ArrowRight') // caller's diff
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await page.keyboard.press('ArrowRight') // → Onderliggende code

    const helperChild = page.locator('[data-testid=related-item][data-child-id*="arrowHelper"]')
    await expect(helperChild).toBeVisible()
    await helperChild.click() // drill in — focus moves to the drilled column's diff

    // Confirm this really is a focused drilled column (focusLevel > 0), not
    // the top-level cursor.
    await expect(page.getByTestId('block-collapsed')).toHaveCount(1)
    const drill = page.getByTestId('drill-column')
    await expect(drill).toContainText('ArrowHelperService::arrowHelper')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()

    const nestedChild = page.locator('[data-testid=related-item][data-child-id*="arrowNested"]')

    // Default landing granularity after drilling is 'group' (the whole
    // 2-line group) — not hidden at 'group', just (a no-op here) reordered.
    await expect(nestedChild).toBeVisible()

    // Refine the DRILLED column's own cursor (f: group → line). Re-anchors
    // onto the group's FIRST row ($value = 2;), which carries no call site
    // at all — the child must now be hidden outright. Before the fix this
    // stayed visible: drilling made relatedChildren/callScopeMethods treat
    // every block as "not the focused cursor", so line/call hiding never
    // applied to a drilled column.
    await page.keyboard.press('f')
    await expect(nestedChild).toHaveCount(0)

    // Step ↓ within the drilled column (drillNextChange, a plain in-column
    // cursor move — no fresh drill/focus change) onto the second line
    // ($nested = $this->service->arrowNested(2);), the call's own site — the
    // child reappears. This also proves the setRelated watch's
    // state.drillCursor dependency re-fires relatedChildren on a plain
    // in-column step, not just on drilling in/out.
    await page.keyboard.press('ArrowDown')
    await expect(nestedChild).toBeVisible()

    // s: line → group. Group never hides, only reorders — visible again
    // regardless of which line the cursor rests on.
    await page.keyboard.press('s')
    await expect(nestedChild).toBeVisible()

    // Step ← back out of the drilled column: the caller's own panel takes
    // over again, showing the (top-level, unchanged-cursor) arrowHelper card.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('drill-column')).toHaveCount(0)
    await expect(helperChild).toBeVisible()
  })
})
