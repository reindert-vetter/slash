import { test, expect, seededPr } from './_fixtures.mjs'

// The comment block (InlineComments, commentColumnWidthCls()) and the Claude
// block (ClaudeChatPanel, claudeColumnWidthCls()) merge into one visual card
// (one border/bg, home.mjs's comment-claude-row) at equal width, separated by
// a vertical dashed divider (comment-claude-connector). Together — comment
// column + connector + Claude column — they are exactly as wide as the
// Onderliggende-code card underneath (related-code, relatedColumnWidthCls()),
// so the whole stack lines up vertically; see relatedWidthCls's doc comment
// in RelatedPanel.mjs for why that holds exactly, not just approximately.
test('comment block and Claude block are equally wide, sit beside each other and line up with Onderliggende code', async ({
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
  // Deliberately no click here: this test is about the RESTING split (equal
  // halves summing to related-code's own width), not about the rail-collapse
  // feature — clicking the card would call toComment(), which at this
  // (narrow, default) viewport collapses the Claude half to its rail (see
  // "comment/Claude rail collapse" below and .claude/docs/comments-panel.md).
  // The row is already visible without it: hasVisibleComments() only needs
  // the comment to be in scope of the selected unit, not the keyboard
  // actually inside it.
  await expect(item).toBeVisible()

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

  // The comment block and the Claude block are roughly the same width (1/2
  // vs 1/2 of the same total) — comparing the two columns to each other, not
  // to an exact px value (.claude/docs/testing-playwright.md).
  expect(commentsBox.width).toBeGreaterThan(claudeBox.width * 0.85)
  expect(commentsBox.width).toBeLessThan(claudeBox.width * 1.15)

  // The three sit left-to-right in that order, immediately next to each
  // other (no extra flex gap around the connector, see home.mjs).
  expect(connectorBox.x).toBeGreaterThanOrEqual(commentsBox.x + commentsBox.width - 1)
  expect(claudeBox.x).toBeGreaterThanOrEqual(connectorBox.x + connectorBox.width - 1)

  // Comment + connector + Claude together are exactly as wide as the
  // Onderliggende-code card below, and start at roughly the same left edge —
  // within a couple of px, not exactly: the merged comment/Claude card now
  // has its own 1px border (see comment-claude-row in home.mjs), which
  // related-code doesn't have, so its content starts 1px further right.
  const rowWidth = claudeBox.x + claudeBox.width - commentsBox.x
  expect(rowWidth).toBeCloseTo(relatedBox.width, 0)
  expect(Math.abs(commentsBox.x - relatedBox.x)).toBeLessThan(3)
})

// "Vertical inklappen" (the rail idiom, not a height cap — see
// .claude/docs/comments-panel.md): below the 1400px `narrow` breakpoint,
// whichever half of comment-claude-row does NOT own the keyboard collapses
// to a narrow, click-to-expand rail (railButtonHTML, src/collapsedRail.mjs —
// the same idiom home.mjs's collapsedColumnHTML already uses for a
// non-focused drilled column) so the focused half can reclaim the width.
test('below 1400px, the unfocused half of comment-claude-row collapses to a rail, click expands it back', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
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

  // Nothing focused yet in this row: both halves render at full column
  // width, exactly as in the resting-split test above.
  await expect(page.getByTestId('claude-chat-column')).toBeVisible()
  await expect(page.getByTestId('comment-claude-rail')).toHaveCount(0)

  // Click into the comment/thread — the Claude half collapses to its rail.
  await item.click()
  const claudeRail = page.getByTestId('claude-chat-rail')
  await expect(claudeRail).toBeVisible()
  await expect(page.getByTestId('claude-chat-column')).toHaveCount(0)
  // The comment half reclaims the freed width instead of staying halved.
  const commentsBoxCollapsed = await page.getByTestId('inline-comments').boundingBox()
  const railBox = await claudeRail.boundingBox()
  expect(commentsBoxCollapsed.width).toBeGreaterThan(railBox.width * 3)

  // Clicking the rail hands the keyboard to Claude, which now expands, and
  // the comment half collapses to ITS rail instead — the mirror direction.
  await claudeRail.click()
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
  const commentRail = page.getByTestId('comment-claude-rail')
  await expect(commentRail).toBeVisible()
  await expect(page.getByTestId('inline-comments')).toHaveCount(0)

  // Clicking that rail hands the keyboard straight back to the comment.
  await commentRail.click()
  await expect(page.getByTestId('reaction-compose')).toBeVisible()
  await expect(page.getByTestId('claude-chat-rail')).toBeVisible()
})

// Reviewer request: "doe dit alleen als ik een scherm heb op mijn laptop,
// maak anders de chat blokken 2x zo breed" — at/above the 1400px `narrow`
// breakpoint neither half ever collapses; both instead render at the SAME
// full clamp relatedColumnWidthCls() itself uses (double the halved split
// below the breakpoint), even while the keyboard sits inside one of them.
test('at/above 1400px, neither half collapses — both are full width instead (double the halved split)', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
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
  await item.click() // enters 'comment' focus — would collapse Claude below 1400px

  await expect(page.getByTestId('comment-claude-rail')).toHaveCount(0)
  await expect(page.getByTestId('claude-chat-rail')).toHaveCount(0)
  const comments = page.getByTestId('inline-comments')
  const claude = page.getByTestId('claude-chat-column')
  const related = page.getByTestId('related-code')
  await expect(comments).toBeVisible()
  await expect(claude).toBeVisible()

  const commentsBox = await comments.boundingBox()
  const claudeBox = await claude.boundingBox()
  const relatedBox = await related.boundingBox()

  // Still equal to each other (same scale for both)...
  expect(commentsBox.width).toBeGreaterThan(claudeBox.width * 0.85)
  expect(commentsBox.width).toBeLessThan(claudeBox.width * 1.15)
  // ...but each is now roughly as wide as the Onderliggende-code card,
  // not half of it.
  expect(commentsBox.width).toBeGreaterThan(relatedBox.width * 0.75)
})
