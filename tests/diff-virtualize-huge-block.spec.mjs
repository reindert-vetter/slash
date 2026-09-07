import { test, expect, evaluateSettled, leaveSearchBox, appReady } from './_fixtures.mjs'

// Virtualizing a huge, mostly-CHANGED block (a schema-dump-shaped file: no
// long unchanged runs, so the existing collapsePlan/collapsedRunHTML measure
// — see diff-trim-collapse.spec.mjs — cannot help at all). See "A SINGLE huge
// block" in .claude/docs/frontend-memory.md for the measured before/after
// this fixes, and "Virtualizing a huge, mostly-changed block" in Block.mjs
// for the mechanism (computeWindow/virtualizedSegs/virtualSpacerHTML).
test.describe('virtualizing a huge, mostly-changed block', () => {
  test('only a row window around the cursor is real DOM; a small block is unaffected', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await appReady(page)
    const res = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const { blockRows } = await import('/src/Block.mjs')
      // 1000 lines, every single one replaced by a DIFFERENT line (disjoint
      // old/new content — no line in `new` matches any line in `old`) so the
      // LCS diff has nothing to align as "unchanged": collapsePlan finds no
      // run of >=10 kept-as-is rows anywhere and returns null, exactly the
      // "mostly changed" shape collapsePlan's own doc comment says it can't
      // help — the case this round targets.
      const n = 1000
      const oldText = Array.from({ length: n }, (_, i) => `oldline_${i}_padding_to_avoid_accidental_matches`).join('\n')
      const newText = Array.from({ length: n }, (_, i) => `newline_${i}_padding_to_avoid_accidental_matches`).join('\n')
      const mk = () =>
        reactive({
          category: 'OTHER',
          label: 'schema.sql',
          status: 'modified',
          file: 'database/schema/mysql-schema.sql',
          line: 1,
          approved: false,
          code: { old: { start: 1, text: oldText }, new: { start: 1, text: newText } },
        })

      const bEnd = mk()
      const rowsEnd = blockRows(bEnd)
      // Put the cursor on the very LAST row — the start of the file should
      // then fall well outside the rendered window.
      const lastRow = rowsEnd.length - 1
      const hostEnd = document.createElement('div')
      hostEnd.id = 'virt-host-end'
      document.body.appendChild(hostEnd)
      Block(bEnd, { activeGroup: () => ({ start: lastRow, end: lastRow }) })(hostEnd)

      const bStart = mk()
      const hostStart = document.createElement('div')
      hostStart.id = 'virt-host-start'
      document.body.appendChild(hostStart)
      Block(bStart, { activeGroup: () => ({ start: 0, end: 0 }) })(hostStart)

      // A small (well under the virtualization threshold) block, otherwise
      // shaped the same way — must render byte-identically to before: every
      // row present, no spacer at all.
      const smallOld = Array.from({ length: 50 }, (_, i) => `oldline_${i}`).join('\n')
      const smallNew = Array.from({ length: 50 }, (_, i) => `newline_${i}`).join('\n')
      const bSmall = reactive({
        ...JSON.parse(JSON.stringify(bEnd)),
        code: { old: { start: 1, text: smallOld }, new: { start: 1, text: smallNew } },
      })
      const hostSmall = document.createElement('div')
      hostSmall.id = 'virt-host-small'
      document.body.appendChild(hostSmall)
      Block(bSmall, { activeGroup: () => ({ start: 0, end: 0 }) })(hostSmall)

      return { rowsLength: rowsEnd.length, lastRow, smallRowsLength: blockRows(bSmall).length }
    })

    expect(res.rowsLength).toBeGreaterThan(400) // actually virtualized
    const end = page.locator('#virt-host-end')
    const start = page.locator('#virt-host-start')
    const small = page.locator('#virt-host-small')

    // Cursor at the LAST row: row 0 (the very start of the file) must not
    // exist in the DOM at all, but the cursor's own row must — the reviewer
    // is always standing on real content, never on a spacer.
    await expect(end.locator(`[data-row="${res.lastRow}"]`)).toHaveCount(1)
    await expect(end.locator('[data-row="0"]')).toHaveCount(0)
    // Far fewer rows are real DOM than the block actually has.
    const endRowCount = await end.locator('[data-row]').count()
    expect(endRowCount).toBeGreaterThan(0)
    expect(endRowCount).toBeLessThan(res.rowsLength / 2)
    // A "before" spacer stands in for the skipped rows above the window —
    // one per pane (old/left + new/right), both carrying the SAME hidden
    // count so the two panes stay the same total height.
    const beforeSpacers = end.locator('[data-virtualized-spacer="before"]')
    await expect(beforeSpacers).toHaveCount(2)
    const beforeCounts = await beforeSpacers.evaluateAll((els) => els.map((e) => e.getAttribute('data-virtualized-count')))
    expect(new Set(beforeCounts).size).toBe(1) // both panes agree
    expect(Number(beforeCounts[0])).toBeGreaterThan(0)
    // Standing at the very last row, there's nothing left to skip AFTER it.
    await expect(end.locator('[data-virtualized-spacer="after"]')).toHaveCount(0)

    // Cursor at row 0: mirror image — the last row is out of the DOM, row 0
    // is in it, and only an "after" spacer exists.
    await expect(start.locator('[data-row="0"]')).toHaveCount(1)
    await expect(start.locator(`[data-row="${res.lastRow}"]`)).toHaveCount(0)
    await expect(start.locator('[data-virtualized-spacer="before"]')).toHaveCount(0)
    await expect(start.locator('[data-virtualized-spacer="after"]')).toHaveCount(2)

    // The small block is completely unaffected: every row renders, no spacer.
    await expect(small.locator('[data-virtualized-spacer]')).toHaveCount(0)
    await expect(small.locator('[data-row]')).toHaveCount(res.smallRowsLength)
  })

  test('a row outside the window still counts toward approve state (data model, not DOM)', async ({
    page,
  }) => {
    await page.goto('/pr/12903')
    await leaveSearchBox(page)
    await appReady(page)
    const res = await evaluateSettled(page, async () => {
      const { reactive } = await import('/src/vendor/arrow.js')
      const Block = (await import('/src/Block.mjs')).default
      const { blockRows, changedRows, approvedRowSet } = await import('/src/Block.mjs')
      const n = 1000
      const oldText = Array.from({ length: n }, (_, i) => `oldline_${i}_padding_to_avoid_accidental_matches`).join('\n')
      const newText = Array.from({ length: n }, (_, i) => `newline_${i}_padding_to_avoid_accidental_matches`).join('\n')
      // Approve every changed row up front (approvedRows keyed on row index)
      // — including plenty that will fall outside the rendered window once
      // the cursor sits at row 0.
      const rowsForApproval = blockRows(reactive({ code: { old: { start: 1, text: oldText }, new: { start: 1, text: newText } } }))
      const allChanged = changedRows(rowsForApproval)
      const b = reactive({
        category: 'OTHER',
        label: 'schema.sql',
        status: 'modified',
        file: 'database/schema/mysql-schema.sql',
        line: 1,
        approved: false,
        approvedRows: allChanged.slice(),
        code: { old: { start: 1, text: oldText }, new: { start: 1, text: newText } },
      })
      const host = document.createElement('div')
      host.id = 'virt-host-approved'
      document.body.appendChild(host)
      Block(b, { activeGroup: () => ({ start: 0, end: 0 }) })(host)
      const rows = blockRows(b)
      return {
        totalChanged: allChanged.length,
        totalRows: rows.length,
        approvedCount: approvedRowSet(b).size,
        // A row deep past the window (cursor sits at row 0) that's still
        // marked approved in the data model.
        farApprovedRow: allChanged[allChanged.length - 1],
      }
    })
    expect(res.approvedCount).toBe(res.totalChanged) // every changed row counted, none dropped
    const host = page.locator('#virt-host-approved')
    // The far row is outside the rendered window — no DOM, no checkmark to
    // find — but the approval COUNT above already proves it's still counted.
    await expect(host.locator(`[data-row="${res.farApprovedRow}"]`)).toHaveCount(0)
  })
})
