import { test, expect, seededPr } from './_fixtures.mjs'

// TODO 3 in todo-claude-chat-blok.md: the comment block (InlineComments,
// commentColumnWidthCls()) and the Claude block (ClaudeChatPanel,
// claudeColumnWidthCls()) sit side by side, connected by the same dashed
// connector the Onderliggende-code children use between each other
// (comment-claude-connector, built in TODO 2). Together — comment column +
// connector + Claude column — they are exactly as wide as the
// Onderliggende-code card underneath (related-code, relatedColumnWidthCls()),
// so the whole stack lines up vertically; see relatedWidthCls's doc comment
// in RelatedPanel.mjs for why that holds exactly, not just approximately.
test('comment block (2/3) and Claude block (1/3) sit beside each other and line up with Onderliggende code', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'even kijken hiernaar',
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

  const comments = page.getByTestId('inline-comments')
  const connector = page.getByTestId('comment-claude-connector')
  const claude = page.getByTestId('claude-chat-column')
  const related = page.getByTestId('related-code')
  await expect(comments).toBeVisible()
  await expect(connector).toBeVisible()
  await expect(claude).toBeVisible()
  await expect(related).toBeVisible()

  const commentsBox = await comments.boundingBox()
  const connectorBox = await connector.boundingBox()
  const claudeBox = await claude.boundingBox()
  const relatedBox = await related.boundingBox()

  // The comment block is roughly twice as wide as the Claude block (2/3 vs
  // 1/3 of the same total) — comparing the two columns to each other, not to
  // an exact px value (.claude/docs/testing-playwright.md).
  expect(commentsBox.width).toBeGreaterThan(claudeBox.width * 1.6)
  expect(commentsBox.width).toBeLessThan(claudeBox.width * 2.4)

  // The three sit left-to-right in that order, immediately next to each
  // other (no extra flex gap around the connector, see home.mjs).
  expect(connectorBox.x).toBeGreaterThanOrEqual(commentsBox.x + commentsBox.width - 1)
  expect(claudeBox.x).toBeGreaterThanOrEqual(connectorBox.x + connectorBox.width - 1)

  // Comment + connector + Claude together are exactly as wide as the
  // Onderliggende-code card below, and start at the same left edge.
  const rowWidth = claudeBox.x + claudeBox.width - commentsBox.x
  expect(rowWidth).toBeCloseTo(relatedBox.width, 0)
  expect(commentsBox.x).toBeCloseTo(relatedBox.x, 0)
})
