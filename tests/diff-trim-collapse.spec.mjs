import { test, expect, evaluateSettled, leaveSearchBox, appReady } from './_fixtures.mjs'

// Performance work for huge whole-file blocks (a multi-thousand-line locale
// JSON, PR 13166's nl.json): (1) diffLines trims the common prefix/suffix
// before its O(n·m) LCS table — this suite pins the trimmed diff's OUTPUT
// (alignment must be indistinguishable from the untrimmed one, including the
// whitespace-insensitive re-indent pairing the trim must not break); and
// (2) blocks over COLLAPSE_MIN_ROWS (300) collapse long unchanged runs into
// one clickable "⋯ N ongewijzigde regels" spacer per run (collapsePlan /
// collapsedRunHTML in Block.mjs), while smaller blocks render every row
// exactly as before. See detail-layout/blocks-and-ingest context in the
// Block.mjs doc comments.
test.describe('diff trim + context collapsing for huge blocks', () => {
  test('diffLines trim keeps the alignment intact (via blockRows)', async ({ page }) => {
    await page.goto('/pr/12903')
    await appReady(page)
    const res = await evaluateSettled(page, async () => {
      const { blockRows } = await import('/src/Block.mjs')
      // A large common prefix + suffix around one replaced line and one added
      // line — the shape the trim optimises. One prefix line is re-indented in
      // new (whitespace-only): the trim compares whitespace-insensitively, so
      // it must still pair as an aligned (wsOnly) row, never drift into the
      // del/ins block in the middle.
      const pre = Array.from({ length: 150 }, (_, i) => `"key${i}": "value ${i}",`)
      const suf = Array.from({ length: 150 }, (_, i) => `"tail${i}": "value ${i}",`)
      const oldMid = ['"changed": "oud",']
      const newMid = ['"changed": "nieuw",', '"toegevoegd": "regel",']
      const preNew = [...pre]
      preNew[10] = '  ' + preNew[10] // re-indent only
      const b = {
        code: {
          old: { start: 1, text: [...pre, ...oldMid, ...suf].join('\n') },
          new: { start: 1, text: [...preNew, ...newMid, ...suf].join('\n') },
        },
      }
      const rows = blockRows(b)
      return {
        total: rows.length,
        reindent: rows[10],
        changed: rows
          .map((r, i) => ({ i, l: r.leftMark, r: r.rightMark, left: r.left, right: r.right }))
          .filter((x) => (x.l || x.r) && x.i !== 10),
      }
    })
    // 150 prefix + 1 paired change + 1 pure insert + 150 suffix = 302 rows.
    expect(res.total).toBe(302)
    // The re-indented prefix line stays a paired (whitespace-only) row.
    expect(res.reindent.leftMark).toBe('del')
    expect(res.reindent.rightMark).toBe('ins')
    expect(res.reindent.right).toBe('  "key10": "value 10",')
    // Exactly the replaced pair + the added line, at rows 150/151.
    expect(res.changed).toEqual([
      { i: 150, l: 'del', r: 'ins', left: '"changed": "oud",', right: '"changed": "nieuw",' },
      { i: 151, l: null, r: 'ins', left: null, right: '"toegevoegd": "regel",' },
    ])
  })

  test('a huge block collapses unchanged runs into clickable spacers; a small block does not', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await appReady(page)
    await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const line = (i) => `"key${i}": "value ${i}",`
      const mkText = (n, edit) =>
        Array.from({ length: n }, (_, i) => (edit && i === 200 ? `"key${i}": "ANDERS",` : line(i))).join('\n')
      // 400 rows, one changed line at row 200 → collapses (> COLLAPSE_MIN_ROWS).
      const big = reactive({
        category: 'OTHER',
        label: 'nl.json',
        status: 'modified',
        file: 'resources/locales/nl.json',
        line: 1,
        approved: false,
        code: {
          old: { start: 1, text: mkText(400, false) },
          new: { start: 1, text: mkText(400, true) },
        },
      })
      // 100 rows, same single change → renders fully (<= COLLAPSE_MIN_ROWS).
      const small = reactive({
        ...JSON.parse(JSON.stringify(big)),
        code: {
          old: { start: 1, text: mkText(100, false).replace('"key20"', '"kez20"') },
          new: { start: 1, text: mkText(100, false) },
        },
      })
      const hostBig = document.createElement('div')
      hostBig.id = 'collapse-host-big'
      document.body.appendChild(hostBig)
      Block(big, { activeGroup: () => null })(hostBig)
      const hostSmall = document.createElement('div')
      hostSmall.id = 'collapse-host-small'
      document.body.appendChild(hostSmall)
      Block(small, { activeGroup: () => null })(hostSmall)
    })

    const big = page.locator('#collapse-host-big')
    const small = page.locator('#collapse-host-small')

    // The big block: two runs (before/after the change) × two panes = 4
    // spacers (the spacer itself is shared between both panes regardless of
    // which one is the canonical/metadata-carrying side); only the changed
    // row + COLLAPSE_CONTEXT (3) rows around it render (7 rows). Only the
    // new/right pane carries `data-row` (see "Only the new/right pane drives
    // selection" in diff-render.md) — the old/left pane is display-only, so
    // this counts ONE pane's worth of rows, not two.
    await expect(big.locator('[data-testid=collapsed-run]')).toHaveCount(4)
    await expect(big.locator('[data-row]')).toHaveCount(7)
    // The spacer names the hidden row count in words (colorblind rule: the
    // text carries the meaning) — first run hides rows 0..196 (197 rows).
    await expect(big.locator('[data-testid=collapsed-run]').first()).toHaveText(
      '⋯ 197 ongewijzigde regels',
    )
    // The changed row itself is rendered and still carries its aligned index
    // — once, on the new/right pane only.
    await expect(big.locator('[data-row="200"]')).toHaveCount(1)

    // The small block renders every row, no spacer — behaviour unchanged.
    await expect(small.locator('[data-testid=collapsed-run]')).toHaveCount(0)
    await expect(small.locator('[data-row]')).toHaveCount(100)

    // Clicking a spacer expands that run in place: the first run's rows come
    // back (in BOTH panes — the plan is shared, so they stay aligned), the
    // other run stays collapsed.
    await big.locator('[data-testid=collapsed-run]').first().click()
    await expect(big.locator('[data-testid=collapsed-run]')).toHaveCount(2)
    await expect(big.locator('[data-row="0"]')).toHaveCount(1)
    await expect(big.locator('[data-row]')).toHaveCount(7 + 197)
  })
})
