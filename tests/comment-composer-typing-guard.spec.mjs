import { test, expect } from './_fixtures.mjs'

// Regression test for: "ik kan niet <-, ->, s, d of f typen in de comment" — the
// composer's own focus-tracking (cs.focus) has to stay in lockstep with real DOM
// focus, otherwise onKeydown's global shortcuts (s/d/f/a/arrows) steal the
// keystroke instead of letting it flow into the textarea. See the "Generieke
// input-focus-guard" section in .claude/rules/keyboard-navigation.md.
//
// This test deliberately reproduces the exact state the bug needs: open the
// comments sidebar (`g`, cs.focus becomes 'new'), then step back out to the diff
// with ← (cs.focus drops to null again while the sidebar stays open, mirroring
// nav-chain.spec.mjs) — and only THEN click the "+ Comment op deze regel" button
// directly (not via `g`/Enter). Before the fix this button flipped
// cs.composing directly without touching cs.focus, so relatedActive() stayed
// false and every global shortcut kept firing while the textarea had focus.
test.describe('PR Review Tree — composer typing guard', () => {
  test('typing s/d/f/a in the composer (opened by a direct click) lands in the field, not as a shortcut, and Escape gets you out', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)
    // Block 0 (ContractController::index) carries no local diff on this seeded
    // PR — select block 1 (CreatePaymentAction::execute) so → actually enters
    // diff mode (mirrors nav-chain.spec.mjs).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('Escape') // leave the auto-focused starting-points search box
    await page.keyboard.press('ArrowRight') // list → diff

    const granOf = () => new URL(page.url()).searchParams.get('gran')

    // Reach the exact repro state: open the sidebar, then step back out to the
    // diff so cs.focus drops to null again while the sidebar stays open.
    await page.keyboard.press('g')
    const sidebar = page.getByTestId('comments-sidebar')
    await expect(sidebar).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)
    await expect(sidebar).toBeVisible() // the sidebar itself stays open
    const granBeforeOpen = granOf()

    // Click the button directly — not via `g`/Enter — to exercise the fixed
    // click handler (openComposer() instead of a bare cs.composing toggle).
    const composer = page.getByTestId('comment-compose')
    await page.getByTestId('new-comment').click()
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
    await expect(page.getByTestId('new-comment')).not.toHaveClass(/ring-indigo-300/)

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
