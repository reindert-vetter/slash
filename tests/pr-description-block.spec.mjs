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

test('the PR description renders markdown tokens and always wraps, even outside the fit stand', async ({ page }) => {
  const longLine =
    'This is a very long single line that should wrap instead of running off the right edge of the card when using the default split view mode, since it is well past eighty characters.'
  await mockMeta(page, '## Problem\n' + longLine)
  await page.goto('/pr/12903?sel=PR-description:1')
  await page.keyboard.press('ArrowRight')

  const codeDiff = page.getByTestId('code-diff').first()
  // Rows: 0 title, 1 blank, 2 "## Problem", 3 the long line.
  const headingRow = codeDiff.locator('[data-row="2"]')
  const longRow = codeDiff.locator('[data-row="3"]')

  // Markdown highlighting: `## Problem` gets a real Prism token (the
  // 'markdown' grammar's heading alias), not escaped plain text — before the
  // markdown grammar was vendored, highlightForLang fell back to escapeHtml
  // and no `.token` span existed at all here.
  await expect(headingRow.locator('.token')).not.toHaveCount(0)

  // Always wraps: even in the default 'split' stand (no `a`/'fit' toggle),
  // the row carries `whitespace-pre-wrap`, not the plain `whitespace-pre`
  // every other stand used to leave it in.
  await expect(longRow).toHaveClass(/whitespace-pre-wrap/)
})

// Inline edit of the description: "Opslaan" writes the new title/body straight
// to GitHub through POST /api/workflows/pr_description_edit (no Claude chat).
test('editing the PR description inline posts the new title and body', async ({ page }) => {
  const longLine =
    'A long description line that is far wider than the editor pane, so the transparent textarea and the highlighted pre behind it must both wrap it the same way.'
  let meta = 'First line.\r\n' + longLine
  await page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pr: 12903, title: 'Rework checkout flow', url: '', body: meta, reviewers: [] }),
    }),
  )
  const posted = []
  await page.route('**/api/workflows/pr_description_edit', (route) => {
    const req = JSON.parse(route.request().postData() || '{}')
    posted.push(req)
    meta = req.body
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"runId":"r1"}' })
  })
  await page.goto('/pr/12903?sel=PR-description:1')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('e')
  const ta = page.getByTestId('inline-edit-textarea')
  await expect(ta).toBeVisible()
  await expect(ta).toHaveValue('Rework checkout flow\n\nFirst line.\n' + longLine)

  // The overlay and the textarea wrap the long line identically: same height.
  const heights = await page.evaluate(() => {
    const t = document.querySelector('[data-testid=inline-edit-textarea]')
    const p = document.querySelector('[data-testid=inline-edit-highlight]')
    return { ta: t.scrollHeight, pre: p.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(t).lineHeight) }
  })
  expect(Math.abs(heights.ta - heights.pre)).toBeLessThan(heights.lh / 2)
  expect(heights.pre).toBeGreaterThan(heights.lh * 5.5) // 4 lines + padding: the long line really wraps

  await ta.fill('Rework checkout flow, v2\n\nFirst line, edited.\n' + longLine)
  await page.keyboard.press('Meta+Enter')
  await expect.poll(() => posted.length).toBe(1)
  expect(posted[0]).toMatchObject({
    pr: 12903,
    title: 'Rework checkout flow, v2',
    body: 'First line, edited.\n' + longLine,
    baseTitle: 'Rework checkout flow',
    baseBody: 'First line.\r\n' + longLine,
  })
  await expect(ta).toHaveCount(0)
})

test('a PR description edit refused by the backend keeps the draft and shows why', async ({ page }) => {
  await mockMeta(page, 'First line.')
  await page.route('**/api/workflows/pr_description_edit', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'intussen gewijzigd' }) }),
  )
  await page.goto('/pr/12903?sel=PR-description:1')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('e')
  const ta = page.getByTestId('inline-edit-textarea')
  await ta.fill('Rework checkout flow\n\nMy edit.')
  await page.getByTestId('inline-edit-save').click()
  await expect(page.getByTestId('inline-edit-error')).toContainText('intussen gewijzigd')
  await expect(page.getByTestId('inline-edit-textarea')).toHaveValue('Rework checkout flow\n\nMy edit.')
})
