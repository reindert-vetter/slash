import { test, expect } from './_fixtures.mjs'

// Cmd+A (Mac) / Ctrl+A (Windows/Linux) must reach the browser's native
// "select all" instead of being swallowed by the bare `a` shortcut (toggling
// state.diffViewMode, see keyboard-navigation.md "`a` — cycling the diff
// view"). `event.key` stays the plain letter 'a' regardless of a held
// modifier, and the diff/code panes are plain, non-input text — not a
// TEXTAREA/INPUT — so isEditableFocused() alone never covered this. Same
// isModifiedKey() guard also protects f/d/s (Cmd+F/D/S — browser
// find/bookmark/save). Anchored on block 1 of PR 12903
// (CreatePaymentAction::execute), which reliably carries a real (two-sided)
// change — see the data caveat in conventions.md.
test.describe('PR Review Tree — Cmd/Ctrl+letter falls through to the browser', () => {
  test('Meta+a / Control+a do not toggle the diff view', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // step into the diff

    const diff = page.getByTestId('code-diff').first()
    await expect(diff).toBeVisible()
    // Block 1's own single (one-row) change group auto-jumps the initial
    // stand to 'unified' once its code arrives (home.mjs's
    // allChangesAreSingleLine watch) — wait for the code to actually render
    // (so that auto-jump has already fired) before forcing 'split' back, or
    // the click races the async code fetch and gets silently overridden the
    // moment it resolves. This test is about the Meta/Control+a
    // fallthrough, not the auto-jump feature.
    await expect(diff.locator('code.language-php').first()).toBeVisible()
    await page.getByTestId('diffview-split').click()
    const panes = diff.locator('code.language-php')
    await expect(panes).toHaveCount(2) // split (default): both panes visible

    // A held Cmd (Playwright's 'Meta') must not collapse the split view.
    await page.keyboard.press('Meta+a')
    await expect(panes).toHaveCount(2)

    // Same for Ctrl (Windows/Linux select-all).
    await page.keyboard.press('Control+a')
    await expect(panes).toHaveCount(2)

    // Sanity check: the bare `a` (no modifier) still toggles as before — this
    // proves the guard only excludes the modified case, not the shortcut
    // itself.
    await page.keyboard.press('a')
    await expect(panes).toHaveCount(1)
  })

  test('Meta+f / Control+f do not zoom the selection', async ({ page }) => {
    await page.goto('/pr/12903')
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // step into the diff, gran='group' (default, not in the URL)

    expect(page.url()).not.toContain('gran=')

    await page.keyboard.press('Meta+f')
    expect(page.url()).not.toContain('gran=')

    await page.keyboard.press('Control+f')
    expect(page.url()).not.toContain('gran=')

    // Sanity check: the bare `f` still zooms in as before — this proves the
    // guard only excludes the modified case, not the shortcut itself. (This
    // block's group unit spans exactly one line, so `f` skips straight to
    // 'call' — see the granularity section in keyboard-navigation.md — hence
    // a bare `gran=` check rather than pinning the exact level.)
    await page.keyboard.press('f')
    await expect.poll(() => page.url()).toContain('gran=')
  })
})
