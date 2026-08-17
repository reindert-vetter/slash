import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Reviewer request: "als ik cmd + [ type, ga dan naar links, cmd + ] naar
// rechts" — a plain Cmd(Mac)/Ctrl(Windows-Linux)+[ / +] remap onto the exact
// same ArrowLeft/ArrowRight the left→right nav chain already uses (see
// "Cmd+[ / Cmd+] ..." at the top of onKeydown, home.mjs). Unlike a plain
// ArrowLeft/ArrowRight, this remap deliberately ALWAYS drives the nav chain,
// even with keyboard focus mid-text inside a comment/reply/Claude field
// (isModifiedKey(e) short-circuits the editableCaretCanMoveLeft/Right
// exception in relatedActive()'s branch) — a native browser Cmd+[/] is a
// history-back/forward shortcut, never a caret move, so there is no existing
// meaning to preserve there.
//
// Follow-up reviewer request: Shift+Cmd+[/] must NOT drive this custom nav —
// it's excluded so the browser's own native Shift+Cmd+[/] (tab-switching in
// Chrome/Safari on Mac) keeps working. Only the kale Cmd+[/] (no Shift) is
// remapped now.
test.describe('Cmd+[ / Cmd+] remap onto the left-right nav chain', () => {
  test('Meta+[ opens the PR-description column (stop 1) exactly like ArrowLeft, Meta+] closes it like ArrowRight', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await expect(page.getByTestId('block-row').first()).toHaveClass(/bg-indigo-50/)

    const info = page.getByTestId('pr-info-column')
    await expect(info).toHaveCount(0)

    await page.keyboard.press('Meta+[')
    await expect(info).toHaveCount(1)
    await expect(info).toBeVisible()

    await page.keyboard.press('Meta+]')
    await expect(info).toHaveCount(0)
  })

  test('Shift+Meta+[ does NOT drive the custom nav (left for the browser\'s own tab-switch)', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)

    const info = page.getByTestId('pr-info-column')
    await expect(info).toHaveCount(0)

    await page.keyboard.press('Shift+Meta+[')
    // Custom nav must not have fired: the PR-description column stays closed.
    await expect(info).toHaveCount(0)
  })

  test('Meta+[ exits a comment composer even with the caret mid-text, unlike a plain ArrowLeft', async ({ page }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode.
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()

    await composer.type('hello world')
    await expect(composer).toHaveValue('hello world')

    // A plain ArrowLeft only moves the caret (see
    // tests/comment-arrowleft-caret.spec.mjs) — sanity-check that behaviour
    // still holds before proving Cmd+[ bypasses it.
    await page.keyboard.press('ArrowLeft')
    await expect(composer).toBeFocused()
    let pos = await composer.evaluate((el) => el.selectionStart)
    expect(pos).toBe(10)

    // Cmd+[ (Meta+[) must exit the composer straight away, regardless of the
    // caret still sitting mid-text.
    await page.keyboard.press('Meta+[')
    await expect(composer).toHaveCount(0)
  })
})
