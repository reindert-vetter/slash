import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// A blank changed row counts as approved when the nearest non-blank changed
// row before OR after it is approved (derived in Block.mjs approvedRowSet,
// never persisted). See "Blank rows follow their neighbour" in approval.md.
test('blank rows follow an approved neighbour, derived at read time', async ({ page }) => {
  await page.goto('/pr/12903')
  await appReady(page)
  const r = await evaluateSettled(page, async () => {
    const { approvedRowSet, changedRows, blockRows, blockApproved } = await import('/src/Block.mjs')
    const mk = (text, approved) => ({
      code: { old: { text: '' }, new: { text } },
      approvedRows: approved,
    })
    // rows: 0 "<?php", 1 blank, 2 "use A;", 3 blank, 4 "use B;"
    const text = '<?php\n\nuse A;\n\nuse B;'
    const b = mk(text, [0])
    const n = blockRows(b).length
    return {
      n,
      onlyFirst: [...approvedRowSet(b)].sort(),
      nextApproved: [...approvedRowSet(mk(text, [4]))].sort(),
      noneApproved: [...approvedRowSet(mk(text, []))].sort(),
      storedBlankIgnored: [...approvedRowSet(mk(text, [1]))].sort(),
      all: blockApproved(mk(text, [0, 2, 4])),
      blankOnly: [...approvedRowSet(mk('\n\n', [0]))].sort(),
      changed: changedRows(blockRows(b)).length,
    }
  })
  expect(r.n).toBe(5)
  expect(r.onlyFirst).toEqual([0, 1])
  expect(r.nextApproved).toEqual([3, 4])
  expect(r.noneApproved).toEqual([])
  expect(r.storedBlankIgnored).toEqual([])
  expect(r.all).toBe(true)
  expect(r.changed).toBe(5)
})
