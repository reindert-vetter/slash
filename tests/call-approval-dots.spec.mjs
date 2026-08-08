import { test, expect, evaluateSettled, appReady } from './_fixtures.mjs'

// The per-segment call-approval indicator must sit exactly under the FIRST
// CHARACTER of the segment it belongs to. It used to be a separate monospace
// row below the code line that positioned its dots with literal leading
// spaces plus a `col = start + 1` assumption — i.e. it assumed a dot is
// exactly one character cell wide. It isn't (a 6px dot in a ~6.6px cell), so
// every dot after the first drifted left, and in the wrapping `fit` stand the
// dots row (whitespace-pre) couldn't follow the wrapped code line at all.
//
// The dots now render inside the code line itself, as a ::after marker on the
// segment's own first character, so alignment is structural. This test mounts
// a row with three call segments, one of them approved, and asserts every
// marker's left edge coincides with its own character's left edge.
test('a call-approval dot sits exactly under the first character of its segment', async ({ page }) => {
  await page.goto('/pr/12903')
  await appReady(page)

  const result = await evaluateSettled(page, async () => {
    const { reactive } = await import('/src/vendor/arrow.js')
    const blockMod = await import('/src/Block.mjs')
    const Block = blockMod.default

    // One changed line with three call segments: `$this`, `->planService`,
    // `->canUpgrade(` … — the shape the reviewer reported.
    const line = '        $ok = $this->planService->canUpgrade($contract);'
    const b = reactive({
      category: 'ACTION',
      label: 'Foo::bar',
      status: 'modified',
      file: 'app/Foo.php',
      line: 26,
      name: 'bar',
      class: 'Foo',
      approvedRows: [],
      approvedCalls: [],
      code: {
        old: { start: 26, end: 28, text: 'public function bar(): void {\n}' },
        new: { start: 26, end: 28, text: 'public function bar(): void {\n' + line + '\n}' },
      },
    })

    const rows = blockMod.blockRows(b)
    const rowIdx = rows.findIndex((r) => (r.right || '').includes('canUpgrade'))
    const segs = blockMod.rowCallSegments(rows, rowIdx)
    if (segs.length < 2) return { error: 'expected several call segments, got ' + segs.length }
    // Approve exactly one segment — that is what makes the row "partial" and
    // renders one solid + N open markers.
    b.approvedCalls = [blockMod.callKey(rowIdx, segs[1].start)]

    const host = document.createElement('div')
    document.body.appendChild(host)
    Block(b, {
      approvedRows: () => blockMod.approvedRowSet(b),
      approvedCalls: () => blockMod.approvedCallSet(b),
    })(host)
    await new Promise((r) => setTimeout(r, 60))

    // The new (right) pane holds the changed line.
    const panes = host.querySelectorAll('[data-pane]')
    const pane = panes[panes.length - 1]
    const rowEl = [...pane.querySelectorAll('[data-row]')].find((el) =>
      el.textContent.includes('canUpgrade'),
    )
    if (!rowEl) return { error: 'row not found' }

    // Where does each segment's first non-space character actually start?
    // Measure it with a Range over the row's own text nodes.
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT)
    const nodes = []
    let n
    while ((n = walker.nextNode())) nodes.push(n)
    const charLeft = (idx) => {
      let seen = 0
      for (const node of nodes) {
        const len = node.data.length
        if (idx < seen + len) {
          const range = document.createRange()
          range.setStart(node, idx - seen)
          range.setEnd(node, idx - seen + 1)
          return range.getBoundingClientRect().left
        }
        seen += len
      }
      return null
    }

    const text = rowEl.textContent
    const marks = [...rowEl.querySelectorAll('[data-seg-dot]')]
    const out = []
    for (const m of marks) {
      const start = Number(m.getAttribute('data-seg-dot'))
      // The marker sits on the segment's first non-space character.
      let ci = start
      while (ci < text.length && /\s/.test(text[ci])) ci++
      const dot = m.getBoundingClientRect()
      // The dot itself is a ::after pseudo-element pinned to left:0 of that
      // character's span — read it back so this also proves Tailwind's runtime
      // (Play CDN) actually generated the arbitrary-value utilities for the
      // markers, i.e. that a dot is really painted.
      const after = getComputedStyle(m, '::after')
      out.push({
        start,
        delta: Math.abs(dot.left - charLeft(ci)),
        width: after.width,
        position: after.position,
        left: after.left,
      })
    }
    return { count: marks.length, out }
  })

  expect(result.error).toBeUndefined()
  expect(result.count).toBeGreaterThanOrEqual(2)
  for (const m of result.out) {
    expect(m.delta, `segment at char ${m.start} is off by ${m.delta}px`).toBeLessThan(1.5)
    expect(m.position).toBe('absolute')
    expect(m.left).toBe('0px')
    expect(m.width).toBe('6px')
  }
})
