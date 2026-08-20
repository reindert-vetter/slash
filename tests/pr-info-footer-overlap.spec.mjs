import { test, expect } from './_fixtures.mjs'

// Regression test for a real overlap bug, so it asserts measured GEOMETRY, not
// classes: with the card's content overflowing (Doel + three since-review
// blocks + a long description), `pr-info-body` was squeezed to a ~40px sliver
// by its own `flex-1` and painted its text straight over the status pills at
// the bottom of the card. The pills are now a fixed card footer outside the
// scrolling area (`pr-info-scroll`) and the body clips itself.
// See "Description truncation" in .claude/docs/detail-layout.md.

const LONG_BODY =
  '## Samenvatting\n\nhttps://plugandpaybv.atlassian.net/browse/STAT-1091\n\n' +
  'De interval-param op /v2/statistics/recurring-mutations werd stil genegeerd. '.repeat(10)

const FACTS =
  '**7 nieuwe commits** sinds jouw laatste review:\n\n' +
  ['group per calendar interval', 'start the first period at since', 'bucket recurring mutations', 'merge origin/develop', 'let the skills auto-load', 'select amount_obligation', 'add the empty periods']
    .map((h) => `- STAT-1091: ${h} (reindert-vetter)`)
    .join('\n') +
  '\n'

async function openOverflowingCard(page) {
  await page.route('**/api/pr?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pr: 12903,
        title: 'STAT-1091: support interval param in recurring-mutations',
        url: 'https://github.com/x/y/pull/12903',
        body: LONG_BODY,
        summary: 'De interval-parameter werd eerder genegeerd. '.repeat(8),
        reviewDecision: 'CHANGES_REQUESTED',
        reviewers: ['ricky-lmu', 'tristandewit'],
        checksTotal: 72,
        checksPassed: 72,
        ghUpdatedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        newSinceKind: 'review',
        sinceSummary: 'De implementatie voor calendar-interval-groepering is vereenvoudigd terug naar een enkele flat select.',
        sinceFacts: FACTS,
      }),
    }),
  )
  await page.goto('/pr/12903')
  await expect(page.getByTestId('block-row').first()).toBeVisible()
  await page.keyboard.press('ArrowLeft') // stop 1: the PR-info column
  await expect(page.getByTestId('pr-info-body')).toBeVisible()
}

// Measured in the page: every box that matters, plus whether the content of the
// description block stays inside that block's own rect.
async function geometry(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right }
    }
    const body = document.querySelector('[data-testid=pr-info-body]')
    const bodyRect = body.getBoundingClientRect()
    const spill = [...body.querySelectorAll('.markdown-body, [data-testid=pr-info-body-toggle]')].map((el) => {
      const r = el.getBoundingClientRect()
      return Math.round(r.bottom - bodyRect.bottom)
    })
    const scroller = document.querySelector('[data-testid=pr-info-scroll]')
    return {
      card: rect('[data-testid=pr-info-card]'),
      scroll: rect('[data-testid=pr-info-scroll]'),
      body: rect('[data-testid=pr-info-body]'),
      pills: rect('[data-testid=pr-info-statuses]'),
      spill,
      // What the reviewer actually sees of the description block: its own rect
      // clipped by the scroller it lives in (getBoundingClientRect ignores an
      // ancestor's overflow, so the raw bottom can sit far below the card).
      visibleBodyBottom: Math.min(bodyRect.bottom, scroller.getBoundingClientRect().bottom),
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      cardScrolls: document.querySelector('[data-testid=pr-info-card]').scrollHeight >
        document.querySelector('[data-testid=pr-info-card]').clientHeight,
    }
  })
}

test('the description block never paints over the status pills, however full the card is', async ({ page }) => {
  await openOverflowingCard(page)
  const g = await geometry(page)

  // The premise of the bug: there is genuinely more content than fits.
  expect(g.scrollable).toBe(true)

  // 1. The block is not squeezed flat any more (it used to be ~40px).
  expect(g.body.height).toBeGreaterThanOrEqual(100)

  // 2. Nothing inside it paints below its own bottom edge.
  for (const over of g.spill) expect(over).toBeLessThanOrEqual(1)

  // 3. No overlap with the pills: what is visible of the block ends at or above
  //    where they start, and the scrolling area as a whole does too — so no
  //    block inside it can reach the footer at all.
  expect(g.visibleBodyBottom).toBeLessThanOrEqual(g.pills.top + 1)
  expect(g.scroll.bottom).toBeLessThanOrEqual(g.pills.top + 1)
})

test('the status pills are a card footer: outside the scroller and always in view', async ({ page }) => {
  await openOverflowingCard(page)
  const before = await geometry(page)

  // The pills sit BELOW the scrolling area, inside the card.
  expect(before.pills.top).toBeGreaterThanOrEqual(before.scroll.bottom - 1)
  expect(before.pills.bottom).toBeLessThanOrEqual(before.card.bottom + 1)
  // The card itself no longer scrolls — its inner area does.
  expect(before.cardScrolls).toBe(false)

  // Scrolling the content does not move them (that is what "footer" means).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=pr-info-scroll]')
    el.scrollTop = el.scrollHeight
  })
  const after = await geometry(page)
  expect(Math.round(after.pills.top)).toBe(Math.round(before.pills.top))
  expect(after.scroll.bottom).toBeLessThanOrEqual(after.pills.top + 1)
})

test('walking down to the description with the arrow keys keeps it clear of the footer', async ({ page }) => {
  await openOverflowingCard(page)

  // ↓ through the two since blocks and onto the description, exactly the walk
  // that produced the reported screenshot.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('pr-info-body')).toHaveAttribute('data-desc-focused', 'true')

  let g = await geometry(page)
  expect(g.visibleBodyBottom).toBeLessThanOrEqual(g.pills.top + 1)
  expect(g.body.height).toBeGreaterThanOrEqual(100)
  for (const over of g.spill) expect(over).toBeLessThanOrEqual(1)

  // Enter opens it in full: still no overlap, still nothing painting outside.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pr-info-body-toggle')).toHaveText(/Inklappen/)
  g = await geometry(page)
  expect(g.visibleBodyBottom).toBeLessThanOrEqual(g.pills.top + 1)
  for (const over of g.spill) expect(over).toBeLessThanOrEqual(1)
})
