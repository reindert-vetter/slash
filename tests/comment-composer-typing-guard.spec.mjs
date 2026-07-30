import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Regression test for: "ik kan niet <-, ->, s, d of f typen in de comment" — the
// composer's own focus-tracking (cs.focus) has to stay in lockstep with real DOM
// focus, otherwise onKeydown's global shortcuts (s/d/f/a/arrows) steal the
// keystroke instead of letting it flow into the textarea. See the "Generieke
// input-focus-guard" section in .claude/rules/keyboard-navigation.md.
//
// This used to open the composer via a direct click on the always-present
// "+ Comment op deze regel" trigger row, specifically to exercise a fixed
// click handler (openComposer()/toNew(), as opposed to an earlier, buggy bare
// cs.composing toggle that left cs.focus out of sync with real DOM focus).
// That trigger row has since been removed entirely (see "Inline comment
// blocks" in .claude/rules/detail-layout.md) — the composer now opens
// exclusively through the command palette's "Comment op deze regel" item
// (startComment), which has always routed through the same toNew() and thus
// never had this bug to begin with. The regression this test actually
// guards — typing s/d/f/a lands as text instead of firing a shortcut, and
// Escape reliably exits — is independent of *how* the composer was opened,
// so it's kept, just opened via the palette (openNewComment) instead of a
// now-nonexistent click target.
test.describe('PR Review Tree — composer typing guard', () => {
  test('typing s/d/f/a in the composer (opened via the command palette) lands in the field, not as a shortcut, and Escape gets you out', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    // Block 0 (ContractController::index) carries no local diff on this seeded
    // PR — select block 1 (CreatePaymentAction::execute) so → actually enters
    // diff mode (mirrors nav-chain.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list → diff

    const granOf = () => new URL(page.url()).searchParams.get('gran')
    const granBeforeOpen = granOf()

    // Open via the command palette's "Comment op deze regel" item.
    const composer = page.getByTestId('comment-compose')
    await openNewComment(page)
    await expect(composer).toBeFocused()

    // Letters that double as global shortcuts (f/d/s zoom, `a` diff-view toggle)
    // must land as text, not fire the shortcut — and the underlying diff
    // granularity must stay untouched while typing them.
    await page.keyboard.type('sdf a')
    await expect(composer).toHaveValue('sdf a')
    expect(granOf()).toBe(granBeforeOpen)

    // Escape gets the reviewer out of the field — the composer closes (the
    // existing handleRelatedKey Escape → exitRelated behavior, now reliably
    // reached because cs.focus is in sync) and DOM focus leaves the textarea.
    await page.keyboard.press('Escape')
    await expect(composer).toHaveCount(0)

    // Global shortcuts resume once the field no longer holds DOM focus: `f`
    // should now zoom the diff in (from 'group', the default) instead of typing
    // anywhere — the exact next level ('line' or, for a single-line group,
    // straight to 'call' — see keyboard-navigation.md) depends on this block's
    // diff shape, so just assert it actually moved off the default.
    expect(granBeforeOpen).toBeNull()
    await page.keyboard.press('f')
    await expect.poll(granOf).not.toBeNull()
  })
})
