import { test, expect, seededPr, leaveSearchBox } from './_fixtures.mjs'

// Verifies the three code-preview-card changes on top of the existing
// mechanism (tests/code-fence-preview.spec.mjs): a richer title (detected
// class name(s) instead of the bare language), the "over: …" context line
// (the chat text that sat directly above the fence), per-class labels inside
// a multi-class pane, and the default-collapsed/Enter-to-expand behaviour for
// a card that does NOT belong to the most recent Claude reply — see
// "Default-collapsed cards, a richer title, and per-class labels" in
// .claude/docs/claude-chat-panel.md.
//
// Turns 4 and 5 of tests/fixtures/claude-chat-turns.json (appended, turns 1-3
// stay exactly as every other chat spec already relies on — see the Fake's
// own per-SESSION cursor, modules/claude/claude.go's SetChatTurns) are the
// two fenced-code replies this test walks to: turn 4 declares one class,
// turn 5 declares two. A fresh conversation always starts its own cursor at
// turn 1, so this test has to send 3 filler messages first to reach them.
test.use({ viewport: { width: 2000, height: 1100 } })

test('code-preview cards: class name(s) + context in the title, per-class labels, default-collapsed except the last answer', async ({
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
  const firstCard = cards.nth(0)
  // Only ONE class detected: the title names it directly, no per-segment
  // labels needed (splitCodeByClasses bails out under 2 classes).
  await expect(firstCard.getByTestId('code-preview-title')).toContainText('FirstExample')
  await expect(firstCard.getByTestId('code-preview-context')).toContainText('voorbeeld')
  await expect(firstCard.locator('[data-testid=code-preview-class-label]')).toHaveCount(0)
  // It's currently the ONLY (and therefore last) answer, so it starts
  // expanded, with its own code visible.
  await expect(firstCard).toHaveAttribute('data-expanded', 'true')
  await expect(firstCard).toContainText('FirstExample')
  await expect(firstCard.locator('pre.code')).toHaveCount(1)

  // Turn 5: a two-class snippet — this demotes turn 4's card to "not the
  // last answer any more", collapsing it, while this new card starts
  // expanded and gets a label above each class's own code.
  await composer.fill('Combineer er twee.')
  await composer.press('Enter')
  await expect(page.getByTestId('claude-message-body').last()).toContainText('En dit combineert er twee')

  await expect(cards).toHaveCount(2)
  const olderCard = cards.nth(0)
  const lastCard = cards.nth(1)

  // The older card (turn 4) is now collapsed: no code at all, just the
  // title/context and the "uitklappen (Enter)" affordance.
  await expect(olderCard).toHaveAttribute('data-expanded', 'false')
  await expect(olderCard.locator('pre.code')).toHaveCount(0)
  await expect(olderCard.getByTestId('code-preview-toggle')).toContainText('uitklappen')

  // The newest card (turn 5) starts expanded, names BOTH classes in the
  // title (in source order, not a bare count), and labels each segment.
  await expect(lastCard).toHaveAttribute('data-expanded', 'true')
  await expect(lastCard.getByTestId('code-preview-title')).toContainText('AlphaClass, BetaClass')
  await expect(lastCard.getByTestId('code-preview-context')).toContainText('combineert')
  const labels = lastCard.locator('[data-testid=code-preview-class-label]')
  await expect(labels).toHaveCount(2)
  await expect(labels.nth(0)).toContainText('AlphaClass')
  await expect(labels.nth(1)).toContainText('BetaClass')
  await expect(lastCard.getByTestId('code-preview-toggle')).toContainText('Inklappen')

  // Enter on the focused (collapsed) older card expands it — the button
  // click does the exact same thing, per mouse-navigation.md. A brief settle
  // wait before each Enter: the reply that just landed can still be settling
  // its own MutationObserver-driven recompute (avatar/name lookups, mention
  // highlighting) for a moment after its text is already visible.
  await page.keyboard.press('ArrowDown') // composer rest -> first (older) card
  await expect(olderCard).toHaveAttribute('data-active', 'true')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(olderCard).toHaveAttribute('data-expanded', 'true')
  await expect(olderCard.locator('pre.code')).toHaveCount(1)

  // Enter again collapses it back.
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(olderCard).toHaveAttribute('data-expanded', 'false')
  await expect(olderCard.locator('pre.code')).toHaveCount(0)
})
