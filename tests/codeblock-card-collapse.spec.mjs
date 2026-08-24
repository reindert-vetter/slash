import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Verifies the code-preview-card behaviour on top of the existing mechanism
// (tests/code-fence-preview.spec.mjs): a richer title (detected class
// name(s) instead of the bare language), the "over: …" context line (the
// chat text that sat directly above the fence, CSS-truncated only while
// collapsed), per-class labels inside a multi-class pane, the
// default-collapsed/Enter-to-expand behaviour for a card that does NOT
// belong to the most recent Claude reply, that reply's own card rendering on
// TOP (not the bottom), and the selected card always scrolling fully into
// view (including moving back UP onto an earlier, still-expanded card) — see
// "Default-collapsed cards, a richer title, and per-class labels" and
// "Three follow-up reviewer reports on the cards above" in
// .claude/docs/claude-chat-panel.md.
//
// Turns 4 and 5 of tests/fixtures/claude-chat-turns.json (appended, turns 1-3
// stay exactly as every other chat spec already relies on — see the Fake's
// own per-SESSION cursor, modules/claude/claude.go's SetChatTurns) are the
// two fenced-code replies this test walks to: turn 4 declares one class,
// turn 5 declares two, each with enough methods to make its EXPANDED pane
// clearly taller than the reduced viewport below — needed to exercise the
// "align to top, not just nearest edge" scroll fix. A fresh conversation
// always starts its own cursor at turn 1, so this test has to send 3 filler
// messages first to reach them.
test.use({ viewport: { width: 2000, height: 700 } })

