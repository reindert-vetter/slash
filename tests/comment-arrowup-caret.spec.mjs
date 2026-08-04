import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Regression test for: "in de textarea naar boven kunnen (tekstregel erboven)
// zolang dat kan, pas naar boven navigeren als het niet meer kan" — ArrowUp
// inside a genuinely DOM-focused, WRAPPED (multi visual-line) textarea must
// move the caret up one visual row, not immediately pop the panel/thread
// focus. Before the fix, the relatedActive() branch in home.mjs's onKeydown
// always hijacked ArrowUp/ArrowDown, even mid-caret in a wrapping composer —
// selectionStart/selectionEnd alone can't tell "first/last visual line" apart
// from "first/last character", which only matters once the field wraps (see
// editableCaretCanMoveUp/Down + caretVisualLineMarks in home.mjs). Mirrors
// tests/comment-arrowleft-caret.spec.mjs's structure.
test.describe('ArrowUp caret guard in a wrapped comment composer', () => {
  test('ArrowUp moves the caret up a wrapped line, then exits once on the first line', async ({ page }) => {
    await page.goto('/pr/12903')
    await expect(page.getByTestId('block-row').first()).toBeVisible()
    // Block 0 carries no local diff on this seeded PR — pick block 1 so →
    // actually enters diff mode (mirrors the ArrowLeft caret spec).
    await page.locator('[data-idx="1"]').click()
    await leaveSearchBox(page)
    await page.keyboard.press('ArrowRight') // list -> diff

    await openNewComment(page)
    const composer = page.getByTestId('comment-compose')
    await expect(composer).toBeFocused()

    // A long, space-separated sentence wraps across several visual lines in
    // the (narrow) composer regardless of exact pixel width.
    const words = Array.from({ length: 40 }, (_, i) => 'woord' + i).join(' ')
    await composer.type(words)
    await expect(composer).toHaveValue(words)

    // Confirm the field genuinely wraps (more than one visual row) before
    // asserting anything about "first"/"not first" line.
    const rows = await composer.evaluate((el) =>
      Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)),
    )
    expect(rows).toBeGreaterThan(1)

    // Caret sits at the very end, on the last visual line. One ArrowUp must
    // move it to the line above, NOT exit the composer.
    await page.keyboard.press('ArrowUp')
    await expect(composer).toBeFocused()
    const posAfterFirstUp = await composer.evaluate((el) => el.selectionStart)
    expect(posAfterFirstUp).toBeLessThan(words.length)
    expect(posAfterFirstUp).toBeGreaterThan(0)
    await expect(composer).toHaveValue(words)

    // Keep pressing ArrowUp: each press must either move the caret further up
    // (stays focused, text untouched, position strictly decreases — never a
    // stray nav mid-field) until the caret finally sits on the field's first
    // visual line, at which point the NEXT ArrowUp has nowhere left to go
    // within the field and exits the composer instead. (The browser's own
    // column-preserving caret movement means the caret needn't land on
    // character 0 exactly to be "on the first line" — a row can span many
    // characters — so this only asserts monotonic movement + eventual exit,
    // not a specific final offset.)
    let pos = posAfterFirstUp
    let sawMultipleRows = false
    let sawExit = false
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowUp')
      if ((await composer.count()) === 0) {
        sawExit = true
        break
      }
      await expect(composer).toBeFocused()
      await expect(composer).toHaveValue(words)
      const next = await composer.evaluate((el) => el.selectionStart)
      expect(next).toBeLessThanOrEqual(pos)
      if (next < pos) sawMultipleRows = true
      pos = next
    }
    // The composer eventually exits (reaching the top), and it took more than
    // just the single already-asserted first press to get there — i.e. the
    // guard genuinely let several ArrowUp presses walk the wrapped rows
    // instead of hijacking the very first one past the end.
    expect(sawExit).toBe(true)
    expect(sawMultipleRows).toBe(true)
  })
})
