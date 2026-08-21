import { test, expect } from './_fixtures.mjs'

// Reviewer report (2026-08-20/21, screenshot of
// FindSessionStateActivity::run): a changed unit consisting only of a long
// `// …` comment line rendered CUT OFF at the card's right edge, and so did
// an unrelated, unselected code line still visible further down the same
// card. Root cause: selectionWindowLineChars's measurableLen (Block.mjs)
// excluded a `//`/`#`/`*`/`/*` row from the width measurement even when that
// row sits INSIDE the reviewer's own selected unit — so a comment-only unit
// measured `0` chars and the whole card floored to MIN_CONTENT_WIDTH_CHARS
// (80), too narrow for both the comment line and the other line still in
// view. The fix keeps a changed comment row measurable when it's part of the
// active selection window (only the whole-block FALLBACK scan,
// nonCommentLineLengths, still skips comments — see diff-card.md).
//
// This is a targeted assertion on the pure width function itself
// (fitCapCharsFor, already exported by Block.mjs for exactly this kind of
// spec — see contentWidthPx/contentWidthChars next to it), not a full
// navigate-and-render flow: no PR data is read, no card is even queried.
// `keepDescription: true` skips the page fixture's default "wait for the
// PR-info column, then ArrowRight" goto behaviour (tests/_fixtures.mjs),
// since nothing here touches the rendered app at all.
test.describe('diff card width — a changed comment line inside the selection window', () => {
  test('fitCapCharsFor measures a comment-only unit instead of flooring to 0', async ({
    page,
  }) => {
    await page.goto('/pr/105', { keepDescription: true })

    const longComment =
      '// Built here, not injected: a worker without a reachable ClickHouse must return early'
    const result = await page.evaluate(
      async ({ longComment }) => {
        const { fitCapCharsFor } = await import('/src/Block.mjs')
        const b = {
          file: 'FindSessionStateActivity.php',
          status: 'added',
          code: {
            old: { text: '' },
            new: { text: `$type = 1;\n${longComment}\nreturn $type;` },
          },
        }
        // The unit is JUST the comment row (row index 1) — the same shape a
        // 'line'-granularity cursor on that single row would pass as
        // activeGroup/topLevelActiveUnit.
        return fitCapCharsFor(b, { start: 1, end: 1 })
      },
      { longComment },
    )

    // Before the fix this was 0 (the comment row was excluded from
    // measurableLen, so the unit reported no measurable chars at all).
    expect(result).toBe(longComment.length)
  })

  test('an unrelated, non-comment unit is unaffected', async ({ page }) => {
    await page.goto('/pr/105', { keepDescription: true })

    const result = await page.evaluate(async () => {
      const { fitCapCharsFor } = await import('/src/Block.mjs')
      const b = {
        file: 'Foo.php',
        status: 'added',
        code: {
          old: { text: '' },
          new: { text: '$x = 1;\n// a short comment\nreturn $x;' },
        },
      }
      return fitCapCharsFor(b, { start: 0, end: 0 })
    })

    expect(result).toBe('$x = 1;'.length)
  })
})
