import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Reviewer report: "als ik in een textarea zit, dan kan ik niet cmd + left
// drukken, dan moet het werken zoals normaal, ik denk dat ik dan naar links in
// de tekst moet gaan". A Cmd/Ctrl-modified key pressed while a real text field
// holds DOM focus is a NATIVE caret/selection command and must never be
// hijacked by the review tree's own navigation — see isNativeTextEditKey
// (home.mjs) and "A Cmd/Ctrl chord inside a text field stays native" in
// .claude/docs/keyboard-navigation.md.
//
// Before the fix, relatedActive()'s arrow branch short-circuited its own
// caret exception on isModifiedKey(e) (built for the Cmd+[/] remap, which
// really does have to navigate mid-text), so a genuinely pressed Cmd+←
// exited the composer instead of moving the caret to the start of the line.
//
// The assertions deliberately check "the app did NOT hijack the key" (the
// composer keeps focus and its text) rather than the resulting caret offset:
// what Cmd+← does to the caret is the browser/OS's business and differs per
// platform, but "the composer must still be open and focused" holds
// everywhere.
test.describe('Cmd/Ctrl chords stay native inside a text field', () => {
  test('Meta+ArrowLeft in the comment composer does not exit it', async ({ page }) => {
    const errors = []
    page.on('pageerror', (err) => errors.push(String(err)))

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

    await page.keyboard.press('Meta+ArrowLeft')
    await expect(composer).toHaveCount(1)
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('hello world')

    // Same for Cmd+→ (end of line) and the Shift+ selecting variant, plus
    // macOS's emacs-style Ctrl+←.
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Shift+Meta+ArrowLeft')
    await page.keyboard.press('Control+ArrowLeft')
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('hello world')

    expect(errors).toEqual([])
  })

  test('a plain ArrowLeft still moves the caret, and Meta+[ still exits mid-text', async ({ page }) => {
    await page.goto('/pr-overview')
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    // Selecting block 1 is itself the FIRST recorded step of the block-
    // history stack (whatever was selected by default, e.g. block 0, is what
    // Meta+[ steps back to below — see "Cmd+[ / Cmd+] ... a previous
    // selected block stack" in keyboard-navigation.md).
    await page.locator('[data-idx="1"]').click()
    await page.keyboard.press('ArrowRight')

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await composer.type('hello world')

    await page.keyboard.press('ArrowLeft')
    await expect(composer).toBeFocused()
    expect(await composer.evaluate((el) => el.selectionStart)).toBe(10)

    // Cmd+[ carries metaKey too, but it drives this app's own block-history
    // stack (checked before isNativeTextEditKey), so it must still act even
    // with the caret mid-text in the composer — stepping back to whichever
    // block was selected right before this one.
    await page.keyboard.press('Meta+[')
    await expect(composer).toHaveCount(0)
    await expect(page).toHaveURL(/\/pr\/12903\?sel=/)
  })
})
