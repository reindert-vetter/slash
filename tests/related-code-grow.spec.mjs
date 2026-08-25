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
// Below the `narrow` breakpoint (< 1400px, see index.html's tailwind.config)
// the floor/ceiling are smaller still (w-[40rem]/w-[48rem]) — the suite's
// default 1280px viewport is itself below that breakpoint, so this test
// (like most of the suite) exercises the narrow ceiling, not the wider one.
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

    // Never exceeds the documented ceiling — at the suite's default 1280px
    // viewport (< the `narrow` breakpoint, 1400px, see index.html's
    // tailwind.config) that's w-[48rem] = 768px, not the wider w-[56rem]
    // (896px) that applies at >= 1400px — some generous slack for rounding,
    // never runaway growth.
    expect(longBox.width).toBeLessThanOrEqual(768 + 4)

    // Switching back to the comment-only caller shrinks the column back down
    // (the width is a live function of the currently focused block's
    // children, not a one-way ratchet).
    await commentCaller.click()
    await expect(item).toContainText('GrowCommentTarget::commentTarget')
    await expect
      .poll(async () => (await related.boundingBox()).width)
      .toBeCloseTo(commentBox.width, 0)
  })

  // An Onderliggende-code column with genuinely nothing in it used to reserve
  // the full clamp FLOOR (42rem/49.2rem, 40rem below the narrow breakpoint)
  // for the single sentence "Geen onderliggende code." — measured on a live PR
  // at a 2000px viewport: 787px of dead column next to a 1429px diff card in a
  // 1952px <main>, so focusing the panel (?rel.foc=code) scrolled <main> to its
  // maximum and cut 240px off the diff card's LEFT edge, which (most lines
  // being short) read as a tall, almost entirely empty card whose title
  // started mid-word. RELATED_EMPTY_WIDTH_CLS (RelatedPanel.mjs) gives that
  // case a flat narrow width instead; see "An empty column is narrow" in
  // .claude/docs/underlying-code.md.
  test('an empty column drops below the narrow floor instead of reserving it', async ({ page }) => {
    // PR 12903's ContractController::index in diff mode: no relations, no
    // resolved calls, no covers rows (see materializeMainWorktrees/
    // relations.json in _setup.mjs — CreatePaymentAction::execute is the one
    // that carries the GroupScopeChildA/B relation children, so it must be
    // avoided here) — and no comments either, so the comment/Claude row
    // above this column is hidden. That second half is the GATE (the
    // documented comment + connector + Claude === related invariant may not
    // break): tests/comment-claude-column-widths.spec.mjs covers the other
    // side of it, a visible row with the ordinary clamp width still summing
    // exactly.
    await page.goto('/pr/12903?sel=app%2FHttp%2FControllers%2FApi%2FContractController.php%3A30&mode=diff&chg=0')

    const related = page.getByTestId('related-code')
    await expect(related).toContainText('Geen onderliggende code.')
    await expect(page.getByTestId('related-item')).toHaveCount(0)
    await expect(page.getByTestId('claude-chat-column')).toBeHidden()

    await expect(related).toHaveClass(/w-\[18rem\]/)
    const box = await related.boundingBox()
    // Comfortably under the 40rem (640px) narrow-breakpoint floor it used to
    // sit on at this viewport — a relative bound, not an exact px assertion.
    expect(box.width).toBeLessThan(640 * 0.6)
  })
})
