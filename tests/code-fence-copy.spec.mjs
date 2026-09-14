import { test, expect, seededPr } from './_fixtures.mjs'

// A "Kopieer" button in the slim header bar of every fenced code block that
// comes from a check/comment — reviewer request: "maak een copy knop in alle
// codeblok dingen die uit een check of comment komt... rechts in dit
// balkje". Two render points, one shared mechanism (src/codeCopy.mjs):
//   - markdown.mjs's inline fence header (raw HTML, event-delegated click —
//     see initMarkdownCodeCopy).
//   - CodePreview.mjs's own full-size preview-card header (a real arrow.js
//     @click).
// Same mockClipboard shape as tests/copy-line-menu.spec.mjs/
// claude-chat-copy-bubble.spec.mjs.
test.use({ viewport: { width: 2000, height: 1100 } })

async function mockClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => {
          window.__copied = t
          return Promise.resolve()
        },
        readText: () => Promise.resolve(window.__copied),
      },
    })
  })
}

test('the inline fence header copy button copies the fence code and flashes "Gekopieerd!"', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockClipboard(page)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier:\n```sql\nSELECT * FROM users WHERE id = 1;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  const fence = page.getByTestId('code-fence').first()
  await expect(fence).toBeVisible()
  const copyBtn = fence.getByTestId('code-fence-copy')
  await expect(copyBtn).toHaveText('Kopieer')

  await copyBtn.click()
  const copied = await page.evaluate(() => window.__copied)
  expect(copied).toBe('SELECT * FROM users WHERE id = 1;')
  await expect(copyBtn).toHaveText('Gekopieerd!')

  // Clicking the button must not also select the underlying comment row
  // (stopPropagation) — the composer for that comment should not have
  // received keyboard focus as a side effect of the click.
  await expect(page.getByTestId('reaction-compose')).not.toBeFocused()
})

test('the full-size preview card header copy button copies the same fence code', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  await mockClipboard(page)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kijk hier:\n```sql\nSELECT * FROM users WHERE id = 1;\n```',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click()

  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toBeVisible()
  const copyBtn = card.getByTestId('code-preview-copy')
  await expect(copyBtn).toHaveText('Kopieer')

  await copyBtn.click()
  const copied = await page.evaluate(() => window.__copied)
  expect(copied).toBe('SELECT * FROM users WHERE id = 1;')
  await expect(copyBtn).toHaveText('Gekopieerd!')
})
