import { test, expect } from './_fixtures.mjs'

// The call-arrow overlay (src/callArrows.mjs): a flowing indigo bezier from the
// changed call-site row inside the ACTIVE navigation unit (new pane of the
// selected diff card) to the matching *changed* method_call child card in the
// Onderliggende-code panel. Only a child whose definition is itself a PR block
// gets an arrow; a resolved call into an unchanged file ("Ongewijzigd" badge)
// never does. Pairs are computed in home.mjs' setRelated watch callback
// (callArrowPairs) and drawn imperatively into one fixed <svg>.
//
// PR 100 (tests/fixtures/arrow-blocks.json + arrow-callresolve.json,
// data/worktrees/pr-100-{base,head} materialized by _setup.mjs): the caller
// ArrowCallerAction::execute has TWO changed groups — an unrelated one first
// (a changed $flag/$note pair, no call site at all — this is the DEFAULT
// active unit on entering the diff) and, after an unchanged blank line, a
// second group with two adjacent call lines: one calls arrowHelper (resolves
// to the also-changed ArrowHelperService::arrowHelper block → arrow), the
// other calls arrowPlain (resolves to a file the PR doesn't touch → no arrow).
test.describe('PR Review Tree — call-arrow overlay', () => {
  test('pijl verschijnt voor een gewijzigde call naar een gewijzigd kind, niet voor een ongewijzigd kind', async ({
    page,
  }) => {
    await page.goto('/pr/100')

    // Only the caller is in the left list; the changed helper definition is a
    // resolved-call target and lives in "Onderliggende code" instead.
    await expect(page.getByTestId('block-row')).toHaveCount(1)
    await expect(page.getByTestId('block-row').first()).toContainText('ArrowCallerAction::execute')

    const arrows = page.locator('[data-testid=call-arrow]')

    // List mode: no active diff unit → no arrows.
    await expect(arrows).toHaveCount(0)

    // Enter the diff (group granularity): the DEFAULT active group is the
    // unrelated $flag/$note pair — it doesn't cover either call site. At
    // 'group' the panel does NOT hide an out-of-active-unit call child (only
    // reorders it, see relatedChildren/resolvedCallChildren), so the
    // arrowHelper child card is still shown here — and the arrow must reach
    // it too (this is the reported bug: card visible, no arrow).
    await page.keyboard.press('Escape') // leave the auto-focused search box
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-change-active]').first()).toBeVisible()
    await expect(
      page.locator('[data-testid=related-item][data-child-id*="arrowHelper"]'),
    ).toBeVisible()
    await expect(arrows).toHaveCount(1)

    // Step down to the second group (the actual call lines): still one arrow,
    // now anchored on the in-scope call site.
    await page.keyboard.press('ArrowDown')
    await expect(arrows).toHaveCount(1)

    // Refine to line granularity: lands on the first changed line (the
    // arrowHelper call) → still one arrow.
    await page.keyboard.press('f')
    await expect(arrows).toHaveCount(1)

    // Next line: the arrowPlain call. Its child is shown (Ongewijzigd) but its
    // definition isn't changed by the PR → no arrow.
    await page.keyboard.press('ArrowDown')
    await expect(
      page.locator('[data-testid=related-item][data-child-id*="arrowPlain"]'),
    ).toBeVisible()
    await expect(arrows).toHaveCount(0)

    // Back up a line: the arrow returns with the cursor.
    await page.keyboard.press('ArrowUp')
    await expect(arrows).toHaveCount(1)

    // `a` narrows every visible card to 60% width (state.diffViewMode) without
    // touching state.selected/mode/gran/change — the setRelated watch that
    // normally redraws the overlay never fires for this toggle (see
    // resettleCallArrows in callArrows.mjs). The arrow must still re-anchor to
    // the narrower pane's right edge instead of staying on its pre-toggle
    // (wide) coordinates.
    const arrowStartX = async () => {
      const d = await arrows.first().getAttribute('d')
      return parseFloat(d.match(/M\s*(-?[\d.]+)/)[1])
    }
    // Let any residual redraw from the preceding navigation steps fully settle
    // first — otherwise a coincidental late redraw (from the *previous* step's
    // own 250ms settle-timer) can paint the post-toggle geometry regardless of
    // whether the `a` toggle itself triggers one, masking the very bug this
    // asserts against.
    await page.waitForTimeout(500)
    const beforeX = await arrowStartX()
    await page.keyboard.press('a')
    // The 200ms width transition plus the overlay's own 250ms settle redraw.
    await page.waitForTimeout(500)
    await expect(arrows).toHaveCount(1)
    const afterX = await arrowStartX()
    expect(afterX).toBeLessThan(beforeX - 20) // moved noticeably left with the narrowed pane
    await page.keyboard.press('a') // back to split view

    // Leave the diff: overlay cleared and hidden.
    await page.keyboard.press('s') // line → group
    await page.keyboard.press('ArrowLeft') // diff → list
    await expect(arrows).toHaveCount(0)
    await expect(page.getByTestId('call-arrows')).toBeHidden()
  })
})
