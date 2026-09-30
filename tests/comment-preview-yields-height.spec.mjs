import { test, expect, leaveSearchBox } from './_fixtures.mjs'

// The look-ahead preview under the selected diff can be a comment-index item
// (the next ↓ stop, see "The look-ahead preview follows the next VISIBLE
// row"). Such a comment-detail-card used to be shrink-0, so a long thread kept
// its full height and squeezed the diff card above it down to its min-h floor.
// Reviewer report: "soms staat comment onder de diff, dan drukt het zo dat de
// diff met code minder hoog is, laat het dan niet beperkt worden door de blok
// eronder". Now the preview yields (min-h-0, clipped): the diff card keeps its
// natural height whenever the column has room for it.
test('a long comment previewed under the diff does not squeeze the diff card', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 })
  const now = new Date().toISOString()
  const longBody = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a very long review comment`).join('\n\n')
  await page.route('**/api/comments?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'long-1',
          runId: 'run-long-1',
          pr: 12903,
          file: 'app/Http/Controllers/Api/ContractController.php',
          label: 'ContractController::index',
          line: 30,
          author: 'reviewer',
          body: longBody,
          createdAt: now,
          reactionCount: 0,
          status: 'open',
          source: 'ui',
          kind: '',
          reactions: [],
          rowStart: -1,
          rowEnd: -1,
        },
      ]),
    }),
  )
  await page.goto('/pr/12903')
  await leaveSearchBox(page)

  // Select the visible index row directly before the comment item, so the
  // comment is the look-ahead preview.
  const rows = page.locator('[data-idx]')
  const commentRow = rows.filter({ hasText: 'line 1 of a very long review comment' })
  await expect(commentRow).toHaveCount(1)
  const pos = await rows.evaluateAll(
    (els) => els.findIndex((el) => el.textContent.includes('line 1 of a very long review comment')),
  )
  expect(pos).toBeGreaterThan(0)
  await rows.nth(pos - 1).click()

  const column = page.getByTestId('block-column')
  const preview = column.getByTestId('comment-detail-card')
  await expect(preview).toBeVisible()

  // The selected diff card's code pane shows every row: it has no internal
  // scroll left, i.e. the column's height shortfall went to the preview.
  const article = column.locator('[data-testid=detail-card]').first().locator('article').first()
  const pane = article.locator('[data-scrollsync]').first()
  await expect(pane).toBeVisible()
  await expect.poll(() => pane.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  // …while the long preview is the one that got clipped.
  expect(await preview.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0)
})
