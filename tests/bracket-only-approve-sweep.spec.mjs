import { test, expect } from './_fixtures.mjs'

// Approving a line/group also sweeps in a directly-FOLLOWING bracket/
// punctuation-only row (a lone `});`/`},`/etc.) so the reviewer doesn't have
// to approve it separately — see isBracketOnlyRow/sweepBracketOnlyForward
// (Block.mjs) and toggleApprove (home.mjs), plus the design notes in
// .claude/rules/blocks-and-ingest.md. These are pure functions, so — mirroring
// the changeGroups tests in navigate.spec.mjs — we import the already-loaded
// page module and call them directly with synthetic row data.
test.describe('PR Review Tree — bracket-only row auto-approve sweep', () => {
  test('isBracketOnlyRow matches only closing-punctuation-only changed rows', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const results = await page.evaluate(async () => {
      const { isBracketOnlyRow } = await import('/src/Block.mjs')
      const changed = (right, left = null) => ({
        left,
        right,
        leftMark: left != null ? 'del' : null,
        rightMark: right != null ? 'ins' : null,
      })
      const unchanged = (text) => ({ left: text, right: text, leftMark: null, rightMark: null })
      return {
        // Every allowed character, and a combination of them.
        closeParen: isBracketOnlyRow(changed(')')),
        closeBrace: isBracketOnlyRow(changed('}')),
        semicolon: isBracketOnlyRow(changed(';')),
        comma: isBracketOnlyRow(changed(',')),
        closeBracket: isBracketOnlyRow(changed(']')),
        openBrace: isBracketOnlyRow(changed('{')),
        combo: isBracketOnlyRow(changed('});')),
        comboWithWhitespace: isBracketOnlyRow(changed('    },')),
        // A pure deletion (no replacement) reads its OLD side, same
        // side-selection as rowHasContent.
        pureDeletionBracketOnly: isBracketOnlyRow(changed(null, '}')),
        // Real content — even mixed with punctuation — never matches.
        realCode: isBracketOnlyRow(changed('return $foo->bar();')),
        mixedWithLetter: isBracketOnlyRow(changed('}); // done')),
        // Not a changed row at all.
        unchangedRow: isBracketOnlyRow(unchanged('}')),
        // Blank/whitespace-only changed row (already excluded elsewhere).
        blankRow: isBracketOnlyRow(changed('   ')),
      }
    })
    expect(results).toEqual({
      closeParen: true,
      closeBrace: true,
      semicolon: true,
      comma: true,
      closeBracket: true,
      openBrace: true,
      combo: true,
      comboWithWhitespace: true,
      pureDeletionBracketOnly: true,
      realCode: false,
      mixedWithLetter: false,
      unchangedRow: false,
      blankRow: false,
    })
  })

  test('sweepBracketOnlyForward chains forward through bracket-only rows and stops at real content', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await page.waitForLoadState('networkidle')
    const results = await page.evaluate(async () => {
      const { sweepBracketOnlyForward } = await import('/src/Block.mjs')
      const changed = (right) => ({ left: null, right, leftMark: null, rightMark: 'ins' })
      const unchanged = (text) => ({ left: text, right: text, leftMark: null, rightMark: null })

      // Row 0: real content just approved. Rows 1-2: bracket-only closers.
      // Row 3: real content again (must NOT be swept in).
      const rows = [
        changed('foo();'),
        changed('});'),
        changed('},'),
        changed('bar();'),
      ]
      const forward = sweepBracketOnlyForward(rows, [0])

      // Backward: a bracket-only row BEFORE the approved unit is never swept
      // (forward-only, deliberate scope).
      const rowsBefore = [changed('});'), changed('bar();')]
      const noBackwardSweep = sweepBracketOnlyForward(rowsBefore, [1])

      // A gap (unchanged row) breaks the chain, same as changeGroups' run
      // boundary.
      const rowsWithGap = [changed('foo();'), unchanged('}'), changed('});')]
      const stopsAtUnchangedGap = sweepBracketOnlyForward(rowsWithGap, [0])

      // Empty target is returned unchanged.
      const emptyTarget = sweepBracketOnlyForward(rows, [])

      return { forward, noBackwardSweep, stopsAtUnchangedGap, emptyTarget }
    })

    expect(results.forward).toEqual([0, 1, 2])
    expect(results.noBackwardSweep).toEqual([1])
    expect(results.stopsAtUnchangedGap).toEqual([0])
    expect(results.emptyTarget).toEqual([])
  })
})
