import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// changeGroups starts a new group at a docblock/attribute/function/class line.
test('changeGroups breaks on docblock, function and class starts', async ({ page }) => {
  await page.goto('/pr/12903')
  await appReady(page)
  const r = await evaluateSettled(page, async () => {
    const { changeGroups } = await import('/src/Block.mjs')
    const rows = (lines) =>
      lines.map((t) => ({ left: null, right: t, leftMark: null, rightMark: 'ins' }))
    return {
      doc: changeGroups(rows(['use A;', 'use B;', '/**', ' * x', ' */', 'function f() {'])),
      fn: changeGroups(rows(['$a = 1;', 'private static function g() {', '$b = 2;'])),
      cls: changeGroups(rows(['use A;', 'final class C {'])),
      slash: changeGroups(rows(['$a = 1;', '// note', '$b = 2;'])),
      attr: changeGroups(rows(['$a;', '#[Attr]', 'public function h() {'])),
    }
  })
  expect(r.doc).toEqual([{ start: 0, end: 1 }, { start: 2, end: 5 }])
  expect(r.fn).toEqual([{ start: 0, end: 0 }, { start: 1, end: 2 }])
  expect(r.cls).toEqual([{ start: 0, end: 0 }, { start: 1, end: 1 }])
  expect(r.slash).toEqual([{ start: 0, end: 2 }])
  expect(r.attr).toEqual([{ start: 0, end: 0 }, { start: 1, end: 2 }])
})
