import { test, expect } from './_fixtures.mjs'

// The Onderliggende-code column has a narrow default width
// (w-[42rem] 2xl:w-[49.2rem], same as a one-sided/`a`-narrowed diff block) but
// grows — up to a ceiling well short of the full diff-block-column width
// (w-[56rem] 2xl:w-[65rem]) — whenever a listed child's code has a genuinely
// wide body (codeGrowthChars uses the 75th percentile of non-comment line
// lengths, not the single longest line, so one exceptional outlier line
// alone doesn't dictate the width). A long PHPDoc/comment line must NOT
// trigger this growth: comment prose wraps just fine and must never stretch
// the column. See RelatedPanel.mjs (codeGrowthChars/relatedColumnWidthCls)
// and detail-layout.md ("Onderliggende code").
//
// PR 103 (tests/fixtures/growcode-blocks.json + growcode-callresolve.json) has
// two independent caller blocks, each with one embedded resolved-call child:
// GrowLongAction::run -> GrowLongTarget::longTarget (one ~200-char CODE line,
// no comments) and GrowCommentAction::run -> GrowCommentTarget::commentTarget
// (a ~160-char PHPDoc comment line, but only short code).
test.describe('PR Review Tree — Onderliggende code column grows with long code, not long comments', () => {
  test('a long non-comment code line grows the column; a long comment line alone does not', async ({
    page,
  }) => {
    await page.goto('/pr/103')

    const rows = page.getByTestId('block-row')
    await expect(rows).toHaveCount(2)
    const longCaller = rows.filter({ hasText: 'GrowLongAction::run' })
    const commentCaller = rows.filter({ hasText: 'GrowCommentAction::run' })

    const related = page.getByTestId('related-code')
    const item = page.getByTestId('related-item')

    // Baseline: the comment-only caller's card sits at (or very close to) the
    // narrow default — a long comment line must not stretch it.
    await commentCaller.click()
    await expect(item).toContainText('GrowCommentTarget::commentTarget')
    const commentBox = await related.boundingBox()

    // The long-code-line caller's card must be measurably wider — comfortably
    // beyond rounding/sub-pixel noise, well short of asserting an exact px value.
    await longCaller.click()
    await expect(item).toContainText('GrowLongTarget::longTarget')
    const longBox = await related.boundingBox()

    expect(longBox.width).toBeGreaterThan(commentBox.width * 1.15)

    // Never exceeds the documented ceiling (w-[56rem] at this < 2xl viewport
    // = 896px) — some generous slack for rounding, never runaway growth.
    expect(longBox.width).toBeLessThanOrEqual(896 + 4)

    // Switching back to the comment-only caller shrinks the column back down
    // (the width is a live function of the currently focused block's
    // children, not a one-way ratchet).
    await commentCaller.click()
    await expect(item).toContainText('GrowCommentTarget::commentTarget')
    await expect
      .poll(async () => (await related.boundingBox()).width)
      .toBeCloseTo(commentBox.width, 0)
  })
})