test('code-preview cards: richer title, collapsed-only truncation, newest on top, selection stays in view', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  const start = await page.request.post('/api/workflows/task_code_comment', {
    data: {
      pr,
      file: 'test.php',
      line: 1,
      author: 'reviewer',
      body: 'kan dit sneller?',
      code: '$order->total();',
      gran: 'call',
      label: 'Order::total',
    },
  })
  expect((await start.json()).runId).toBeTruthy()

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)
  const item = page.getByTestId('comment-item').first()
  await expect(item).toBeVisible()
  await item.click() // -> cs.focus = 'comment'
  await page.keyboard.press('ArrowRight') // comment -> claude

  const composer = page.getByTestId('claude-chat-compose')
  await expect(composer).toBeFocused()

  // Turns 1-3: irrelevant filler, walked through purely to advance this
  // session's own cursor to turn 4.
  await composer.fill('Eerste vraag.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Ik heb naar de code gekeken')
  await composer.fill('Tweede vraag.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-question-option')).toHaveCount(3)
  await composer.fill('Derde, gewone vraag (negeert de open vraag hierboven).')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Bedankt, ik ga verder met Optie B.')

  // Turn 4: a single-class snippet, preceded by an explanatory sentence.
  await composer.fill('Laat een voorbeeld zien.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('Hier is een voorbeeld')

  const cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)
  const onlyCard = cards.nth(0)
  // Only ONE class detected: the title names it directly, no per-segment
  // labels needed (splitCodeByClasses bails out under 2 classes).
  await expect(onlyCard.getByTestId('code-preview-title')).toContainText('FirstExample')
  await expect(onlyCard.getByTestId('code-preview-context')).toContainText('voorbeeld')
  await expect(onlyCard.locator('[data-testid=code-preview-class-label]')).toHaveCount(0)
  // It's currently the ONLY (and therefore last/most recent) answer, so it
  // starts expanded, with its own code visible and its context line NOT
  // CSS-truncated (only a collapsed card clips it).
  await expect(onlyCard).toHaveAttribute('data-expanded', 'true')
  await expect(onlyCard).toContainText('FirstExample')
  await expect(onlyCard.locator('pre.code')).toHaveCount(1)
  await expect(onlyCard.getByTestId('code-preview-context')).not.toHaveClass(/truncate/)

  // Turn 5: a two-class (and, per-class, much longer) snippet — this demotes
  // turn 4's card to "not the last answer any more", collapsing it, while
  // this new card starts expanded, gets a label above each class's own code,
  // and — the reviewer's own new request — renders ABOVE the older card, not
  // below it.
  await composer.fill('Combineer er twee.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('En dit combineert er twee')

  await expect(cards).toHaveCount(2)
  const newestCard = cards.nth(0)
  const olderCard = cards.nth(1)

  // The newest card (turn 5) renders FIRST (on top), starts expanded, names
  // BOTH classes in the title (in source order, not a bare count), and
  // labels each segment.
  await expect(newestCard).toHaveAttribute('data-expanded', 'true')
  await expect(newestCard.getByTestId('code-preview-title')).toContainText('AlphaClass, BetaClass')
  await expect(newestCard.getByTestId('code-preview-context')).toContainText('combineert')
  const labels = newestCard.locator('[data-testid=code-preview-class-label]')
  await expect(labels).toHaveCount(2)
  await expect(labels.nth(0)).toContainText('AlphaClass')
  await expect(labels.nth(1)).toContainText('BetaClass')
  await expect(newestCard.getByTestId('code-preview-toggle')).toContainText('Inklappen')
  await expect(newestCard.getByTestId('code-preview-context')).not.toHaveClass(/truncate/)

  // The older card (turn 4) is now collapsed and rendered SECOND (below the
  // newer one): no code at all, just the title/context and the "uitklappen
  // (Enter)" affordance — and, being collapsed, its context line IS
  // CSS-truncated now.
  await expect(olderCard).toHaveAttribute('data-expanded', 'false')
  await expect(olderCard.locator('pre.code')).toHaveCount(0)
  await expect(olderCard.getByTestId('code-preview-toggle')).toContainText('uitklappen')
  await expect(olderCard.getByTestId('code-preview-context')).toHaveClass(/truncate/)

  // Enter on the focused (collapsed) older card — now the SECOND card, two
  // ArrowDowns from the composer's rest position — expands it. A brief
  // settle wait before each Enter: the reply that just landed can still be
  // settling its own MutationObserver-driven recompute (avatar/name lookups,
  // mention highlighting) for a moment after its text is already visible.
  await page.keyboard.press('ArrowDown') // composer rest -> newest (top) card
  await expect(newestCard).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('ArrowDown') // -> older (second) card
  await expect(olderCard).toHaveAttribute('data-active', 'true')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(olderCard).toHaveAttribute('data-expanded', 'true')
  await expect(olderCard.locator('pre.code')).toHaveCount(1)
  await expect(olderCard.getByTestId('code-preview-context')).not.toHaveClass(/truncate/)

  // Enter again collapses it back.
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(olderCard).toHaveAttribute('data-expanded', 'false')
  await expect(olderCard.locator('pre.code')).toHaveCount(0)

  // The scroll fix: the newest card's own methods (12+ per class) make its
  // expanded pane much taller than this reduced 700px viewport, so walking
  // BACK UP onto it (↑↑ from the now-collapsed older card) must still bring
  // its own TOP (title/selection ring) flush with its scroller's top —
  // never leaving the selection scrolled out of view, in either direction.
  // alignToTopVertical (RelatedPanel.mjs's focusPreviewCard) scrolls the
  // scroller's scrollTop so the card's top lines up with the scroller's own
  // top; a few px of tolerance for subpixel rounding.
  await page.keyboard.press('ArrowUp')
  await expect(olderCard).toHaveAttribute('data-active', 'false')
  await expect(newestCard).toHaveAttribute('data-active', 'true')
  await page.waitForTimeout(150)
  const scroller = page.getByTestId('comments-and-related')
  const [cardBox, scrollerBox] = await Promise.all([newestCard.boundingBox(), scroller.boundingBox()])
  expect(Math.abs(cardBox.y - scrollerBox.y)).toBeLessThan(4)
})
