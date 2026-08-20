import { test, expect, leaveSearchBox, openNewComment } from './_fixtures.mjs'

// Regression for "als ik in comment/chat blok zit, dan wil ik dat volledig
// zien, schuif linkerkant dan naar links op, als ik naar links ga, moet het
// weer hersteld worden" — reported with a screenshot of a wide split-diff
// block leaving the composer's send button (and the Claude/Onderliggende-code
// columns behind it) clipped off the right edge of the viewport.
//
// scrollRelatedIntoView() (home.mjs) + the watch on relatedActive() scrolls
// <main> so the comment/composer/Claude-chat/Onderliggende-code column is
// fully visible once the keyboard steps into it (cs.focus !== null), and
// scrollFocusIntoView() restores the diff to its own flush-left rest position
// on the way back out — see .claude/docs/detail-layout.md.
//
// Narrow viewport (matches main-scroll-rest-left.spec.mjs's own reasoning) so
// <main>'s content genuinely overflows: the two-sided diff card alone is
// already ~70rem/1120px wide.
test('entering the comment composer scrolls it fully into view, leaving restores the diff', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 })
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-column')).toBeVisible()

  // Block 1 (CreatePaymentAction::execute) carries a real diff on this seeded
  // PR (see comment-composer-typing-guard.spec.mjs for the same setup).
  await page.locator('[data-idx="1"]').click()
  await leaveSearchBox(page)
  await page.keyboard.press('ArrowRight') // list -> diff

  const main = page.getByTestId('detail-panel')
  await expect(main).toHaveAttribute('data-testid', 'detail-panel')

  // At rest, flush-left.
  expect(await main.evaluate((el) => el.scrollLeft)).toBe(0)

  await openNewComment(page)
  const composer = page.getByTestId('comment-compose')
  await expect(composer).toBeFocused()

  // <main> scrolled right so the whole merged comment+Claude card
  // (comment-claude-row) is fully within the viewport — not just the
  // composer itself, which alone would already fit: the Claude-chat column
  // shows optimistically right next to it (cs.focus === 'new') and is the
  // one that was reported clipped off the right edge.
  await expect(async () => {
    const scrollLeft = await main.evaluate((el) => el.scrollLeft)
    expect(scrollLeft).toBeGreaterThan(0)
  }).toPass()

  const mainBox = await main.boundingBox()
  const row = page.getByTestId('comment-claude-row')
  await expect(async () => {
    const rowBox = await row.boundingBox()
    expect(rowBox.x).toBeGreaterThanOrEqual(mainBox.x)
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1)
  }).toPass()

  // Leaving the composer (Escape -> exitRelated) restores the diff to its
  // flush-left rest position.
  await page.keyboard.press('Escape')
  await expect(composer).toHaveCount(0)
  await expect(async () => {
    expect(await main.evaluate((el) => el.scrollLeft)).toBe(0)
  }).toPass()
})

// Regression for the exact scenario the original screenshot's URL reproduced:
// a fresh page load restoring ?rel.foc=... from the URL (see urlstate.spec.mjs's
// own rel.foc round trip) lands cs.focus on the panel BEFORE the block's own
// code has finished loading — so <main> may not overflow yet at the moment
// relatedActive()'s one-time watch fires, and the panel would stay clipped
// forever without a second chance. setupMainOverflowObserver's existing
// IntersectionObserver already re-fires on any later change to <main>'s
// content width (the diff finally rendering at full size), and now also
// calls scrollRelatedIntoView() in that case — see .claude/docs/detail-layout.md.
test('a cold restore of rel.foc still scrolls into view once the delayed diff finishes loading', async ({
  page,
}) => {
  let releaseDelay
  const delay = new Promise((resolve) => {
    releaseDelay = resolve
  })
  await page.route('**/api/code**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('name') === 'execute') {
      await delay
    }
    await route.fallback()
  })

  // 1100px, not the original 1300: this fixture's Onderliggende-code panel is
  // EMPTY ("Geen onderliggende code.") and such a panel now takes a flat
  // narrow width instead of the 42rem clamp floor (RELATED_EMPTY_WIDTH_CLS,
  // RelatedPanel.mjs — see "An empty column is narrow" in
  // .claude/docs/underlying-code.md). At 1300 the whole column flow therefore
  // fits exactly (measured: scrollWidth === clientWidth === 1252), so there is
  // nothing left to scroll and this test's own premise — the panel being
  // clipped until the delayed code lands — no longer exists there. 1100 keeps
  // the flow genuinely overflowing (926px card + 288px panel), so the
  // overflow-observer path under test still runs.
  await page.setViewportSize({ width: 1100, height: 900 })
  // Block 1 (CreatePaymentAction::execute) — same fixture as the test above,
  // restored straight from the URL with the related panel already focused on
  // Onderliggende code (rel.foc=code), diff mode, change group 0.
  await page.goto('/pr/12903?sel=app%2FActions%2FCreatePaymentAction.php%3A1&mode=diff&chg=0&rel.foc=code')

  const main = page.getByTestId('detail-panel')
  const related = page.getByTestId('related-code')
  await expect(related).toBeVisible()

  releaseDelay()

  // Once the delayed code lands and the diff renders at full width, the
  // overflow observer's own re-check calls scrollRelatedIntoView(), scrolling
  // <main> so Onderliggende code is fully visible.
  const mainBox = await main.boundingBox()
  await expect(async () => {
    const scrollLeft = await main.evaluate((el) => el.scrollLeft)
    expect(scrollLeft).toBeGreaterThan(0)
    const relatedBox = await related.boundingBox()
    expect(relatedBox.x + relatedBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1)
  }).toPass()
})
