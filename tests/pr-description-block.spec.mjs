import { test, expect } from './_fixtures.mjs'

// The "PR-titel & omschrijving" index block (prDescriptionBlock, home.mjs):
// the PR's own title + body as a block with inline code, first in the index,
// approvable line by line like code, and — after the author edits the
// description — reset per line (only the changed line loses its approval).

function mockMeta(page, body) {
  return page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pr: 12903,
        title: 'Rework checkout flow',
        url: 'https://github.com/x/y/pull/12903',
        body,
        reviewDecision: 'APPROVED',
        reviewers: [],
        checksTotal: 1,
        checksPassed: 1,
      }),
    }),
  )
}

async function descApproval(page) {
  return page.evaluate(async () => {
    const rows = await (await fetch('/api/approvals?pr=12903')).json()
    const a = (rows || []).find((r) => r.blockId === 'prdesc:12903')
    return a ? a.rows : null
  })
}

test('the PR description is the first index block, approvable per line, reset per changed line', async ({ page }) => {
  await mockMeta(page, 'First line.\r\nSecond line.')
  await page.goto('/pr/12903?sel=PR-description:1')
  const first = page.getByTestId('block-row').first()
  await expect(first).toContainText('PR-titel & omschrijving')

  // Rows: 0 title, 1 blank, 2 "First line.", 3 "Second line." — the group
  // at gran=group covers all of them; approve it from the diff.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Space')
  await expect.poll(() => descApproval(page)).toEqual([0, 2, 3])

  // The author rewrites the second line on GitHub: after a reload only that
  // line goes back to unapproved.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await mockMeta(page, 'First line.\nSecond line, edited.')
  await page.reload()
  await expect(page.getByTestId('block-row').first()).toContainText('PR-titel & omschrijving')
  await expect.poll(() => descApproval(page)).toEqual([0, 2])
})
