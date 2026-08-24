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
  // halves summing to related-code's own width), not about the read-only
  // shrink feature — clicking the card would call toComment(), which at this
  // (narrow, default) viewport shrinks the Claude half to 1/3 (see "Read-only,
  // not a rail" below and .claude/docs/comments-panel.md). The row is already
  // visible without it: hasVisibleComments() only needs the comment to be in
  // scope of the selected unit, not the keyboard actually inside it.
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

// "Read-only, not a rail" (see .claude/docs/comments-panel.md): below
// COMMENT_CLAUDE_WIDE_BREAKPOINT_PX (1920px, home.mjs — its OWN threshold,
// deliberately separate from Tailwind's app-wide `narrow` screen at 1399px,
// which stays untouched and keeps governing diff-card widths etc.),
// whichever half of comment-claude-row does NOT own the keyboard shrinks to
// 1/3 of the row (the focused half gets 2/3) but keeps showing its full
// content, read-only — no composer, no "Stuur", no menu button, no
// question-option/retry buttons, and no working in-body links/mentions/
// images. 1690×1054 is the reviewer's OWN real MacBook viewport (1710×1107
// screen at DPR 2, minus browser chrome) — the exact case that exposed the
// first cut's wrong (1399px) threshold: it sits comfortably above 1399px but
// must still shrink.
test('at 1690px (the reviewer\'s own MacBook viewport), the unfocused half shrinks to 1/3 and goes read-only, click hands the keyboard back', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1690, height: 1054 })
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
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
  const restCommentBox = await page.getByTestId('inline-comments').boundingBox()
  const restClaudeBox = await page.getByTestId('claude-chat-column').boundingBox()
  const restConnectorBox = await page.getByTestId('comment-claude-connector').boundingBox()
  // A span (sum of the three widths), not an x-position subtraction — robust
  // to whatever the row's own absolute left edge happens to be.
  const restTotal = restCommentBox.width + restConnectorBox.width + restClaudeBox.width

  // Click into the comment/thread — the Claude half shrinks to 1/3 and its
  // composer/menu button disappear, but the thread itself stays visible.
  await item.click()
  const claudeCard = page.getByTestId('claude-chat-card')
  await expect(claudeCard).toHaveAttribute('data-readonly', 'true')
  await expect(page.getByTestId('claude-chat-compose')).toHaveCount(0)
  await expect(page.getByTestId('claude-chat-thread')).toBeVisible()

  // The comment half is now the 2/3 side, wider than a bare half-share...
  const commentsBoxFocused = await page.getByTestId('inline-comments').boundingBox()
  const claudeBoxReadOnly = await page.getByTestId('claude-chat-column').boundingBox()
  expect(commentsBoxFocused.width).toBeGreaterThan(claudeBoxReadOnly.width)

  // ...but the ROW'S TOTAL WIDTH must stay exactly what it was at rest —
  // reviewer report (screenshot, on the earlier rail-collapse cut): the
  // expanded half used to reclaim ALL the width the other side gave up,
  // leaving the whole block wider on a laptop than in the unfocused rest
  // state. The 2/3+1/3 split keeps the same invariant automatically (see
  // columnPairScale's own doc comment in RelatedPanel.mjs).
  const focusedTotal = commentsBoxFocused.width + restConnectorBox.width + claudeBoxReadOnly.width
  expect(focusedTotal).toBeCloseTo(restTotal, 0)

  // Clicking anywhere on the read-only Claude card hands the keyboard to it
  // — it now expands to 2/3, and the comment half goes read-only instead
  // (the mirror direction).
  await claudeCard.click()
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
  const commentCard = page.getByTestId('comment-item')
  await expect(commentCard).toHaveAttribute('data-readonly', 'true')
  await expect(page.getByTestId('reaction-compose')).toHaveCount(0)
  await expect(page.getByTestId('comment-thread')).toBeVisible()

  // Clicking that read-only comment card hands the keyboard straight back.
  await commentCard.click()
  await expect(page.getByTestId('reaction-compose')).toBeVisible()
  await expect(claudeCard).toHaveAttribute('data-readonly', 'true')
})

// The cutoff itself, one px below COMMENT_CLAUDE_WIDE_BREAKPOINT_PX: still
// narrow enough to shrink/go read-only, so the threshold really sits exactly
// at 1920px and not, say, 1919 or 1921.
test('at 1919px (one below the threshold), the unfocused half still shrinks and goes read-only', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1919, height: 1080 })
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
  await item.click() // enters 'comment' focus

  await expect(page.getByTestId('claude-chat-card')).toHaveAttribute('data-readonly', 'true')
  await expect(page.getByTestId('claude-chat-compose')).toHaveCount(0)
  await expect(page.getByTestId('claude-chat-thread')).toBeVisible()
})

// Reviewer request: "doe dit alleen als ik een scherm heb op mijn laptop,
// maak anders de chat blokken 2x zo breed" — at/above
// COMMENT_CLAUDE_WIDE_BREAKPOINT_PX (1920px) neither half ever shrinks or
// goes read-only; both instead render at the SAME COMMENT_CLAUDE_WIDE_SCALE
// (RelatedPanel.mjs — 0.75, lowered from 1 on a later "~25% kleiner" report),
// well above the halved rest-state split below the breakpoint, even while
// the keyboard sits inside one of them.
test('at 1920px (the threshold itself), neither half shrinks — both are full width and stay interactive (double the halved split)', async ({
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
  await item.click() // enters 'comment' focus — would shrink/read-only Claude below 1920px

  await expect(page.getByTestId('claude-chat-card')).toHaveAttribute('data-readonly', 'false')
  await expect(page.getByTestId('claude-chat-compose')).toBeVisible()
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
  // ...but each is now roughly as wide as the Onderliggende-code card
  // (COMMENT_CLAUDE_WIDE_SCALE, 0.75, minus the small connector offset on the
  // comment side), not half of it (0.5).
  expect(commentsBox.width).toBeGreaterThan(relatedBox.width * 0.65)
})
