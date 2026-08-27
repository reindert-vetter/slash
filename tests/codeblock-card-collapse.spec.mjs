import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Verifies the code-preview-card behaviour on top of the existing mechanism
// (tests/code-fence-preview.spec.mjs): a richer title (detected class
// name(s), shown ONLY when detected — no bare "Codeblok N · PHP" fallback
// any more), the "over: …" context line (the
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
  // No visible chevron glyph any more (reviewer request, "uitklap ding...
  // kan helemaal weg") — the whole header row is the click target instead,
  // see "Default-collapsed cards…" in .claude/docs/claude-chat-panel.md. The
  // Dutch wording survives only as its `title` tooltip.
  await expect(newestCard.getByTestId('code-preview-toggle')).toHaveAttribute('title', 'Inklappen')
  await expect(newestCard.getByTestId('code-preview-context')).not.toHaveClass(/truncate/)

  // The older card (turn 4) is now collapsed and rendered SECOND (below the
  // newer one): no code at all, just the title/context header (itself the
  // click target) — and, being collapsed, its context line IS CSS-truncated
  // now.
  await expect(olderCard).toHaveAttribute('data-expanded', 'false')
  await expect(olderCard.locator('pre.code')).toHaveCount(0)
  await expect(olderCard.getByTestId('code-preview-toggle')).toHaveAttribute('title', 'Uitklappen (Enter)')
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

// Regression test for the key-stability bug fixed alongside the header
// cleanup above (see "A card not belonging to the LAST answer starts
// collapsed…" in .claude/docs/claude-chat-panel.md). Reviewer report: "eerder
// had ik iets anders ingeklapt, dat moet niet effect hebben op andere
// blokken" — manually collapsing one card's preview visibly collapsed a
// DIFFERENT, unrelated card too. Two separate comment threads, each with its
// own single fenced code block: switching the focused comment removes the
// no-longer-focused thread's fence from the DOM (only the focused card
// renders full-size, see recomputeCodePreviews' own filter) and the other
// thread's fence takes its place — the exact scenario that used to collide
// on the fence's raw array position.
test('collapsing one comment thread\'s code-preview card does not affect a different thread\'s card', async ({
  page,
}, testInfo) => {
  const pr = seededPr(testInfo)
  for (const [body, label] of [
    ['eerste toelichting:\n```php\n$a = 1;\n```', 'Order::total'],
    ['tweede toelichting:\n```php\n$b = 2;\n```', 'Order::lines'],
  ]) {
    const res = await page.request.post('/api/workflows/task_code_comment', {
      data: { pr, file: 'test.php', line: 1, author: 'reviewer', body, gran: 'call', label },
    })
    expect((await res.json()).runId).toBeTruthy()
  }

  await page.goto('/pr/' + pr)
  await leaveSearchBox(page)

  const itemA = page.getByTestId('comment-item').filter({ hasText: 'eerste toelichting' })
  const itemB = page.getByTestId('comment-item').filter({ hasText: 'tweede toelichting' })
  await expect(itemA).toBeVisible()
  await expect(itemB).toBeVisible()

  // Focus thread A — its single card is the only one rendered, so it starts
  // expanded by default (isLast is trivially true for a lone item).
  await itemA.click()
  let cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toHaveAttribute('data-expanded', 'true')

  // Manually collapse thread A's own card.
  await cards.first().getByTestId('code-preview-toggle').click()
  await expect(cards.first()).toHaveAttribute('data-expanded', 'false')

  // Switch focus to thread B — thread A's card (and its fence) disappears
  // from the DOM, thread B's own fence takes the preview column's only slot.
  await itemB.click()
  cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('$b = 2;')
  // Thread B never had its own card toggled — it must start expanded on its
  // own default, not inherit thread A's collapsed override.
  await expect(cards.first()).toHaveAttribute('data-expanded', 'true')

  // Switching back to thread A: ITS own manual collapse must still hold.
  // Thread A sits ABOVE the now-expanded thread B, so it is hidden behind
  // the "N hierboven" hint (InlineComments only renders cards from the
  // expanded one down, see "The selected conversation hides the ones above
  // it…" in .claude/docs/comments-panel.md) rather than clickable directly.
  await page.getByTestId('comment-more-above').click()
  cards = page.getByTestId('code-preview-card')
  await expect(cards).toHaveCount(1)
  // Still collapsed, so no code renders at all (by design) — identify the
  // card via its context line instead.
  await expect(cards.first().getByTestId('code-preview-context')).toContainText('eerste toelichting')
  await expect(cards.first()).toHaveAttribute('data-expanded', 'false')
})
