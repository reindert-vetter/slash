import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Regression: a code-preview card stayed selected (cs.previewPos > 0) after a
// click back into the composer, and Shift+Enter in the input then collapsed
// that card instead of inserting a newline.
test('clicking the composer clears the card selection; Shift+Enter never toggles a card', async ({ page }, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: { pr, file: 'd.php', line: 0, author: 'AI check', body: 'vraag met een codeblok', kind: 'ai_warning', source: 'ai', local: true },
  })
  const runId = (await start.json()).runId
  await page.route('**/api/chat*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('commentId') === runId) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'm1', role: 'user', body: 'vraag', createdAt: '2024-01-01T00:00:00Z' },
            { id: 'm2', role: 'assistant', body: 'Voorstel:\n```php\n$a = 1;\n```\nKlaar.', createdAt: '2024-01-01T00:01:00Z' },
          ],
          seenAt: '',
        }),
      })
    }
    if (!url.searchParams.get('commentId') && url.searchParams.get('pr')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversations: [runId] }) })
    }
    return route.continue()
  })
  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  await page.getByTestId('block-row').filter({ hasText: 'vraag met een codeblok' }).first().click()
  const compose = page.getByTestId('claude-chat-compose')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(compose).toBeFocused()
  const card = page.getByTestId('code-preview-card').first()
  await expect(card).toBeVisible()

  await page.keyboard.press('ArrowDown')
  await expect(card).toHaveAttribute('data-active', 'true')
  await compose.click()
  await expect(compose).toBeFocused()
  await expect(card).not.toHaveAttribute('data-active', 'true')

  await page.keyboard.type('a')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('b')
  await expect(compose).toHaveValue('a\nb')
})
